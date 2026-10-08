import type { RouteInfo } from './routes.js'
import { getRouteRecoveryPolicy, getRouteResourcePolicy, type NormalizedRouteFailure } from './provider-policy.js'

export interface RouteHealthEntry {
  key: string
  kind: NormalizedRouteFailure['kind']
  failedAt: number
  /** Explicit provider reset timestamp; manual retries cannot bypass this floor. */
  resetAt?: number
  /** Earliest plugin recovery probe, not a claim that a subscription has reset. */
  retryAt?: number
  retryCount?: number
  halfOpenAgent?: string
  route: RouteInfo
  aliases?: string[]
}
const FAILURE_KINDS = new Set(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'context_exceeded', 'capability_mismatch', 'unknown'])
export interface RouteManualRetryResult {
  ok: boolean
  keys: string[]
  reason?: 'provider-reset-pending' | 'cooldown-pending' | 'retry-in-flight' | 'invalid-owner'
  retryAt?: number
}
const keyValid = (key: unknown): key is string => typeof key === 'string' && key.length <= 2048 && /^(?:route|domain|pool):[^\x00-\x1f]+$/.test(key)
const routeValid = (raw: unknown): raw is RouteInfo => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const route = raw as RouteInfo
  if (![route.provider, route.model].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value))) return false
  if (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || route.reasoningEffort.length > 64)) return false
  const policy = route.policy
  if (policy === undefined) return true
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return false
  if (policy.accessMode !== undefined && !['subscription', 'metered_api', 'judgment_api', 'unknown'].includes(policy.accessMode)) return false
  if (policy.quotaScope !== undefined && !['account', 'plan', 'model', 'pool', 'unknown'].includes(policy.quotaScope)) return false
  for (const id of [policy.quotaDomainId, policy.poolId]) if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 512 || /[\x00-\x1f]/.test(id))) return false
  return policy.capabilities === undefined || (policy.capabilities !== null && typeof policy.capabilities === 'object' && !Array.isArray(policy.capabilities) && Object.values(policy.capabilities).every((value) => typeof value === 'boolean'))
}
const snapshotRoute = (route: RouteInfo): RouteInfo => ({ provider: route.provider, model: route.model,
  ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  ...(route.policy === undefined ? {} : { policy: structuredClone(route.policy) }) })
const routeKey = (route: RouteInfo): string => `route:${route.provider}/${route.model}${getRouteResourcePolicy(route).quotaDomainId === undefined ? '' : `@${getRouteResourcePolicy(route).quotaDomainId}`}`
const keysOf = (route: RouteInfo): string[] => [
  routeKey(route),
  ...(getRouteResourcePolicy(route).poolId === undefined ? [] : [`pool:${getRouteResourcePolicy(route).poolId}`]),
  ...(getRouteResourcePolicy(route).quotaDomainId === undefined ? [] : [`domain:${getRouteResourcePolicy(route).quotaDomainId}`])
]

