import type { SwarmConfigInfo } from '../../config.js'
import type { SwarmEventJournal } from '../../event-journal.js'
import { appendWithOutbox, getOutboxRecords, makeOutboxIntent, type OutboxIntent } from '../../outbox.js'
import { evaluateTrigger, normalizeTrigger, ValidateSourceInstance, ValidateSourceSubscription, ValidateSourceThread,
  type SourceInstance, type SourceSubscription, type SourceThread, type TriggerDecision, type TriggerFact, type TriggerInput } from './model.js'
import { createHash } from 'node:crypto'

export interface SourceAdapter<Raw = unknown> {
  readonly kind: string
  normalize(input: { source: SourceInstance; raw: Raw; at: Date }): TriggerInput | { filtered: string }
}

export interface SourceIngestResult {
  status: 'accepted' | 'would-accept' | 'ignored' | 'filtered' | 'duplicate'
  reason: string
  trigger?: TriggerFact
  decision?: TriggerDecision
  outboxId?: string
  fanoutTicketIds: string[]
  evalRequired: boolean
}

export interface SourceTriggerStatus {
  sources: Array<Pick<SourceInstance, 'id' | 'kind' | 'enabled' | 'selfActor'> & { lastAt?: string; received: number; accepted: number; observed: number; filtered: number }>
  counts: { received: number; accepted: number; observed: number; filtered: number }
  outboxPending: number
  outboxFailed: number
  threads: number
  subscriptions: number
}

const sourceId = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/
const sourceIdentity = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/
const MAX_SUBSCRIPTIONS_PER_THREAD = 64
const ADMISSION_CLAIM_TTL_MS = 15 * 60_000
const readTrigger = (value: unknown): TriggerFact | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (!Object.keys(row).every((key) => ['schemaVersion', 'id', 'at', 'sourceId', 'externalId', 'threadId', 'actorId', 'actorKind',
    'addressed', 'preview', 'topics', 'ruleIds', 'replyChannel', 'mandate', 'contentDigest', 'strength'].includes(key))) return undefined
  return row.schemaVersion === 1 && typeof row.id === 'string' && sourceIdentity.test(row.id)
    && typeof row.at === 'string' && Number.isFinite(Date.parse(row.at))
    && typeof row.sourceId === 'string' && sourceId.test(row.sourceId)
    && typeof row.externalId === 'string' && sourceIdentity.test(row.externalId)
    && typeof row.threadId === 'string' && sourceIdentity.test(row.threadId)
    && typeof row.actorId === 'string' && sourceIdentity.test(row.actorId)
    && ['human', 'bot', 'system'].includes(String(row.actorKind))
    && typeof row.addressed === 'boolean' && typeof row.preview === 'string'
    && Array.isArray(row.topics) && row.topics.every((item) => typeof item === 'string')
    && Array.isArray(row.ruleIds) && row.ruleIds.every((item) => typeof item === 'string')
    && (row.replyChannel === undefined || typeof row.replyChannel === 'string')
    && (row.mandate === undefined || row.mandate !== null && typeof row.mandate === 'object' && !Array.isArray(row.mandate))
    && typeof row.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(row.contentDigest)
    && (row.strength === undefined || row.strength === 'explicit' || row.strength === 'inferred') ? value as TriggerFact : undefined
}

