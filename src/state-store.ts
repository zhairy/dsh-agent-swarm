import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, readdir, rename, unlink, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { intMutex } from './util/mutex.js'
import { StateStoreError, canonicalStateJson, checksumText, checksum, deepFreeze } from './state-core.js'
import { ChunkedState, normalizeStatePatch, type SegmentSpecs, type StatePatch } from './state-chunks.js'

export { StateStoreError, canonicalStateJson } from './state-core.js'

export interface DurableStateStore<T> {
  readonly directory: string
  readonly durable: boolean
  /** 完整状态的编码字节上限；内存态与持久化态取值不同，由调用方按模式决定。 */
  readonly maxStateBytes: number
  /** 最近一次成功提交（或恢复装载）状态的编码字节数；提交失败不改变该读数。 */
  getStateBytes: () => number
  /** 当前状态的根校验和（分片哈希的规范组合）；用于链校验与诊断。 */
  getRootChecksum: () => string
  read: () => T
  readPath?: <R = unknown>(path: readonly (string | number)[]) => R | undefined
  readFields?: <K extends keyof T>(keys: readonly K[]) => Pick<T, K>
  getSequence: () => number
  commit: (type: string, mutate: (draft: T) => T | void | Promise<T | void>) => Promise<T>
  /**
   * 分片增量提交：只编码/校验/哈希本次变更的分片，日志只写增量。
   * 调用方必须保证补丁覆盖了全部变更（未声明的分片保持已提交内容不变）。
   * 传入函数时在互斥区内以冻结的当前状态求值，使“读取-判断-写补丁”与提交之间没有其它写入者。
   * 返回提交元信息而不是状态快照：增量路径不应为返回值再复制一份完整状态。
   * `changed === false` 表示补丁与已提交内容逐字节一致，未写入日志也未消耗序列号。
   */
  update: (type: string, write: StateWrite<T>) => Promise<{ readonly sequence: number; readonly changed: boolean }>
  dispose: () => Promise<void>
}
/**
 * 增量写入的两种形式：直接给补丁，或在互斥区内按冻结基线求值补丁。
 * `build` 形式让“读取-判断-写补丁”与提交同处一个事务，避免读-改-写竞态。
 */
export type StateWrite<T> = { readonly patch: unknown } | { readonly build: (state: T) => unknown | Promise<unknown> }
export interface StateValidationIssue { path: string; code: string }
export interface StateValidationReport { ok: boolean; issues?: readonly StateValidationIssue[] }
export type StateValidationResult = boolean | StateValidationReport
export interface StateChunkTouch { readonly segment: string; readonly key: string }
export interface DurableStateOptions<T> {
  directory: string
  initialState: T
  validate?: (value: unknown) => StateValidationResult
  /** 增量提交的按分片校验：只收到本次触碰的分片；未提供时增量提交回退全量 validate。 */
  validateIncremental?: (state: T, changed: readonly StateChunkTouch[]) => StateValidationResult
  recover?: (state: T) => T
  /** 顶层段的分片规格；未声明的段按 whole 处理（每次提交整段替换）。 */
  segments?: SegmentSpecs
  /**
   * 旧布局回放规格：日志行声明的布局不等于 `layoutVersion` 时按它回放。
   * 缺省与 `segments` 相同（不存在布局迁移）。旧目录在这种情形下会在下一次写入时
   * 自动补一条当前布局的全量行，之后的写入才是增量行。
   */
  legacySegments?: SegmentSpecs
  /** 明确的旧版本规格，逐版本复核旧指纹与根哈希，不能把不同旧布局混作同一规格。 */
  legacyLayouts?: Readonly<Record<number, SegmentSpecs>>
  /** 当前布局版本；日志行的 `layout` 必须等于它才能直接续写增量行。默认 1。 */
  layoutVersion?: number
  enabled?: boolean
  maxStateBytes?: number
  maxJournalBytes?: number
  snapshotEvery?: number
}

/** Validators return structural locations and fixed rule codes, never state values. */
const validationFailureMessage = (result: StateValidationResult): string => {
  if (typeof result !== 'object' || result === null || !Array.isArray(result.issues)) return 'State schema validation failed'
  const issues = result.issues.slice(0, 3).flatMap((issue) => {
    if (issue === null || typeof issue !== 'object' || typeof issue.path !== 'string' || typeof issue.code !== 'string'
      || issue.path.length > 192 || !/^\$(?:\.[A-Za-z][A-Za-z0-9_]{0,31}|\[\d{1,8}\])*$/.test(issue.path)
      || !/^[A-Z][A-Z0-9_]{0,63}$/.test(issue.code)) return []
    return [`${issue.path}: ${issue.code}`]
  })
  return 'State schema validation failed' + (issues.length === 0 ? '' : ` (${issues.join('; ')})`)
}

