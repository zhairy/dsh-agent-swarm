import { randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises'
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
const stateEnvelope = (fields: Record<string, unknown>, encodedState: string): string => '{' + [...Object.keys(fields), 'state'].sort().map((key) => JSON.stringify(key) + ':' + (key === 'state' ? encodedState : canonicalStateJson(fields[key]))).join(',') + '}'
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

interface Snapshot<T> { schemaVersion: 1; sequence: number; checksum: string; state: T }
/** v1 行携带完整状态对象；v2 行携带 `state`（编码字符串）或 `changes`（增量分片编码）；两代都以 entryChecksum 自校验。 */
interface JournalEntry { schemaVersion?: number; sequence: number; type: string; previousChecksum: string; checksum: string; state?: unknown; changes?: unknown; layout?: unknown; entryChecksum: string }
const snapshotValid = (value: unknown): value is Snapshot<unknown> => {
  if (value === null || typeof value !== 'object') return false
  const record = value as Snapshot<unknown>
  return record.schemaVersion === 1 && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.checksum === 'string' && record.checksum === checksum(record.state)
}
const journalShape = (value: unknown): value is JournalEntry => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as JournalEntry
  return Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.type === 'string'
    && typeof record.previousChecksum === 'string' && typeof record.checksum === 'string' && typeof record.entryChecksum === 'string'
    && (record.schemaVersion === undefined || record.schemaVersion === 1 || record.schemaVersion === 2)
}

/** Running work is interrupted on recovery; live host sessions are never assumed resumable. */
export const markInterruptedOnRecovery = <T>(state: T): T => {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit)
    if (item === null || typeof item !== 'object') return item
    const record = Object.fromEntries(Object.entries(item).map(([key, value]) => [key, visit(value)]))
    if (record.status === 'running' || record.status === 'cancelling') { record.status = 'interrupted'; record.mutationUnknown = true }
    if (record.state === 'active' && typeof record.agentId === 'string') record.state = 'suspended'
    if (typeof record.busy === 'boolean') record.busy = false
    return record
  }
  return visit(state) as T
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
  // 分片根哈希依赖段布局：把布局指纹写进每一行，避免用不同布局打开同一目录时报出难以定位的校验和不符。
  const layoutId = checksumText(canonicalStateJson(Object.entries(segmentSpecs).sort(([left], [right]) => left < right ? -1 : 1).map(([name, spec]) => [name, spec.kind])))
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
        const snapshotPath = join(directory, 'snapshot.json')
        const metadata = await lstat(snapshotPath)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxStateBytes + 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot file is invalid')
        const raw = await readFile(snapshotPath, 'utf8')
        if (Buffer.byteLength(raw) > maxStateBytes + 1024) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot size is invalid')
        const parsed: unknown = JSON.parse(raw)
        if (!snapshotValid(parsed)) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot checksum/schema mismatch')
        snapshot = parsed as Snapshot<T>
        const validated = validateFull(snapshot.state)
        chunked = ChunkedState.fromState(validated.value, segmentSpecs, { verified: true })
        state = deepFreeze(chunked.materialize()) as T
        stateBytes = chunked.getStateBytes()
        stateChecksum = chunked.rootChecksum()
        sequence = snapshot.sequence
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
          if (entry.layout !== layoutId) throw new StateStoreError('RECOVERY_REQUIRED', 'State journal was written with a different chunk layout')
          if (entry.previousChecksum !== stateChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch')
          let next: ChunkedState
          if (entry.state !== undefined) {
            next = ChunkedState.fromState(entry.state, segmentSpecs, { verified: true })
          } else if (entry.changes !== null && typeof entry.changes === 'object' && !Array.isArray(entry.changes)) {
            next = chunked.applyEncoded(entry.changes as Parameters<typeof chunked.applyEncoded>[0])
          } else throw new StateStoreError('RECOVERY_REQUIRED', 'Journal entry carries neither state nor changes')
          if (next.rootChecksum() !== entry.checksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum mismatch')
          if (next.getStateBytes() > maxStateBytes) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal state exceeds byte limit')
          chunked = next
          state = deepFreeze(chunked.materialize()) as T
          stateBytes = chunked.getStateBytes()
          stateChecksum = entry.checksum
          sawUpgradedEntry = true
        } else {
          if (sawUpgradedEntry) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal mixes legacy entries after upgraded entries')
          if (!snapshotValid(entry)) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch')
          if (entry.previousChecksum !== legacyChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch')
          const validated = validateFull(entry.state)
          chunked = ChunkedState.fromState(validated.value, segmentSpecs, { verified: true })
          state = deepFreeze(chunked.materialize()) as T
          stateBytes = chunked.getStateBytes()
          stateChecksum = chunked.rootChecksum()
          legacyChecksum = entry.checksum
        }
        sequence = entry.sequence
      }
      const writeSnapshot = async (atSequence: number): Promise<void> => {
        const encoded = chunked.encode()
        await atomicStateFile(directory, 'snapshot.json', stateEnvelope({ schemaVersion: 1, sequence: atSequence, checksum: checksumText(encoded) }, encoded))
      }
      const clearJournal = async (): Promise<void> => { await atomicStateFile(directory, 'journal.jsonl', ''); journalBytes = 0 }
      if (snapshot === undefined && sequence === 0) await writeSnapshot(0)
      // The first journal directory entry must be durable before any committed append is acknowledged.
      if (!journalPresent) await clearJournal()
    } catch (error) {
      await clearOwnOwner().catch(() => undefined)
      if (error instanceof StateStoreError) throw error
      throw new StateStoreError('RECOVERY_REQUIRED', 'Cannot recover trusted state: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const writeSnapshot = async (atSequence: number): Promise<void> => {
    const encoded = chunked.encode()
    await atomicStateFile(directory, 'snapshot.json', stateEnvelope({ schemaVersion: 1, sequence: atSequence, checksum: checksumText(encoded) }, encoded))
  }
  const clearJournal = async (): Promise<void> => { await atomicStateFile(directory, 'journal.jsonl', ''); journalBytes = 0 }
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
      const draft = copy(state)
      const returned = await mutate(draft)
      const next = validateFull(returned === undefined ? draft : returned)
      const nextChunked = ChunkedState.fromState(next.value, segmentSpecs, { verified: true })
      const nextChecksum = nextChunked.rootChecksum()
      if (store.durable) await appendJournal({ schemaVersion: 2, layout: layoutId, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, state: next.value })
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
      if (store.durable) await appendJournal({ schemaVersion: 2, layout: layoutId, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, changes: buildChanges(normalized, preview) })
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
