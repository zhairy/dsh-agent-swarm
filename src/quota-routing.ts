import { createHash } from 'node:crypto'
import { getRouteResourcePolicy } from './provider-policy.js'
import { getQuotaAccountId, getQuotaRouteId, parseQuotaAccountModel, SUBSCRIPTION_QUOTA_PROVIDERS, type QuotaAccount, type QuotaRouteInput, type QuotaView, type QuotaWindow } from './quota.js'

/** Only the active subscription entry's public pool projection belongs here. */
export interface QuotaPoolConfiguration {
  source: 'dsh-config-editor'
  namespace: string
  providers?: readonly string[]
  pool: unknown
}
export interface QuotaRoutingInput {
  quota: QuotaView
  poolConfiguration?: QuotaPoolConfiguration
  /** Unwrapped responses from the public subscriptions-auth.providerSettings RPC. */
  providerSettings: Readonly<Record<string, unknown>>
  registeredProviders: readonly string[]
  now?: number
}
export interface QuotaRouteMember {
  provider: string
  model: string
  accountId: string
}
export interface QuotaMembership {
  status: 'proven' | 'unknown'
  source: 'independent-account' | 'public-pool-configuration' | 'public-account-fallback' | 'unavailable'
  members: QuotaRouteMember[]
  reason: string
}
export interface QuotaRouteDecision {
  routeId: string
  eligibility: 'eligible' | 'exhausted' | 'unknown'
  hardSkip: boolean
  preference: 'neutral'
  hint: 'reported-capacity' | 'reported-full' | 'unknown'
  confidence: 'reported-possibly-cached' | 'insufficient-evidence'
  source: 'dsh-plugin-subscriptions'
  freshness: 'upstream-not-disclosed'
  sampledAt: null
  readAt: number
  scope: 'account' | 'pool' | 'unknown'
  /** Stable across re-reads of the same cached windows; excludes readAt. */
  fingerprint: string
  membership: QuotaMembership
  windowIds: string[]
  reason: string
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
const unknownMembership = (reason: string): QuotaMembership => ({ status: 'unknown', source: 'unavailable', members: [], reason })

/** Read only the exact active subscription entry and its non-secret pool projection. */
export const getSubscriptionPoolConfiguration = (editor: { entries(): readonly unknown[] } | undefined): QuotaPoolConfiguration | undefined => {
  try {
    const matches = (editor?.entries() ?? []).filter((entry) => object(entry) && object(entry.options) && entry.options.name === 'dsh-plugin-subscriptions' && object(entry.fiber) && entry.fiber.state === 2 && entry.fiber.runtime !== null && entry.fiber.runtime !== undefined)
    if (matches.length !== 1) return undefined
    const entry = matches[0] as Record<string, unknown>, options = entry.options as Record<string, unknown>, fiber = entry.fiber as Record<string, unknown>
    if (!text(options.id) || !object(fiber.config)) return undefined
    const providers = fiber.config.providers
    if (providers !== undefined && (!Array.isArray(providers) || providers.length > 5 || !providers.every((provider) => (SUBSCRIPTION_QUOTA_PROVIDERS as readonly unknown[]).includes(provider)))) return undefined
    const provenance = { source: 'dsh-config-editor' as const, namespace: options.id, ...(providers === undefined ? {} : { providers: [...providers] as string[] }) }
    const raw = fiber.config.pool
    if (raw === undefined) return { ...provenance, pool: undefined }
    if (!object(raw)) return undefined
    // Do not enumerate/spread the plugin config: it contains unrelated secret
    // fields. These explicit fields are the public pool's entire route policy.
    const pool: Record<string, unknown> = {}
    let memberCount = 0
    for (const key of ['enabled', 'strategy', 'autoAccounts', 'autoFamilies', 'switchMargin']) if (raw[key] !== undefined) pool[key] = raw[key]
    for (const key of ['families', 'tiers']) {
      const definitions = raw[key]
      if (definitions === undefined) continue
      if (!object(definitions) || Object.keys(definitions).length > 256) return undefined
      const projected: Record<string, unknown> = Object.create(null)
      for (const [id, members] of Object.entries(definitions)) {
        if (!Array.isArray(members) || members.length > 512) return undefined
        memberCount += members.length
        if (memberCount > 4096) return undefined
        projected[id] = members.map((member) => {
          if (!object(member)) throw new Error('Invalid pool member')
          return { provider: member.provider, model: member.model, ...(member.account === undefined ? {} : { account: member.account }) }
        })
      }
      pool[key] = projected
    }
    return { ...provenance, pool }
  } catch { return undefined }
}
type CatalogAccount = { id: string; models: Set<string>; poolEnabled: boolean; independentEntry: boolean; poolModels?: Set<string>; unavailable: boolean }
type Catalog = { accounts: CatalogAccount[]; incomplete: boolean }
type ScopedCatalogs = Map<string, Catalog | undefined>
const buildCatalog = (provider: string, input: QuotaRoutingInput): Catalog | undefined => {
  const raw = input.providerSettings[provider]
  if (!object(raw) || raw.provider !== provider || !object(raw.settings) || !Array.isArray(raw.accounts) || raw.accounts.length > 128) return undefined
  const preferences = raw.settings.accounts
  if (preferences !== undefined && !object(preferences)) return undefined
  const sourceAccounts = input.quota.providers.find((entry) => entry.provider === provider)?.accounts
  if (sourceAccounts === undefined) return undefined
  const accounts: CatalogAccount[] = []
  const seen = new Set<string>()
  for (const item of raw.accounts) {
    if (!object(item) || !text(item.key) || !Array.isArray(item.models) || item.models.length > 4096 || (item.unavailable !== undefined && typeof item.unavailable !== 'boolean')) return undefined
    const id = getQuotaAccountId(provider, item.key)
    if (seen.has(id) || !sourceAccounts.some((account) => account.id === id)) return undefined
    seen.add(id)
    const policy = object(preferences) && Object.hasOwn(preferences, item.key) ? preferences[item.key] : undefined
    if (policy !== undefined && (!object(policy) || ['poolEnabled', 'independentEntry'].some((key) => policy[key] !== undefined && typeof policy[key] !== 'boolean') || (policy.poolModels !== undefined && (!Array.isArray(policy.poolModels) || policy.poolModels.length > 4096 || !policy.poolModels.every(text))))) return undefined
    const models = new Set<string>()
    for (const model of item.models) { if (!object(model) || !text(model.id)) return undefined; models.add(model.id) }
    accounts.push({ id, models, poolEnabled: !object(policy) || policy.poolEnabled !== false, independentEntry: object(policy) && policy.independentEntry === true, ...(object(policy) && Array.isArray(policy.poolModels) ? { poolModels: new Set(policy.poolModels as string[]) } : {}), unavailable: item.unavailable === true })
  }
  // Status and catalog may race with login/logout; neither snapshot may stand
  // in for the missing account from the other one.
  if (sourceAccounts.length !== accounts.length) return undefined
  const ordered = sourceAccounts.map((account) => accounts.find((entry) => entry.id === account.id)!)
  return { accounts: ordered, incomplete: accounts.some((account) => account.unavailable) }
}
const catalogFor = (provider: string, input: QuotaRoutingInput, catalogs?: ScopedCatalogs): Catalog | undefined => {
  if (catalogs?.has(provider)) return catalogs.get(provider)
  const value = buildCatalog(provider, input)
  catalogs?.set(provider, value)
  return value
}
const allowsPool = (account: CatalogAccount, model: string): boolean => account.poolEnabled && (account.poolModels?.has(model) ?? true)
type RawMember = { provider: string; model: string; account?: string }
const parseMembers = (raw: unknown): RawMember[] | undefined => {
  if (!Array.isArray(raw) || raw.length > 512) return undefined
  const result: RawMember[] = []
  for (const value of raw) {
    if (!object(value) || !(SUBSCRIPTION_QUOTA_PROVIDERS as readonly unknown[]).includes(value.provider) || !text(value.model) || (value.account !== undefined && !text(value.account)) || value.model.startsWith('~account:')) return undefined
    result.push({ provider: value.provider as string, model: value.model, ...(value.account === undefined ? {} : { account: value.account as string }) })
  }
  return result
}

/**
 * Reconstruct the installed subscription adapter's membership from its public
 * configuration and public account catalogs. This does not copy its private
 * health/usage cache, choose an account, or pretend to bind a prepared call.
 */
const evaluateMembership = (route: QuotaRouteInput, input: QuotaRoutingInput, catalogs?: ScopedCatalogs): QuotaMembership => {
  if (!input.registeredProviders.includes(route.provider)) return unknownMembership('The provider is not currently registered')
  const configuration = input.poolConfiguration
  if (configuration?.source !== 'dsh-config-editor' || !text(configuration.namespace) || (configuration.pool !== undefined && !object(configuration.pool)) || (configuration.providers !== undefined && !configuration.providers.includes(route.provider))) return unknownMembership('No active public subscription owner/configuration was provided for this route')
  const independent = parseQuotaAccountModel(route.model)
  if (route.model.startsWith('~account:')) {
    if (independent === undefined) return unknownMembership('Invalid independent account model identity')
    const catalog = catalogFor(route.provider, input, catalogs)
    const accountId = getQuotaAccountId(route.provider, independent.account)
    const account = catalog?.accounts.find((entry) => entry.id === accountId)
    if (account === undefined || account.unavailable || !account.independentEntry || !account.models.has(independent.model)) return unknownMembership('Independent account eligibility is not proven by the public catalog and preferences')
    return { status: 'proven', source: 'independent-account', members: [{ provider: route.provider, model: independent.model, accountId }], reason: 'Canonical independent identity and public account preferences/catalog agree' }
  }
  const pool = configuration.pool ?? {}
  if (['enabled', 'autoAccounts', 'autoFamilies'].some((key) => pool[key] !== undefined && typeof pool[key] !== 'boolean') || (pool.strategy !== undefined && !['priority', 'quota_aware'].includes(String(pool.strategy)))) return unknownMembership('Unsupported public pool configuration')
  const enabled = pool.enabled !== false
  const auto = pool.autoAccounts ?? pool.autoFamilies ?? true
  let configured: RawMember[] | undefined
  if (enabled) for (const key of ['families', 'tiers']) {
    const definitions = pool[key]
    if (definitions !== undefined && (!object(definitions) || Object.keys(definitions).length > 256)) return unknownMembership('Unsupported public pool definitions')
    if (!object(definitions) || !Object.hasOwn(definitions, route.model)) continue
    const members = parseMembers(definitions[route.model])
    if (members === undefined) return unknownMembership('Pool member identities are not supported')
    if (members.length === 0 || members[0].provider !== route.provider) continue
    // Same-provider families are filtered by the upstream plugin; tiers may
    // contain heterogeneous providers and override a family of the same id.
    configured = key === 'families' ? members.filter((member) => member.provider === route.provider) : members
  }
  if (configured !== undefined) {
    const members: QuotaRouteMember[] = []
    const seen = new Set<string>()
    for (const member of configured) {
      if (!input.registeredProviders.includes(member.provider) || (configuration.providers !== undefined && !configuration.providers.includes(member.provider))) continue
      const catalog = catalogFor(member.provider, input, catalogs)
      const source = input.quota.providers.find((entry) => entry.provider === member.provider)
      if (catalog === undefined || source === undefined) return unknownMembership('A configured member has no matching public account catalog')
      const defaults = source.accounts.filter((account) => account.isDefault)
      const accountId = member.account === undefined ? defaults.length === 1 ? defaults[0].id : undefined : getQuotaAccountId(member.provider, member.account)
      const account = catalog.accounts.find((entry) => entry.id === accountId)
      if (account === undefined || account.unavailable) return unknownMembership('A configured account alias/default or catalog is unresolved')
      if (!allowsPool(account, member.model) || !account.models.has(member.model)) continue
      const key = JSON.stringify([member.provider, member.model, accountId])
      if (seen.has(key)) continue
      seen.add(key)
      members.push({ provider: member.provider, model: member.model, accountId: account.id })
    }
    return members.length === 0 ? unknownMembership('No eligible configured pool member is proven') : { status: 'proven', source: 'public-pool-configuration', members, reason: 'Public pool definitions, account identity, catalog and preferences agree' }
  }
  const catalog = catalogFor(route.provider, input, catalogs)
  if (catalog === undefined || catalog.incomplete) return unknownMembership('Account catalogs are missing, incomplete, or raced with login state')
  const eligible = catalog.accounts.filter((account) => allowsPool(account, route.model) && account.models.has(route.model))
  if (eligible.length === 0) return unknownMembership('No eligible account is proven by the public catalog')
  const pooled = enabled && auto === true
  const selected = pooled ? eligible : eligible.slice(0, 1)
  return { status: 'proven', source: pooled ? 'public-pool-configuration' : 'public-account-fallback', members: selected.map((account) => ({ provider: route.provider, model: route.model, accountId: account.id })), reason: pooled ? 'Public auto-account pool and catalog/preferences agree' : 'Public default-first account fallback and catalog/preferences agree' }
}

/** Standalone calls deliberately do not retain normalized catalog state. */
export const getQuotaRouteMembership = (route: QuotaRouteInput, input: QuotaRoutingInput): QuotaMembership => evaluateMembership(route, input)

const windowsFor = (member: QuotaRouteMember, account: QuotaAccount, now: number): QuotaWindow[] => account.windows.filter((window) =>
  // This is the installed plugin's explicit windowApplies rule, not a new
  // inferred alias/family matcher. It is used only for non-authoritative hints.
  (window.scope === undefined || member.model.toLowerCase().includes(window.scope.toLowerCase())) && (window.resetsAt === undefined || window.resetsAt > now))

/**
 * Current subscriptions 0.9.8 does not disclose sampledAt/stale, even on
 * force. Its percentages may inform a bounded soft policy, but cannot prove
 * live eligibility/exhaustion, deny a route, clear health, or skip recovery.
 */
const evaluateDecision = (route: QuotaRouteInput, input: QuotaRoutingInput, catalogs?: ScopedCatalogs): QuotaRouteDecision => {
  const membership = evaluateMembership(route, input, catalogs)
  const now = input.now ?? Date.now()
  const windows: QuotaWindow[] = []
  const stale = now < input.quota.readAt || now - input.quota.readAt >= 30_000
  const policyConflict = input.quota.routes.some((value) => value.routeId === getQuotaRouteId(route.provider, route.model) && value.policyConflict === true)
  let incomplete = membership.status !== 'proven' || stale || policyConflict
  let incompleteReason = policyConflict ? 'Conflicting configured resource policies cannot guide this route' : stale ? 'The local quota snapshot is outside its bounded advisory lifetime' : 'One or more pool members have incomplete reported quota windows'
  let allFull = membership.members.length > 0
  for (const member of membership.members) {
    const account = input.quota.providers.find((entry) => entry.provider === member.provider)?.accounts.find((entry) => entry.id === member.accountId)
    if (account?.status !== 'reported' || account.completeness !== 'complete') { incomplete = true; allFull = false; continue }
    if (account.windows.some((window) => (window.scope === undefined || member.model.toLowerCase().includes(window.scope.toLowerCase())) && window.resetsAt !== undefined && window.resetsAt <= now)) { incomplete = true; incompleteReason = 'An applicable returned window has already reset; its current state is unknown' }
    const applicable = windowsFor(member, account, now)
    if (applicable.length === 0) { incomplete = true; allFull = false; continue }
    if (applicable.some((window) => window.usedPercent >= 100 && window.resetsAt === undefined)) { incomplete = true; incompleteReason = 'A reported-full window has no disclosed reset deadline; do not defer indefinitely' }
    windows.push(...applicable)
    if (!applicable.some((window) => window.usedPercent >= 100 && window.resetsAt !== undefined)) allFull = false
  }
  const hint = incomplete ? 'unknown' : allFull ? 'reported-full' : 'reported-capacity'
  const pool = object(input.poolConfiguration?.pool) ? input.poolConfiguration.pool : {}
  const fingerprint = createHash('sha256').update(JSON.stringify({ membership: membership.status, membershipSource: membership.source, namespace: input.poolConfiguration?.namespace,
    policy: [pool.enabled ?? true, pool.autoAccounts ?? pool.autoFamilies ?? true, pool.strategy ?? 'quota_aware'],
    members: membership.members.map((member) => [member.provider, member.model, member.accountId]).sort(), windows: windows.map((window) => [window.id, window.usedPercent, window.resetsAt ?? null]).sort() })).digest('hex')
  return {
    routeId: getQuotaRouteId(route.provider, route.model), eligibility: 'unknown', hardSkip: false, preference: 'neutral', hint,
    confidence: incomplete ? 'insufficient-evidence' : 'reported-possibly-cached', source: 'dsh-plugin-subscriptions', freshness: 'upstream-not-disclosed', sampledAt: null,
    readAt: input.quota.readAt, scope: membership.status !== 'proven' ? 'unknown' : membership.members.length > 1 ? 'pool' : 'account', fingerprint, membership,
    windowIds: [...new Set(windows.map((window) => window.id))],
    reason: incomplete ? membership.status === 'unknown' ? membership.reason : incompleteReason : 'Membership is proven for this snapshot, but upstream sample time/cache freshness is not disclosed; continue authoritative probing and the upstream account selector'
  }
}

export const getQuotaRouteDecision = (route: QuotaRouteInput, input: QuotaRoutingInput): QuotaRouteDecision => evaluateDecision(route, input)

/**
 * One synchronous ordering batch gets one detached quota/config snapshot and
 * one normalized account catalog per provider. Nothing survives outside the
 * returned evaluator's scope; there is no global eligibility/health cache.
 * Create a new evaluator for the next ordering, source generation, or request.
 */
export const createQuotaRouteEvaluator = (input: QuotaRoutingInput): ((route: QuotaRouteInput) => QuotaRouteDecision) => {
  const catalogs: ScopedCatalogs = new Map()
  for (const provider of SUBSCRIPTION_QUOTA_PROVIDERS) catalogs.set(provider, buildCatalog(provider, input))
  const snapshot: QuotaRoutingInput = {
    quota: structuredClone(input.quota),
    ...(input.poolConfiguration === undefined ? {} : { poolConfiguration: structuredClone(input.poolConfiguration) }),
    providerSettings: {}, registeredProviders: [...input.registeredProviders], now: input.now ?? Date.now()
  }
  return (route) => evaluateDecision(route, snapshot, catalogs)
}

/** Stable soft ordering: never drop a route, move a subscription after an API,
 * or move a protected manual/preferred trial. Only the reported-full hint is
 * deferred; reported-capacity and unknown remain in their original order. */
export const stableOrderQuotaRoutes = <T extends QuotaRouteInput>(routes: readonly T[], getDecision: (route: T) => QuotaRouteDecision | undefined, protectedRoutes: readonly QuotaRouteInput[] = []): T[] => {
  const protectedIds = new Set(protectedRoutes.map((route) => getQuotaRouteId(route.provider, route.model)))
  const result: T[] = [], segment: T[] = []
  const flush = (): void => {
    const normal: T[] = [], deferred: T[] = []
    for (const route of segment) {
      const decision = getDecision(route)
      if (decision?.membership.status === 'proven' && decision.hint === 'reported-full') deferred.push(route)
      else normal.push(route)
    }
    result.push(...normal, ...deferred)
    segment.length = 0
  }
  for (const route of routes) {
    if (getRouteResourcePolicy(route).accessMode === 'subscription' && !protectedIds.has(getQuotaRouteId(route.provider, route.model))) segment.push(route)
    else { flush(); result.push(route) }
  }
  flush()
  return result
}
