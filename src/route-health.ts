import type { RouteInfo } from './routes.js'
import { randomUUID } from 'node:crypto'
import { getRouteRecoveryPolicy, getRouteResourcePolicy, type NormalizedRouteFailure } from './provider-policy.js'

export interface RouteHealthEntry {
  key: string
  kind: NormalizedRouteFailure['kind']
  failedAt: number
  /** Identifies one observed failure across independent root snapshots. */
  failureId?: string
  /** Explicit provider reset timestamp; manual retries cannot bypass this floor. */
  resetAt?: number
  /** Earliest plugin recovery probe, not a claim that a subscription has reset. */
  retryAt?: number
  retryCount?: number
  halfOpenAgent?: string
  route: RouteInfo
  aliases?: string[]
}
export interface RouteHealthClear { key: string; failedAt: number; failureId?: string; clearedAt: number }
export interface RouteHealthSnapshot { schemaVersion: 1; entries: RouteHealthEntry[]; cleared: RouteHealthClear[] }
/** All aliases and clear barriers share one bounded identity space; none are evicted by age/LRU. */
export const MAX_ROUTE_HEALTH_KEYS = 4096
const FAILURE_KINDS = new Set(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'context_exceeded', 'capability_mismatch', 'unknown'])
export interface RouteManualRetryResult {
  ok: boolean
  keys: string[]
  reason?: 'provider-reset-pending' | 'cooldown-pending' | 'retry-in-flight' | 'invalid-owner'
  retryAt?: number
}
const keyValid = (key: unknown): key is string => typeof key === 'string' && key.length <= 2048 && /^(?:route|domain|pool):[^\x00-\x1f]+$/.test(key)
const unsafeIdentifier = (value: string): boolean => ['__proto__', 'constructor', 'prototype'].includes(value)
const routeValid = (raw: unknown): raw is RouteInfo => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const route = raw as RouteInfo
  if (![route.provider, route.model].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !unsafeIdentifier(value) && !/[\x00-\x1f]/.test(value))) return false
  if (route.reasoningEffort !== undefined && (typeof route.reasoningEffort !== 'string' || route.reasoningEffort.length === 0 || route.reasoningEffort.length > 64 || unsafeIdentifier(route.reasoningEffort))) return false
  const policy = route.policy
  if (policy === undefined) return true
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return false
  if (policy.accessMode !== undefined && !['subscription', 'metered_api', 'judgment_api', 'unknown'].includes(policy.accessMode)) return false
  if (policy.quotaScope !== undefined && !['account', 'plan', 'model', 'pool', 'unknown'].includes(policy.quotaScope)) return false
  for (const id of [policy.quotaDomainId, policy.poolId]) if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > 512 || unsafeIdentifier(id) || /[\x00-\x1f]/.test(id))) return false
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
const persistedAliases = (entry: RouteHealthEntry): string[] => {
  const policy = getRouteResourcePolicy(entry.route)
  return entry.aliases ?? [...new Set([entry.key, routeKey(entry.route), `route:${entry.route.provider}/${entry.route.model}`,
    ...(entry.key.startsWith('domain:') && policy.quotaDomainId !== undefined && ['account', 'plan'].includes(policy.quotaScope ?? 'unknown') ? [`domain:${policy.quotaDomainId}`] : [])])]
}
const finiteTime = (raw: unknown): raw is number => typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
const failureIdValid = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(raw)
const isObject = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
const parseSnapshot = (raw: unknown, allowLiveClaims: boolean): RouteHealthSnapshot => {
  if (!Array.isArray(raw) && (!isObject(raw) || raw.schemaVersion !== 1 || Object.keys(raw).some((key) => !['schemaVersion', 'entries', 'cleared'].includes(key)) || !Array.isArray(raw.entries) || !Array.isArray(raw.cleared))) throw new Error('invalid-route-health-snapshot')
  const snapshot = Array.isArray(raw) ? { schemaVersion: 1 as const, entries: raw, cleared: [] } : raw as unknown as RouteHealthSnapshot
  if (snapshot.entries.length > MAX_ROUTE_HEALTH_KEYS || snapshot.cleared.length > MAX_ROUTE_HEALTH_KEYS) throw new Error('invalid-route-health-snapshot')
  const ids = new Set<string>(), keys = new Set<string>()
  for (const entry of snapshot.entries) {
    if (!isObject(entry) || Object.keys(entry).some((key) => !['key', 'kind', 'failedAt', 'failureId', 'resetAt', 'retryAt', 'retryCount', 'route', 'aliases', ...(allowLiveClaims ? ['halfOpenAgent'] : [])].includes(key))
      || !keyValid(entry.key) || ids.has(entry.key) || typeof entry.kind !== 'string' || !FAILURE_KINDS.has(entry.kind) || !routeValid(entry.route) || !finiteTime(entry.failedAt)
      || (entry.failureId !== undefined && !failureIdValid(entry.failureId))
      || (entry.resetAt !== undefined && !finiteTime(entry.resetAt)) || (entry.retryAt !== undefined && !finiteTime(entry.retryAt))
      || (entry.retryCount !== undefined && (typeof entry.retryCount !== 'number' || !Number.isInteger(entry.retryCount) || entry.retryCount < 0 || entry.retryCount > 32))
      || (entry.halfOpenAgent !== undefined && (typeof entry.halfOpenAgent !== 'string' || entry.halfOpenAgent.length === 0 || entry.halfOpenAgent.length > 512))
      || (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.length > MAX_ROUTE_HEALTH_KEYS || !entry.aliases.every(keyValid) || new Set(entry.aliases).size !== entry.aliases.length))) throw new Error('invalid-route-health-entry')
    ids.add(entry.key)
    keys.add(entry.key)
    for (const key of persistedAliases(entry as unknown as RouteHealthEntry)) keys.add(key)
  }
  ids.clear()
  for (const marker of snapshot.cleared) {
    if (!isObject(marker) || Object.keys(marker).some((key) => !['key', 'failedAt', 'failureId', 'clearedAt'].includes(key)) || !keyValid(marker.key) || ids.has(marker.key)
      || !finiteTime(marker.failedAt) || !finiteTime(marker.clearedAt) || marker.clearedAt < marker.failedAt
      || (marker.failureId !== undefined && !failureIdValid(marker.failureId))) throw new Error('invalid-route-health-clear')
    ids.add(marker.key); keys.add(marker.key)
  }
  if (keys.size > MAX_ROUTE_HEALTH_KEYS) throw new Error('route-health-capacity-recovery-required')
  return structuredClone(snapshot)
}
/** One stable validator is shared by persistence and the live registry. */
export const validateRouteHealthSnapshot = (raw: unknown): raw is RouteHealthSnapshot | RouteHealthEntry[] => {
  try { parseSnapshot(raw, false); return true } catch { return false }
}

