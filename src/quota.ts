import { createHash, randomUUID } from 'node:crypto'
import { getRouteResourcePolicy, type RouteResourcePolicy } from './provider-policy.js'

/** The installed subscriptions plugin's public read-only RPC surface. */
export const SUBSCRIPTION_QUOTA_PROVIDERS = ['codex', 'claude', 'grok', 'copilot', 'antigravity'] as const
export type SubscriptionQuotaProvider = typeof SUBSCRIPTION_QUOTA_PROVIDERS[number]
export const QUOTA_FRESHNESS_NOTICE = '上游采样时间未公开，可能为订阅插件缓存；读取时间不等于供应商采样时间。'
export const QUOTA_UNAVAILABLE_NOTICE = '当前宿主未公开此模型的额度读取接口；额度未知，不以本地调用数、Token 消耗或价格推算。'

export interface QuotaRouteInput {
  provider: string
  model: string
  policy?: RouteResourcePolicy
}
export interface QuotaWindow {
  id: string
  kind: 'session' | 'weekly' | 'other'
  scope?: string
  unit: 'percent'
  usedPercent: number
  resetsAt?: number
  resetState: 'future' | 'elapsed' | 'unknown'
}
export type QuotaStatus = 'reported' | 'unknown' | 'unsupported' | 'logged-out' | 'error'
export interface QuotaAccount {
  /** Opaque stable identity; account emails and raw store keys are not exposed. */
  id: string
  label: string
  isDefault: boolean
  status: QuotaStatus
  completeness: 'complete' | 'partial' | 'unknown'
  readAt: number
  sampledAt: null
  freshness: 'upstream-not-disclosed'
  plan?: string
  windows: QuotaWindow[]
  warnings: string[]
}
export interface QuotaProvider {
  provider: SubscriptionQuotaProvider
  status: QuotaStatus
  readAt: number
  accounts: QuotaAccount[]
  warnings: string[]
}
export interface QuotaRouteView {
  routeId: string
  provider: string
  /** Independent-account identifiers are reduced to their wire model id. */
  model: string
  modelIdentity: 'wire' | 'account-redacted'
  accessMode: NonNullable<RouteResourcePolicy['accessMode']>
  policyConflict?: boolean
  status: QuotaStatus
  /** Provider account views are not proof of the actual pool member selected. */
  mapping: 'independent-account' | 'provider-accounts' | 'unmapped'
  accountIds: string[]
  windowIds: string[]
  warnings: string[]
}
export interface QuotaView {
  source: 'dsh-plugin-subscriptions'
  readAt: number
  sampledAt: null
  freshness: 'upstream-not-disclosed'
  providers: QuotaProvider[]
  routes: QuotaRouteView[]
  warnings: string[]
  delivery: 'read' | 'local-cache' | 'shared-read'
  cacheAgeMs: number
  refreshRequested: boolean
  refreshJoinedExisting: boolean
}
export type QuotaRpcMethod = 'subscriptions-auth.status' | 'subscriptions-auth.usage' | 'subscriptions-auth.providerSettings'
export type QuotaRpcInvoke = (method: QuotaRpcMethod, payload: { provider?: SubscriptionQuotaProvider; account?: string; force?: boolean }, signal: AbortSignal) => Promise<unknown>
export interface QuotaReader {
  invalidate?: () => void
  read(input?: { routes?: readonly QuotaRouteInput[]; force?: boolean; signal?: AbortSignal }): Promise<QuotaView>
}

