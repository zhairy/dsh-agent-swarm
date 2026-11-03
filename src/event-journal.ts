import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getRedactedValue } from './evidence.js'

export const EVENT_JOURNAL_SCHEMA = 'dsh-agent-swarm/event/v2' as const
export const EVENT_JOURNAL_MAX_LINE_BYTES = 64 * 1024

export type SwarmEventType =
  | 'request/received'
  | 'host/event-filtered'
  | 'ticket/admitted'
  | 'ticket/state-changed'
  | 'ticket/quarantined'
  | 'assignment/queued'
  | 'assignment/started'
  | 'assignment/heartbeat'
  | 'assignment/ended'
  | 'route/selected'
  | 'route/skipped'
  | 'route/fallback'
  | 'route/recovered'
  | 'evidence/recorded'
  | 'review/recorded'
  | 'acceptance/recorded'
  | 'worktree/bound'
  | 'watchdog/alert'

export interface EventRevision { request: number; card: number; workflow: number; leaseEpoch: number }
export interface SwarmEventInput {
  eventId: string
  idempotencyKey: string
  ticketId?: string
  assignmentId?: string
  type: SwarmEventType
  actor: { kind: 'router' | 'worker' | 'host' | 'watchdog' | 'person'; id: string }
  policyVersion?: string
  revision?: Partial<EventRevision>
  payload?: Record<string, unknown>
}

export interface SwarmEvent extends SwarmEventInput {
  schema: typeof EVENT_JOURNAL_SCHEMA
  rootSessionId: string
  seq: number
  at: string
  previousDigest: string
  digest: string
  payload: Record<string, unknown>
}

export interface JournalIssue { line: number; reason: 'invalid-json' | 'invalid-shape' | 'digest-mismatch' | 'sequence-mismatch' | 'duplicate-id' }

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const eventDigest = (event: Omit<SwarmEvent, 'digest'>): string => sha256(JSON.stringify(event))
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization|credentials?|private[_-]?key)/i
const SAFE_TOKEN_METRIC_KEYS = new Set(['measuredTokens', 'reservedOutputTokens', 'safetyMarginTokens', 'safeInputTokens', 'surfaceTokens', 'totalTokens', 'inputTokens', 'outputTokens'])
const redactPayload = (value: unknown, depth = 0): unknown => {
  if (depth > 16) throw new Error('Event payload nested too deeply')
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return getRedactedValue(value)
  if (Array.isArray(value)) return value.slice(0, 4096).map((item) => redactPayload(item, depth + 1))
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 512).map(([key, item]) => [key, SENSITIVE_KEY.test(key) && !SAFE_TOKEN_METRIC_KEYS.has(key) ? '[REDACTED]' : redactPayload(item, depth + 1)]))
  return String(value)
}

const safeSessionFile = (sessionId: string): string => `session-${sha256(sessionId).slice(0, 32)}.v2.jsonl`

const parseAndValidate = (text: string, rootSessionId: string): { events: SwarmEvent[]; issues: JournalIssue[]; validBytes: number } => {
  const events: SwarmEvent[] = [], issues: JournalIssue[] = [], seen = new Set<string>()
  let previousDigest = 'GENESIS', validBytes = 0
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw === '') continue
    let event: SwarmEvent
    try { event = JSON.parse(raw) as SwarmEvent } catch { issues.push({ line: index + 1, reason: 'invalid-json' }); break }
    if (event.schema !== EVENT_JOURNAL_SCHEMA || event.rootSessionId !== rootSessionId || event.seq !== events.length + 1
      || typeof event.eventId !== 'string' || typeof event.idempotencyKey !== 'string' || typeof event.type !== 'string'
      || typeof event.previousDigest !== 'string' || typeof event.digest !== 'string') {
      issues.push({ line: index + 1, reason: 'invalid-shape' }); break
    }
    if (event.seq !== events.length + 1) { issues.push({ line: index + 1, reason: 'sequence-mismatch' }); break }
    if (event.previousDigest !== previousDigest) { issues.push({ line: index + 1, reason: 'digest-mismatch' }); break }
    const { digest, ...withoutDigest } = event
    if (digest !== eventDigest(withoutDigest)) { issues.push({ line: index + 1, reason: 'digest-mismatch' }); break }
    const keys = [event.eventId, event.idempotencyKey]
    if (keys.some((key) => seen.has(key))) { issues.push({ line: index + 1, reason: 'duplicate-id' }); break }
    for (const key of keys) seen.add(key)
    events.push(event); previousDigest = digest; validBytes += Buffer.byteLength(`${raw}\n`)
  }
  return { events, issues, validBytes }
}

