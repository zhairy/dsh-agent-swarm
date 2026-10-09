import { getQuotaRouteId, mapQuotaRoutes, SUBSCRIPTION_QUOTA_PROVIDERS, type QuotaReader, type QuotaRpcInvoke } from './quota.js'
import { createQuotaRouteEvaluator, stableOrderQuotaRoutes, type QuotaPoolConfiguration, type QuotaRouteDecision, type QuotaRoutingInput } from './quota-routing.js'
import type { RouteInfo } from './routes.js'
import { getValueDigest } from './workflow.js'

const cancelled = () => new DOMException('Quota routing cancelled', 'AbortError')
/** End one bounded wait, never claim the underlying upstream operation was cancelled. */
const within = <T>(work: Promise<T>, milliseconds: number, signal?: AbortSignal, background = false): Promise<T> => {
  if (signal?.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (value?: T, error?: unknown) => {
      if (done) return
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      error === undefined ? resolve(value as T) : reject(error)
    }
    const abort = () => finish(undefined, cancelled())
    const timer = setTimeout(() => finish(undefined, new DOMException('Quota routing wait expired', 'TimeoutError')), milliseconds)
    if (background) timer.unref?.()
    signal?.addEventListener('abort', abort, { once: true })
    work.then(value => finish(value), error => finish(undefined, error))
    if (signal?.aborted) abort()
  })
}
/** Bound projection hashing; malformed settings cannot expand an automatic request without limit. */
const projectionKey = (value: unknown): string | undefined => {
  let nodes = 0, bytes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 24_576 || depth > 8) throw new Error('Projection limit')
    if (item === undefined || item === null || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item === 'string' && item.length <= 1024) { bytes += Buffer.byteLength(item); if (bytes > 256 * 1024) throw new Error('Projection bytes'); return }
    if (Array.isArray(item) && item.length <= 4096) { item.forEach(value => visit(value, depth + 1)); return }
    if (item !== null && typeof item === 'object' && Object.keys(item).length <= 512) { for (const value of Object.values(item)) visit(value, depth + 1); return }
    throw new Error('Projection format')
  }
  try { visit(value, 0); return getValueDigest(value) } catch { return undefined }
}
export interface QuotaRoutingSource {
  orderQuotaRoutes: (routes: readonly RouteInfo[], signal?: AbortSignal, protectedRoutes?: readonly RouteInfo[]) => Promise<readonly RouteInfo[]>
  succeeded: (route: RouteInfo) => void
  invalidate: () => void
  diagnostics: () => unknown
  dispose: () => void
}
/** Ephemeral source, separate from contracts, health tombstones and numerical task budgets. */
export const createQuotaRoutingSource = (deps: {
  reader: QuotaReader
  invoke: QuotaRpcInvoke
  getPoolConfiguration: () => QuotaPoolConfiguration | undefined
  getRegisteredProviders: () => readonly string[]
  available: () => boolean
  now?: () => number
  waitMs?: number
}): QuotaRoutingSource => {
  const now = deps.now ?? Date.now, waitMs = Math.min(1000, Math.max(1, deps.waitMs ?? 1000))
  let generation = 0, disposed = false
  type Data = { key: string; input: QuotaRoutingInput }
  let cached: Data | undefined, pending: Promise<Data | undefined> | undefined
  const last = new Map<string, QuotaRouteDecision>()
  const successes = new Map<string, { fingerprint?: string }>()
  let report: unknown = { source: 'dsh-plugin-subscriptions', status: 'not-read', authoritativeQuota: false }
  const context = () => {
    try {
    const poolConfiguration = deps.getPoolConfiguration()
    if (poolConfiguration === undefined || !deps.available()) return undefined
    const registeredProviders = [...new Set(deps.getRegisteredProviders())].sort()
    const key = projectionKey({ poolConfiguration, registeredProviders })
    return key === undefined ? undefined : { key, poolConfiguration, registeredProviders }
    } catch { return undefined }
  }
  const refresh = (scope: NonNullable<ReturnType<typeof context>>): Promise<Data | undefined> => {
    const capturedGeneration = generation
    const work = (async (): Promise<Data | undefined> => {
      const signal = AbortSignal.timeout(30_000)
      const providerSettings: Record<string, unknown> = {}
      const providers = SUBSCRIPTION_QUOTA_PROVIDERS.filter(provider => scope.registeredProviders.includes(provider) && (scope.poolConfiguration.providers?.includes(provider) ?? true))
      let cursor = 0
      const [quota] = await Promise.all([
        within(deps.reader.read(), 30_000, signal, true),
        Promise.all(Array.from({ length: Math.min(4, providers.length) }, async () => {
          while (cursor < providers.length) {
            const provider = providers[cursor++]
            try { providerSettings[provider] = await within(Promise.resolve().then(() => deps.invoke('subscriptions-auth.providerSettings', { provider, force: false }, signal)), 30_000, signal, true) }
            catch { /* Missing catalogs stay unknown; error bodies and account keys are never reflected. */ }
          }
        }))
      ])
      if (disposed || capturedGeneration !== generation || context()?.key !== scope.key) return undefined
      const value = { key: scope.key, input: { quota, poolConfiguration: scope.poolConfiguration, providerSettings, registeredProviders: scope.registeredProviders } }
      cached = value
      return value
    })().catch(() => undefined)
    let tracked: Promise<Data | undefined>
    tracked = work.finally(() => { if (pending === tracked) pending = undefined })
    pending = tracked
    return tracked
  }
  return {
    async orderQuotaRoutes(routes, signal, protectedRoutes = []) {
      if (signal?.aborted) throw cancelled()
      if (disposed || routes.length < 2) return [...routes]
      const scope = context()
      if (scope === undefined) { report = { source: 'dsh-plugin-subscriptions', status: 'unavailable', authoritativeQuota: false }; return [...routes] }
      let data = cached?.key === scope.key && now() >= cached.input.quota.readAt && now() - cached.input.quota.readAt < 30_000 ? cached : undefined
      if (data === undefined) {
        try { data = await within(pending ?? refresh(scope), waitMs, signal) }
        catch { if (signal?.aborted) throw cancelled(); report = { source: 'dsh-plugin-subscriptions', status: 'unknown-timeout', authoritativeQuota: false }; return [...routes] }
      }
      if (signal?.aborted) throw cancelled()
      if (disposed) return [...routes]
      if (data === undefined || data.key !== context()?.key) { report = { source: 'dsh-plugin-subscriptions', status: 'unknown-context-changed', authoritativeQuota: false }; return [...routes] }
      const input = { ...data.input, quota: { ...data.input.quota, routes: mapQuotaRoutes(routes, data.input.quota.providers) }, now: now() }
      const evaluate = createQuotaRouteEvaluator(input)
      const byId = new Map<string, QuotaRouteDecision>()
      for (const route of routes) {
        const id = getQuotaRouteId(route.provider, route.model)
        if (!byId.has(id)) byId.set(id, evaluate(route))
      }
      const decisions = [...byId.values()]
      for (const decision of decisions) { last.delete(decision.routeId); last.set(decision.routeId, decision); if (last.size > 512) last.delete(last.keys().next().value!) }
      const ordered = stableOrderQuotaRoutes(routes, route => {
        const decision = byId.get(getQuotaRouteId(route.provider, route.model))
        if (decision === undefined) return undefined
        const success = successes.get(decision.routeId)
        if (success !== undefined && decision.hint !== 'unknown') {
          success.fingerprint ??= decision.fingerprint
          if (success.fingerprint === decision.fingerprint) return { ...decision, hint: 'unknown' }
        }
        return decision
      }, protectedRoutes)
      report = { source: 'dsh-plugin-subscriptions', status: 'observed', authoritativeQuota: false, sampledAt: null, readAt: data.input.quota.readAt,
        reordered: routes.some((route, index) => route !== ordered[index]), decisions: decisions.slice(0, 32).map(value => ({ routeId: value.routeId, hint: value.hint, eligibility: value.eligibility, hardSkip: value.hardSkip, membership: value.membership.status, fingerprint: value.fingerprint, reason: value.reason })) }
      return ordered
    },
    succeeded(route) {
      if (disposed) return
      const id = getQuotaRouteId(route.provider, route.model), decision = last.get(id)
      successes.delete(id); successes.set(id, { ...(decision !== undefined && decision.hint !== 'unknown' ? { fingerprint: decision.fingerprint } : {}) })
      if (successes.size > 512) successes.delete(successes.keys().next().value!)
    },
    invalidate() { generation++; cached = undefined; deps.reader.invalidate?.(); for (const [id, success] of successes) if (success.fingerprint === undefined) successes.delete(id) },
    diagnostics: () => structuredClone(report),
    dispose() { disposed = true; generation++; cached = undefined; last.clear(); successes.clear(); report = { source: 'dsh-plugin-subscriptions', status: 'disposed', authoritativeQuota: false } }
  }
}