const MAX_ACCOUNTS = 128
const MAX_WINDOWS = 128
const MAX_TOTAL_ACCOUNTS = 128
const MAX_TOTAL_WINDOWS = 1024
const RPC_TIMEOUT_MS = 30_000
const LOCAL_CACHE_MS = 30_000
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const boundedText = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
const identity = (...parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
export const getQuotaAccountId = (provider: string, account: string): string => `qa-${identity(provider, account)}`
export const getQuotaRouteId = (provider: string, model: string): string => `qr-${identity(provider, model)}`
const abortError = (): Error => new DOMException('Quota read cancelled', 'AbortError')

/** Caller cancellation stops that wait, without aborting work shared with another caller. */
const waitFor = async <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (signal === undefined) return promise
  if (signal.aborted) throw abortError()
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { signal.removeEventListener('abort', aborted); reject(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? signal.reason : abortError()) }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then((value) => { signal.removeEventListener('abort', aborted); resolve(value) }, (error) => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}

/** Never reflect an upstream error body, credential, account email, or endpoint into the public view. */
const failedReadNotice = (error: unknown): string => error instanceof DOMException && error.name === 'TimeoutError'
  ? '额度读取超时；请稍后刷新。未将超时解释为额度耗尽。'
  : '额度接口不可用或读取失败；请在 DSH 订阅设置中检查登录和连接后刷新。未将失败解释为额度耗尽。'

/**
 * Normalize provider-reported percentages only. No conversion into tokens,
 * money, a five-hour duration, or an inferred remaining subscription allowance.
 */
export const normalizeSubscriptionUsage = (provider: SubscriptionQuotaProvider, account: string, raw: unknown, readAt: number): Pick<QuotaAccount, 'status' | 'completeness' | 'plan' | 'windows' | 'warnings'> => {
  if (!object(raw) || typeof raw.supported !== 'boolean') return { status: 'error', completeness: 'unknown', windows: [], warnings: ['额度接口返回的结构不受支持；未使用该数据。'] }
  if (!raw.supported) return { status: 'unsupported', completeness: 'unknown', windows: [], warnings: ['此订阅提供方未开放额度接口；额度未知。'] }
  if (!Array.isArray(raw.windows) || raw.windows.length > MAX_WINDOWS) return { status: 'unknown', completeness: 'unknown', windows: [], warnings: ['额度窗口缺失或超出受支持的数量；额度未知。'] }
  const windows: QuotaWindow[] = []
  const seen = new Map<string, number>()
  let malformed = 0
  for (const value of raw.windows) {
    if (!object(value) || !['session', 'weekly', 'other'].includes(String(value.kind)) || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100 || (value.scope !== undefined && !boundedText(value.scope)) || (value.resetsAt !== undefined && (typeof value.resetsAt !== 'number' || !Number.isSafeInteger(value.resetsAt) || value.resetsAt <= 0))) {
      malformed++
      continue
    }
    const scope = value.scope as string | undefined
    const resetsAt = value.resetsAt as number | undefined
    const id = `qw-${identity(provider, account, String(value.kind), scope ?? '', resetsAt?.toString() ?? '')}`
    const prior = seen.get(id)
    if (prior !== undefined) {
      if (prior !== value.usedPercent) return { status: 'error', completeness: 'unknown', windows: [], warnings: ['同一额度窗口返回冲突数值；未选择其中任何一个作为额度结论。'] }
      continue
    }
    seen.set(id, value.usedPercent)
    windows.push({ id, kind: value.kind as QuotaWindow['kind'], ...(scope === undefined ? {} : { scope }), unit: 'percent', usedPercent: value.usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }), resetState: resetsAt === undefined ? 'unknown' : resetsAt <= readAt ? 'elapsed' : 'future' })
  }
  return {
    status: windows.length === 0 ? 'unknown' : 'reported',
    completeness: windows.length === 0 ? 'unknown' : malformed === 0 ? 'complete' : 'partial',
    ...(boundedText(raw.plan) ? { plan: raw.plan } : {}),
    windows,
    warnings: [QUOTA_FRESHNESS_NOTICE, ...(malformed === 0 ? [] : ['部分额度窗口格式不受支持，已明确忽略；列表不是完整额度统计。']), ...(windows.length === 0 ? ['供应商未返回可用额度窗口；空列表不代表零消耗或无限额度。'] : []), ...(windows.some((window) => window.resetState === 'elapsed') ? ['返回窗口的重置时间已过去，不能据此认定当前窗口仍耗尽或已恢复。'] : [])]
  }
}

export const parseQuotaAccountModel = (model: string): { account: string; model: string } | undefined => {
  if (!model.startsWith('~account:')) return undefined
  const parts = model.slice(9).split(':')
  if (parts.length !== 2) return undefined
  try {
    const account = decodeURIComponent(parts[0])
    const wireModel = decodeURIComponent(parts[1])
    return boundedText(account, 512) && boundedText(wireModel, 512) && `~account:${encodeURIComponent(account)}:${encodeURIComponent(wireModel)}` === model ? { account, model: wireModel } : undefined
  } catch { return undefined }
}

