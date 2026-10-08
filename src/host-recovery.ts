/** A lifecycle-only fold of the real Host's validated inspection and parent catalog.
 * This proves durable lineage and a closed last turn, never workspace side effects. */
export interface ChildRecoveryEvidence {
  parentSessionId: string
  childId: string
  continuable: boolean
  settled: boolean
  stopReason?: string
  turn?: number
  turnStartedAt?: number
  settledAt?: number
  reason?: string
}
const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
const integer = (raw: unknown): raw is number => Number.isSafeInteger(raw) && Number(raw) >= 0

/** Restore intent, never the SDK's last automatically selected fallback header. */
export const inspectRootPreference = (inspection: unknown): { provider: string; model: string; reasoningEffort?: string } | undefined => {
  if (!object(inspection) || !object(inspection.meta) || inspection.meta.parentSession !== undefined || !Array.isArray(inspection.events)
    || !integer(inspection.inheritedEventCount) || inspection.inheritedEventCount > inspection.events.length || inspection.events.length > 200000) return undefined
  const route = (raw: unknown) => {
    if (!object(raw) || typeof raw.provider !== 'string' || raw.provider.length === 0 || raw.provider.length > 256 || typeof raw.model !== 'string' || raw.model.length === 0 || raw.model.length > 256
      || (raw.reasoningEffort !== undefined && (typeof raw.reasoningEffort !== 'string' || raw.reasoningEffort.length === 0 || raw.reasoningEffort.length > 128))) return undefined
    return { provider: raw.provider, model: raw.model, ...(typeof raw.reasoningEffort === 'string' ? { reasoningEffort: raw.reasoningEffort } : {}) }
  }
  let initial: ReturnType<typeof route>
  let selected: ReturnType<typeof route>
  for (const event of inspection.events.slice(inspection.inheritedEventCount)) {
    if (!object(event) || !object(event.data)) continue
    if (event.type === 'model/selection') {
      const current = route(event.data)
      if (current !== undefined) selected = current
    }
    if (initial !== undefined || event.type !== 'request/header' || !['initial', 'resume'].includes(String(event.data.reason)) || !object(event.data.header)) continue
    const header = event.data.header
    const current = route(header.config)
    if (current !== undefined) {
      if (object(header.adapterDefaults) && header.adapterDefaults.reasoningEffort === true) delete current.reasoningEffort
      initial = current
    }
  }
  return selected ?? initial
}

export const inspectChildRecovery = (input: { parentSessionId: string; childId: string; inspection: unknown; catalog: unknown; notBefore?: number }): ChildRecoveryEvidence => {
  const base = { parentSessionId: input.parentSessionId, childId: input.childId, continuable: false, settled: false }
  const reject = (reason: string): ChildRecoveryEvidence => ({ ...base, reason })
  if (!object(input.inspection) || !object(input.inspection.meta) || !Array.isArray(input.inspection.events) || !integer(input.inspection.inheritedEventCount)
    || input.inspection.inheritedEventCount > input.inspection.events.length || input.inspection.events.length > 200000) return reject('invalid-host-inspection')
  if (input.inspection.meta.id !== input.childId || input.inspection.meta.parentSession !== input.parentSessionId) return reject('parent-child-lineage-mismatch')
  if (!Array.isArray(input.catalog) || !input.catalog.some((item) => object(item) && item.id === input.childId && item.mode === 'continuable')) return reject('parent-catalog-does-not-own-continuable-child')
  const own = input.inspection.events.slice(input.inspection.inheritedEventCount)
  // The Host's public fold uses the FIRST own descriptor; inherited or later facts cannot rewrite identity.
  const descriptorEvent = own.find((event) => object(event) && event.type === 'subagent/descriptor')
  const descriptor = object(descriptorEvent) ? descriptorEvent.data : undefined
  if (!object(descriptor) || descriptor.version !== 3 || descriptor.mode !== 'continuable' || typeof descriptor.provider !== 'string' || descriptor.provider === '' || typeof descriptor.label !== 'string') return reject('unsupported-own-continuation-descriptor')
  let open: number | undefined
  let latest = -1
  let stopReason: string | undefined
  let turnStartedAt: number | undefined
  let settledAt: number | undefined
  let deliveryAfterEnd = false
  for (const event of own) {
    if (!object(event)) return reject('invalid-host-event')
    if (event.type === 'user/message' && open === undefined && latest >= 0 && (!object(event.data) || !object(event.data.source) || event.data.source.kind !== 'compact-checkpoint')) deliveryAfterEnd = true
    if (event.type !== 'turn/start' && event.type !== 'turn/end') continue
    if (!object(event.data) || !integer(event.data.turn)) return reject('invalid-host-turn')
    const turn = event.data.turn
    if (event.type === 'turn/start') {
      if (open !== undefined || turn <= latest) return reject('conflicting-host-turns')
      open = turn; latest = turn; stopReason = undefined; settledAt = undefined; deliveryAfterEnd = false
      turnStartedAt = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
    } else {
      if (open !== turn || !object(event.data.reason) || typeof event.data.reason.kind !== 'string') return reject('unpaired-host-turn-end')
      open = undefined; stopReason = event.data.reason.kind
      settledAt = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : undefined
    }
  }
  if (latest < 0) return { ...base, continuable: true, reason: 'no-own-completed-turn' }
  if (open !== undefined) return { ...base, continuable: true, turn: latest, reason: 'host-turn-still-open' }
  if (deliveryAfterEnd) return { ...base, continuable: true, turn: latest, reason: 'delivery-after-last-closed-turn' }
  if (input.notBefore !== undefined && (!Number.isFinite(input.notBefore) || turnStartedAt === undefined || turnStartedAt < input.notBefore)) return { ...base, continuable: true, turn: latest, ...(turnStartedAt === undefined ? {} : { turnStartedAt }), reason: 'last-closed-turn-predates-bound-delegation' }
  // Cold query may synthesize an interrupted closer for an orphaned run. It is
  // explicitly recovery-required, not evidence that the original run settled.
  const settled = stopReason !== undefined && ['completed', 'aborted', 'error', 'blocked', 'max-tokens'].includes(stopReason)
  return { ...base, continuable: true, settled, turn: latest, ...(turnStartedAt === undefined ? {} : { turnStartedAt }), ...(settledAt === undefined ? {} : { settledAt }), ...(stopReason === undefined ? {} : { stopReason }), ...(settled ? {} : { reason: 'host-turn-requires-reconciliation' }) }
}
