import { statSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * rc3 的公开扩展事件入口只接受 `plugin:` 前缀，并由 SDK 自动写入
 * `ignorable:true`。该名称是本项目对逻辑事实 `swarm/notebook-task-binding`
 * 的持久化映射。
 */
export const NOTEBOOK_TASK_BINDING_EVENT = 'plugin:swarm/notebook-task-binding' as const
export const NOTEBOOK_TASK_BINDING_SCHEMA_VERSION = 1 as const

/** 只回看尾部固定数量的子会话事件；更老 marker 缺失时按普通会话拒绝托管恢复。 */
export const MAX_NOTEBOOK_MARKER_SCAN_EVENTS = 4096
/** observe/inspect 的正常并发增长只允许有限次 fresh-cut 重观测。 */
export const MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS = 3

const MAX_IDENTITY_CHARS = 1024
const SESSION_SDK_SPECIFIER = '@deepseek-ai/dsh-session'

export type NotebookContextErrorCode =
  | 'NOTEBOOK_CONTEXT_INVALID'
  | 'NOTEBOOK_CONTEXT_UNAVAILABLE'
  | 'NOTEBOOK_CONTEXT_SESSION_NOT_FOUND'
  | 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH'
  | 'NOTEBOOK_CONTEXT_NOT_HOST_FS'
  | 'NOTEBOOK_CONTEXT_NOT_DURABLE'
  | 'NOTEBOOK_CONTEXT_APPEND_FAILED'
  | 'NOTEBOOK_CONTEXT_FLUSH_FAILED'

export class NotebookContextError extends Error {
  readonly code: NotebookContextErrorCode
  readonly cause?: unknown

  constructor(code: NotebookContextErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message)
    this.name = 'NotebookContextError'
    this.code = code
    if ('cause' in options) this.cause = options.cause
  }
}

export interface NotebookContextBinding {
  taskId: string
  rootSessionId: string
  attemptId: string
}

export interface NotebookResolvedReadContext {
  schemaVersion: typeof NOTEBOOK_TASK_BINDING_SCHEMA_VERSION
  sessionId: string
  managed: boolean
  /** RootRouter 的纯内存草稿豁免；只能由主入口 closure 按当前真实角色增补。 */
  routerDraft?: true
  taskId: string | null
  agentId: string
  attemptId: string | null
  rootSessionId: string | null
  cwd: string
  directoryIdentity: string
  source: 'swarm-marker' | 'host-session'
}

export interface NotebookContextSession {
  readonly id: string
  readonly header: {
    readonly id: string
    readonly cwd?: string
    readonly parentSession?: string
  }
  readonly seq: number
  readonly firstLiveSeq: number
}

export interface NotebookContextAgent {
  readonly id: string
  readonly session: NotebookContextSession
}

export interface NotebookContextObservation {
  readonly source: 'live' | 'prepared'
  readonly header: NotebookContextSession['header']
  readonly inheritedEventCount: number
  readonly events: readonly unknown[]
  readonly cursor: number
  retain?: () => NotebookContextObservation
  [Symbol.dispose]?: () => void
}

interface NotebookSessionQueryLike {
  observeSession: (
    sessionId: string,
    options?: { signal?: AbortSignal; projectionMode?: 'all' | 'none' },
  ) => Promise<NotebookContextObservation>
  inspectSession: <T>(
    sessionId: string,
    read: (session: NotebookContextSession) => T,
    signal?: AbortSignal,
  ) => Promise<T>
}

interface NotebookSessionsLike {
  get: (sessionId: string) => NotebookContextSession | undefined
  flush: (session: NotebookContextSession) => Promise<boolean>
}

interface NotebookWorkingDirectoryLike {
  get: (session: NotebookContextSession) => string
}

interface NotebookFsTargetLike {
  readonly targetKey: string
  readonly displayPath: string
}

interface NotebookFsLike {
  lstat: (path: string, opts?: { cwd?: string }, signal?: AbortSignal) => Promise<{ type: string } | undefined>
  resolve: (path: string, opts?: { cwd?: string; signal?: AbortSignal }) => Promise<NotebookFsTargetLike>
  stat: (target: NotebookFsTargetLike, signal?: AbortSignal) => Promise<{ type: string } | undefined>
  processPath: (target: NotebookFsTargetLike) => string
  processPathFromHostPath: (hostPath: string) => string | undefined
}