const quotaPolicyIdentity = (route: QuotaRouteInput): string => {
  const policy = getRouteResourcePolicy(route)
  return JSON.stringify([policy.accessMode, policy.quotaScope, policy.quotaDomainId, policy.poolId,
    policy.capabilities?.generation, policy.capabilities?.structuredOutput, policy.capabilities?.vision, policy.capabilities?.tools])
}

/** Reasoning levels do not create another account allowance for the same model. */
export const mapQuotaRoutes = (routes: readonly QuotaRouteInput[], providers: readonly QuotaProvider[]): QuotaRouteView[] => {
  const unique = new Map<string, { route: QuotaRouteInput; policy: string; conflict: boolean }>()
  for (const route of routes) {
    const key = JSON.stringify([route.provider, route.model]), policy = quotaPolicyIdentity(route), prior = unique.get(key)
    if (prior === undefined) unique.set(key, { route, policy, conflict: false })
    else if (prior.policy !== policy) prior.conflict = true
  }
  return [...unique.values()].map(({ route, conflict }) => {
    const value = mapQuotaRoute(route, providers)
    return conflict ? { ...value, accessMode: 'unknown' as const, policyConflict: true, warnings: [...value.warnings, '同一提供方/模型配置了冲突的资源策略；计费方式显示为 unknown，未任选其中一条策略。账户上报值不受影响。'] } : value
  })
}

const mapQuotaRoute = (route: QuotaRouteInput, providers: readonly QuotaProvider[]): QuotaRouteView => {
  const accessMode = getRouteResourcePolicy(route).accessMode ?? 'unknown'
  const provider = providers.find((entry) => entry.provider === route.provider)
  const independent = parseQuotaAccountModel(route.model)
  const publicIdentity = {
    routeId: getQuotaRouteId(route.provider, route.model), provider: route.provider,
    model: route.model.startsWith('~account:') ? independent?.model ?? '[invalid independent account model]' : route.model,
    modelIdentity: (route.model.startsWith('~account:') ? 'account-redacted' : 'wire') as QuotaRouteView['modelIdentity']
  }
  if (provider === undefined) return { ...publicIdentity, accessMode, status: 'unknown', mapping: 'unmapped', accountIds: [], windowIds: [], warnings: [QUOTA_UNAVAILABLE_NOTICE] }
  if (route.model.startsWith('~account:') && independent === undefined) return { ...publicIdentity, accessMode, status: 'unknown', mapping: 'unmapped', accountIds: [], windowIds: [], warnings: ['独立账户模型标识无效，未猜测其所属账户。'] }
  if (independent === undefined) return {
    ...publicIdentity, accessMode, status: provider.status === 'logged-out' || provider.status === 'unsupported' || provider.status === 'error' ? provider.status : 'unknown',
    mapping: 'provider-accounts', accountIds: provider.accounts.map((account) => account.id), windowIds: [],
    warnings: ['仅关联同一提供方的账户视图；公开接口未披露此模型的实际池成员及当前所选账户，不能汇总为模型额度。']
  }
  const account = provider.accounts.find((entry) => entry.id === getQuotaAccountId(route.provider, independent.account))
  if (account === undefined) return { ...publicIdentity, accessMode, status: 'unknown', mapping: 'unmapped', accountIds: [], windowIds: [], warnings: ['独立账户未在提供方当前登录状态中出现；额度未知。'] }
  return {
    ...publicIdentity, accessMode, status: account.status,
    mapping: 'independent-account', accountIds: [account.id],
    // Model-scoped display names (e.g. "Opus") do not prove wire-id membership.
    windowIds: account.windows.filter((window) => window.scope === undefined).map((window) => window.id),
    warnings: ['账户共享窗口在账户视图中只存一份；有 scope 的窗口保留原始标签，不猜测其与模型 ID 的匹配关系。']
  }
}

