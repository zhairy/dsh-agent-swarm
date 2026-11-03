import { createHash } from 'node:crypto'
import type { SwarmEventJournal } from './event-journal.js'
import { canonicalStateJson, checksumText } from './state-core.js'
import { ChunkedState, type SegmentSpecs, type StatePatch } from './state-chunks.js'

/** Keep a state fragment well below EventJournal's 64 KiB line ceiling after JSON and digest metadata. */
export const STATE_JOURNAL_CHUNK_BYTES = 16 * 1024
const MAX_STATE_JOURNAL_CHUNKS = 65_536
const MAX_PENDING_STATE_COMMITS = 64

export interface StateCommitFact<T> {
  kind: 'snapshot' | 'patch'
  type: string
  sequence: number
  previousChecksum: string
  checksum: string
  state?: T
  patch?: StatePatch
  changes?: Record<string, unknown>
}

export interface StateJournalIssue { commitId?: string; sequence?: number; reason: string }
export interface StateJournalRecovery<T> {
  state?: T
  sequence: number
  checksum?: string
  commits: number
  incomplete: number
  issues: StateJournalIssue[]
}

interface BeginPayload {
  protocol: 1
  commitId: string
  kind: 'snapshot' | 'patch'
  representation: 'state' | 'patch' | 'changes'
  type: string
  sequence: number
  previousChecksum: string
  checksum: string
  contentHash: string
  contentBytes: number
  chunks: number
}

interface PendingCommit { begin: BeginPayload; chunks: Map<number, string> }

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const eventId = (identity: string, suffix: string): string => `evt-state-${sha256(`${identity}:${suffix}`).slice(0, 40)}`

const validateBegin = (value: unknown): BeginPayload | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row.protocol !== 1 || (row.kind !== 'snapshot' && row.kind !== 'patch')
    || !['state', 'patch', 'changes'].includes(String(row.representation))
    || typeof row.commitId !== 'string' || !/^[a-f0-9]{64}$/.test(row.commitId)
    || typeof row.type !== 'string' || row.type.length < 1 || row.type.length > 120
    || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0
    || typeof row.previousChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.previousChecksum)
    || typeof row.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(row.checksum)
    || (row.kind === 'snapshot' && row.representation !== 'state')
    || (row.kind === 'patch' && row.representation === 'state')
    || !/^[a-f0-9]{64}$/.test(row.contentHash as string)
    || !Number.isSafeInteger(row.contentBytes) || (row.contentBytes as number) < 0
    || !Number.isSafeInteger(row.chunks) || (row.chunks as number) < 1 || (row.chunks as number) > MAX_STATE_JOURNAL_CHUNKS) return undefined
  return row as unknown as BeginPayload
}

/** Append one state mutation as an incomplete-until-finalized chunk group in the same EventJournal. */
export const appendStateCommitToJournal = <T>(journal: SwarmEventJournal, fact: StateCommitFact<T>): void => {
  if ((fact.kind === 'snapshot' && (fact.state === undefined || fact.patch !== undefined || fact.changes !== undefined))
    || (fact.kind === 'patch' && (fact.state !== undefined || ((fact.patch === undefined) === (fact.changes === undefined))))) throw new Error('Invalid state journal commit shape')
  if (!Number.isSafeInteger(fact.sequence) || fact.sequence < 0) throw new Error('Invalid state journal sequence')
  const representation = fact.kind === 'snapshot' ? 'state' : fact.changes === undefined ? 'patch' : 'changes'
  const content = Buffer.from(canonicalStateJson(fact.kind === 'snapshot' ? fact.state : fact.changes ?? fact.patch), 'utf8').toString('base64')
  const contentHash = sha256(content)
  const commitId = sha256(canonicalStateJson({ kind: fact.kind, type: fact.type, sequence: fact.sequence,
    previousChecksum: fact.previousChecksum, checksum: fact.checksum, contentHash }))
  // Base64 plus the EventJournal envelope and two digests consume most of a
  // minimum 1 KiB line. Keep ample headroom for long root-session identities.
  const chunkFraction = journal.maxLineBytes <= 4096 ? 0.2 : 0.5
  const chunkChars = Math.max(64, Math.min(STATE_JOURNAL_CHUNK_BYTES, Math.floor(journal.maxLineBytes * chunkFraction)))
  const chunks = Math.max(1, Math.ceil(content.length / chunkChars))
  if (chunks > MAX_STATE_JOURNAL_CHUNKS) throw new Error('State journal commit exceeds chunk limit')
  const begin: BeginPayload = { protocol: 1, commitId, kind: fact.kind, representation, type: fact.type, sequence: fact.sequence,
    previousChecksum: fact.previousChecksum, checksum: fact.checksum, contentHash, contentBytes: Buffer.byteLength(content), chunks }
  const actor = { kind: 'host' as const, id: 'state-journal' }
  journal.append({ eventId: eventId(commitId, 'begin'), idempotencyKey: `state-journal:${commitId}:begin`,
    type: 'state/journal-begin', actor, policyVersion: 'state-journal/1', payload: { ...begin } })
  for (let index = 0; index < chunks; index++) journal.append({
    eventId: eventId(commitId, `chunk:${index}`), idempotencyKey: `state-journal:${commitId}:chunk:${index}`,
    type: 'state/journal-chunk', actor, policyVersion: 'state-journal/1',
    payload: { commitId, index, data: content.slice(index * chunkChars, (index + 1) * chunkChars) }
  })
  journal.append({ eventId: eventId(commitId, 'commit'), idempotencyKey: `state-journal:${commitId}:commit`,
    type: 'state/journal-commit', actor, policyVersion: 'state-journal/1',
    payload: { commitId, chunks, contentHash, sequence: fact.sequence, checksum: fact.checksum } })
}