interface NotebookSessionSdk {
  appendPluginRecord: (
    session: NotebookContextSession,
    type: typeof NOTEBOOK_TASK_BINDING_EVENT,
    data: {
      schemaVersion: typeof NOTEBOOK_TASK_BINDING_SCHEMA_VERSION
      sessionId: string
      rootSessionId: string
      taskId: string
      attemptId: string
    },
  ) => number
}

export interface NotebookContextHost {
  get(name: string): unknown
  appendPluginRecord?: NotebookSessionSdk['appendPluginRecord']
}

export interface NotebookContextPort {
  record(
    agent: NotebookContextAgent,
    binding: NotebookContextBinding,
    signal?: AbortSignal,
  ): Promise<{
    sessionId: string
    eventType: typeof NOTEBOOK_TASK_BINDING_EVENT
    seq: number
    flushed: true
  }>
  read(sessionId: string, signal?: AbortSignal): Promise<NotebookResolvedReadContext | undefined>
}

const errorCode = (error: unknown): string | undefined => {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)

const requireText = (name: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_IDENTITY_CHARS || value.includes('\0')) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', `${name} 必须是非空可信文本`)
  }
  return value
}

const requireNonNegativeInteger = (name: string, value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', `${name} 必须是非负安全整数`)
  }
  return Number(value)
}

const getService = <T>(host: NotebookContextHost, name: string, validate: (value: unknown) => value is T): T => {
  const value = host.get(name)
  if (!validate(value)) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', `Notebook Host context 缺少 ${name} 服务`)
  }
  return value
}

const isSessionQuery = (value: unknown): value is NotebookSessionQueryLike => isRecord(value)
  && typeof value.observeSession === 'function'
  && typeof value.inspectSession === 'function'

const isSessions = (value: unknown): value is NotebookSessionsLike => isRecord(value)
  && typeof value.get === 'function'
  && typeof value.flush === 'function'

const isWorkingDirectory = (value: unknown): value is NotebookWorkingDirectoryLike => isRecord(value)
  && typeof value.get === 'function'

const isFs = (value: unknown): value is NotebookFsLike => isRecord(value)
  && typeof value.lstat === 'function'
  && typeof value.resolve === 'function'
  && typeof value.stat === 'function'
  && typeof value.processPath === 'function'
  && typeof value.processPathFromHostPath === 'function'

const isNotFound = (error: unknown): boolean => errorCode(error) === 'SESSION_QUERY_SESSION_NOT_FOUND'
  || (error as { name?: unknown } | undefined)?.name === 'SessionPersistenceNotFoundError'

interface SessionSdkCacheEntry {
  hostEntry: string
  promise: Promise<NotebookSessionSdk>
}

let sessionSdkCache: SessionSdkCacheEntry | undefined

