import type { RouteInfo } from './routes.js'
import { getRouteResourcePolicy, type NormalizedRouteFailure } from './provider-policy.js'

export interface RouteHealthEntry {
  key: string
  kind: NormalizedRouteFailure['kind']
  failedAt: number
  resetAt?: number
  halfOpenAgent?: string
  route: RouteInfo
  aliases?: string[]
}
const FAILURE_KINDS = new Set(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'unknown'])
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
  const setAlias = (key: string, entry: RouteHealthEntry): void => {
    const old = entries.get(key)
    if (old !== undefined && old !== entry) old.aliases = old.aliases?.filter((alias) => alias !== key)
    entries.set(key, entry)
    entry.aliases = [...new Set([...(entry.aliases ?? []), key])]
  }
  const getBlocked = (route: RouteInfo): RouteHealthEntry | undefined => keysOf(route).map((key) => entries.get(key)).find((entry) => entry !== undefined)
  return {
    record: (route: RouteInfo, failure: NormalizedRouteFailure, cooldownMs?: number): void => {
      const domainWide = failure.quotaDomainId !== undefined && ['account', 'plan'].includes(failure.quotaScope ?? 'unknown') && failure.kind !== 'model_unavailable' && failure.kind !== 'pool_exhausted'
      const enriched = { ...route, policy: { ...route.policy, ...(failure.quotaDomainId === undefined ? {} : { quotaDomainId: failure.quotaDomainId }) } }
      const key = (failure.kind === 'pool_exhausted' || failure.quotaScope === 'pool') && failure.poolId !== undefined ? `pool:${failure.poolId}`
        : domainWide ? `domain:${failure.quotaDomainId}` : routeKey(route)
      const resetAt = failure.resetAt === undefined ? undefined : Date.parse(failure.resetAt)
      const entry: RouteHealthEntry = { key, kind: failure.kind, failedAt: now(), route: snapshotRoute(route),
        ...(resetAt !== undefined && Number.isFinite(resetAt) ? { resetAt } : cooldownMs !== undefined ? { resetAt: now() + cooldownMs } : {}) }
      const previous = entries.get(key)
      if (previous !== undefined) for (const [alias, linked] of entries) if (linked === previous) setAlias(alias, entry)
      setAlias(key, entry)
      // 未携带元数据的后续请求仍能识别确切已失败的路由。
      if (key !== routeKey(route)) setAlias(routeKey(route), entry)
      if (key !== routeKey(enriched)) setAlias(routeKey(enriched), entry)
      setAlias(`route:${route.provider}/${route.model}`, entry)
      const sourcePolicy = getRouteResourcePolicy(route)
      if (domainWide && sourcePolicy.quotaDomainId !== undefined && ['account', 'plan'].includes(sourcePolicy.quotaScope ?? 'unknown')) setAlias(`domain:${sourcePolicy.quotaDomainId}`, entry)
    },
    isAvailable: (route: RouteInfo): boolean => {
      const entry = getBlocked(route)
      return entry === undefined || (entry.resetAt !== undefined && now() >= entry.resetAt && entry.halfOpenAgent === undefined)
    },
    claim: (route: RouteInfo, agentId: string): boolean => {
      const blocked = keysOf(route).map((key) => entries.get(key)).filter((entry): entry is RouteHealthEntry => entry !== undefined)
      if (blocked.some((entry) => entry.resetAt === undefined || now() < entry.resetAt || (entry.halfOpenAgent !== undefined && entry.halfOpenAgent !== agentId))) return false
      for (const entry of blocked) entry.halfOpenAgent = agentId
      return true
    },
    succeeded: (route: RouteInfo, agentId: string): void => {
      const restored = new Set(keysOf(route).map((key) => entries.get(key)).filter((entry) => entry?.halfOpenAgent === agentId))
      for (const [key, entry] of entries) if (restored.has(entry)) entries.delete(key)
    },
    failHalfOpen: (route: RouteInfo, agentId: string): boolean => {
      let failed = false
      for (const entry of new Set(keysOf(route).map((key) => entries.get(key)))) {
        if (entry?.halfOpenAgent !== agentId) continue
        failed = true
        entry.halfOpenAgent = undefined
        entry.resetAt = undefined // 一次受控验证失败；不能仅因旧 reset 时间已过不断重开。
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
          || (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.length > 4096 || !entry.aliases.every(keyValid)))) throw new Error('invalid-route-health-entry')
        seen.add(entry.key)
        const sourcePolicy = getRouteResourcePolicy(entry.route)
        const legacyAliases = [entry.key, routeKey(entry.route), `route:${entry.route.provider}/${entry.route.model}`,
          ...(entry.key.startsWith('domain:') && sourcePolicy.quotaDomainId !== undefined && ['account', 'plan'].includes(sourcePolicy.quotaScope ?? 'unknown') ? [`domain:${sourcePolicy.quotaDomainId}`] : [])]
        restored.push({ key: entry.key, kind: entry.kind, failedAt: entry.failedAt, route: snapshotRoute(entry.route),
          ...(entry.resetAt === undefined ? {} : { resetAt: entry.resetAt }),
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