/** 一个 profile 内所有根会话、角色与线程共享。释放 Agent 不会清除隔离状态。 */
export const intRouteHealth = (now: () => number = Date.now) => {
  const entries = new Map<string, RouteHealthEntry>()
  const cleared = new Map<string, RouteHealthClear>()
  const manualClaims = new WeakSet<RouteHealthEntry>()
  const requireCapacity = (incoming: Iterable<string>): void => {
    const keys = new Set([...entries.keys(), ...cleared.keys(), ...incoming])
    if (keys.size > MAX_ROUTE_HEALTH_KEYS) throw new Error('route-health-capacity-recovery-required')
  }
  const suppressed = (key: string, entry: RouteHealthEntry): boolean => {
    const marker = cleared.get(key)
    return marker !== undefined && marker.clearedAt >= (entry.resetAt ?? 0)
      && (entry.failedAt < marker.failedAt || (entry.failedAt === marker.failedAt && (entry.failureId === undefined || marker.failureId === undefined || entry.failureId === marker.failureId)))
  }
  const markClear = (key: string, entry: RouteHealthEntry): void => {
    const previous = cleared.get(key)
    if (previous === undefined || previous.failedAt <= entry.failedAt) cleared.set(key, { key, failedAt: entry.failedAt,
      ...(entry.failureId === undefined ? {} : { failureId: entry.failureId }), clearedAt: Math.max(now(), entry.failedAt) })
  }
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
      const clock = now()
      // Billing identity proves shared quota, not shared credentials or a shared model catalog.
      const domainWide = failure.quotaDomainId !== undefined && ['account', 'plan'].includes(failure.quotaScope ?? 'unknown')
        && ['quota_exhausted', 'insufficient_balance'].includes(failure.kind)
      const enriched = { ...route, policy: { ...route.policy, ...(failure.quotaDomainId === undefined ? {} : { quotaDomainId: failure.quotaDomainId }) } }
      const key = (failure.kind === 'pool_exhausted' || failure.quotaScope === 'pool') && failure.poolId !== undefined ? `pool:${failure.poolId}`
        : domainWide ? `domain:${failure.quotaDomainId}` : routeKey(route)
      const resetAt = failure.resetAt === undefined ? undefined : Date.parse(failure.resetAt)
      const previous = entries.get(key)
      const sourcePolicy = getRouteResourcePolicy(route)
      const aliases = [...new Set([key, routeKey(route), routeKey(enriched), `route:${route.provider}/${route.model}`,
        ...(domainWide && sourcePolicy.quotaDomainId !== undefined && ['account', 'plan'].includes(sourcePolicy.quotaScope ?? 'unknown') ? [`domain:${sourcePolicy.quotaDomainId}`] : []),
        ...(previous?.aliases ?? [])])]
      requireCapacity(aliases)
      // A per-resource logical millisecond disambiguates later failures even
      // when the clock does not advance or moves backwards. Reset floors are separate.
      const at = Math.max(clock, ...aliases.map((alias) => Math.max(entries.get(alias)?.failedAt ?? -1, cleared.get(alias)?.failedAt ?? -1) + 1))
      const retryCount = previous?.kind === failure.kind ? Math.min(32, (previous.retryCount ?? 1) + 1) : 1
      const policy = getRouteRecoveryPolicy({ ...failure, ...(cooldownMs === undefined ? {} : { providerRetryAfterMs: cooldownMs }) }, retryCount)
      const providerReset = Math.max(previous?.resetAt ?? 0, resetAt !== undefined && Number.isFinite(resetAt) ? resetAt : 0) || undefined
      const entry: RouteHealthEntry = { key, kind: failure.kind, failedAt: at, failureId: randomUUID(), route: snapshotRoute(route), retryCount,
        retryAt: Math.max(at, providerReset !== undefined && providerReset > clock ? providerReset : clock + policy.retryDelayMs),
        ...(providerReset === undefined ? {} : { resetAt: providerReset }) }
      if (previous !== undefined) for (const [alias, linked] of entries) if (linked === previous) setAlias(alias, entry)
      setAlias(key, entry)
      // 未携带元数据的后续请求仍能识别确切已失败的路由。
      if (key !== routeKey(route)) setAlias(routeKey(route), entry)
      if (key !== routeKey(enriched)) setAlias(routeKey(enriched), entry)
      setAlias(`route:${route.provider}/${route.model}`, entry)
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
    succeeded: (route: RouteInfo, agentId: string): boolean => {
      const restored = new Set(keysOf(route).map((key) => entries.get(key)).filter((entry) => entry?.halfOpenAgent === agentId && now() >= (entry.resetAt ?? 0)))
      for (const entry of restored) if (entry !== undefined) manualClaims.delete(entry)
      for (const [key, entry] of entries) if (restored.has(entry)) { markClear(key, entry); entries.delete(key) }
      return restored.size > 0
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
        entry.failedAt = Math.max(now(), entry.failedAt + 1)
        entry.failureId = randomUUID()
      }
      return failed
    },
    clear: (key?: string): void => {
      const target = key === undefined ? undefined : entries.get(key)
      for (const [entryKey, entry] of entries) if ((key === undefined || entry === target) && now() >= (entry.resetAt ?? 0)) { markClear(entryKey, entry); entries.delete(entryKey) }
    },
    list: (): RouteHealthEntry[] => [...new Set(entries.values())].map((entry) => structuredClone(entry)),
    getSnapshot: (): RouteHealthSnapshot => ({ schemaVersion: 1, entries: [...new Set(entries.values())].map(({ halfOpenAgent: _owner, ...entry }) => structuredClone(entry)), cleared: structuredClone([...cleared.values()]) }),
    restore: (raw: unknown): void => {
      const snapshot = parseSnapshot(raw, true)
      const restored: RouteHealthEntry[] = []
      for (const entry of snapshot.entries) {
        if (!getRouteRecoveryPolicy(entry).isolate) continue
        restored.push({ key: entry.key, kind: entry.kind, failedAt: entry.failedAt, route: snapshotRoute(entry.route),
          ...(entry.failureId === undefined ? {} : { failureId: entry.failureId }),
          ...(entry.resetAt === undefined ? {} : { resetAt: entry.resetAt }),
          retryCount: entry.retryCount ?? 1,
          retryAt: Math.max(entry.resetAt ?? 0, entry.retryAt ?? legacyRetryAt(entry)),
          aliases: [...persistedAliases(entry)] })
      }
      requireCapacity([...snapshot.cleared.map((marker) => marker.key), ...restored.flatMap((entry) => [entry.key, ...(entry.aliases ?? [])])])
      for (const marker of snapshot.cleared) {
        const current = cleared.get(marker.key)
        if (current === undefined || current.failedAt < marker.failedAt || (current.failedAt === marker.failedAt && current.clearedAt < marker.clearedAt)) cleared.set(marker.key, marker)
      }
      // A learned successful recovery removes only the failures it actually superseded.
      for (const [key, entry] of entries) if (suppressed(key, entry)) entries.delete(key)
      // 原子校验后才合并，恢复不清除其他根会话的更新隔离状态，也不恢复live half-open所有者。
      for (const entry of restored) {
        for (const alias of entry.aliases ?? []) {
          if (suppressed(alias, entry)) continue
          const existing = entries.get(alias)
          if (existing !== undefined && (existing.halfOpenAgent !== undefined || existing.failedAt >= entry.failedAt)) continue
          setAlias(alias, entry)
        }
        if (!suppressed(entry.key, entry)) {
          const current = entries.get(entry.key)
          if (current === undefined || (current.halfOpenAgent === undefined && current.failedAt < entry.failedAt)) setAlias(entry.key, entry)
        }
      }
    }
  }
}
export type RouteHealth = ReturnType<typeof intRouteHealth>
