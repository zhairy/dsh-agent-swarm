import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Notebook 数据快照格式版本；升级时必须显式迁移，不能猜测旧结构。 */
export const NOTEBOOK_SNAPSHOT_SCHEMA_VERSION = 1

/** 单会话默认最多保存 16 MiB，与现有完成视图内存预算一致。 */
export const DEFAULT_NOTEBOOK_SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024

/** 即使运维显式放宽，也不允许快照超过 Notebook 单文件上限。 */
export const MAX_NOTEBOOK_SNAPSHOT_BYTES = 128 * 1024 * 1024

/** Swarm 主入口安装、Notebook 插件消费的进程内端口。 */
export const NOTEBOOK_SNAPSHOT_RUNTIME_KEY = Symbol.for('dsh-agent-swarm.notebook-snapshot.v1')

const MAX_SESSION_ID_CHARS = 512
const MAX_IDENTITY_CHARS = 1024
const MAX_DATA_DEPTH = 64
const MAX_CELLS = 4096

export type NotebookJson = null | boolean | number | string | NotebookJson[] | { [key: string]: NotebookJson }

export type NotebookSnapshotErrorCode =
  | 'NOTEBOOK_SNAPSHOT_INVALID'
  | 'NOTEBOOK_SNAPSHOT_PATH_OUTSIDE'
  | 'NOTEBOOK_SNAPSHOT_NOT_DATA'
  | 'NOTEBOOK_SNAPSHOT_TOO_LARGE'
  | 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH'
  | 'NOTEBOOK_SNAPSHOT_CORRUPT'
  | 'NOTEBOOK_SNAPSHOT_IO'

/** 带稳定错误码的快照错误，便于插件返回固定诊断而不会泄露内部路径内容。 */
export class NotebookSnapshotError extends Error {
  readonly code: NotebookSnapshotErrorCode
  readonly cause?: unknown

  constructor(code: NotebookSnapshotErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'NotebookSnapshotError'
    this.code = code
    if ('cause' in options) this.cause = options.cause
  }
}

