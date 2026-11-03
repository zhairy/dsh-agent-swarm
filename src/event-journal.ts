import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getRedactedValue } from './evidence.js'

export const EVENT_JOURNAL_SCHEMA = 'dsh-agent-swarm/event/v2' as const
export const EVENT_JOURNAL_MAX_LINE_BYTES = 64 * 1024
export const EVENT_JOURNAL_SEAL_BYTES = 64 * 1024 * 1024

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

const parseAndValidate = (text: string, rootSessionId: string, initialSeq = 1, initialDigest = 'GENESIS', seen = new Set<string>()): { events: SwarmEvent[]; issues: JournalIssue[]; validBytes: number } => {
  const events: SwarmEvent[] = [], issues: JournalIssue[] = []
  let previousDigest = initialDigest, validBytes = 0
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw === '') continue
    let event: SwarmEvent
    try { event = JSON.parse(raw) as SwarmEvent } catch { issues.push({ line: index + 1, reason: 'invalid-json' }); break }
    if (event === null || typeof event !== 'object' || Array.isArray(event)
      || event.schema !== EVENT_JOURNAL_SCHEMA || event.rootSessionId !== rootSessionId || event.seq !== initialSeq + events.length
      || typeof event.eventId !== 'string' || typeof event.idempotencyKey !== 'string' || typeof event.type !== 'string'
      || typeof event.previousDigest !== 'string' || typeof event.digest !== 'string') {
      issues.push({ line: index + 1, reason: 'invalid-shape' }); break
    }
    if (event.seq !== initialSeq + events.length) { issues.push({ line: index + 1, reason: 'sequence-mismatch' }); break }
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
      const quarantined = typeof event.payload.quarantined === 'boolean'
        ? event.payload.quarantined : event.type === 'ticket/quarantined' || stage === 'quarantined' ? true : prior.quarantined
      projection.tickets[ticketId] = { stage, updatedAt: event.at, quarantined }
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
  segments: () => readonly string[]
}

/** Append-only, checksummed JSONL journal. It records facts but never replays external side effects. */
export const createSwarmEventJournal = (input: { directory: string; rootSessionId: string; now?: () => Date; sealAfterBytes?: number; maxLineBytes?: number }): SwarmEventJournal => {
  const path = join(input.directory, safeSessionFile(input.rootSessionId))
  const stem = safeSessionFile(input.rootSessionId).replace(/\.jsonl$/, '')
  const sealAfterBytes = input.sealAfterBytes ?? EVENT_JOURNAL_SEAL_BYTES
  const maxLineBytes = input.maxLineBytes ?? EVENT_JOURNAL_MAX_LINE_BYTES
  const now = input.now ?? (() => new Date())
  if (!Number.isSafeInteger(sealAfterBytes) || sealAfterBytes < 1024) throw new Error('Event journal seal size is too small')
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024 || maxLineBytes > EVENT_JOURNAL_MAX_LINE_BYTES) throw new Error('Event journal line limit is invalid')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const escapedStem = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sealPattern = new RegExp(`^${escapedStem}\\.segment-(\\d+)-(\\d+)\\.jsonl$`)
  const sealedPaths = (): string[] => readdirSync(input.directory)
    .map((name) => ({ name, match: sealPattern.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .sort((left, right) => Number(left.match[1]) - Number(right.match[1]))
    .map((item) => join(input.directory, item.name))
  const allEvents: SwarmEvent[] = [], allIssues: JournalIssue[] = []
  const seen = new Set<string>()
  let previousDigest = 'GENESIS', nextSeq = 1, activeStartSeq = 1, sealedFailure: string | undefined
  for (const segment of [...sealedPaths(), path]) {
    if (!existsSync(segment)) continue
    const parsed = parseAndValidate(readFileSync(segment, 'utf8'), input.rootSessionId, nextSeq, previousDigest, seen)
    for (const event of parsed.events) { allEvents.push(event); seen.add(event.eventId); seen.add(event.idempotencyKey) }
    if (parsed.events.length > 0) previousDigest = parsed.events.at(-1)!.digest
    allIssues.push(...parsed.issues)
    nextSeq += parsed.events.length
    if (segment === path) {
      activeStartSeq = nextSeq - parsed.events.length
      // The active tail is repairable; sealed segments are immutable and fail closed.
      if (parsed.issues.length > 0) {
        const prefix = parsed.events.map((event) => JSON.stringify(event)).join('\n')
        writeFileSync(path, prefix === '' ? '' : `${prefix}\n`, { encoding: 'utf8', mode: 0o600 })
      }
    } else if (parsed.issues.length > 0) sealedFailure = `Sealed event journal segment is corrupt: ${segment}`
  }
  if (!existsSync(path)) writeFileSync(path, '', { encoding: 'utf8', mode: 0o600 })
  let activeBytes = statSync(path).size
  let projection = reduceSwarmEvents(allEvents)
  const sealActive = (): void => {
    if (activeBytes <= 0 || allEvents.length === 0) return
    const endSeq = allEvents.at(-1)!.seq
    const target = join(input.directory, `${stem}.segment-${String(activeStartSeq).padStart(12, '0')}-${String(endSeq).padStart(12, '0')}.jsonl`)
    if (existsSync(target)) throw new Error('Event journal seal target already exists')
    renameSync(path, target)
    writeFileSync(path, '', { encoding: 'utf8', mode: 0o600 })
    activeStartSeq = endSeq + 1
    activeBytes = 0
  }
  return {
    path,
    append: (value) => {
      if (sealedFailure !== undefined) throw new Error(sealedFailure)
      if (seen.has(value.eventId) || seen.has(value.idempotencyKey)) return undefined
      if (typeof value.eventId !== 'string' || value.eventId.length > 128 || typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length > 512) throw new Error('Invalid event identity')
      const payload = redactPayload(value.payload ?? {}) as Record<string, unknown>
      const withoutDigest: Omit<SwarmEvent, 'digest'> = {
        ...value, schema: EVENT_JOURNAL_SCHEMA, rootSessionId: input.rootSessionId,
        seq: nextSeq, at: now().toISOString(),
        previousDigest: allEvents.at(-1)?.digest ?? 'GENESIS', payload
      }
      const event: SwarmEvent = { ...withoutDigest, digest: eventDigest(withoutDigest) }
      const line = `${JSON.stringify(event)}\n`
      const lineBytes = Buffer.byteLength(line)
      if (lineBytes > maxLineBytes) throw new Error('Event exceeds journal line limit')
      if (activeBytes + lineBytes > sealAfterBytes) sealActive()
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 })
      activeBytes += lineBytes
      nextSeq++
      allEvents.push(event); seen.add(event.eventId); seen.add(event.idempotencyKey)
      projection = reduceSwarmEvents([event], projection)
      return event
    },
    read: () => ({ events: structuredClone(allEvents), issues: structuredClone(allIssues) }),
    project: () => structuredClone(projection),
    segments: () => [...sealedPaths(), path]
  }
}