/**
 * Read the subscriptions plugin's supported RPCs, not its auth store, private
 * controller, or cached internals. There is no local quota estimate. The
 * 30-second view cache preserves its original read time; overlapping reads
 * share work, and a newly started manual refresh passes force upstream.
 */
export const createQuotaReader = (deps: { invoke: QuotaRpcInvoke; now?: () => number }): QuotaReader => {
  const now = deps.now ?? Date.now
  type Snapshot = Pick<QuotaView, 'readAt' | 'providers'>
  let cached: Snapshot | undefined
  let generation = 0
  let pending: Promise<Snapshot> | undefined
  const readSnapshot = async (force: boolean): Promise<Snapshot> => {
    const timeout = AbortSignal.timeout(RPC_TIMEOUT_MS)
    const providers: QuotaProvider[] = []
    const jobs: { provider: QuotaProvider; account: { key: string; isDefault: boolean }; index: number }[] = []
    let accountCount = 0
    let rawStatus: unknown
    try { rawStatus = await waitFor(Promise.resolve().then(() => deps.invoke('subscriptions-auth.status', {}, timeout)), timeout) }
    catch (error) { return { readAt: now(), providers: SUBSCRIPTION_QUOTA_PROVIDERS.map((provider) => ({ provider, status: 'error', readAt: now(), accounts: [], warnings: [failedReadNotice(error)] })) } }
    for (const provider of SUBSCRIPTION_QUOTA_PROVIDERS) {
      try {
        const status = object(rawStatus) && object(rawStatus.providers) ? rawStatus.providers[provider] : undefined
        if (!object(status) || !Array.isArray(status.accounts) || status.accounts.length > MAX_ACCOUNTS || (status.accounts.length === 0 && status.detail !== undefined)) throw new Error('Invalid account status')
        const keys = new Set<string>()
        const accounts: { key: string; isDefault: boolean }[] = []
        for (const value of status.accounts) {
          if (!object(value) || !boundedText(value.key, 512) || typeof value.isDefault !== 'boolean' || keys.has(value.key)) throw new Error('Invalid account identity')
          keys.add(value.key)
          accounts.push({ key: value.key, isDefault: value.isDefault })
        }
        if (accountCount + accounts.length > MAX_TOTAL_ACCOUNTS) {
          providers.push({ provider, status: 'unknown', readAt: now(), accounts: [], warnings: ['总账户数超过单次额度视图的 128 个账户上限；此提供方未被读取，视图不完整，不代表该提供方没有额度。'] })
          continue
        }
        accountCount += accounts.length
        const view: QuotaProvider = { provider, status: accounts.length === 0 ? 'logged-out' : 'unknown', readAt: now(), accounts: [], warnings: accounts.length === 0 ? ['该提供方当前没有已登录账户。'] : [QUOTA_FRESHNESS_NOTICE] }
        providers.push(view)
        for (let index = 0; index < accounts.length; index++) jobs.push({ provider: view, account: accounts[index], index })
      } catch (error) { providers.push({ provider, status: 'error', readAt: now(), accounts: [], warnings: [failedReadNotice(error)] }) }
    }
    let cursor = 0
    let windowCount = 0
    // A single queue bounds all providers together, not four calls per provider.
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const { provider, account, index } = jobs[cursor++]
        let usage: Pick<QuotaAccount, 'status' | 'completeness' | 'plan' | 'windows' | 'warnings'>
        try {
          if (timeout.aborted) throw timeout.reason
          const raw = await waitFor(Promise.resolve().then(() => deps.invoke('subscriptions-auth.usage', { provider: provider.provider, account: account.key, force }, timeout)), timeout)
          usage = normalizeSubscriptionUsage(provider.provider, account.key, raw, now())
          if (windowCount + usage.windows.length > MAX_TOTAL_WINDOWS) usage = { status: 'unknown', completeness: 'unknown', windows: [], warnings: ['总额度窗口超过单次视图的 1024 个窗口上限；该账户窗口未纳入，视图不完整，不代表零消耗或无限额度。'] }
          else windowCount += usage.windows.length
        } catch (error) { usage = { status: 'error', completeness: 'unknown', windows: [], warnings: [failedReadNotice(error)] } }
        provider.accounts[index] = { id: getQuotaAccountId(provider.provider, account.key), label: `账户 ${index + 1}`, isDefault: account.isDefault, readAt: now(), sampledAt: null, freshness: 'upstream-not-disclosed', ...usage }
      }
    }))
    for (const provider of providers) {
      if (provider.accounts.length === 0) continue
      const reported = provider.accounts.some((account) => account.status === 'reported')
      provider.status = reported ? 'reported' : provider.accounts.every((account) => account.status === 'unsupported') ? 'unsupported' : provider.accounts.some((account) => account.status === 'error') ? 'error' : 'unknown'
      provider.readAt = now()
      if (reported && provider.accounts.some((account) => account.status !== 'reported')) provider.warnings.push('部分账户没有可用额度数据，提供方视图不代表完整统计。')
    }
    return { readAt: now(), providers }
  }
  return {
    invalidate() { generation++; cached = undefined },
    async read(input = {}) {
      if (input.signal?.aborted) throw abortError()
      let snapshot: Snapshot
      let delivery: QuotaView['delivery']
      const joined = pending !== undefined
      if (pending !== undefined) { snapshot = await waitFor(pending, input.signal); delivery = 'shared-read' }
      else if (input.force !== true && cached !== undefined && now() >= cached.readAt && now() - cached.readAt < LOCAL_CACHE_MS) { snapshot = cached; delivery = 'local-cache' }
      else {
        const capturedGeneration = generation
        pending = readSnapshot(input.force === true).then((value) => { if (generation === capturedGeneration) cached = value; return value }).finally(() => { pending = undefined })
        snapshot = await waitFor(pending, input.signal)
        delivery = 'read'
      }
      if (input.signal?.aborted) throw abortError()
      // Detach every public result so UI consumers cannot poison a later cached read.
      const providers = structuredClone(snapshot.providers)
      return {
        source: 'dsh-plugin-subscriptions', readAt: snapshot.readAt, sampledAt: null, freshness: 'upstream-not-disclosed', providers,
        routes: mapQuotaRoutes(input.routes ?? [], providers), delivery, cacheAgeMs: Math.max(0, now() - snapshot.readAt), refreshRequested: input.force === true, refreshJoinedExisting: input.force === true && joined,
        warnings: [QUOTA_FRESHNESS_NOTICE, '仅展示上游实际返回的数据；不同账户、窗口、模型、百分比与货币单位均不相加。此视图不修改模型路由或隔离状态。', ...(input.force === true && joined ? ['已加入正在进行的额度读取；本次没有额外发起上游强制刷新。'] : [])]
      }
    }
  }
}