export interface NotebookSnapshotCleanup {
  close?: () => Promise<void>
  unlink: () => Promise<void>
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/**
 * 保存失败后执行受限清理；只忽略已不存在的临时文件与已关闭句柄。
 * 清理异常不能被吞掉，也不能覆盖原始写入失败，因此统一挂到 AggregateError cause。
 */
export const rethrowNotebookSnapshotFailure = async (
  original: unknown,
  cleanup: NotebookSnapshotCleanup
): Promise<never> => {
  const cleanupErrors: unknown[] = []
  if (cleanup.close !== undefined) {
    try {
      await cleanup.close()
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT' && code !== 'EBADF' && code !== 'ERR_FILE_HANDLE_CLOSED') cleanupErrors.push(error)
    }
  }
  try {
    await cleanup.unlink()
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') cleanupErrors.push(error)
  }
  if (cleanupErrors.length > 0) {
    throw new NotebookSnapshotError(
      'NOTEBOOK_SNAPSHOT_IO',
      'Notebook 快照写入失败且临时文件清理未确认',
      { cause: new AggregateError([original, ...cleanupErrors], 'Notebook 快照写入及清理失败') }
    )
  }
  if (original instanceof NotebookSnapshotError) throw original
  throw new NotebookSnapshotError(
    'NOTEBOOK_SNAPSHOT_IO',
    `Notebook 快照写入失败: ${errorCode(original) ?? 'UNKNOWN'}`,
    { cause: original }
  )
}

export interface NotebookSnapshotTask {
  id: string | null
  agentId: string | null
  attemptId: string | null
  managed: boolean
}

export interface NotebookSnapshotProject {
  cwd: string
  repositoryRoot: string
  directoryIdentity: string | null
}

export interface NotebookSnapshotBoundary {
  mode: 'write' | 'read-only' | 'host-worktree'
  operation: 'shell' | 'file' | 'host'
  writeScopes: string[]
}

export interface NotebookSnapshotNotebook {
  cells: NotebookJson[]
  metadata: NotebookJson
  nbformat: number
  nbformat_minor: number
}

export interface AddNotebookSnapshotInput {
  sessionId: string
  savedAt: string
  savedPath: string
  notebook: {
    cells: readonly unknown[]
    metadata?: unknown
    nbformat: number
    nbformat_minor: number
  }
  cellExtras?: unknown
  task: NotebookSnapshotTask
  project: NotebookSnapshotProject
  boundary: NotebookSnapshotBoundary | null
}

export interface NotebookSnapshotRecord {
  schemaVersion: typeof NOTEBOOK_SNAPSHOT_SCHEMA_VERSION
  sessionId: string
  savedAt: string
  recordedAt: string
  savedPath: string
  task: NotebookSnapshotTask
  project: NotebookSnapshotProject
  boundary: NotebookSnapshotBoundary | null
  notebook: NotebookSnapshotNotebook
  cellExtras: NotebookJson
  view: {
    mode: 'read-only'
    kernelAlive: false
    autoRun: false
  }
}

export interface NotebookSnapshotReceipt {
  saved: true
  digest: string
  bytes: number
  savedAt: string
  recordedAt: string
}

export interface NotebookSnapshotRuntime {
  version: 1
  /** 只在显式文件保存已成功后登记数据；快照本身从不授予工作区写权限。 */
  save: (input: AddNotebookSnapshotInput) => Promise<NotebookSnapshotReceipt>
  /** 仅恢复纯数据；调用方仍须用可信 Host 状态完成会话、项目和任务隔离。 */
  load: (sessionId: string, context?: NotebookSnapshotReadContext) => Promise<NotebookSnapshotRecord | undefined>
  /** Swarm 主入口可挂载的 Host 冷读 resolver；Notebook 桥不得从模型参数补 owner/path。 */
  resolveReadContext?: (sessionId: string, signal?: AbortSignal) => Promise<NotebookSnapshotReadContext | undefined>
}

export interface NotebookSnapshotReadContext {
  /** 可信 Host 给出的逻辑 Session；存在时必须与 load 的第一个参数一致。 */
  sessionId?: string
  /**
   * RootRouter 的可信纯内存草稿标记。只能由 runtime resolver 根据实际 Host
   * Agent 与 Swarm 当前角色增补，不能来自 HTTP/模型字段或持久 marker。
   */
  routerDraft?: true
  /** 旧桥接字段；托管快照不接受它代替精确 cwd 与目录身份。 */
  projectPaths?: readonly string[]
  agentId?: string
  taskId?: string | null
  /**
   * 当前已核验执行 attempt。它可以不同于记录中的 producer attempt；
   * 快照只复用同一 task/agent 的纯数据，不恢复旧 attempt 的写授权。
   */
  attemptId?: string | null
  rootSessionId?: string | null
  managed?: boolean
  /** 当前 Host working directory；必须与保存时的 project.cwd 精确相等。 */
  cwd?: string
  /** 当前目录的 dev:ino:birthtimeNs；同一路径被替换后必须变化并拒绝恢复。 */
  directoryIdentity?: string
}

export interface NotebookSnapshotStoreOptions {
  dshHome: string
  maxBytes?: number
  now?: () => number
}

export interface NotebookSnapshotStore extends NotebookSnapshotRuntime {
  readonly directory: string
  readonly maxBytes: number
}

interface StoredNotebookSnapshot {
  schemaVersion: typeof NOTEBOOK_SNAPSHOT_SCHEMA_VERSION
  digest: string
  record: NotebookSnapshotRecord
}

const invalid = (message: string): never => {
  throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_INVALID', message)
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)

const validateText = (name: string, value: unknown, required = true, maximum = MAX_IDENTITY_CHARS): string | null => {
  if (value === null || value === undefined) {
    if (required) invalid(`${name} 不能为空`)
    return null
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximum || value.includes('\0')) {
    invalid(`${name} 必须是长度不超过 ${maximum} 的非空文本`)
  }
  return value as string
}

const validateTime = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) invalid(`${name} 必须是有效时间`)
  return value as string
}