/** Journal-only Source/Trigger adapter. Source instances, triggers and decisions are reconstructed from events. */
export const createSourceTriggerRuntime = (input: { journal: SwarmEventJournal; config: () => SwarmConfigInfo; now?: () => number }) => {
  const now = input.now ?? Date.now
  const adapters = new Map<string, SourceAdapter>()
  const sources = new Map<string, SourceInstance>()
  const threads = new Map<string, SourceThread>()
  const subscriptions = new Map<string, SourceSubscription>()
  const admissionClaims = new Map<string, number>()
  const seen = new Set<string>()
  const threadKey = (source: string, thread: string): string => `${source}\0${thread}`
  const needsTicketEffect = (trigger: TriggerFact, decision: TriggerDecision): boolean => decision.disposition === 'accepted'
    && trigger.mandate !== undefined
    && (decision.reason === 'proactive-rule' || decision.reason === 'explicit-request' && trigger.sourceId !== 'session')
  for (const event of input.journal.queryTypes(['source/configured', 'source/trigger-evaluated', 'source/trigger-filtered', 'thread/opened', 'subscription/created', 'subscription/ended'])) {
    if (event.type === 'source/configured' && ValidateSourceInstance(event.payload.source)) sources.set(event.payload.source.id, structuredClone(event.payload.source))
    if (event.type === 'thread/opened' && ValidateSourceThread(event.payload.thread)) threads.set(event.payload.thread.id, structuredClone(event.payload.thread))
    if (event.type === 'subscription/created' && ValidateSourceSubscription(event.payload.subscription)) subscriptions.set(event.payload.subscription.id, structuredClone(event.payload.subscription))
    if (event.type === 'subscription/ended' && typeof event.payload.subscriptionId === 'string') {
      const current = subscriptions.get(event.payload.subscriptionId)
      if (current !== undefined) subscriptions.set(current.id, { ...current, endedAt: typeof event.payload.endedAt === 'string' ? event.payload.endedAt : event.at })
    }
    const trigger = readTrigger(event.payload.trigger)
    if (trigger !== undefined) {
      seen.add(`${trigger.sourceId}\0${trigger.externalId}`)
      const decision = event.payload.decision as TriggerDecision | undefined
      if (decision !== undefined && needsTicketEffect(trigger, decision)) {
        admissionClaims.set(threadKey(trigger.sourceId, trigger.threadId), Date.parse(trigger.at))
      }
    }
    if (event.type === 'subscription/created' && ValidateSourceSubscription(event.payload.subscription)) {
      admissionClaims.delete(threadKey(event.payload.subscription.sourceId, event.payload.subscription.threadId))
    }
  }
  let closed = false
  const assertOpen = (): void => { if (closed) throw new Error('Source runtime is closed') }
  const requireSource = (id: string): SourceInstance => {
    const source = sources.get(id)
    if (source === undefined) throw new Error(`Unknown source: ${id}`)
    return source
  }
  const getActiveSubscriptions = (source: string, thread: string): SourceSubscription[] => [...subscriptions.values()]
    .filter((subscription) => subscription.sourceId === source && subscription.threadId === thread && subscription.endedAt === undefined)
  const hasAdmissionClaim = (source: string, thread: string): boolean => {
    const key = threadKey(source, thread), claimedAt = admissionClaims.get(key)
    if (claimedAt === undefined) return false
    if (!Number.isFinite(claimedAt) || now() - claimedAt <= ADMISSION_CLAIM_TTL_MS) return true
    admissionClaims.delete(key)
    return false
  }
  const ensureThread = (source: SourceInstance, raw: TriggerFact): SourceThread => {
    const key = threadKey(source.id, raw.threadId)
    const current = threads.get(key)
    if (current !== undefined) return current
    const thread: SourceThread = { schemaVersion: 1, id: key, sourceId: source.id, threadId: raw.threadId, openedAt: raw.at, lastAt: raw.at }
    input.journal.append({ eventId: `evt-thread-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`, idempotencyKey: `thread:${key}`,
      type: 'thread/opened', actor: { kind: 'host', id: 'source-trigger-runtime' }, payload: { thread } })
    threads.set(key, thread)
    return thread
  }
  const appendDecision = (trigger: TriggerFact, decision: TriggerDecision, filteredReason?: string,
    fanoutTicketIds: string[] = [], evalRequired = true): SourceIngestResult => {
    if (closed) throw new Error('Source runtime is closed')
    const identity = `${trigger.sourceId}:${trigger.externalId}`
    const ticketIntent = needsTicketEffect(trigger, decision)
    const followupIntent = decision.disposition === 'accepted' && decision.reason === 'ticket-follow-up'
    const contextIntent = fanoutTicketIds.length > 0 && !ticketIntent && !followupIntent && decision.disposition !== 'filtered'
    let intent: OutboxIntent | undefined
    if (ticketIntent) intent = makeOutboxIntent({ identity: `ticket-intent:${trigger.id}`, kind: 'ticket-intent', createdAt: now(), maxAttempts: 8,
      payload: { triggerId: trigger.id, sourceId: trigger.sourceId, threadId: trigger.threadId, actorId: trigger.actorId,
        strength: trigger.strength, matchedRules: decision.matchedRules, preview: trigger.preview, contentDigest: trigger.contentDigest,
        policyVersion: decision.policyVersion, fanoutTicketIds, ...(trigger.mandate === undefined ? {} : { card: trigger.mandate }) } })
    else if (followupIntent || contextIntent) intent = makeOutboxIntent({ identity: `${followupIntent ? 'ticket-follow-up' : 'ticket-context'}:${trigger.id}`,
      kind: followupIntent ? 'ticket-follow-up' : 'ticket-context', createdAt: now(), maxAttempts: 8,
      payload: { triggerId: trigger.id, sourceId: trigger.sourceId, threadId: trigger.threadId, ticketIds: fanoutTicketIds,
        actorId: trigger.actorId, preview: trigger.preview, contentDigest: trigger.contentDigest, policyVersion: decision.policyVersion } })
    const type = decision.disposition === 'filtered' ? 'source/trigger-filtered' : 'source/trigger-evaluated'
    appendWithOutbox(input.journal, { eventId: `evt-source-${trigger.id}`, idempotencyKey: `source-trigger:${identity}`,
      type, actor: { kind: 'host', id: 'source-trigger-runtime' }, policyVersion: decision.policyVersion,
      revision: { request: 1, card: 1, workflow: 1, leaseEpoch: 1 },
      payload: { sourceId: trigger.sourceId, trigger, decision, fanoutTicketIds, evalRequired,
        ...(filteredReason === undefined ? {} : { filteredReason }) } }, intent)
    if (ticketIntent) admissionClaims.set(threadKey(trigger.sourceId, trigger.threadId), Date.parse(trigger.at))
    seen.add(`${trigger.sourceId}\0${trigger.externalId}`)
    return { status: decision.disposition, reason: decision.reason, trigger: structuredClone(trigger), decision: structuredClone(decision),
      fanoutTicketIds: [...fanoutTicketIds], evalRequired, ...(intent === undefined ? {} : { outboxId: intent.id }) }
  }
  return {
    registerAdapter(adapter: SourceAdapter): () => void {
      assertOpen()
      if (!effectKind(adapter.kind)) throw new Error('Invalid source adapter kind')
      const existing = adapters.get(adapter.kind)
      if (existing !== undefined && existing !== adapter) throw new Error(`Source adapter already registered: ${adapter.kind}`)
      adapters.set(adapter.kind, adapter)
      return () => { if (adapters.get(adapter.kind) === adapter) adapters.delete(adapter.kind) }
    },
    configure(source: SourceInstance): SourceInstance {
      assertOpen()
      if (!sourceId.test(source.id) || !ValidateSourceInstance(source)) throw new Error('Invalid source instance')
      const existing = sources.get(source.id)
      if (existing !== undefined && createHash('sha256').update(JSON.stringify(existing)).digest('hex') === createHash('sha256').update(JSON.stringify(source)).digest('hex')) {
        return structuredClone(existing)
      }
      const revision = createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 40)
      input.journal.append({ eventId: `evt-source-config-${source.id}-${revision}`, idempotencyKey: `source-config:${source.id}:${revision}`,
        type: 'source/configured', actor: { kind: 'host', id: 'source-trigger-runtime' }, policyVersion: 'source/1',
        payload: { source: structuredClone(source) } })
      sources.set(source.id, structuredClone(source))
      return structuredClone(source)
    },
    subscribe(inputValue: { sourceId: string; threadId: string; ticketId: string; contextOnly?: boolean }): SourceSubscription {
      assertOpen()
      const source = requireSource(inputValue.sourceId)
      if (!sourceIdentity.test(inputValue.threadId) || !sourceIdentity.test(inputValue.ticketId)) throw new Error('Invalid subscription identity')
      const identity = `${source.id}\0${inputValue.threadId}\0${inputValue.ticketId}`
      const id = `subscription-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`
      const existing = subscriptions.get(id)
      if (existing !== undefined) return structuredClone(existing)
      if ([...subscriptions.values()].filter((subscription) => subscription.sourceId === source.id
        && subscription.threadId === inputValue.threadId && subscription.endedAt === undefined).length >= MAX_SUBSCRIPTIONS_PER_THREAD) {
        throw new Error(`Source thread subscription limit exceeded: ${MAX_SUBSCRIPTIONS_PER_THREAD}`)
      }
      const subscription: SourceSubscription = { schemaVersion: 1, id, sourceId: source.id, threadId: inputValue.threadId,
        ticketId: inputValue.ticketId, contextOnly: inputValue.contextOnly === true, createdAt: new Date(now()).toISOString() }
      input.journal.append({ eventId: `evt-${id}`, idempotencyKey: `subscription:${id}`, type: 'subscription/created',
        actor: { kind: 'host', id: 'source-trigger-runtime' }, payload: { subscription } })
      subscriptions.set(id, subscription)
      admissionClaims.delete(threadKey(source.id, inputValue.threadId))
      return structuredClone(subscription)
    },
    unsubscribe(subscriptionIdValue: string): boolean {
      assertOpen()
      const current = subscriptions.get(subscriptionIdValue)
      if (current === undefined || current.endedAt !== undefined) return false
      const endedAt = new Date(now()).toISOString()
      input.journal.append({ eventId: `evt-subscription-ended-${current.id}`, idempotencyKey: `subscription-ended:${current.id}`,
        type: 'subscription/ended', actor: { kind: 'host', id: 'source-trigger-runtime' }, payload: { subscriptionId: current.id, endedAt } })
      subscriptions.set(current.id, { ...current, endedAt })
      return true
    },
    unsubscribeTicket(ticketIdValue: string): number {
      assertOpen()
      let ended = 0
      for (const subscription of [...subscriptions.values()]) {
        if (subscription.ticketId !== ticketIdValue || subscription.endedAt !== undefined) continue
        if (this.unsubscribe(subscription.id)) ended++
      }
      return ended
    },
    ingest(sourceIdValue: string, raw: TriggerInput, options: { hasActiveTicket?: boolean } = {}): SourceIngestResult {
      assertOpen()
      const source = requireSource(sourceIdValue)
      const normalized = normalizeTrigger(source, raw, new Date(now()))
      if ('filtered' in normalized) {
        const rawRow = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as unknown as Record<string, unknown> : {}
        const safe = (value: unknown, fallback: string) => typeof value === 'string'
          ? value.slice(0, 256).replace(/[^A-Za-z0-9._:/@+-]/g, '-') || fallback : fallback
        const trigger: TriggerFact = { schemaVersion: 1, id: `trigger-${source.id}-${safe(rawRow.externalId, 'invalid')}`.slice(0, 64).replace(/[^A-Za-z0-9_-]/g, '-'),
          at: new Date(now()).toISOString(), sourceId: source.id, externalId: safe(rawRow.externalId, 'invalid-external'),
          threadId: safe(rawRow.threadId, source.id), actorId: safe(rawRow.actorId, 'invalid-actor'),
          actorKind: ['human', 'bot', 'system'].includes(String(rawRow.actorKind)) ? rawRow.actorKind as TriggerFact['actorKind'] : 'system',
          addressed: rawRow.addressed === true, preview: '', topics: [],
          ruleIds: [], contentDigest: '0'.repeat(64) }
        const config = input.config().proactive
        return appendDecision(trigger, { schemaVersion: 1, disposition: 'filtered', reason: normalized.filtered,
          policyVersion: `proactive/${config.mode}/source-filter`, matchedRules: [] }, normalized.filtered)
      }
      const key = `${normalized.sourceId}\0${normalized.externalId}`
      const active = getActiveSubscriptions(normalized.sourceId, normalized.threadId)
      const fanoutTicketIds = [...new Set(active.map((subscription) => subscription.ticketId))]
      const confirmedActive = active.some((subscription) => !subscription.contextOnly)
      const claimed = hasAdmissionClaim(normalized.sourceId, normalized.threadId)
      const inheritedActive = confirmedActive || claimed
      if (seen.has(key)) return { status: 'duplicate', reason: 'duplicate-external-id', trigger: structuredClone(normalized), fanoutTicketIds, evalRequired: false }
      ensureThread(source, normalized)
      if (normalized.strength === 'explicit' && confirmedActive) {
        return appendDecision(normalized, { schemaVersion: 1, disposition: 'accepted', reason: 'ticket-follow-up',
          policyVersion: 'ticket-follow-up/1', matchedRules: [] }, undefined, fanoutTicketIds, false)
      }
      if (normalized.strength === 'explicit' && claimed) {
        return appendDecision(normalized, { schemaVersion: 1, disposition: 'ignored', reason: 'thread-admission-pending',
          policyVersion: 'source-admission/1', matchedRules: [] }, undefined, fanoutTicketIds, false)
      }
      const config = input.config().proactive
      return appendDecision(normalized, evaluateTrigger(normalized, { mode: config.mode, rules: config.rules,
        hasActiveTicket: inheritedActive || options.hasActiveTicket === true, hasMandate: normalized.mandate !== undefined }),
        undefined, fanoutTicketIds, true)
    },
    ingestRaw(sourceIdValue: string, raw: unknown, options: { hasActiveTicket?: boolean } = {}): SourceIngestResult {
      assertOpen()
      const source = requireSource(sourceIdValue)
      const adapter = adapters.get(source.kind)
      if (adapter === undefined) throw new Error(`Source adapter is not registered: ${source.kind}`)
      const normalized = adapter.normalize({ source: structuredClone(source), raw, at: new Date(now()) })
      if ('filtered' in normalized) {
        let rawIdentity: string
        try { rawIdentity = JSON.stringify(raw) } catch { rawIdentity = String(raw) }
        const filterIdentity = createHash('sha256').update(rawIdentity).digest('hex').slice(0, 32)
        const trigger: TriggerFact = { schemaVersion: 1, id: `trigger-${filterIdentity}`.slice(0, 64), at: new Date(now()).toISOString(),
          sourceId: source.id, externalId: `adapter-filter-${filterIdentity}`, threadId: source.id, actorId: 'system:adapter', actorKind: 'system',
          addressed: false, preview: '', topics: [], ruleIds: [], contentDigest: '0'.repeat(64) }
        return appendDecision(trigger, { schemaVersion: 1, disposition: 'filtered', reason: normalized.filtered, policyVersion: 'source-adapter/1', matchedRules: [] }, normalized.filtered)
      }
      return this.ingest(source.id, normalized, options)
    },
    status(): SourceTriggerStatus {
      const stats = new Map([...sources.values()].map((source) => [source.id, { id: source.id, kind: source.kind, enabled: source.enabled,
        ...(source.selfActor === undefined ? {} : { selfActor: source.selfActor }), received: 0, accepted: 0, observed: 0, filtered: 0, lastAt: undefined as string | undefined }]))
      let received = 0, accepted = 0, observed = 0, filtered = 0
      for (const event of input.journal.queryTypes(['source/trigger-evaluated', 'source/trigger-filtered'])) {
        if (!['source/trigger-evaluated', 'source/trigger-filtered'].includes(event.type)) continue
        const trigger = readTrigger(event.payload.trigger)
        const decision = event.payload.decision as TriggerDecision | undefined
        if (trigger === undefined || decision === undefined) continue
        received++
        const row = stats.get(trigger.sourceId)
        if (row !== undefined) { row.received++; row.lastAt = trigger.at }
        if (decision.disposition === 'accepted') { accepted++; if (row !== undefined) row.accepted++ }
        else if (decision.disposition === 'would-accept') { observed++; if (row !== undefined) row.observed++ }
        else if (decision.disposition === 'filtered') { filtered++; if (row !== undefined) row.filtered++ }
      }
      const outbox = getOutboxRecords(input.journal)
      const outboxPending = outbox.filter((record) => record.status !== 'delivered' && record.nextAt < Number.MAX_SAFE_INTEGER).length
      const outboxFailed = outbox.filter((record) => record.status !== 'delivered' && record.nextAt >= Number.MAX_SAFE_INTEGER).length
      return { sources: [...stats.values()], counts: { received, accepted, observed, filtered }, outboxPending, outboxFailed,
        threads: threads.size, subscriptions: [...subscriptions.values()].filter((subscription) => subscription.endedAt === undefined).length }
    },
    dispose(): void { closed = true /* Journal-backed runtime owns no file handle. */ }
  }
}