// Only already-validated private state reaches this copier. Validation remains at every commit boundary.
const copy = <T>(value: T): T => structuredClone(value)
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

export const atomicStateFile = async (directory: string, name: string, content: string): Promise<void> => {
  if (!/^[a-z][a-z0-9.-]*$/i.test(name)) throw new StateStoreError('STATE_INVALID', 'Unsafe state filename')
  const temporary = join(directory, '.' + name + '.' + randomUUID() + '.tmp')
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(content, 'utf8'); await handle.sync() } catch (error) { await unlink(temporary).catch(() => undefined); throw error } finally { await handle.close() }
  try { await rename(temporary, join(directory, name)); await syncDirectory(directory) } catch (error) { await unlink(temporary).catch(() => undefined); throw error }
}

/** Conservative local stopped-owner handshake; remote/NFS owners and reused live PIDs are never stolen. */
export const reconcileStoppedStateOwner = async (directory: string): Promise<boolean> => {
  const path = join(directory, 'owner.json')
  let raw: string
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2048) return false
    raw = await readFile(path, 'utf8')
  } catch (error) { if (missing(error)) return true; throw error }
  let owner: { schemaVersion?: number; pid?: number; host?: string }
  try { owner = JSON.parse(raw) as typeof owner } catch { return false }
  if (owner.schemaVersion !== 1 || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return false
  try { process.kill(owner.pid as number, 0); return false } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') return false }
  if (await readFile(path, 'utf8') !== raw) return false
  await unlink(path)
  await syncDirectory(directory)
  return true
}

interface Snapshot<T> { schemaVersion: 1; sequence: number; checksum: string; state: T; layout?: unknown; layoutFingerprint?: unknown }
/** v1 行携带完整状态对象；v2 行携带 `state`（编码字符串）或 `changes`（增量分片编码）；两代都以 entryChecksum 自校验。 */
interface JournalEntry { schemaVersion?: number; sequence: number; type: string; previousChecksum: string; checksum: string; state?: unknown; changes?: unknown; layout?: unknown; layoutFingerprint?: unknown; entryChecksum: string }
const snapshotValid = (value: unknown): value is Snapshot<unknown> => {
  if (value === null || typeof value !== 'object') return false
  const record = value as Snapshot<unknown>
  return record.schemaVersion === 1 && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.checksum === 'string' && record.checksum === checksum(record.state)
}
/** 行/快照声明的布局版本：数字版本号才是当前格式；2.6.0 写的是布局哈希，一律视为 legacy。 */
const readStoredLayout = (raw: unknown): number | undefined =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined
/** 旧布局（行里没有数字版本号）在内存中的占位版本；只用于与 `currentLayout` 比较。 */
const LEGACY_LAYOUT = 0

/** 段布局指纹：段名 + 类型 + 是否分桶。版本号决定「能否续写」，指纹决定「规格是否真的对得上」。 */
const layoutFingerprintOf = (specs: SegmentSpecs): string => checksumText(canonicalStateJson(
  Object.entries(specs).sort(([left], [right]) => left < right ? -1 : 1).map(([name, spec]) => [name, spec.kind, spec.bucketOf !== undefined])
))
/** 2.6.0 的布局指纹算法（只含段名与类型）；旧行把它直接写在 `layout` 字段里。 */
const legacyLayoutHashOf = (specs: SegmentSpecs): string => checksumText(canonicalStateJson(
  Object.entries(specs).sort(([left], [right]) => left < right ? -1 : 1).map(([name, spec]) => [name, spec.kind])
))
const journalShape = (value: unknown): value is JournalEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as JournalEntry
  return Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.type === 'string'
    && typeof record.previousChecksum === 'string' && typeof record.checksum === 'string' && typeof record.entryChecksum === 'string'
    && (record.schemaVersion === undefined || record.schemaVersion === 1 || record.schemaVersion === 2)
}