const cloneData = (
  value: unknown,
  path = '$',
  depth = 0,
  seen = new Set<object>()
): NotebookJson => {
  if (depth > MAX_DATA_DEPTH) throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 嵌套过深`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 含非有限数字`)
    return value
  }
  if (typeof value !== 'object') {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 不是纯 JSON 数据`)
  }
  if (seen.has(value)) throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 含循环引用`)
  if (typeof (value as { then?: unknown }).then === 'function') {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 含活 Promise`)
  }
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => cloneData(entry, `${path}[${index}]`, depth + 1, seen))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 不是普通 JSON 对象`)
    }
    const result: { [key: string]: NotebookJson } = Object.create(null) as { [key: string]: NotebookJson }
    for (const [key, entry] of Object.entries(value)) {
      if (key === '_runJob') {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_NOT_DATA', `${path} 仍包含运行中 cell 句柄`)
      }
      result[key] = cloneData(entry, `${path}.${key}`, depth + 1, seen)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

const within = (root: string, target: string): boolean => {
  const rel = relative(root, target)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

const canonicalFile = async (path: string, name: string): Promise<string> => {
  if (!isAbsolute(path)) invalid(`${name} 必须是绝对路径`)
  let entry
  try {
    entry = await lstat(path)
  } catch (error) {
    throw new NotebookSnapshotError(
      'NOTEBOOK_SNAPSHOT_IO',
      `${name} 不可访问: ${errorCode(error) ?? 'UNKNOWN'}`,
      { cause: error }
    )
  }
  if (entry.isSymbolicLink() || !entry.isFile()) invalid(`${name} 必须是普通文件且不能是符号链接`)
  return realpath(path)
}

const canonicalDirectory = async (path: string, name: string): Promise<string> => {
  if (!isAbsolute(path)) invalid(`${name} 必须是绝对路径`)
  try {
    const entry = await lstat(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) invalid(`${name} 必须是原物理目录`)
    return realpath(path)
  } catch (error) {
    if (error instanceof NotebookSnapshotError) throw error
    throw new NotebookSnapshotError(
      'NOTEBOOK_SNAPSHOT_IO',
      `${name} 不可访问: ${errorCode(error) ?? 'UNKNOWN'}`,
      { cause: error }
    )
  }
}

const inspectDirectory = async (path: string, name: string): Promise<{ path: string; identity: string }> => {
  if (!isAbsolute(path)) invalid(`${name} 必须是绝对路径`)
  try {
    const entry = await lstat(path, { bigint: true })
    if (entry.isSymbolicLink() || !entry.isDirectory()) invalid(`${name} 必须是原物理目录`)
    const canonical = await realpath(path)
    const canonicalEntry = await lstat(canonical, { bigint: true })
    if (canonicalEntry.isSymbolicLink() || !canonicalEntry.isDirectory()) invalid(`${name} 必须是稳定物理目录`)
    return {
      path: canonical,
      identity: [canonicalEntry.dev, canonicalEntry.ino, canonicalEntry.birthtimeNs].join(':')
    }
  } catch (error) {
    if (error instanceof NotebookSnapshotError) throw error
    throw new NotebookSnapshotError(
      'NOTEBOOK_SNAPSHOT_IO',
      `${name} 不可访问: ${errorCode(error) ?? 'UNKNOWN'}`,
      { cause: error }
    )
  }
}

const validateSessionId = (sessionId: unknown): string => validateText('sessionId', sessionId, true, MAX_SESSION_ID_CHARS)!

const getDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const getSnapshotPath = (directory: string, sessionId: string): string => {
  const key = createHash('sha256').update(sessionId).digest('hex')
  return join(directory, `${key}.json`)
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  }
  return value
}

const validateRecord = (value: unknown): NotebookSnapshotRecord => {
  if (!isRecord(value) || value.schemaVersion !== NOTEBOOK_SNAPSHOT_SCHEMA_VERSION) {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照版本或结构无效')
  }
  if (!isRecord(value.view)
    || value.view.mode !== 'read-only'
    || value.view.kernelAlive !== false
    || value.view.autoRun !== false) {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照只读标志无效')
  }
  if (!isRecord(value.notebook)
    || !Array.isArray(value.notebook.cells)
    || value.notebook.cells.length < 1
    || value.notebook.cells.length > MAX_CELLS
    || !Number.isSafeInteger(value.notebook.nbformat)
    || !Number.isSafeInteger(value.notebook.nbformat_minor)) {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照 cell 数据无效')
  }
  if (!isRecord(value.task) || !isRecord(value.project)) {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照身份数据无效')
  }
  const task = value.task as Record<string, unknown>
  const project = value.project as Record<string, unknown>
  if (typeof task.managed !== 'boolean' || !isRecord(value.cellExtras)) {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照身份或扩展数据无效')
  }
  validateSessionId(value.sessionId)
  validateTime('savedAt', value.savedAt)
  validateTime('recordedAt', value.recordedAt)
  const savedPath = validateText('savedPath', value.savedPath)!
  const cwd = validateText('project.cwd', project.cwd)!
  validateText('project.repositoryRoot', project.repositoryRoot)
  validateText('project.directoryIdentity', project.directoryIdentity, false)
  validateText('task.id', task.id, task.managed === true)
  validateText('task.agentId', task.agentId, task.managed === true)
  validateText('task.attemptId', task.attemptId, task.managed === true)
  if (value.boundary !== null) {
    if (!isRecord(value.boundary)
      || !['write', 'read-only', 'host-worktree'].includes(String(value.boundary.mode))
      || !['shell', 'file', 'host'].includes(String(value.boundary.operation))
      || !Array.isArray(value.boundary.writeScopes)
      || value.boundary.writeScopes.some(scope => typeof scope !== 'string' || !isAbsolute(scope))) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照执行边界无效')
    }
  }
  for (const [index, cell] of ((value.notebook as Record<string, unknown>).cells as unknown[]).entries()) {
    if (!isRecord(cell)
      || typeof cell.id !== 'string'
      || cell.id === ''
      || !['code', 'markdown', 'raw'].includes(String(cell.cell_type))
      || typeof cell.source !== 'string'
      || (cell.outputs !== undefined && !Array.isArray(cell.outputs))) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', `Notebook 快照 cell[${index}] 无效`)
    }
  }
  if (!isAbsolute(savedPath) || !isAbsolute(cwd) || !within(cwd, savedPath)) {
    throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照路径身份无效')
  }
  return value as unknown as NotebookSnapshotRecord
}

