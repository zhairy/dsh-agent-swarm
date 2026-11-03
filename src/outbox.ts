import type { SwarmEvent, SwarmEventJournal } from './event-journal.js'
import { getValueDigest } from './workflow.js'

export type OutboxStatus = 'pending' | 'delivered' | 'failed' | 'blocked'
export interface OutboxIntent { id: string; kind: string; payload: Record<string, unknown>; createdAt: number; maxAttempts?: number }
export interface OutboxRecord extends OutboxIntent { status: OutboxStatus; attempts: number; nextAt: number; lastError?: string; deliveredAt?: number }
export interface OutboxHandler { (record: OutboxRecord): void | Promise<void> }

const effectId = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/
const effectKind = /^[a-z][a-z0-9._-]{0,63}$/
const receiptEventId = (prefix: 'delivered' | 'failed', effect: string, attempt?: number): string =>
  `evt-outbox-${prefix}-${getValueDigest(`${effect}:${attempt ?? ''}`).slice(0, 40)}`
const boundedIntent = (raw: unknown): OutboxIntent | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !effectId.test(row.id) || typeof row.kind !== 'string' || !effectKind.test(row.kind)
    || row.payload === null || typeof row.payload !== 'object' || Array.isArray(row.payload)
    || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt) || row.createdAt < 0
    || (row.maxAttempts !== undefined && (!Number.isSafeInteger(row.maxAttempts) || (row.maxAttempts as number) < 1 || (row.maxAttempts as number) > 32))) return undefined
  let payloadJson: string
  try { payloadJson = JSON.stringify(row.payload) } catch { return undefined }
  if (Buffer.byteLength(payloadJson, 'utf8') > 32 * 1024) return undefined
  let payload: Record<string, unknown>
  try { payload = JSON.parse(payloadJson) as Record<string, unknown> } catch { return undefined }
  const intent = { id: row.id, kind: row.kind, payload, createdAt: row.createdAt,
    ...(row.maxAttempts === undefined ? {} : { maxAttempts: row.maxAttempts as number }) }
  return intent
}

/** Embed the outbox intent in the same EventJournal line as its enabling fact. */
export const appendWithOutbox = (journal: SwarmEventJournal, value: Parameters<SwarmEventJournal['append']>[0], intent?: OutboxIntent): SwarmEvent | undefined => {
  if (intent === undefined) return journal.append(value)
  const checked = boundedIntent(intent)
  if (checked === undefined) throw new Error('Invalid outbox intent')
  return journal.append({ ...value, payload: { ...(value.payload ?? {}), outbox: checked } })
}

export const makeOutboxIntent = (input: { identity: string; kind: string; payload: Record<string, unknown>; createdAt: number; maxAttempts?: number }): OutboxIntent => ({
  id: `effect-${getValueDigest(input.identity).slice(0, 40)}`, kind: input.kind, payload: input.payload,
  createdAt: input.createdAt, ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts })
})

export const getOutboxRecords = (journal: SwarmEventJournal): OutboxRecord[] => {
  const records = new Map<string, OutboxRecord>()
  for (const event of journal.queryOutbox()) {
    const embedded = boundedIntent(event.payload.outbox)
    if (embedded !== undefined && !records.has(embedded.id)) records.set(embedded.id, {
      ...embedded, status: 'pending', attempts: 0, nextAt: embedded.createdAt
    })
    const id = typeof event.payload.effectId === 'string' ? event.payload.effectId : event.payload.outbox !== null
      && typeof event.payload.outbox === 'object' && !Array.isArray(event.payload.outbox)
      ? (event.payload.outbox as Record<string, unknown>).id : undefined
    if (typeof id !== 'string') continue
    const current = records.get(id)
    if (current === undefined) continue
    if (event.type === 'outbox/delivered') {
      records.set(id, { ...current, status: 'delivered', nextAt: Number.POSITIVE_INFINITY,
        ...(typeof event.payload.deliveredAt === 'number' && Number.isFinite(event.payload.deliveredAt) && event.payload.deliveredAt >= 0 ? { deliveredAt: event.payload.deliveredAt } : {}) })
    } else if (event.type === 'outbox/failed') {
      const attempts = Number.isSafeInteger(event.payload.attempt) && (event.payload.attempt as number) >= 1 ? event.payload.attempt as number : current.attempts + 1
      records.set(id, { ...current, status: event.payload.errorCode === 'recovery-required' ? 'blocked' : 'failed', attempts,
        nextAt: typeof event.payload.nextAt === 'number' && Number.isFinite(event.payload.nextAt) && event.payload.nextAt >= 0 ? event.payload.nextAt : current.nextAt,
        ...(typeof event.payload.errorCode === 'string' ? { lastError: event.payload.errorCode.slice(0, 96) } : {}) })
    }
  }
  return [...records.values()]
}

export interface OutboxDispatchResult { delivered: number; failed: number; skipped: number }

/** Durable at-least-once dispatch; handlers must make their own external operation idempotent by `record.id`. */
export const dispatchOutbox = async (journal: SwarmEventJournal, handlers: ReadonlyMap<string, OutboxHandler>, options: { now?: () => number; limit?: number; includeBlocked?: boolean } = {}): Promise<OutboxDispatchResult> => {
  const now = options.now ?? Date.now
  const at = now()
  const limit = Math.max(1, Math.min(options.limit ?? 64, 256))
  const result: OutboxDispatchResult = { delivered: 0, failed: 0, skipped: 0 }
  const active = new Set<string>()
  for (const record of getOutboxRecords(journal).filter((item) => item.status === 'blocked'
    ? options.includeBlocked === true : item.status !== 'delivered' && item.nextAt <= at).slice(0, limit)) {
    const handler = handlers.get(record.kind)
    if (handler === undefined) { result.skipped++; continue }
    if (active.has(record.id)) continue
    active.add(record.id)
    try {
      await handler(record)
      journal.append({ eventId: receiptEventId('delivered', record.id), idempotencyKey: `outbox-delivered:${record.id}`,
        type: 'outbox/delivered', actor: { kind: 'host', id: 'outbox-dispatcher' },
        payload: { effectId: record.id, deliveredAt: now() } })
      result.delivered++
    } catch (error) {
      const attempts = record.attempts + 1
      const maxAttempts = record.maxAttempts ?? 8
      const errorCode = (error as { code?: unknown } | null)?.code
      const recoveryBlocked = errorCode === 'RECOVERY_REQUIRED' || errorCode === 'STORE_CLOSED' || errorCode === 'OWNER_ACTIVE'
      const delay = Math.min(3_600_000, 1000 * 2 ** Math.min(attempts - 1, 12))
      journal.append({ eventId: receiptEventId('failed', record.id, attempts), idempotencyKey: `outbox-failed:${record.id}:${attempts}`,
        type: 'outbox/failed', actor: { kind: 'host', id: 'outbox-dispatcher' },
        payload: { effectId: record.id, attempt: attempts,
          nextAt: recoveryBlocked || attempts >= maxAttempts ? Number.MAX_SAFE_INTEGER : now() + delay,
          errorCode: recoveryBlocked ? 'recovery-required' : attempts >= maxAttempts ? 'max-attempts' : 'handler-failed' } })
      result.failed++
    } finally { active.delete(record.id) }
  }
  return result
}