/** Complete committed states form the journal. Auditing/redacted ledgers are never recovery inputs. */
export const createDurableStateStore = async <T>(options: DurableStateOptions<T>): Promise<DurableStateStore<T>> => {
  const maxStateBytes = options.maxStateBytes ?? 4 * 1024 * 1024
  const maxJournalBytes = options.maxJournalBytes ?? 64 * 1024 * 1024
  // 增量日志下 journal 增长缓慢：较大周期只会摊薄整份快照成本，不改变恢复正确性。
  const snapshotEvery = options.snapshotEvery ?? 64
  if (![maxStateBytes, maxJournalBytes, snapshotEvery].every((n) => Number.isSafeInteger(n) && n > 0)) throw new StateStoreError('STATE_INVALID', 'Invalid state resource limits')
  const validateFull = (value: unknown): { value: T; encoded: string; bytes: number } => {
    const encoded = canonicalStateJson(value)
    const bytes = Buffer.byteLength(encoded, 'utf8')
    if (bytes > maxStateBytes) throw new StateStoreError('STATE_TOO_LARGE', 'State exceeds byte limit')
    if (options.validate !== undefined) {
      const result = options.validate(value)
      if (result !== true && (typeof result !== 'object' || result === null || result.ok !== true)) throw new StateStoreError('STATE_INVALID', validationFailureMessage(result))
    }
    return { value: JSON.parse(encoded) as T, encoded, bytes }
  }
  const assertValidation = (result: StateValidationResult): void => {
    if (result !== true && (typeof result !== 'object' || result === null || result.ok !== true)) throw new StateStoreError('STATE_INVALID', validationFailureMessage(result))
  }
  const initial = validateFull(options.initialState)
  const segmentSpecs: SegmentSpecs = options.segments ?? {}
  const legacySpecs: SegmentSpecs = options.legacySegments ?? segmentSpecs
  const currentLayout = options.layoutVersion ?? 1
  if (!Number.isSafeInteger(currentLayout) || currentLayout < 1) throw new StateStoreError('STATE_INVALID', 'Invalid state layout version')
  const currentFingerprint = layoutFingerprintOf(segmentSpecs)
  const legacyLayoutHash = legacyLayoutHashOf(legacySpecs)
  const specsForLayout = (layout: number | undefined): SegmentSpecs => layout === currentLayout ? segmentSpecs : options.legacyLayouts?.[layout ?? LEGACY_LAYOUT] ?? legacySpecs
  const fingerprintForLayout = (layout: number): string => layoutFingerprintOf(specsForLayout(layout))
  /** 行声明的布局是否与期望规格一致：新行比对指纹，2.6.0 行比对它自带的布局哈希。 */
  const layoutMatches = (entryLayout: number | undefined, fingerprint: unknown, rawLayout: unknown): boolean => {
    if (entryLayout === currentLayout) return fingerprint === currentFingerprint
    if (options.legacyLayouts !== undefined && options.legacyLayouts[entryLayout ?? LEGACY_LAYOUT] === undefined) return false
    if (fingerprint !== undefined) return fingerprint === layoutFingerprintOf(specsForLayout(entryLayout))
    return rawLayout === legacyLayoutHash
  }
  // 用旧布局打开的目录在下一次写入时补一条当前布局的全量行；之后的写入才是增量行。
  let needsLayoutCommit = false
  /** chunked 当前实际使用的布局；迁移前是 LEGACY_LAYOUT，迁移行之后是 currentLayout。 */
  let chunkedLayout = currentLayout
  let chunked = ChunkedState.fromState(initial.value, segmentSpecs, { verified: true })
  let state = deepFreeze(chunked.materialize()) as T
  let stateBytes = chunked.getStateBytes()
  let stateChecksum = chunked.rootChecksum()
  let sequence = 0
  let journalBytes = 0
  let closed = false
  let failed = false
  let directory = resolve(options.directory)
  let ownerPath: string | undefined
  let ownerIdentity: { dev: bigint; ino: bigint } | undefined
  const clearOwnOwner = async (): Promise<void> => {
    if (ownerPath === undefined || ownerIdentity === undefined) return
    try {
      const metadata = await lstat(ownerPath, { bigint: true })
      if (!metadata.isFile() || metadata.dev !== ownerIdentity.dev || metadata.ino !== ownerIdentity.ino) return
      await unlink(ownerPath)
      await syncDirectory(directory)
    } catch (error) { if (!missing(error)) throw error }
  }
  const mutex = intMutex()
  const snapshotDirectory = join(directory, 'snapshot')
  const snapshotSegmentFile = (name: string, fingerprint: string): string => `${name}.${fingerprint.slice(0, 16)}.json`
  const pathWithin = (parent: string, name: string): string => {
    if (!/^[A-Za-z][A-Za-z0-9._-]*\.json$/.test(name)) throw new StateStoreError('STATE_INVALID', 'Unsafe snapshot file name')
    return join(parent, name)
  }
  const existingFile = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false)
  /** 旧格式：单个 snapshot.json 承载整份状态。只读兼容，不再写入。 */
  const readWholeSnapshot = async (): Promise<Snapshot<T> | undefined> => {
    const snapshotPath = join(directory, 'snapshot.json')
    let raw: string
    try {
      const metadata = await lstat(snapshotPath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxStateBytes + 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot file is invalid')
      raw = await readFile(snapshotPath, 'utf8')
    } catch (error) { if (missing(error)) return undefined; throw error }
    if (Buffer.byteLength(raw) > maxStateBytes + 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot size is invalid')
    const parsed: unknown = JSON.parse(raw)
    if (!snapshotValid(parsed)) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot checksum/schema mismatch')
    return parsed as Snapshot<T>
  }
  /**
   * 按段快照：段文件按内容指纹命名并复用，因此一次快照只写发生变化的分片段，
   * 未变段直接沿用上一次的文件；`meta.json` 最后原子替换，读取方只会看到完整的一代。
   */
  const readSegmentedSnapshot = async (): Promise<{ sequence: number; layout?: unknown; layoutFingerprint?: unknown; checksum: string; state: unknown } | undefined> => {
    const metaPath = join(snapshotDirectory, 'meta.json')
    let raw: string
    try {
      const metadata = await lstat(metaPath)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot metadata is invalid')
      raw = await readFile(metaPath, 'utf8')
    } catch (error) { if (missing(error)) return undefined; throw error }
    let meta: { schemaVersion?: unknown; sequence?: unknown; layout?: unknown; layoutFingerprint?: unknown; checksum?: unknown; segments?: unknown }
    try { meta = JSON.parse(raw) as typeof meta } catch { throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot metadata is not valid JSON') }
    if (meta.schemaVersion !== 1 || !Number.isSafeInteger(meta.sequence) || (meta.sequence as number) < 0
      || typeof meta.checksum !== 'string' || meta.segments === null || typeof meta.segments !== 'object' || Array.isArray(meta.segments)) {
      throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot metadata is invalid')
    }
    const metadata = await lstat(snapshotDirectory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot directory is invalid')
    const state: Record<string, unknown> = {}
    for (const [name, entry] of Object.entries(meta.segments as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot entry is invalid')
      const file = (entry as { file?: unknown }).file
      if (typeof file !== 'string') throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot entry is invalid')
      const filePath = pathWithin(snapshotDirectory, file)
      const fileMetadata = await lstat(filePath)
      if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink() || fileMetadata.size > maxStateBytes + 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot segment file is invalid')
      const segmentRaw = await readFile(filePath, 'utf8')
      if (Buffer.byteLength(segmentRaw) > maxStateBytes + 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Segmented snapshot segment size is invalid')
      state[name] = JSON.parse(segmentRaw)
    }
    return { sequence: meta.sequence as number, layout: meta.layout, layoutFingerprint: meta.layoutFingerprint, checksum: meta.checksum as string, state }
  }
  /** 写一代按段快照；只落盘指纹变化的段文件，然后原子替换 meta.json 并清理上一代的孤儿文件。 */
  const writeSnapshot = async (atSequence: number): Promise<void> => {
    await mkdir(snapshotDirectory, { recursive: true, mode: 0o700 })
    const directoryMetadata = await lstat(snapshotDirectory)
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new StateStoreError('STATE_INVALID', 'Snapshot directory must be a private directory, not a symlink')
    const segments: Record<string, { file: string; fingerprint: string }> = {}
    const keep = new Set<string>(['meta.json'])
    for (const name of chunked.segmentNames()) {
      const fingerprint = chunked.segmentFingerprint(name)!
      const encoded = chunked.segmentEncoded(name)!
      const file = snapshotSegmentFile(name, fingerprint)
      keep.add(file)
      segments[name] = { file, fingerprint }
      if (!await existingFile(join(snapshotDirectory, file))) await atomicStateFile(snapshotDirectory, file, encoded)
    }
    await atomicStateFile(snapshotDirectory, 'meta.json', canonicalStateJson({
      schemaVersion: 1, sequence: atSequence, layout: chunkedLayout,
      layoutFingerprint: fingerprintForLayout(chunkedLayout),
      checksum: chunked.rootChecksum(), segments
    }))
    for (const entry of await readdir(snapshotDirectory)) {
      if (!entry.endsWith('.json') || keep.has(entry)) continue
      await unlink(join(snapshotDirectory, entry)).catch(() => undefined)
    }
    // 按段快照是同一份数据的更细表示：保留旧整份快照既浪费空间，也会让恢复路径读到过期状态。
    await unlink(join(directory, 'snapshot.json')).catch(() => undefined)
  }
  const clearJournal = async (): Promise<void> => { await atomicStateFile(directory, 'journal.jsonl', ''); journalBytes = 0 }
  if (options.enabled !== false) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await lstat(directory)).isSymbolicLink()) throw new StateStoreError('STATE_INVALID', 'State directory cannot be a symlink')
    directory = await realpath(directory)
    ownerPath = join(directory, 'owner.json')
    try {
      let owner
      try { owner = await open(ownerPath, 'wx', 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        if (!await reconcileStoppedStateOwner(directory)) throw new StateStoreError('OWNER_ACTIVE', 'State owner exists; explicit stopped-owner reconciliation is required')
        try { owner = await open(ownerPath, 'wx', 0o600) } catch { throw new StateStoreError('OWNER_ACTIVE', 'Another owner won stopped-owner reconciliation') }
      }
      try {
        const identity = await owner.stat({ bigint: true })
        ownerIdentity = { dev: identity.dev, ino: identity.ino }
        await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, host: hostname(), ownerId: randomUUID() })); await owner.sync()
      } finally { await owner.close() }
      await syncDirectory(directory)
      let snapshot: Snapshot<T> | undefined
      try {
        // 优先按段快照；没有才回退旧整份快照。两条路径都会在读取后按声明布局重建分片。
        const segmented = await readSegmentedSnapshot()
        let loadedState: unknown
        let loadedLayout: number | undefined
        let loadedChecksum: string | undefined
        let loadedFingerprint: unknown
        if (segmented !== undefined) {
          loadedState = segmented.state
          loadedLayout = readStoredLayout(segmented.layout)
          loadedChecksum = segmented.checksum
          loadedFingerprint = segmented.layoutFingerprint
          sequence = segmented.sequence
        } else {
          const whole = await readWholeSnapshot()
          if (whole !== undefined) {
            loadedState = whole.state
            loadedLayout = readStoredLayout(whole.layout)
            loadedChecksum = whole.checksum
            loadedFingerprint = whole.layoutFingerprint
            sequence = whole.sequence
          }
        }
        if (loadedState !== undefined) {
          if (loadedLayout !== undefined && loadedLayout > currentLayout) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot was written by a newer layout version')
          }
          if (loadedLayout !== undefined && !layoutMatches(loadedLayout, loadedFingerprint, undefined)) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot was written with a different chunk layout')
          }
          const validated = validateFull(loadedState)
          const useCurrent = loadedLayout === currentLayout
          chunked = ChunkedState.fromState(validated.value, specsForLayout(loadedLayout), { verified: true })
          const rebuiltChecksum = chunked.rootChecksum()
          // 按段快照的校验和是分片根哈希；旧整份快照的是整份编码的 sha256，两者都在此逐字节重建后复核。
          if (loadedChecksum !== undefined && loadedChecksum !== rebuiltChecksum && loadedChecksum !== checksumText(validated.encoded)) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot checksum/schema mismatch')
          }
          chunkedLayout = loadedLayout ?? LEGACY_LAYOUT
          needsLayoutCommit = !useCurrent
          state = deepFreeze(chunked.materialize()) as T
          stateBytes = chunked.getStateBytes()
          stateChecksum = rebuiltChecksum
          snapshot = { schemaVersion: 1, sequence, checksum: loadedChecksum ?? rebuiltChecksum, state: validated.value, layout: loadedLayout }
        }
      } catch (error) { if (!missing(error)) throw error }
      // 旧格式（v1）行的链值不是分片根哈希；单独跟踪，升级后新行一律使用 v2 根哈希链。
      let legacyChecksum = snapshot?.checksum ?? checksumText(initial.encoded)
      let sawUpgradedEntry = false
      let journal = ''
      let journalPresent = false
      try {
        const journalPath = join(directory, 'journal.jsonl')
        const metadata = await lstat(journalPath)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxJournalBytes) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal file is invalid')
        journal = await readFile(journalPath, 'utf8')
        journalPresent = true
      } catch (error) { if (!missing(error)) throw error }
      journalBytes = Buffer.byteLength(journal)
      if (journalBytes > maxJournalBytes || (journal !== '' && !journal.endsWith('\n'))) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal is oversized or has an incomplete committed record')
      for (const line of journal.split('\n').filter(Boolean)) {
        const raw: unknown = JSON.parse(line)
        if (!journalShape(raw)) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch')
        const entry = raw
        const { entryChecksum, ...payload } = entry
        if (entryChecksum !== checksumText(canonicalStateJson(payload))) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch')
        if (entry.sequence <= sequence) {
          // 与快照同序号的行可能来自升级前的 v1 写入（例如压缩时快照已落盘、日志清空未完成的崩溃窗口）：
          // 它的链值是整份状态的校验和，而不是分片根哈希，必须按代际选择比较基准。
          const expectedChecksum = entry.schemaVersion === 2 ? stateChecksum : legacyChecksum
          if (entry.sequence === sequence && entry.checksum !== expectedChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot and journal disagree')
          continue
        }
        if (entry.sequence !== sequence + 1) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch')
        if (entry.schemaVersion === 2) {
          const entryLayout = readStoredLayout(entry.layout)
          // 目录比代码新：拒绝打开，避免用旧布局改写并破坏后续兼容。
          if (entryLayout !== undefined && entryLayout > currentLayout) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal was written by a newer layout version')
          }
          // 版本号只决定能否续写；指纹决定这套规格是否真的对得上目录，防止用错规格静默读出错误状态。
          if (!layoutMatches(entryLayout, entry.layoutFingerprint, entry.layout)) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal was written with a different chunk layout')
          }
          const isCurrentLayout = entryLayout === currentLayout
          // 当前布局的增量行只能出现在迁移行之后；否则说明日志被人为拼接。
          if ((entryLayout ?? LEGACY_LAYOUT) !== chunkedLayout && entry.changes !== undefined) {
            throw new StateStoreError('RECOVERY_REQUIRED', 'Journal continues incremental entries before the layout migration record')
          }
          if (!isCurrentLayout) needsLayoutCommit = true
          if (entry.previousChecksum !== stateChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch')
          let next: ChunkedState
          if (entry.state !== undefined) {
            next = ChunkedState.fromState(entry.state, specsForLayout(entryLayout), { verified: true })
          } else if (entry.changes !== null && typeof entry.changes === 'object' && !Array.isArray(entry.changes)) {
            next = chunked.applyEncoded(entry.changes as Parameters<typeof chunked.applyEncoded>[0])
          } else throw new StateStoreError('RECOVERY_REQUIRED', 'Journal entry carries neither state nor changes')
          if (next.rootChecksum() !== entry.checksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum mismatch')
          if (next.getStateBytes() > maxStateBytes) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal state exceeds byte limit')
          chunked = next
          chunkedLayout = entryLayout ?? LEGACY_LAYOUT
          state = deepFreeze(chunked.materialize()) as T
          stateBytes = chunked.getStateBytes()
          stateChecksum = entry.checksum
          sawUpgradedEntry = true
        } else {
          if (sawUpgradedEntry) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal mixes legacy entries after upgraded entries')
          if (!snapshotValid(entry)) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch')
          if (entry.previousChecksum !== legacyChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch')
          const validated = validateFull(entry.state)
          chunked = ChunkedState.fromState(validated.value, legacySpecs, { verified: true })
          chunkedLayout = LEGACY_LAYOUT
          needsLayoutCommit = true
          state = deepFreeze(chunked.materialize()) as T
          stateBytes = chunked.getStateBytes()
          stateChecksum = chunked.rootChecksum()
          legacyChecksum = entry.checksum
        }
        sequence = entry.sequence
      }
      if (snapshot === undefined && sequence === 0) await writeSnapshot(0)
      // The first journal directory entry must be durable before any committed append is acknowledged.
      if (!journalPresent) await clearJournal()
    } catch (error) {
      await clearOwnOwner().catch(() => undefined)
      if (error instanceof StateStoreError) throw error
      throw new StateStoreError('RECOVERY_REQUIRED', 'Cannot recover trusted state: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const appendJournal = async (fields: Record<string, unknown>): Promise<void> => {
    const payload = canonicalStateJson(fields)
    const line = canonicalStateJson({ ...fields, entryChecksum: checksumText(payload) }) + '\n'
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (lineBytes > maxJournalBytes) throw new StateStoreError('STATE_TOO_LARGE', 'One committed state exceeds the journal capacity')
    try {
      if (journalBytes + lineBytes > maxJournalBytes) {
        await writeSnapshot(sequence)
        await clearJournal()
      }
      const journalPath = join(directory, 'journal.jsonl')
      try { if ((await lstat(journalPath)).isSymbolicLink()) throw new StateStoreError('STATE_INVALID', 'Journal cannot be a symlink') } catch (error) { if (!missing(error)) throw error }
      const handle = await open(journalPath, 'a', 0o600)
      try { await handle.writeFile(line, 'utf8'); await handle.sync() } finally { await handle.close() }
      journalBytes += lineBytes
    } catch (error) { failed = true; throw new StateStoreError('RECOVERY_REQUIRED', 'Durable commit failed: ' + (error instanceof Error ? error.message : String(error))) }
  }
  const compactIfDue = async (): Promise<void> => {
    if (!store.durable || sequence % snapshotEvery !== 0) return
    try {
      await writeSnapshot(sequence)
      await clearJournal()
    } catch { failed = true }
  }
  /**
   * 旧布局目录的首次写入：用当前布局重建全部段并补一条全量行。
   * 增量行的分片键依赖布局，因此必须先把当前状态以新布局落盘，后续增量才有意义。
   */
  const migrateLayout = async (): Promise<void> => {
    const nextChunked = ChunkedState.fromState(state, segmentSpecs, { verified: true })
    const nextChecksum = nextChunked.rootChecksum()
    if (options.enabled !== false) {
      await appendJournal({ schemaVersion: 2, layout: currentLayout, layoutFingerprint: currentFingerprint, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type: 'state/layout-migrated', state })
    }
    chunked = nextChunked
    chunkedLayout = currentLayout
    stateBytes = nextChunked.getStateBytes()
    stateChecksum = nextChecksum
    sequence++
    needsLayoutCommit = false
  }
  const buildChanges = (patch: StatePatch, preview: { encoded: Record<string, Record<string, { encoded: string }>>; next: ChunkedState }): Record<string, unknown> => {
    const { encoded, next } = preview
    const changes: Record<string, unknown> = {}
    const segments = new Set([...Object.keys(patch.set ?? {}), ...Object.keys(patch.remove ?? {}), ...Object.keys(patch.order ?? {}), ...Object.keys(patch.whole ?? {})])
    for (const segment of segments) {
      const out: Record<string, unknown> = {}
      // 列表段的键序必须显式入日志：canonical JSON 按键名排序对象字段，回放不能依赖 set 的键序。
      const order = next.order(segment)
      if (order !== undefined) out.order = [...order]
      const remove = patch.remove?.[segment]
      if (remove !== undefined) out.remove = [...remove]
      if (patch.whole !== undefined && segment in patch.whole) out.whole = encoded[segment]?.['']?.encoded ?? (() => { throw new StateStoreError('STATE_INVALID', 'Missing encoded whole chunk') })()
      const set = patch.set?.[segment]
      if (set !== undefined) out.set = Object.fromEntries(Object.keys(set).map((key) => {
        const chunk = encoded[segment]?.[key]
        if (chunk === undefined) throw new StateStoreError('STATE_INVALID', 'Missing encoded chunk')
        return [key, chunk.encoded]
      }))
      changes[segment] = out
    }
    return changes
  }
  const store: DurableStateStore<T> = {
    directory, durable: options.enabled !== false, maxStateBytes,
    getStateBytes: () => stateBytes,
    getRootChecksum: () => stateChecksum,
    read: () => { if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed'); return copy(state) },
    readPath: <R = unknown>(path: readonly (string | number)[]): R | undefined => {
      if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed')
      if (path.length > 64) throw new StateStoreError('STATE_INVALID', 'State projection path exceeds nesting limit')
      let selected: unknown = state
      for (const key of path) {
        if ((typeof key !== 'string' && (typeof key !== 'number' || !Number.isSafeInteger(key) || key < 0)) || ['__proto__', 'constructor', 'prototype'].includes(String(key))) throw new StateStoreError('STATE_INVALID', 'Unsafe state projection path')
        if (selected === null || typeof selected !== 'object') return undefined
        const descriptor = Object.getOwnPropertyDescriptor(selected, key)
        if (descriptor === undefined) return undefined
        selected = descriptor.value
      }
      return copy(selected) as R | undefined
    },
    readFields: <K extends keyof T>(keys: readonly K[]): Pick<T, K> => {
      if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed')
      const projected: Record<string, unknown> = {}
      if (state === null || typeof state !== 'object') return projected as Pick<T, K>
      for (const key of keys) {
        if ((typeof key !== 'string' && typeof key !== 'number') || ['__proto__', 'constructor', 'prototype'].includes(String(key))) throw new StateStoreError('STATE_INVALID', 'Unsafe state projection field')
        const descriptor = Object.getOwnPropertyDescriptor(state, key)
        if (descriptor !== undefined) projected[String(key)] = descriptor.value
      }
      return copy(projected) as Pick<T, K>
    },
    getSequence: () => sequence,
    commit: (type, mutate) => mutex.run(async () => {
      if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed')
      if (failed) throw new StateStoreError('RECOVERY_REQUIRED', 'A previous durable write failed; reconcile before further commits')
      if (typeof type !== 'string' || type.length < 1 || type.length > 120) throw new StateStoreError('STATE_INVALID', 'Invalid event type')
      if (needsLayoutCommit) await migrateLayout()
      const draft = copy(state)
      const returned = await mutate(draft)
      const next = validateFull(returned === undefined ? draft : returned)
      const nextChunked = ChunkedState.fromState(next.value, segmentSpecs, { verified: true })
      const nextChecksum = nextChunked.rootChecksum()
      if (store.durable) await appendJournal({ schemaVersion: 2, layout: currentLayout, layoutFingerprint: currentFingerprint, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, state: next.value })
      chunked = nextChunked
      state = deepFreeze(chunked.materialize()) as T
      stateBytes = chunked.getStateBytes()
      stateChecksum = nextChecksum
      sequence++
      await compactIfDue()
      return copy(state)
    }),
    update: (type, write) => mutex.run(async () => {
      if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed')
      if (failed) throw new StateStoreError('RECOVERY_REQUIRED', 'A previous durable write failed; reconcile before further commits')
      if (typeof type !== 'string' || type.length < 1 || type.length > 120) throw new StateStoreError('STATE_INVALID', 'Invalid event type')
      if (needsLayoutCommit) await migrateLayout()
      // build 形式在互斥区内求值：调用方读到的就是本次提交的基线，读-改-写不再有竞态窗口。
      const normalized = normalizeStatePatch('build' in write ? await write.build(state) : write.patch)
      const preview = chunked.preview(normalized)
      // 与已提交分片逐字节一致的补丁不写日志、不消耗序列号：重复提交同一内容保持幂等。
      if (!preview.changed) return { sequence, changed: false }
      const nextBytes = preview.next.getStateBytes()
      if (nextBytes > maxStateBytes) throw new StateStoreError('STATE_TOO_LARGE', 'State exceeds byte limit')
      // 校验与提交使用同一个冻结视图：校验器看到的字节与被提交的状态完全一致。
      const view = deepFreeze(preview.next.materialize()) as T
      const changed = [...new Map([...preview.removed, ...preview.touched.map(({ segment, key }) => ({ segment, key }))]
        .map((entry) => [entry.segment + '\u0000' + entry.key, entry])).values()]
      if (options.validateIncremental !== undefined) assertValidation(options.validateIncremental(view, changed))
      else if (options.validate !== undefined) assertValidation(options.validate(view))
      const nextChecksum = preview.next.rootChecksum()
      if (store.durable) await appendJournal({ schemaVersion: 2, layout: currentLayout, layoutFingerprint: currentFingerprint, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, changes: buildChanges(normalized, preview) })
      chunked = preview.next
      state = view
      stateBytes = nextBytes
      stateChecksum = nextChecksum
      sequence++
      await compactIfDue()
      return { sequence, changed: true }
    }),
    dispose: () => mutex.run(async () => {
      if (closed) return
      closed = true
      await clearOwnOwner()
    })
  }
  if (options.recover !== undefined && sequence > 0) {
    try {
      const recovered = validateFull(options.recover(copy(state)))
      if (recovered.encoded !== chunked.encode()) await store.commit('state/recovered', () => copy(recovered.value))
    } catch (error) {
      closed = true
      await clearOwnOwner().catch(() => undefined)
      throw error
    }
  }
  return store
}