/**
 * 创建项目隔离的 Notebook 数据快照存储。
 *
 * 快照只接受纯 JSON cell 数据，按 session 覆盖最新一次显式保存；文件名使用
 * session 摘要避免路径注入，目录固定在 DSH_HOME 内并使用 0700/0600 权限。
 */
export const createNotebookSnapshotStore = (options: NotebookSnapshotStoreOptions): NotebookSnapshotStore => {
  if (!isAbsolute(options.dshHome)) invalid('dshHome 必须是绝对路径')
  const maxBytes = options.maxBytes ?? DEFAULT_NOTEBOOK_SNAPSHOT_MAX_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_NOTEBOOK_SNAPSHOT_BYTES) {
    invalid(`maxBytes 必须为 1024-${MAX_NOTEBOOK_SNAPSHOT_BYTES} 的安全整数`)
  }
  const now = options.now ?? Date.now
  const directory = join(resolve(options.dshHome), 'share', 'dsh-agent-swarm', 'notebook-snapshots', 'v1')
  const writeChains = new Map<string, Promise<void>>()

  const waitForWrites = async (sessionId: string): Promise<void> => {
    const pending = writeChains.get(sessionId)
    if (pending !== undefined) await pending
  }

  const saveNow = async (input: AddNotebookSnapshotInput): Promise<NotebookSnapshotReceipt> => {
    const sessionId = validateSessionId(input.sessionId)
    const savedAt = validateTime('savedAt', input.savedAt)
    const savedPath = await canonicalFile(input.savedPath, 'savedPath')
    const cwdInfo = await inspectDirectory(input.project.cwd, 'project.cwd')
    const cwd = cwdInfo.path
    const repositoryRoot = await canonicalDirectory(input.project.repositoryRoot, 'project.repositoryRoot')
    if (!within(cwd, savedPath)) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_PATH_OUTSIDE', 'Notebook 保存路径超出当前项目工作目录')
    }
    const task = {
      id: validateText('task.id', input.task.id, input.task.managed),
      agentId: validateText('task.agentId', input.task.agentId, input.task.managed),
      attemptId: validateText('task.attemptId', input.task.attemptId, input.task.managed),
      managed: input.task.managed === true
    }
    if (task.managed && task.id === null) invalid('托管 Notebook 快照必须携带 task.id')
    const suppliedDirectoryIdentity = validateText(
      'project.directoryIdentity',
      input.project.directoryIdentity,
      task.managed
    )
    if (suppliedDirectoryIdentity !== null && suppliedDirectoryIdentity !== cwdInfo.identity) {
      throw new NotebookSnapshotError(
        'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH',
        'Notebook 保存时的目录身份与当前物理目录不一致'
      )
    }
    const boundary = input.boundary === null ? null : {
      mode: input.boundary.mode,
      operation: input.boundary.operation,
      writeScopes: input.boundary.writeScopes.map((scope, index) => validateText(`boundary.writeScopes[${index}]`, scope)!)
    }
    if (boundary !== null && !['write', 'read-only', 'host-worktree'].includes(boundary.mode)) invalid('boundary.mode 无效')
    if (boundary !== null && !['shell', 'file', 'host'].includes(boundary.operation)) invalid('boundary.operation 无效')
    if (task.managed && (boundary === null || boundary.mode !== 'write')) invalid('托管 Notebook 快照必须保留显式写入边界')

    const rawCells = input.notebook.cells
    if (!Array.isArray(rawCells) || rawCells.length < 1 || rawCells.length > MAX_CELLS) {
      invalid(`Notebook 快照 cells 数量必须为 1-${MAX_CELLS}`)
    }
    if (!Number.isSafeInteger(input.notebook.nbformat) || input.notebook.nbformat < 1 || input.notebook.nbformat > 99) {
      invalid('Notebook nbformat 无效')
    }
    if (!Number.isSafeInteger(input.notebook.nbformat_minor) || input.notebook.nbformat_minor < 0 || input.notebook.nbformat_minor > 99) {
      invalid('Notebook nbformat_minor 无效')
    }
    const cells = cloneData(rawCells, '$.notebook.cells') as NotebookJson[]
    for (const [index, cell] of cells.entries()) {
      if (!isRecord(cell)
        || validateText(`cells[${index}].id`, cell.id, true, 256) === null
        || !['code', 'markdown', 'raw'].includes(String(cell.cell_type))
        || typeof cell.source !== 'string'
        || (cell.outputs !== undefined && !Array.isArray(cell.outputs))) {
        invalid(`Notebook cell[${index}] 结构无效`)
      }
    }
    const metadata = cloneData(input.notebook.metadata ?? {}, '$.notebook.metadata')
    const cellExtras = cloneData(input.cellExtras ?? {}, '$.cellExtras')
    if (!isRecord(cellExtras)) invalid('cellExtras 必须是对象')

    const record: NotebookSnapshotRecord = deepFreeze({
      schemaVersion: NOTEBOOK_SNAPSHOT_SCHEMA_VERSION,
      sessionId,
      savedAt,
      recordedAt: new Date(now()).toISOString(),
      savedPath,
      task,
      project: {
        cwd,
        repositoryRoot,
        directoryIdentity: cwdInfo.identity
      },
      boundary,
      notebook: {
        cells,
        metadata,
        nbformat: input.notebook.nbformat,
        nbformat_minor: input.notebook.nbformat_minor
      },
      cellExtras,
      view: {
        mode: 'read-only',
        kernelAlive: false,
        autoRun: false
      }
    })
    const digest = getDigest(record)
    const document: StoredNotebookSnapshot = {
      schemaVersion: NOTEBOOK_SNAPSHOT_SCHEMA_VERSION,
      digest,
      record
    }
    const encoded = JSON.stringify(document)
    const bytes = Buffer.byteLength(encoded, 'utf8')
    if (bytes > maxBytes) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_TOO_LARGE', `Notebook 数据快照 ${bytes} 字节，超过上限 ${maxBytes}`)
    }

    const target = getSnapshotPath(directory, sessionId)
    const temporary = join(dirname(target), `.${randomUUID()}.tmp`)
    let handle
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      handle = await open(temporary, 'wx', 0o600)
      await handle.writeFile(encoded, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, target)
      const dirHandle = await open(directory, 'r')
      try {
        await dirHandle.sync()
      } finally {
        await dirHandle.close()
      }
    } catch (error) {
      await rethrowNotebookSnapshotFailure(error, {
        ...(handle === undefined ? {} : { close: () => handle!.close() }),
        unlink: () => unlink(temporary)
      })
    }
    return {
      saved: true,
      digest,
      bytes,
      savedAt: record.savedAt,
      recordedAt: record.recordedAt
    }
  }

  const save = async (input: AddNotebookSnapshotInput): Promise<NotebookSnapshotReceipt> => {
    const sessionId = validateSessionId(input.sessionId)
    const previous = writeChains.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => saveNow(input))
    const tail = current.then(() => undefined, () => undefined)
    writeChains.set(sessionId, tail)
    try {
      return await current
    } finally {
      if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId)
    }
  }

  const load = async (
    rawSessionId: string,
    context?: NotebookSnapshotReadContext
  ): Promise<NotebookSnapshotRecord | undefined> => {
    const sessionId = validateSessionId(rawSessionId)
    await waitForWrites(sessionId)
    const file = getSnapshotPath(directory, sessionId)
    let info
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      info = await handle.stat()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new NotebookSnapshotError(
        'NOTEBOOK_SNAPSHOT_IO',
        `Notebook 快照不可访问: ${errorCode(error) ?? 'UNKNOWN'}`,
        { cause: error }
      )
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) {
      await handle.close()
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照文件类型或大小无效')
    }
    let raw: string | undefined
    let readFailure: unknown
    try {
      raw = await handle.readFile('utf8')
    } catch (error) {
      readFailure = error
    }
    const closeFailures: unknown[] = []
    try {
      await handle.close()
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ENOENT' && code !== 'EBADF' && code !== 'ERR_FILE_HANDLE_CLOSED') closeFailures.push(error)
    }
    if (readFailure !== undefined || closeFailures.length > 0) {
      const failures = [readFailure, ...closeFailures].filter(error => error !== undefined)
      throw new NotebookSnapshotError(
        'NOTEBOOK_SNAPSHOT_IO',
        'Notebook 快照读取或关闭失败',
        { cause: failures.length === 1 ? failures[0] : new AggregateError(failures, 'Notebook 快照读取及关闭失败') }
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw!)
    } catch (error) {
      throw new NotebookSnapshotError(
        'NOTEBOOK_SNAPSHOT_CORRUPT',
        'Notebook 快照不是有效 JSON',
        { cause: error }
      )
    }
    if (!isRecord(parsed)
      || parsed.schemaVersion !== NOTEBOOK_SNAPSHOT_SCHEMA_VERSION
      || typeof parsed.digest !== 'string'
      || !/^[a-f0-9]{64}$/.test(parsed.digest)
      || !isRecord(parsed.record)) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照封装结构无效')
    }
    let record
    try {
      record = validateRecord(parsed.record)
    } catch (error) {
      if (error instanceof NotebookSnapshotError && error.code === 'NOTEBOOK_SNAPSHOT_INVALID') {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', error.message)
      }
      throw error
    }
    if (record.sessionId !== sessionId || getDigest(record) !== parsed.digest) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_CORRUPT', 'Notebook 快照身份或摘要不匹配')
    }
    if (context?.sessionId !== undefined && context.sessionId !== sessionId) {
      throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照 session context 与请求不一致')
    }
    if (record.task.managed) {
      if (context === undefined
        || context.managed !== true
        || context.projectPaths !== undefined
        || typeof context.taskId !== 'string' || context.taskId.trim() === ''
        || typeof context.agentId !== 'string' || context.agentId.trim() === ''
        || typeof context.attemptId !== 'string' || context.attemptId.trim() === ''
        || typeof context.cwd !== 'string' || context.cwd.trim() === ''
        || typeof context.directoryIdentity !== 'string' || context.directoryIdentity.trim() === '') {
        throw new NotebookSnapshotError(
          'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH',
          '托管 Notebook 快照恢复缺少完整可信 task/agent/cwd/目录身份'
        )
      }
      if (context.taskId !== record.task.id
        || context.agentId !== record.task.agentId) {
        throw new NotebookSnapshotError(
          'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH',
          'Notebook 快照 task/agent owner 与当前 Host context 不一致'
        )
      }
      const currentCwd = await inspectDirectory(context.cwd, 'context.cwd')
      if (currentCwd.path !== record.project.cwd) {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照 worktree 与当前 cwd 不一致')
      }
      if (currentCwd.identity !== context.directoryIdentity
        || record.project.directoryIdentity === null
        || context.directoryIdentity !== record.project.directoryIdentity) {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照目录身份已变化')
      }
    } else if (context !== undefined) {
      if (context.managed === true) {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照管理模式与当前会话不一致')
      }
      if (context.agentId !== undefined && record.task.agentId !== null && context.agentId !== record.task.agentId) {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照 agent 与当前身份不一致')
      }
      if (context.taskId !== undefined && context.taskId !== record.task.id) {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照 task 与当前任务不一致')
      }
      if (context.cwd !== undefined) {
        const currentCwd = await inspectDirectory(context.cwd, 'context.cwd')
        if (currentCwd.path !== record.project.cwd) {
          throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照项目路径与当前项目不一致')
        }
        if (context.directoryIdentity !== undefined && currentCwd.identity !== context.directoryIdentity) {
          throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照目录身份与当前目录不一致')
        }
      }
      if (context.directoryIdentity !== undefined
        && record.project.directoryIdentity !== null
        && context.directoryIdentity !== record.project.directoryIdentity) {
        throw new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH', 'Notebook 快照目录身份已变化')
      }
    }
    return record
  }

  return Object.freeze({
    version: 1 as const,
    directory,
    maxBytes,
    save,
    load
  })
}