const effectKind = (value: string): boolean => /^[a-z][a-z0-9._-]{0,63}$/.test(value)

export const sourceTriggerFromSessionEvent = (input: { sessionId: string; event: { type: string; seq?: number; data?: unknown }; sourceId: string }): TriggerInput | { filtered: string } => {
  if (input.event.type !== 'user/message' || !Number.isSafeInteger(input.event.seq) || (input.event.seq as number) < 0) return { filtered: 'not-a-user-message' }
  const data = input.event.data !== null && typeof input.event.data === 'object' && !Array.isArray(input.event.data) ? input.event.data as Record<string, unknown> : {}
  const source = data.source !== null && typeof data.source === 'object' && !Array.isArray(data.source) ? data.source as Record<string, unknown> : {}
  if (source.kind !== 'user' && source.kind !== undefined) return { filtered: 'plugin-message' }
  const content = Array.isArray(data.content) ? data.content.slice(0, 64).flatMap((part) => part !== null && typeof part === 'object'
    && typeof (part as Record<string, unknown>).text === 'string' ? [((part as Record<string, unknown>).text as string).slice(0, 4096)] : []).join('\n').slice(0, 4096) : ''
  return { sourceId: input.sourceId, externalId: `session-${input.sessionId}:${input.event.seq}`, threadId: input.sessionId,
    actorId: `human:${input.sessionId}`, actorKind: 'human', addressed: true, preview: content, topics: [], ruleIds: [] }
}