/**
 * Trusted in-process carrier for the fixed public read-only endpoints. Wire
 * this only from an already-authorized Host operation/RPC; never expose the
 * handler as an arbitrary proxy or supply browser credentials to it.
 */
export const createSubscriptionQuotaInvoker = (getHandler: () => { fetch(request: Request): Promise<Response> } | ((request: Request) => Promise<Response>) | undefined): QuotaRpcInvoke => async (method, payload, signal) => {
  if (!['subscriptions-auth.status', 'subscriptions-auth.usage', 'subscriptions-auth.providerSettings'].includes(method) || (method !== 'subscriptions-auth.status' && (payload.provider === undefined || !SUBSCRIPTION_QUOTA_PROVIDERS.includes(payload.provider)))) throw new Error('Unsupported quota RPC')
  const handler = getHandler()
  if (handler === undefined) throw new Error('Host connection unavailable')
  const rpcId = `swarm-quota-${randomUUID()}`
  const request = new Request(`http://localhost/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal })
  const response = await (typeof handler === 'function' ? handler(request) : handler.fetch(request))
  if (!response.ok) throw new Error('Quota RPC unavailable')
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Quota RPC empty response')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      if (signal.aborted) throw abortError()
      const next = await waitFor(reader.read(), signal)
      if (next.done) break
      size += next.value.byteLength
      if (size > 512 * 1024) throw new Error('Quota RPC response too large')
      chunks.push(next.value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  if (!object(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !object(body.result) || body.result.ok !== true || !('value' in body.result)) throw new Error('Quota RPC invalid or failed response')
  return body.result.value
}