const getHostEntry = (): string => {
  const hostEntry = process.argv[1]
  if (typeof hostEntry !== 'string' || hostEntry.trim() === '' || hostEntry.includes('\0') || !isAbsolute(hostEntry)) {
    throw new NotebookContextError(
      'NOTEBOOK_CONTEXT_UNAVAILABLE',
      '无法定位真实 Host process.argv[1] 原生入口；拒绝从 Swarm 自身依赖树解析 Session SDK'
    )
  }
  try {
    if (!statSync(hostEntry).isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new NotebookContextError(
      'NOTEBOOK_CONTEXT_UNAVAILABLE',
      '真实 Host process.argv[1] 原生入口不可访问',
      { cause: error }
    )
  }
  return hostEntry
}

const loadSessionSdk = async (): Promise<NotebookSessionSdk> => {
  const hostEntry = getHostEntry()
  if (sessionSdkCache?.hostEntry === hostEntry) return await sessionSdkCache.promise
  const requireFromHost = createRequire(hostEntry)
  const promise = (async (): Promise<NotebookSessionSdk> => {
    let resolved: string
    try {
      resolved = requireFromHost.resolve(SESSION_SDK_SPECIFIER)
    } catch (error) {
      throw new NotebookContextError(
        'NOTEBOOK_CONTEXT_UNAVAILABLE',
        '真实 Host 原生入口无法解析 @deepseek-ai/dsh-session',
        { cause: error }
      )
    }
    let module: unknown
    try {
      module = await import(pathToFileURL(resolved).href)
    } catch (error) {
      throw new NotebookContextError(
        'NOTEBOOK_CONTEXT_UNAVAILABLE',
        '真实 Host 解析到的 @deepseek-ai/dsh-session 无法作为 ESM 加载',
        { cause: error }
      )
    }
    if (!isRecord(module) || typeof module.appendPluginRecord !== 'function') {
      throw new NotebookContextError(
        'NOTEBOOK_CONTEXT_UNAVAILABLE',
        '真实 Host @deepseek-ai/dsh-session 未导出 appendPluginRecord'
      )
    }
    return module as unknown as NotebookSessionSdk
  })()
  const cache = { hostEntry, promise }
  sessionSdkCache = cache
  try {
    return await promise
  } catch (error) {
    if (sessionSdkCache === cache) sessionSdkCache = undefined
    throw error
  }
}

const getAppendPluginRecord = async (
  host: NotebookContextHost,
): Promise<NotebookSessionSdk['appendPluginRecord']> => {
  return host.appendPluginRecord ?? (await loadSessionSdk()).appendPluginRecord
}

const parseMarker = (
  event: unknown,
  sessionId: string,
  rootSessionId: string | undefined,
  minimumSeq: number,
  maximumSeq: number,
): NotebookResolvedReadContext | undefined => {
  if (rootSessionId === undefined || !isRecord(event)) return undefined
  if (event.type !== NOTEBOOK_TASK_BINDING_EVENT
    || event.ignorable !== true
    || !Number.isSafeInteger(event.seq)
    || Number(event.seq) < minimumSeq
    || Number(event.seq) > maximumSeq
    || !isRecord(event.data)
    || event.data.schemaVersion !== NOTEBOOK_TASK_BINDING_SCHEMA_VERSION
    || event.data.sessionId !== sessionId
    || event.data.rootSessionId !== rootSessionId
    || typeof event.data.taskId !== 'string'
    || event.data.taskId.trim() === ''
    || typeof event.data.attemptId !== 'string'
    || event.data.attemptId.trim() === '') {
    return undefined
  }
  return {
    schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
    sessionId,
    managed: true,
    taskId: event.data.taskId,
    agentId: sessionId,
    attemptId: event.data.attemptId,
    rootSessionId,
    cwd: '',
    directoryIdentity: '',
    source: 'swarm-marker'
  }
}

const getVerifiedHostDirectoryIdentity = async (
  fs: NotebookFsLike,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> => {
  if (!isAbsolute(cwd)) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook Host cwd 必须是绝对路径')
  }
  signal?.throwIfAborted()
  const pathInfo = await fs.lstat(cwd, undefined, signal)
  signal?.throwIfAborted()
  if (pathInfo?.type !== 'directory') {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook cwd 不是 Host 目录')
  }
  const target = await fs.resolve(cwd, { signal })
  const targetInfo = await fs.stat(target, signal)
  signal?.throwIfAborted()
  if (targetInfo?.type !== 'directory') {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook Host fs target 不是目录')
  }
  const mapped = fs.processPathFromHostPath(cwd)
  if (mapped === undefined) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook fs 不能映射当前 Host 物理目录')
  }
  const processPath = fs.processPath(target)
  let canonicalHost: string
  let canonicalMapped: string
  let canonicalProcess: string
  try {
    canonicalHost = await realpath(cwd)
    canonicalMapped = await realpath(mapped)
    canonicalProcess = await realpath(processPath)
  } catch (error) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook Host 目录身份解析失败', { cause: error })
  }
  if (canonicalMapped !== canonicalHost || canonicalProcess !== canonicalHost) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook fs 执行世界不是当前 Host 物理目录')
  }
  const stat = await lstat(canonicalHost, { bigint: true })
  signal?.throwIfAborted()
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook Host cwd 不是稳定物理目录')
  }
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
}

/**
 * 创建 Swarm 主入口挂载到 Notebook runtime 的 Host context 端口。
 * `record` 只接受真实 live Agent；`read` 只走 sessionQuery 公共冷读接口。
 */
