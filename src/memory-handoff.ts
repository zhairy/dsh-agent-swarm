import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { canonicalStateJson, StateStoreError, type StateValidationResult } from './state-store.js'
import { digest } from './task-model.js'

const MAX_BYTES = 4 * 1024 * 1024
const SOURCE_VERSIONS = ['2.3.0', '2.3.1', '2.3.2'] as const
export type MemoryHandoffSourceVersion = typeof SOURCE_VERSIONS[number]
const sourceVersionValid = (raw: unknown): raw is MemoryHandoffSourceVersion => SOURCE_VERSIONS.some(version => version === raw)
export interface MemoryHandoffEnvelope<T> {
  schemaVersion: 1
  sourceVersion: MemoryHandoffSourceVersion
  rootSessionId: string
  workspaceId: string
  checksum: string
  state: T
}
export interface LoadedMemoryHandoff<T> {
  state: T
  sourceVersion: MemoryHandoffSourceVersion
  /** Call only after the feature session and host recovery initialize successfully. */
  commitConsumption: () => Promise<string>
}
export interface MemoryHandoffInput {
  dshHome: string
  rootSessionId: string
  workspaceId: string
  persistenceEnabled: boolean
  validate: (raw: unknown) => StateValidationResult
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
function fail (code: string): never { throw new StateStoreError('RECOVERY_REQUIRED', `Memory handoff rejected: ${code}`) }
const scopeValid = (input: Pick<MemoryHandoffInput, 'rootSessionId' | 'workspaceId'>) =>
  /^[a-f0-9]{64}$/.test(input.workspaceId) && typeof input.rootSessionId === 'string'
  && input.rootSessionId.length > 0 && input.rootSessionId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(input.rootSessionId)
const checksum = (state: unknown) => createHash('sha256').update(canonicalStateJson(state)).digest('hex')

/** Trusted maintenance code can use the exact envelope format without exposing a new tool/RPC. */
export const createMemoryHandoffEnvelope = <T>(input: Pick<MemoryHandoffInput, 'rootSessionId' | 'workspaceId'> & { state: T; sourceVersion: MemoryHandoffSourceVersion }): MemoryHandoffEnvelope<T> => {
  if (!scopeValid(input)) fail('SCOPE_FORMAT')
  if (!sourceVersionValid(input.sourceVersion)) fail('ENVELOPE_VERSION')
  const envelope: MemoryHandoffEnvelope<T> = { schemaVersion: 1, sourceVersion: input.sourceVersion,
    rootSessionId: input.rootSessionId, workspaceId: input.workspaceId, checksum: checksum(input.state), state: structuredClone(input.state) }
  if (Buffer.byteLength(canonicalStateJson(envelope)) > MAX_BYTES) fail('SIZE_LIMIT')
  return envelope
}

const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
const validFile = (metadata: BigIntStats, uid: bigint) => metadata.isFile() && !metadata.isSymbolicLink()
  && metadata.uid === uid && (metadata.mode & 0o7777n) === 0o600n && metadata.nlink === 1n
  && metadata.size > 0n && metadata.size <= BigInt(MAX_BYTES)
const readTrustedFile = async (path: string, original: BigIntStats, uid: bigint): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat({ bigint: true })
    if (!validFile(before, uid) || !sameFile(original, before)) fail('FILE_CHANGED')
    // One extra byte detects growth without an unbounded readFile allocation.
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length !== Number(before.size) || !sameFile(before, await handle.stat({ bigint: true }))) fail('FILE_CHANGED')
    return bytes.subarray(0, length).toString('utf8')
  } finally { await handle.close() }
}
const rawChecksum = (value: string) => createHash('sha256').update(value).digest('hex')

/** A deliberately narrow, one-time bridge for an explicitly staged supported in-memory source session.
 * No caller-controlled filename, automatic normalization or durable-state replacement is accepted. */