const stateChecksum = <T>(state: T, specs: SegmentSpecs): string => ChunkedState.fromState(state, specs, { verified: true }).rootChecksum()

/** Reconstruct the last complete, contiguous state chain. An unfinished tail is ignored, never half-applied. */
export const recoverStateFromJournal = <T>(journal: SwarmEventJournal, options: {
  specs: SegmentSpecs
  validate: (state: unknown) => boolean | { ok: boolean; issues?: readonly unknown[] }
}): StateJournalRecovery<T> => {
  const events = journal.queryTypes(['state/journal-begin', 'state/journal-chunk', 'state/journal-commit'])
  const pending = new Map<string, PendingCommit>()
  const issues: StateJournalIssue[] = []
  let state: T | undefined
  let sequence = 0
  let checksum: string | undefined
  let commits = 0
  for (const event of events) {
    if (event.type === 'state/journal-begin') {
      const begin = validateBegin(event.payload)
      if (begin === undefined) { issues.push({ reason: 'invalid-state-journal-begin' }); continue }
      if (!pending.has(begin.commitId) && pending.size >= MAX_PENDING_STATE_COMMITS) {
        issues.push({ commitId: begin.commitId, sequence: begin.sequence, reason: 'state-journal-pending-limit' }); continue
      }
      pending.set(begin.commitId, { begin, chunks: new Map() })
      continue
    }
    if (event.type === 'state/journal-chunk') {
      const id = typeof event.payload.commitId === 'string' ? event.payload.commitId : undefined
      const index = event.payload.index
      const data = event.payload.data
      const target = id === undefined ? undefined : pending.get(id)
      if (target === undefined || !Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= target.begin.chunks || typeof data !== 'string') {
        issues.push({ ...(id === undefined ? {} : { commitId: id }), reason: 'invalid-state-journal-chunk' }); continue
      }
      if (target.chunks.has(index as number)) { issues.push({ commitId: id, sequence: target.begin.sequence, reason: 'duplicate-state-journal-chunk' }); continue }
      target.chunks.set(index as number, data)
      continue
    }
    if (event.type !== 'state/journal-commit') continue
    const id = typeof event.payload.commitId === 'string' ? event.payload.commitId : undefined
    const target = id === undefined ? undefined : pending.get(id)
    if (target === undefined) { issues.push({ ...(id === undefined ? {} : { commitId: id }), reason: 'state-journal-final-without-begin' }); continue }
    const { begin, chunks } = target
    if (event.payload.chunks !== begin.chunks || event.payload.contentHash !== begin.contentHash
      || event.payload.sequence !== begin.sequence || event.payload.checksum !== begin.checksum || chunks.size !== begin.chunks) {
      issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-final-mismatch' }); pending.delete(id!); continue
    }
    const encoded = Array.from({ length: begin.chunks }, (_, index) => chunks.get(index)).join('')
    if (sha256(encoded) !== begin.contentHash || Buffer.byteLength(encoded) !== begin.contentBytes) {
      issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-content-hash-mismatch' }); pending.delete(id!); continue
    }
    let content: unknown
    try { content = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) } catch {
      issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-invalid-json' }); pending.delete(id!); continue
    }
    let next: T | undefined
    try {
      if (begin.kind === 'snapshot') {
        if (state === undefined || checksum === undefined || begin.sequence !== sequence + 1 || begin.previousChecksum !== checksum) {
          if (state !== undefined) {
            issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-broken-chain' }); pending.delete(id!); continue
          }
        }
        next = content as T
      } else {
        if (state === undefined || checksum === undefined || begin.sequence !== sequence + 1 || begin.previousChecksum !== checksum) {
          issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-broken-chain' }); pending.delete(id!); continue
        }
        const chunked = ChunkedState.fromState(state, options.specs, { verified: true })
        next = begin.representation === 'changes'
          ? chunked.applyEncoded(content as Parameters<typeof chunked.applyEncoded>[0]).materialize() as T
          : chunked.preview(content as StatePatch).next.materialize() as T
      }
      if (begin.sequence < sequence) {
        issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-sequence-regression' }); pending.delete(id!); continue
      }
      const validated = options.validate(next)
      if (validated !== true && (typeof validated !== 'object' || validated === null || validated.ok !== true)) {
        issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-validation-failed' }); pending.delete(id!); continue
      }
      const actual = stateChecksum(next, options.specs)
      if (actual !== begin.checksum) {
        issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-state-checksum-mismatch' }); pending.delete(id!); continue
      }
      state = next; sequence = begin.sequence; checksum = actual; commits++
      pending.delete(id!)
    } catch {
      issues.push({ commitId: id, sequence: begin.sequence, reason: 'state-journal-apply-failed' }); pending.delete(id!)
    }
  }
  return { ...(state === undefined ? {} : { state }), sequence, ...(checksum === undefined ? {} : { checksum }),
    commits, incomplete: [...pending.values()].length, issues }
}

export const initializeStateJournal = <T>(journal: SwarmEventJournal, state: T, sequence: number, specs: SegmentSpecs): string | undefined => {
  const recovered = recoverStateFromJournal<T>(journal, { specs, validate: () => true })
  if (recovered.state !== undefined) return recovered.checksum
  const empty = checksumText('')
  appendStateCommitToJournal(journal, { kind: 'snapshot', type: 'state/journal-seeded', sequence: Math.max(0, sequence),
    previousChecksum: empty, checksum: stateChecksum(state, specs), state })
  return stateChecksum(state, specs)
}