export const createNotebookContextPort = (input: { host: NotebookContextHost }): NotebookContextPort => {
  const { host } = input

  const record: NotebookContextPort['record'] = async (agent, binding, signal) => {
    signal?.throwIfAborted()
    const sessionId = requireText('agent.session.id', agent.session.id)
    if (agent.id !== sessionId || agent.session.header.id !== sessionId) {
      throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook Agent 与 Session 身份不一致')
    }
    const rootSessionId = requireText('binding.rootSessionId', binding.rootSessionId)
    if (agent.session.header.parentSession !== rootSessionId) {
      throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook marker root 与 child parentSession 不一致')
    }
    const taskId = requireText('binding.taskId', binding.taskId)
    const attemptId = requireText('binding.attemptId', binding.attemptId)
    const appendPluginRecord = await getAppendPluginRecord(host)
    let seq: number
    try {
      seq = appendPluginRecord(agent.session, NOTEBOOK_TASK_BINDING_EVENT, {
        schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
        sessionId,
        rootSessionId,
        taskId,
        attemptId
      })
    } catch (error) {
      throw new NotebookContextError('NOTEBOOK_CONTEXT_APPEND_FAILED', 'Notebook task binding 写入失败', { cause: error })
    }
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new NotebookContextError('NOTEBOOK_CONTEXT_APPEND_FAILED', 'Notebook task binding 返回无效 seq')
    }
    const sessions = getService(host, 'sessions', isSessions)
    let flushed: boolean
    try {
      flushed = await sessions.flush(agent.session)
    } catch (error) {
      throw new NotebookContextError('NOTEBOOK_CONTEXT_FLUSH_FAILED', 'Notebook task binding durable flush 失败', { cause: error })
    }
    if (!flushed) {
      throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_DURABLE', 'Notebook task binding 没有持久化 listener 确认')
    }
    return {
      sessionId,
      eventType: NOTEBOOK_TASK_BINDING_EVENT,
      seq,
      flushed: true
    }
  }

  const read: NotebookContextPort['read'] = async (rawSessionId, signal) => {
    const sessionId = requireText('sessionId', rawSessionId)
    const sessionQuery = getService(host, 'sessionQuery', isSessionQuery)
    const sessions = getService(host, 'sessions', isSessions)
    const workingDirectory = getService(host, 'workingDirectory', isWorkingDirectory)
    const fs = getService(host, 'fs', isFs)

    const readCut = async (observation: NotebookContextObservation): Promise<NotebookResolvedReadContext> => {
      signal?.throwIfAborted()
      if (observation.header.id !== sessionId) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook observeSession 返回错误 Session')
      }
      if (observation.source !== 'live' && observation.source !== 'prepared') {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook observation source 无效')
      }
      const observationCursor = Number(observation.cursor)
      const inheritedEventCount = requireNonNegativeInteger(
        'observation.inheritedEventCount',
        observation.inheritedEventCount
      )
      if (!Number.isSafeInteger(observationCursor) || observationCursor < -1) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook observation cursor 无效')
      }
      const inspected = await sessionQuery.inspectSession(sessionId, session => {
        const live = sessions.get(sessionId) === session
        return {
          header: session.header,
          cwd: workingDirectory.get(session),
          source: live ? 'live' as const : 'prepared' as const,
          cursor: Number(live ? session.seq : session.firstLiveSeq) - 1
        }
      }, signal)
      signal?.throwIfAborted()
      if (inspected.header.id !== sessionId
        || inspected.source !== observation.source
        || inspected.cursor !== observationCursor
        || inspected.header.parentSession !== observation.header.parentSession) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_CURSOR_MISMATCH', 'Notebook session 在 observe 与 inspect 间发生变化')
      }
      const cwd = requireText('workingDirectory', inspected.cwd)
      const directoryIdentity = await getVerifiedHostDirectoryIdentity(fs, cwd, signal)
      const minimumSeq = Math.max(inheritedEventCount, observationCursor - MAX_NOTEBOOK_MARKER_SCAN_EVENTS + 1)
      const scanStart = Math.max(0, observation.events.length - MAX_NOTEBOOK_MARKER_SCAN_EVENTS)
      let marker: NotebookResolvedReadContext | undefined
      for (let index = observation.events.length - 1; index >= scanStart; index -= 1) {
        const candidate = observation.events[index]
        if (!isRecord(candidate) || !Number.isSafeInteger(candidate.seq) || Number(candidate.seq) < minimumSeq) continue
        marker = parseMarker(
          candidate,
          sessionId,
          inspected.header.parentSession,
          minimumSeq,
          observationCursor
        )
        if (marker !== undefined) break
      }
      if (marker !== undefined) return { ...marker, cwd, directoryIdentity }
      return {
        schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
        sessionId,
        managed: false,
        taskId: null,
        agentId: sessionId,
        attemptId: null,
        rootSessionId: inspected.header.parentSession ?? null,
        cwd,
        directoryIdentity,
        source: 'host-session'
      }
    }

    for (let attempt = 1; attempt <= MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS; attempt += 1) {
      signal?.throwIfAborted()
      let observation: NotebookContextObservation
      try {
        observation = await sessionQuery.observeSession(sessionId, {
          projectionMode: 'none',
          ...(signal === undefined ? {} : { signal })
        })
      } catch (error) {
        if (isNotFound(error)) return undefined
        throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', 'Notebook Host session 冷读失败', { cause: error })
      }

      let result: NotebookResolvedReadContext | undefined
      let cutFailure: unknown
      try {
        result = await readCut(observation)
      } catch (error) {
        cutFailure = error
      }

      let disposeFailure: unknown
      try {
        observation[Symbol.dispose]?.()
      } catch (error) {
        disposeFailure = error
      }
      if (disposeFailure !== undefined) {
        if (cutFailure !== undefined) {
          throw new AggregateError(
            [cutFailure, disposeFailure],
            'Notebook session 读取和 observation dispose 均失败'
          )
        }
        throw new NotebookContextError(
          'NOTEBOOK_CONTEXT_UNAVAILABLE',
          'Notebook session observation dispose 失败',
          { cause: disposeFailure }
        )
      }
      if (cutFailure === undefined) return result!

      const cursorChanged = cutFailure instanceof NotebookContextError
        && cutFailure.code === 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH'
      if (cursorChanged && attempt < MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS) continue
      if (cursorChanged) {
        throw new NotebookContextError(
          'NOTEBOOK_CONTEXT_CURSOR_MISMATCH',
          `Notebook session 连续 ${MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS} 次 fresh cut 仍不稳定；拒绝旧 marker`,
          { cause: cutFailure }
        )
      }
      throw cutFailure
    }
    throw new NotebookContextError('NOTEBOOK_CONTEXT_CURSOR_MISMATCH', 'Notebook session context 未能取得稳定 fresh cut')
  }

  return Object.freeze({ record, read })
}