export const loadMemoryHandoff = async <T>(input: MemoryHandoffInput): Promise<LoadedMemoryHandoff<T> | undefined> => {
  if (input.persistenceEnabled) return undefined
  if (!scopeValid(input)) fail('SCOPE_FORMAT')
  const home = resolve(input.dshHome)
  const directories = [home, join(home, 'share'), join(home, 'share', 'dsh-agent-swarm'),
    join(home, 'share', 'dsh-agent-swarm', 'maintenance'),
    join(home, 'share', 'dsh-agent-swarm', 'maintenance', input.workspaceId),
    join(home, 'share', 'dsh-agent-swarm', 'maintenance', input.workspaceId, digest(input.rootSessionId))]
  const directory = directories.at(-1)!, pending = join(directory, 'pending.json')
  let original: BigIntStats
  try { original = await lstat(pending, { bigint: true }) } catch (error) { if (missing(error)) return undefined; fail('FILE_READ') }
  const getuid = process.getuid
  if (typeof getuid !== 'function') fail('UID_UNAVAILABLE')
  const uid = BigInt(getuid())
  // Do not create directories or otherwise affect ordinary installations without a staged handoff.
  for (const [index, directory] of directories.entries()) {
    let metadata: BigIntStats
    try { metadata = await lstat(directory, { bigint: true }) } catch { fail('DIRECTORY_READ') }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== uid) fail('DIRECTORY_OWNER_OR_TYPE')
    if (index >= 3 && (metadata.mode & 0o7777n) !== 0o700n) fail('DIRECTORY_MODE')
  }
  if (!validFile(original, uid)) fail('FILE_OWNER_MODE_TYPE_OR_SIZE')
  let raw: string
  try {
    raw = await readTrustedFile(pending, original, uid)
  } catch (error) { if (error instanceof StateStoreError) throw error; fail('FILE_READ') }
  let envelope: MemoryHandoffEnvelope<T>
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) fail('ENVELOPE_FORMAT')
    const candidate = parsed as MemoryHandoffEnvelope<T>
    if (Object.keys(candidate).some((key) => !['schemaVersion', 'sourceVersion', 'rootSessionId', 'workspaceId', 'checksum', 'state'].includes(key))
      || candidate.schemaVersion !== 1 || !sourceVersionValid(candidate.sourceVersion)) fail('ENVELOPE_VERSION')
    if (candidate.rootSessionId !== input.rootSessionId || candidate.workspaceId !== input.workspaceId) fail('SCOPE_MISMATCH')
    if (typeof candidate.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.checksum) || candidate.checksum !== checksum(candidate.state)) fail('CHECKSUM_MISMATCH')
    const result = input.validate(candidate.state)
    if (result !== true && (typeof result !== 'object' || result === null || result.ok !== true)) fail('STATE_SCHEMA')
    envelope = candidate
  } catch (error) { if (error instanceof StateStoreError) throw error; fail('ENVELOPE_OR_STATE_FORMAT') }

  const encodedChecksum = rawChecksum(raw)
  let consumption: Promise<string> | undefined
  return { state: structuredClone(envelope.state), sourceVersion: envelope.sourceVersion,
    commitConsumption: () => consumption ??= (async () => {
      try {
        const current = await lstat(pending, { bigint: true })
        if (!validFile(current, uid) || !sameFile(original, current)) fail('FILE_CHANGED_BEFORE_CONSUMPTION')
        // Some filesystems expose coarse modification timestamps; metadata
        // alone cannot prove the staged bytes are still the validated bytes.
        if (rawChecksum(await readTrustedFile(pending, current, uid)) !== encodedChecksum) fail('FILE_CHANGED_BEFORE_CONSUMPTION')
        const destination = join(directory, 'consumed-' + Date.now() + '-' + randomUUID() + '.json')
        await rename(pending, destination)
        // A concurrent replacement cannot silently become the acknowledged source.
        const moved = await lstat(destination, { bigint: true })
        if (moved.dev !== original.dev || moved.ino !== original.ino || moved.size !== original.size || moved.mtimeNs !== original.mtimeNs) fail('FILE_CHANGED_DURING_CONSUMPTION')
        if (rawChecksum(await readTrustedFile(destination, moved, uid)) !== encodedChecksum) fail('FILE_CHANGED_DURING_CONSUMPTION')
        const handle = await open(directory, 'r')
        try { await handle.sync() } finally { await handle.close() }
        return destination
      } catch (error) { if (error instanceof StateStoreError) throw error; fail('CONSUMPTION_FAILED_BACKUP_RETAINED') }
    })()
  }
}