/** 一个 profile 内所有根会话、角色与线程共享。释放 Agent 不会清除隔离状态。 */
export const intRouteHealth = (now: () => number = Date.now) => {
  const entries = new Map<string, RouteHealthEntry>()
  const manualClaims = new WeakSet<RouteHealthEntry>()
  const setAlias = (key: string, entry: RouteHealthEntry): void => {
    const old = entries.get(key)
    if (old !== undefined && old !== entry) old.aliases = old.aliases?.filter((alias) => alias !== key)
    entries.set(key, entry)
    entry.aliases = [...new Set([...(entry.aliases ?? []), key])]
  }
  const blockedEntries = (route: RouteInfo): RouteHealthEntry[] => [...new Set(keysOf(route).map((key) => entries.get(key)).filter((entry): entry is RouteHealthEntry => entry !== undefined))]
  const legacyRetryAt = (entry: RouteHealthEntry): number => entry.resetAt !== undefined && entry.resetAt > entry.failedAt
    ? entry.resetAt : entry.failedAt + getRouteRecoveryPolicy(entry, entry.retryCount ?? 1).retryDelayMs
  const dueAt = (entry: RouteHealthEntry): number => Math.max(entry.resetAt ?? 0, entry.retryAt ?? legacyRetryAt(entry))
  const record = (route: RouteInfo, failure: NormalizedRouteFailure, cooldownMs?: number): void => {
      if (!getRouteRecoveryPolicy(failure).isolate) return
      const at = now()
      // Billing identity proves shared quota, not shared credentials or a shared model catalog.
      const domainWide = failure.quotaDomainId !== undefined && ['account', 'plan'].includes(failure.quotaScope ?? 'unknown')
        && ['quota_exhausted', 'insufficient_balance'].includes(failure.kind)
      const enriched = { ...route, policy: { ...route.policy, ...(failure.quotaDomainId === undefined ? {} : { quotaDomainId: failure.quotaDomainId }) } }
      const key = (failure.kind === 'pool_exhausted' || failure.quotaScope === 'pool') && failure.poolId !== undefined ? `pool:${failure.poolId}`
        : domainWide ? `domain:${failure.quotaDomainId}` : routeKey(route)
      const resetAt = failure.resetAt === undefined ? undefined : Date.parse(failure.resetAt)
      const previous = entries.get(key)
      const retryCount = previous?.kind === failure.kind ? Math.min(32, (previous.retryCount ?? 1) + 1) : 1
      const policy = getRouteRecoveryPolicy({ ...failure, ...(cooldownMs === undefined ? {} : { providerRetryAfterMs: cooldownMs }) }, retryCount)
      const providerReset = resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : undefined
      const entry: RouteHealthEntry = { key, kind: failure.kind, failedAt: at, route: snapshotRoute(route), retryCount,
        retryAt: providerReset !== undefined && providerReset > at ? providerReset : at + policy.retryDelayMs,
        ...(providerReset === undefined ? {} : { resetAt: providerReset }) }
      if (previous !== undefined) for (const [alias, linked] of entries) if (linked === previous) setAlias(alias, entry)
      setAlias(key, entry)
      // 未携带元数据的后续请求仍能识别确切已失败的路由。
      if (key !== routeKey(route)) setAlias(routeKey(route), entry)
      if (key !== routeKey(enriched)) setAlias(routeKey(enriched), entry)
      setAlias(`route:${route.provider}/${route.model}`, entry)
      const sourcePolicy = getRouteResourcePolicy(route)
      if (domainWide && sourcePolicy.quotaDomainId !== undefined && ['account', 'plan'].includes(sourcePolicy.quotaScope ?? 'unknown')) setAlias(`domain:${sourcePolicy.quotaDomainId}`, entry)
    }
  return {
    record,
    /** Admission eligibility only: an elapsed cooldown permits a probe, not a claim of restored quota. */
    isAvailable: (route: RouteInfo): boolean => {
      const at = now()
      return blockedEntries(route).every((entry) => at >= dueAt(entry) && entry.halfOpenAgent === undefined)
    },
    claim: (route: RouteInfo, agentId: string): boolean => {
      const blocked = blockedEntries(route)
      const at = now()
      if (blocked.some((entry) => (entry.halfOpenAgent !== undefined && entry.halfOpenAgent !== agentId)
        || at < (entry.resetAt ?? 0) || (at < dueAt(entry) && !(entry.halfOpenAgent === agentId && manualClaims.has(entry))))) return false
      for (const entry of blocked) entry.halfOpenAgent = agentId
      return true
    },
    /** User-controlled, scoped permit. force only bypasses plugin cooldown, never provider reset. */
    claimManualRetry: (route: RouteInfo, agentId: string, options: { force?: boolean } = {}): RouteManualRetryResult => {
      const blocked = blockedEntries(route)
      const keys = blocked.map((entry) => entry.key)
      if (!agentId || agentId.length > 512 || /[\x00-\x1f]/.test(agentId)) return { ok: false, keys, reason: 'invalid-owner' }
      const at = now()
      const providerReset = Math.max(0, ...blocked.map((entry) => entry.resetAt ?? 0))
      if (at < providerReset) return { ok: false, keys, reason: 'provider-reset-pending', retryAt: providerReset }
      if (blocked.some((entry) => entry.halfOpenAgent !== undefined)) return { ok: false, keys, reason: 'retry-in-flight' }
      const retryAt = Math.max(0, ...blocked.map(dueAt))
      if (!options.force && at < retryAt) return { ok: false, keys, reason: 'cooldown-pending', retryAt }
      for (const entry of blocked) { entry.halfOpenAgent = agentId; manualClaims.add(entry) }
      return { ok: true, keys }
    },
    getRelatedEntries: (route: RouteInfo): RouteHealthEntry[] => blockedEntries(route).map((entry) => structuredClone(entry)),
    /** Cancellation releases an in-flight probe; it never restores a failed resource as healthy. */
    release: (agentId: string): void => {
      for (const entry of new Set(entries.values())) if (entry.halfOpenAgent === agentId) { entry.halfOpenAgent = undefined; manualClaims.delete(entry) }
    },
    succeeded: (route: RouteInfo, agentId: string): void => {
      const restored = new Set(keysOf(route).map((key) => entries.get(key)).filter((entry) => entry?.halfOpenAgent === agentId))
      for (const entry of restored) if (entry !== undefined) manualClaims.delete(entry)
      for (const [key, entry] of entries) if (restored.has(entry)) entries.delete(key)
    },
    failHalfOpen: (route: RouteInfo, agentId: string): boolean => {
      let failed = false
      for (const entry of new Set(keysOf(route).map((key) => entries.get(key)))) {
        if (entry?.halfOpenAgent !== agentId) continue
        failed = true
        entry.halfOpenAgent = undefined
        manualClaims.delete(entry)
        // Re-arm a bounded probe delay; the following definitive record increments retryCount.
        entry.retryAt = Math.max(entry.resetAt ?? 0, now() + getRouteRecoveryPolicy(entry, (entry.retryCount ?? 1) + 1).retryDelayMs)
        entry.failedAt = now()
      }
      return failed
    },
    clear: (key?: string): void => {
      if (key === undefined) { entries.clear(); return }
      const target = entries.get(key)
      for (const [entryKey, entry] of entries) if (entry === target) entries.delete(entryKey)
    },
    list: (): RouteHealthEntry[] => [...new Set(entries.values())].map((entry) => structuredClone(entry)),
    restore: (raw: unknown): void => {
      if (!Array.isArray(raw) || raw.length > 4096) throw new Error('invalid-route-health-snapshot')
      const restored: RouteHealthEntry[] = []
      const seen = new Set<string>()
      for (const value of raw) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-route-health-entry')
        const entry = value as RouteHealthEntry
        if (!keyValid(entry.key) || seen.has(entry.key) || !FAILURE_KINDS.has(entry.kind) || !routeValid(entry.route)
          || !Number.isFinite(entry.failedAt) || entry.failedAt < 0
          || (entry.resetAt !== undefined && (!Number.isFinite(entry.resetAt) || entry.resetAt < 0))
          || (entry.retryAt !== undefined && (!Number.isFinite(entry.retryAt) || entry.retryAt < 0))
          || (entry.retryCount !== undefined && (!Number.isInteger(entry.retryCount) || entry.retryCount < 0 || entry.retryCount > 32))
          || (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.length > 4096 || !entry.aliases.every(keyValid)))) throw new Error('invalid-route-health-entry')
        seen.add(entry.key)
        if (!getRouteRecoveryPolicy(entry).isolate) continue
        const sourcePolicy = getRouteResourcePolicy(entry.route)
        const legacyAliases = [entry.key, routeKey(entry.route), `route:${entry.route.provider}/${entry.route.model}`,
          ...(entry.key.startsWith('domain:') && sourcePolicy.quotaDomainId !== undefined && ['account', 'plan'].includes(sourcePolicy.quotaScope ?? 'unknown') ? [`domain:${sourcePolicy.quotaDomainId}`] : [])]
        restored.push({ key: entry.key, kind: entry.kind, failedAt: entry.failedAt, route: snapshotRoute(entry.route),
          ...(entry.resetAt === undefined ? {} : { resetAt: entry.resetAt }),
          retryCount: entry.retryCount ?? 1,
          retryAt: Math.max(entry.resetAt ?? 0, entry.retryAt ?? legacyRetryAt(entry)),
          aliases: entry.aliases === undefined ? [...new Set(legacyAliases)] : [...entry.aliases] })
      }
      // 原子校验后才合并，恢复不清除其他根会话的更新隔离状态，也不恢复live half-open所有者。
      for (const entry of restored) {
        const current = entries.get(entry.key)
        if (current !== undefined && current.failedAt >= entry.failedAt) continue
        for (const alias of entry.aliases ?? []) {
          const existing = entries.get(alias)
          if (existing !== undefined && existing.failedAt > entry.failedAt) continue
          setAlias(alias, entry)
        }
        setAlias(entry.key, entry)
      }
    }
  }
}
export type RouteHealth = ReturnType<typeof intRouteHealth>
