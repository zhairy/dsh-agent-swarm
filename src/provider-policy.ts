import type { LlmFailureLike } from './host-contract.js'
import type { RouteInfo } from './routes.js'

export type FailureKind = 'quota_exhausted' | 'pool_exhausted' | 'insufficient_balance' | 'auth_invalid'
  | 'model_unavailable' | 'rate_limited' | 'network_transient' | 'service_transient' | 'unknown'

/** 只存适配器返回的不透明身份，不保存账号或凭据。缺失时只隔离当前路由。 */
export interface RouteResourcePolicy {
  accessMode?: 'subscription' | 'metered_api' | 'judgment_api' | 'unknown'
  quotaDomainId?: string
  quotaScope?: 'account' | 'plan' | 'model' | 'pool' | 'unknown'
  poolId?: string
  capabilities?: { generation?: boolean; structuredOutput?: boolean; vision?: boolean; tools?: boolean }
}

/** 已核验内置 provider 契约，不按模型名称猜额度域。自定义接入可显式覆盖为 unknown。 */
export const getRouteResourcePolicy = (route: RouteInfo): RouteResourcePolicy => {
  const inferred: RouteResourcePolicy = route.provider === 'qwen-token-plan-cn'
    ? { accessMode: 'subscription', quotaScope: 'plan', quotaDomainId: 'provider-instance:qwen-token-plan-cn' }
    : route.provider === 'opencode-go' ? { accessMode: 'subscription', quotaScope: 'model' }
      : ['codex', 'claude'].includes(route.provider) ? { accessMode: 'subscription', quotaScope: 'unknown' }
        : route.provider === 'deepseek-official' ? { accessMode: 'metered_api', quotaScope: 'unknown' }
          : route.provider === 'jev' ? { accessMode: 'judgment_api', quotaScope: 'unknown' } : { accessMode: 'unknown', quotaScope: 'unknown' }
  if (route.policy === undefined) return inferred
  const policy = { ...inferred, ...route.policy }
  if (route.policy.quotaDomainId === undefined && (
    (route.policy.accessMode !== undefined && route.policy.accessMode !== inferred.accessMode)
    || (route.policy.quotaScope !== undefined && route.policy.quotaScope !== inferred.quotaScope)
  )) {
    delete policy.quotaDomainId
    if (route.policy.quotaScope === undefined) policy.quotaScope = 'unknown'
  }
  return policy
}

export const getRouteResourceInfo = (route: RouteInfo) => ({
  ...getRouteResourcePolicy(route),
  inferredResourceType: getRouteResourcePolicy(route).accessMode ?? 'unknown',
  metadataSource: route.policy !== undefined ? 'configured' : route.provider === 'qwen-token-plan-cn' ? 'verified-provider-instance' : getRouteResourcePolicy(route).accessMode === 'unknown' ? 'unknown' : 'provider-kind'
})
export interface RouteFailureMetadata extends LlmFailureLike {
  kind?: string
  quotaDomainId?: string
  quotaScope?: RouteResourcePolicy['quotaScope']
  poolId?: string
  resetAt?: string
  providerRetryAfterMs?: number
  requestId?: string
}
export interface NormalizedRouteFailure extends RouteFailureMetadata {
  kind: FailureKind
  provider: string
  model: string
  message: string
}