export interface SwarmProjection {
  schemaVersion: 2
  sequence: number
  tickets: Record<string, { stage: string; updatedAt: string; quarantined: boolean }>
  routes: Record<string, { lastEvent: string; failures: number; recoveredAt?: string }>
  alerts: Array<{ id: string; severity: string; detail: string; at: string }>
}

export const emptyProjection = (): SwarmProjection => ({ schemaVersion: 2, sequence: 0, tickets: {}, routes: {}, alerts: [] })

/** Pure projection reducer; rebuilding the same event stream always yields the same view. */
export const reduceSwarmEvents = (events: readonly SwarmEvent[], initial: SwarmProjection = emptyProjection()): SwarmProjection => {
  const projection: SwarmProjection = structuredClone(initial)
  for (const event of events) {
    projection.sequence = Math.max(projection.sequence, event.seq)
    const ticketId = event.ticketId
    if (ticketId !== undefined) {
      const prior = projection.tickets[ticketId] ?? { stage: 'created', updatedAt: event.at, quarantined: false }
      const stage = typeof event.payload.stage === 'string' ? event.payload.stage
        : event.type === 'ticket/admitted' ? 'admitted'
          : event.type === 'ticket/quarantined' ? 'quarantined' : prior.stage
      projection.tickets[ticketId] = { stage, updatedAt: event.at, quarantined: prior.quarantined || stage === 'quarantined' }
    }
    if (event.type.startsWith('route/') && typeof event.payload.route === 'string') {
      const route = event.payload.route
      const prior = projection.routes[route] ?? { lastEvent: event.type, failures: 0 }
      const failures = event.type === 'route/fallback' || event.type === 'route/skipped' ? prior.failures + 1 : 0
      projection.routes[route] = { lastEvent: event.type, failures, ...(event.type === 'route/recovered' ? { recoveredAt: event.at } : prior.recoveredAt === undefined ? {} : { recoveredAt: prior.recoveredAt }) }
    }
    if (event.type === 'watchdog/alert' && event.payload.alert !== null && typeof event.payload.alert === 'object') {
      const alert = event.payload.alert as Record<string, unknown>
      if (typeof alert.id === 'string' && typeof alert.severity === 'string' && typeof alert.detail === 'string') projection.alerts.push({ id: alert.id, severity: alert.severity, detail: alert.detail.slice(0, 500), at: event.at })
    }
  }
  return projection
}

export interface SwarmEventJournal {
  readonly path: string
  append: (input: SwarmEventInput) => SwarmEvent | undefined
  read: () => { events: SwarmEvent[]; issues: JournalIssue[] }
  project: () => SwarmProjection
}

/** Append-only, checksummed JSONL journal. It records facts but never replays external side effects. */
export const createSwarmEventJournal = (input: { directory: string; rootSessionId: string; now?: () => Date }): SwarmEventJournal => {
  const path = join(input.directory, safeSessionFile(input.rootSessionId))
  const now = input.now ?? (() => new Date())
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let loaded = existsSync(path) ? parseAndValidate(readFileSync(path, 'utf8'), input.rootSessionId) : { events: [], issues: [], validBytes: 0 }
  if (loaded.issues.length > 0) {
    const prefix = loaded.events.map((event) => JSON.stringify(event)).join('\n')
    writeFileSync(path, prefix === '' ? '' : `${prefix}\n`, { encoding: 'utf8', mode: 0o600 })
  }
  const seen = new Set<string>()
  for (const event of loaded.events) { seen.add(event.eventId); seen.add(event.idempotencyKey) }
  return {
    path,
    append: (value) => {
      if (seen.has(value.eventId) || seen.has(value.idempotencyKey)) return undefined
      const payload = redactPayload(value.payload ?? {}) as Record<string, unknown>
      const withoutDigest: Omit<SwarmEvent, 'digest'> = {
        ...value, schema: EVENT_JOURNAL_SCHEMA, rootSessionId: input.rootSessionId,
        seq: loaded.events.length + 1, at: now().toISOString(),
        previousDigest: loaded.events.at(-1)?.digest ?? 'GENESIS', payload
      }
      const event: SwarmEvent = { ...withoutDigest, digest: eventDigest(withoutDigest) }
      const line = `${JSON.stringify(event)}\n`
      if (Buffer.byteLength(line) > EVENT_JOURNAL_MAX_LINE_BYTES) throw new Error('Event exceeds journal line limit')
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
      loaded.events.push(event); seen.add(event.eventId); seen.add(event.idempotencyKey)
      return event
    },
    read: () => ({ events: structuredClone(loaded.events), issues: structuredClone(loaded.issues) }),
    project: () => reduceSwarmEvents(loaded.events)
  }
}
