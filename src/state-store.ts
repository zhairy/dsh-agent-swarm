import { createHash, randomUUID } from 'node:crypto'
import { open, mkdir, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { hostname } from 'node:os'
import { intMutex } from './util/mutex.js'

export class StateStoreError extends Error {
  constructor (readonly code: 'RECOVERY_REQUIRED' | 'STATE_INVALID' | 'STATE_TOO_LARGE' | 'STORE_CLOSED' | 'OWNER_ACTIVE', message: string) { super(message); this.name = 'StateStoreError' }
}
export interface DurableStateStore<T> {
  readonly directory: string
  readonly durable: boolean
  read: () => T
  readPath?: <R = unknown>(path: readonly (string | number)[]) => R | undefined
  readFields?: <K extends keyof T>(keys: readonly K[]) => Pick<T, K>
  getSequence: () => number
  commit: (type: string, mutate: (draft: T) => T | void | Promise<T | void>) => Promise<T>
  dispose: () => Promise<void>
}
export interface StateValidationIssue { path: string; code: string }
export interface StateValidationReport { ok: boolean; issues?: readonly StateValidationIssue[] }
export type StateValidationResult = boolean | StateValidationReport
export interface DurableStateOptions<T> {
  directory: string
  initialState: T
  validate?: (value: unknown) => StateValidationResult
  recover?: (state: T) => T
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

/** Reject non-JSON, accessors and credential fields before persistence; never silently redact recovery state. */
export const canonicalStateJson = (value: unknown): string => {
  const stack = new Set<object>()
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64) throw new StateStoreError('STATE_INVALID', 'State nesting exceeds limit')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(Object.is(item, -0) ? 0 : item)
    if (typeof item !== 'object' || item === null || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new StateStoreError('STATE_INVALID', 'State must contain finite plain JSON values')
    if (stack.has(item)) throw new StateStoreError('STATE_INVALID', 'State is cyclic')
    stack.add(item)
    const entries: string[] = []
    const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(item).sort()
    for (const key of keys) {
      if (/^(?:api[_-]?key|password|authorization|credentials|private[_-]?key)$/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new StateStoreError('STATE_INVALID', 'Credential or unsafe state field is forbidden')
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (descriptor === undefined || !('value' in descriptor)) throw new StateStoreError('STATE_INVALID', 'State accessors and sparse arrays are forbidden')
      entries.push((Array.isArray(item) ? '' : JSON.stringify(key) + ':') + encode(descriptor.value, depth + 1))
    }
    stack.delete(item)
    return Array.isArray(item) ? '[' + entries.join(',') + ']' : '{' + entries.join(',') + '}'
  }
  return encode(value, 0)
}
const checksumText = (text: string): string => createHash('sha256').update(text).digest('hex')
const checksum = (value: unknown): string => checksumText(canonicalStateJson(value))
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
interface JournalEntry<T> extends Snapshot<T> { type: string; previousChecksum: string; entryChecksum: string }
const snapshotValid = (value: unknown): value is Snapshot<unknown> => {
  if (value === null || typeof value !== 'object') return false
  const record = value as Snapshot<unknown>
  return record.schemaVersion === 1 && Number.isSafeInteger(record.sequence) && record.sequence >= 0 && typeof record.checksum === 'string' && record.checksum === checksum(record.state)
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
  const snapshotEvery = options.snapshotEvery ?? 16
  if (![maxStateBytes, maxJournalBytes, snapshotEvery].every((n) => Number.isSafeInteger(n) && n > 0)) throw new StateStoreError('STATE_INVALID', 'Invalid state resource limits')
  const validate = (value: unknown): { value: T; encoded: string } => {
    const encoded = canonicalStateJson(value)
    if (Buffer.byteLength(encoded, 'utf8') > maxStateBytes) throw new StateStoreError('STATE_TOO_LARGE', 'State exceeds byte limit')
    if (options.validate !== undefined) {
      const result = options.validate(value)
      if (result !== true && (typeof result !== 'object' || result === null || result.ok !== true)) throw new StateStoreError('STATE_INVALID', validationFailureMessage(result))
    }
    return { value: JSON.parse(encoded) as T, encoded }
  }
  const initial = validate(options.initialState)
  let state = initial.value
  let stateEncoded = initial.encoded
  let sequence = 0
  let stateChecksum = checksumText(stateEncoded)
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
        const validated = validate(snapshot.state)
        state = validated.value; stateEncoded = validated.encoded; sequence = snapshot.sequence; stateChecksum = snapshot.checksum
      } catch (error) { if (!missing(error)) throw error }
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
        const entry: JournalEntry<T> = JSON.parse(line)
        const { entryChecksum, ...payload } = entry
        if (!snapshotValid(entry) || entryChecksum !== checksum(payload) || typeof entry.type !== 'string' || typeof entry.previousChecksum !== 'string') throw new StateStoreError('RECOVERY_REQUIRED', 'Journal checksum/schema mismatch')
        if (entry.sequence <= sequence) {
          if (entry.sequence === sequence && entry.checksum !== stateChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Snapshot and journal disagree')
          continue
        }
        if (entry.sequence !== sequence + 1 || entry.previousChecksum !== stateChecksum) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal sequence or ancestry mismatch')
        const validated = validate(entry.state)
        state = validated.value; stateEncoded = validated.encoded; sequence = entry.sequence; stateChecksum = entry.checksum
      }
      if (snapshot === undefined) {
        if (sequence !== 0) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal has no initial trusted snapshot')
        await atomicStateFile(directory, 'snapshot.json', stateEnvelope({ schemaVersion: 1, sequence, checksum: stateChecksum }, stateEncoded))
      }
      // The first journal directory entry must be durable before any committed append is acknowledged.
      if (!journalPresent) await atomicStateFile(directory, 'journal.jsonl', '')
    } catch (error) {
      await clearOwnOwner().catch(() => undefined)
      if (error instanceof StateStoreError) throw error
      throw new StateStoreError('RECOVERY_REQUIRED', 'Cannot recover trusted state: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const store: DurableStateStore<T> = {
    directory, durable: options.enabled !== false,
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
      const next = validate(returned === undefined ? draft : returned)
      const nextChecksum = checksumText(next.encoded)
      if (store.durable) {
        const fields = { schemaVersion: 1 as const, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type }
        const payload = stateEnvelope(fields, next.encoded)
        const line = stateEnvelope({ ...fields, entryChecksum: checksumText(payload) }, next.encoded) + '\n'
        const lineBytes = Buffer.byteLength(line, 'utf8')
        if (lineBytes > maxJournalBytes) throw new StateStoreError('STATE_TOO_LARGE', 'One committed state exceeds the journal capacity')
        try {
          if (journalBytes + lineBytes > maxJournalBytes) {
            await atomicStateFile(directory, 'snapshot.json', stateEnvelope({ schemaVersion: 1, sequence, checksum: stateChecksum }, stateEncoded))
            await atomicStateFile(directory, 'journal.jsonl', '')
            journalBytes = 0
          }
          const journalPath = join(directory, 'journal.jsonl')
          try { if ((await lstat(journalPath)).isSymbolicLink()) throw new StateStoreError('STATE_INVALID', 'Journal cannot be a symlink') } catch (error) { if (!missing(error)) throw error }
          const handle = await open(journalPath, 'a', 0o600)
          try { await handle.writeFile(line, 'utf8'); await handle.sync() } finally { await handle.close() }
          journalBytes += lineBytes
        } catch (error) { failed = true; throw new StateStoreError('RECOVERY_REQUIRED', 'Durable commit failed: ' + (error instanceof Error ? error.message : String(error))) }
      }
      state = next.value; stateEncoded = next.encoded; sequence++; stateChecksum = nextChecksum
      if (store.durable && sequence % snapshotEvery === 0) {
        // Journal is already durable. Compaction failure must not pretend the committed transaction was rolled back.
        try {
          await atomicStateFile(directory, 'snapshot.json', stateEnvelope({ schemaVersion: 1, sequence, checksum: stateChecksum }, stateEncoded))
          await atomicStateFile(directory, 'journal.jsonl', '')
          journalBytes = 0
        } catch { failed = true }
      }
      return copy(state)
    }),
    dispose: () => mutex.run(async () => {
      if (closed) return
      closed = true
      await clearOwnOwner()
    })
  }
  if (options.recover !== undefined && sequence > 0) {
    try {
      const recovered = validate(options.recover(copy(state)))
      if (checksumText(recovered.encoded) !== stateChecksum) await store.commit('state/recovered', () => recovered.value)
    } catch (error) {
      closed = true
      await clearOwnOwner().catch(() => undefined)
      throw error
    }
  }
  return store
}