/** DSH LlmError.failure 是已发布的结构化事实；无该字段时只保留实际错误自身字段。 */
export const getRouteFailure = (error: unknown): RouteFailureMetadata => {
  const live = error !== null && typeof error === 'object' ? error as Record<string, unknown> : {}
  const facts = live.failure !== null && typeof live.failure === 'object' ? live.failure as Record<string, unknown> : live
  const value: RouteFailureMetadata = { message: typeof facts.message === 'string' ? facts.message : error instanceof Error ? error.message : String(error) }
  for (const key of ['code', 'kind', 'quotaDomainId', 'poolId', 'resetAt', 'requestId'] as const) if (typeof facts[key] === 'string') value[key] = facts[key] as string
  for (const key of ['status', 'providerRetryAfterMs'] as const) if (typeof facts[key] === 'number' && Number.isFinite(facts[key])) value[key] = facts[key] as number
  if (['account', 'plan', 'model', 'pool', 'unknown'].includes(String(facts.quotaScope))) value.quotaScope = facts.quotaScope as RouteResourcePolicy['quotaScope']
  return value
}
const KINDS = new Set<FailureKind>(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'unknown'])
const POOL = /\bpool\s+["']([^"']+)["']\s+exhausted\b/i
const QUOTA = /\busage limit(?:\s+(?:reached|exceeded))?\b|\b(?:you(?:'|’)ve|you have) hit your (?:usage )?limit\b|\bexceeded (?:your )?(?:current )?quota\b|\b(?:quota|credits?)\s+(?:exhausted|exceeded|depleted)\b|额度(?:已)?(?:耗尽|用尽)|计划(?:额度)?(?:耗尽|用尽)/i
const BALANCE = /insufficient (?:balance|funds)|balance (?:exhausted|depleted)|余额不足/i
const MODEL = /Unpurchased|Access to model denied|not eligible for (?:using )?(?:this|the) model|model[^\n]*not (?:found|exist)/i
const RATE_WINDOW = /\b(?:rpm|tpm)\b|per (?:second|minute)|每(?:秒|分钟)|concurrent (?:requests|limit)|并发(?:请求|限制)/i

/** 有确切终态事实才按额度处理，普通 rate-limit/quota-per-minute 不扩大成账号封禁。 */
export const normalizeRouteFailure = (failure: RouteFailureMetadata, route: RouteInfo): NormalizedRouteFailure => {
  const policy = getRouteResourcePolicy(route)
  const code = String(failure.code ?? '').toUpperCase()
  const message = failure.message ?? ''
  const pool = POOL.exec(message)?.[1]
  let kind: FailureKind = failure.kind !== undefined && KINDS.has(failure.kind as FailureKind) ? failure.kind as FailureKind : 'unknown'
  if (kind === 'unknown') {
    if (pool !== undefined || code === 'POOL_EXHAUSTED') kind = 'pool_exhausted'
    else if (BALANCE.test(message) || ['INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS'].includes(code)
      || (failure.status === 402 && (route.provider === 'deepseek-official' || policy.accessMode === 'metered_api'))) kind = 'insufficient_balance'
    else if (['QUOTA', 'INSUFFICIENT_QUOTA', 'USAGE_LIMIT', 'BILLING_HARD_LIMIT_REACHED'].includes(code)) kind = 'quota_exhausted'
    else if (RATE_WINDOW.test(message) && (failure.status === 429 || code === 'RATE_LIMIT')) kind = 'rate_limited'
    else if (QUOTA.test(message)) kind = 'quota_exhausted'
    else if (code === 'NO_ADAPTER' && /No eligible account|transport failed|fetch failed/i.test(message)) kind = 'network_transient'
    else if (MODEL.test(message) || ['NO_ADAPTER', 'UNKNOWN_MODEL', 'UNKNOWN_PROVIDER', 'MISSING_CREDENTIAL', 'UNSUPPORTED_OPTION', 'IMAGE_UNSUPPORTED'].includes(code)) kind = 'model_unavailable'
    else if (['INVALID_CREDENTIAL', 'UNAUTHORIZED', 'FORBIDDEN'].includes(code) || failure.status === 401 || failure.status === 403) kind = 'auth_invalid'
    else if (['NETWORK', 'TRANSPORT', 'TIMEOUT'].includes(code)) kind = 'network_transient'
    else if (code === 'RATE_LIMIT' || failure.status === 429 || /rate.?limit|too many requests/i.test(message)) kind = 'rate_limited'
    else if (['OVERLOADED', 'SERVER_ERROR', 'SERVER', 'EMPTY_RESPONSE'].includes(code) || (failure.status ?? 0) >= 500) kind = 'service_transient'
    else if ([400, 404, 402, 422].includes(failure.status ?? 0)) kind = 'model_unavailable'
  }
  return {
    ...failure, kind, provider: route.provider, model: route.model, message,
    ...(failure.quotaDomainId ?? policy.quotaDomainId ? { quotaDomainId: failure.quotaDomainId ?? policy.quotaDomainId } : {}),
    ...(failure.quotaScope ?? policy.quotaScope ? { quotaScope: failure.quotaScope ?? policy.quotaScope } : {}),
    // 文本里的池名称未证明跨 provider 是同一资源；只有显式opaque ID才跨别名共享。
    ...(failure.poolId ?? policy.poolId ?? pool ? { poolId: failure.poolId ?? policy.poolId ?? `provider-instance:${route.provider}:pool:${pool}` } : {})
  }
}
export const isTerminalRouteFailure = (failure: NormalizedRouteFailure): boolean =>
  ['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable'].includes(failure.kind)

export const nativeRecoveryCoverage = (structuredFailureAvailable: boolean, retryControlVerified = false): { verified: boolean; reason: string } => ({
  verified: structuredFailureAvailable && retryControlVerified,
  reason: !structuredFailureAvailable ? 'native-internal-retries-unobservable' : retryControlVerified ? 'structured-failure-and-retry-control-verified' : 'native-retry-control-unverified'
})

/** 拟议 native 适配合同，能力声明与已验证覆盖分开；现有无此合同的后端明确 unknown。 */
export interface NativeRecoverySupport {
  contractVersion: 1
  structuredFailure: boolean
  preDelayControl: boolean
  attemptEvents: boolean
  verified: boolean
  reason: string
}
export const getNativeRecoverySupport = (capabilities: Record<string, boolean> | undefined, adapterControlVerified = false): NativeRecoverySupport => {
  const structuredFailure = capabilities?.routeFailureMetadataV1 === true
  const preDelayControl = capabilities?.requestRecoveryControlV1 === true
  const attemptEvents = capabilities?.requestAttemptEventsV1 === true
  const coverage = nativeRecoveryCoverage(structuredFailure, preDelayControl && attemptEvents && adapterControlVerified)
  return { contractVersion: 1, structuredFailure, preDelayControl, attemptEvents, ...coverage }
}
