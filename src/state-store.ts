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
  getSequence: () => number
  commit: (type: string, mutate: (draft: T) => T | void | Promise<T | void>) => Promise<T>
  dispose: () => Promise<void>
}
export interface DurableStateOptions<T> {
  directory: string
  initialState: T
  validate?: (value: unknown) => boolean
  recover?: (state: T) => T
  enabled?: boolean
  maxStateBytes?: number
  maxJournalBytes?: number
  snapshotEvery?: number
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
const checksum = (value: unknown): string => createHash('sha256').update(canonicalStateJson(value)).digest('hex')
const copy = <T>(value: T): T => JSON.parse(canonicalStateJson(value)) as T
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
  const validate = (value: unknown): T => {
    const encoded = canonicalStateJson(value)
    if (Buffer.byteLength(encoded, 'utf8') > maxStateBytes) throw new StateStoreError('STATE_TOO_LARGE', 'State exceeds byte limit')
    if (options.validate !== undefined && !options.validate(value)) throw new StateStoreError('STATE_INVALID', 'State schema validation failed')
    return JSON.parse(encoded) as T
  }
  let state = validate(options.initialState)
  let sequence = 0
  let stateChecksum = checksum(state)
  let journalBytes = 0
  let closed = false
  let failed = false
  let directory = resolve(options.directory)
  let ownerPath: string | undefined
  const mutex = intMutex()
  if (options.enabled !== false) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if ((await lstat(directory)).isSymbolicLink()) throw new StateStoreError('STATE_INVALID', 'State directory cannot be a symlink')
    directory = await realpath(directory)
    ownerPath = join(directory, 'owner.json')
    let owner
    try { owner = await open(ownerPath, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
      if (!await reconcileStoppedStateOwner(directory)) throw new StateStoreError('OWNER_ACTIVE', 'State owner exists; explicit stopped-owner reconciliation is required')
      try { owner = await open(ownerPath, 'wx', 0o600) } catch { throw new StateStoreError('OWNER_ACTIVE', 'Another owner won stopped-owner reconciliation') }
    }
    try { await owner.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, host: hostname(), ownerId: randomUUID() })); await owner.sync() } finally { await owner.close() }
    await syncDirectory(directory)
    try {
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
        state = validate(snapshot.state); sequence = snapshot.sequence; stateChecksum = snapshot.checksum
      } catch (error) { if (!missing(error)) throw error }
      let journal = ''
      try {
        const journalPath = join(directory, 'journal.jsonl')
        const metadata = await lstat(journalPath)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxJournalBytes) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal file is invalid')
        journal = await readFile(journalPath, 'utf8')
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
        state = validate(entry.state); sequence = entry.sequence; stateChecksum = entry.checksum
      }
      if (snapshot === undefined) {
        if (sequence !== 0) throw new StateStoreError('RECOVERY_REQUIRED', 'Journal has no initial trusted snapshot')
        await atomicStateFile(directory, 'snapshot.json', canonicalStateJson({ schemaVersion: 1, sequence, checksum: stateChecksum, state }))
      }
    } catch (error) {
      await unlink(ownerPath).catch(() => undefined)
      if (error instanceof StateStoreError) throw error
      throw new StateStoreError('RECOVERY_REQUIRED', 'Cannot recover trusted state: ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  const store: DurableStateStore<T> = {
    directory, durable: options.enabled !== false,
    read: () => { if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed'); return copy(state) },
    getSequence: () => sequence,
    commit: (type, mutate) => mutex.run(async () => {
      if (closed) throw new StateStoreError('STORE_CLOSED', 'State store is closed')
      if (failed) throw new StateStoreError('RECOVERY_REQUIRED', 'A previous durable write failed; reconcile before further commits')
      if (typeof type !== 'string' || type.length < 1 || type.length > 120) throw new StateStoreError('STATE_INVALID', 'Invalid event type')
      const draft = copy(state)
      const returned = await mutate(draft)
      const next = validate(returned === undefined ? draft : returned)
      const nextChecksum = checksum(next)
      const payload = { schemaVersion: 1 as const, sequence: sequence + 1, checksum: nextChecksum, previousChecksum: stateChecksum, type, state: next }
      const line = canonicalStateJson({ ...payload, entryChecksum: checksum(payload) }) + '\n'
      if (store.durable && Buffer.byteLength(line, 'utf8') > maxJournalBytes) throw new StateStoreError('STATE_TOO_LARGE', 'One committed state exceeds the journal capacity')
      if (store.durable) {
        try {
          if (journalBytes + Buffer.byteLength(line) > maxJournalBytes) {
            await atomicStateFile(directory, 'snapshot.json', canonicalStateJson({ schemaVersion: 1, sequence, checksum: stateChecksum, state }))
            await atomicStateFile(directory, 'journal.jsonl', '')
            journalBytes = 0
          }
          const journalPath = join(directory, 'journal.jsonl')
          try { if ((await lstat(journalPath)).isSymbolicLink()) throw new StateStoreError('STATE_INVALID', 'Journal cannot be a symlink') } catch (error) { if (!missing(error)) throw error }
          const handle = await open(journalPath, 'a', 0o600)
          try { await handle.writeFile(line, 'utf8'); await handle.sync() } finally { await handle.close() }
          journalBytes += Buffer.byteLength(line)
        } catch (error) { failed = true; throw new StateStoreError('RECOVERY_REQUIRED', 'Durable commit failed: ' + (error instanceof Error ? error.message : String(error))) }
      }
      state = next; sequence++; stateChecksum = nextChecksum
      if (store.durable && sequence % snapshotEvery === 0) {
        // Journal is already durable. Compaction failure must not pretend the committed transaction was rolled back.
        try {
          await atomicStateFile(directory, 'snapshot.json', canonicalStateJson({ schemaVersion: 1, sequence, checksum: stateChecksum, state }))
          await atomicStateFile(directory, 'journal.jsonl', '')
          journalBytes = 0
        } catch { failed = true }
      }
      return copy(state)
    }),
    dispose: () => mutex.run(async () => {
      if (closed) return
      closed = true
      if (ownerPath !== undefined) { await unlink(ownerPath); await syncDirectory(directory) }
    })
  }
  if (options.recover !== undefined && sequence > 0) {
    const recovered = validate(options.recover(copy(state)))
    if (checksum(recovered) !== stateChecksum) await store.commit('state/recovered', () => recovered)
  }
  return store
}