/** main 接线兜底：从 Cordis context 的 `get` 能力构造 host port。 */
export const createNotebookContextPortFromContext = (ctx: {
  get: (name: string) => unknown
}): NotebookContextPort => createNotebookContextPort({
  host: { get: name => ctx.get(name) }
})

/**
 * 主入口只对真实 RootRouter 的 Host session 增补该标记。
 * marker/Worker context 或任何带 task 身份的 context 一律拒绝，避免把
 * Root 草稿豁免扩散成绕过 managed scope 的通用后门。
 */
export const withNotebookRouterDraft = (
  resolved: NotebookResolvedReadContext,
): NotebookResolvedReadContext => {
  if (resolved.managed !== false
    || resolved.source !== 'host-session'
    || resolved.taskId !== null
    || resolved.attemptId !== null
    || resolved.rootSessionId !== null) {
    throw new NotebookContextError(
      'NOTEBOOK_CONTEXT_INVALID',
      'routerDraft 只能标记无 task 的普通 Host root session'
    )
  }
  return Object.freeze({ ...resolved, routerDraft: true })
}

export const assertNotebookReadContextMatches = (
  resolved: NotebookResolvedReadContext,
  trusted: {
    agentId?: string
    taskId?: string
    cwd?: string
  },
): NotebookResolvedReadContext => {
  if (trusted.agentId !== undefined && trusted.agentId !== resolved.agentId) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook resolver agent 与执行 scope 不一致')
  }
  if (trusted.taskId !== undefined && trusted.taskId !== resolved.taskId) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook resolver task 与执行 scope 不一致')
  }
  if (trusted.cwd !== undefined && resolve(trusted.cwd) !== resolve(resolved.cwd)) {
    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook resolver cwd 与执行 scope 不一致')
  }
  return resolved
}