/** 获取当前进程安装的 Notebook 快照端口；缺失时由插件保持原有 .ipynb 保存语义。 */
export const getNotebookSnapshotRuntime = (): NotebookSnapshotRuntime | undefined => {
  const value = (globalThis as Record<symbol, unknown>)[NOTEBOOK_SNAPSHOT_RUNTIME_KEY]
  return isRecord(value)
    && value.version === 1
    && typeof value.save === 'function'
    && typeof value.load === 'function'
    && (value.resolveReadContext === undefined || typeof value.resolveReadContext === 'function')
    ? value as unknown as NotebookSnapshotRuntime
    : undefined
}

/** 安装唯一快照端口；返回幂等卸载器且只删除本实例持有的全局值。 */
export const installNotebookSnapshotRuntime = (runtime: NotebookSnapshotRuntime): (() => void) => {
  if (runtime.version !== 1
    || typeof runtime.save !== 'function'
    || typeof runtime.load !== 'function'
    || (runtime.resolveReadContext !== undefined && typeof runtime.resolveReadContext !== 'function')) {
    invalid('Notebook 快照端口不完整')
  }
  const globals = globalThis as Record<symbol, unknown>
  if (globals[NOTEBOOK_SNAPSHOT_RUNTIME_KEY] !== undefined) {
    throw new Error('Notebook 快照端口已被占用')
  }
  globals[NOTEBOOK_SNAPSHOT_RUNTIME_KEY] = runtime
  return () => {
    if (globals[NOTEBOOK_SNAPSHOT_RUNTIME_KEY] === runtime) delete globals[NOTEBOOK_SNAPSHOT_RUNTIME_KEY]
  }
}
