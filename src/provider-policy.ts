import type { LlmFailureLike } from './host-contract.js'
import type { RouteInfo } from './routes.js'

export type FailureKind = 'quota_exhausted' | 'pool_exhausted' | 'insufficient_balance' | 'auth_invalid'
  | 'model_unavailable' | 'rate_limited' | 'network_transient' | 'service_transient' | 'context_exceeded' | 'capability_mismatch'
  | 'protocol_incompatible' | 'unknown'

/** 只存适配器返回的不透明身份，不保存账号或凭据。缺失时只隔离当前路由。 */
export interface RouteResourcePolicy {
  accessMode?: 'subscription' | 'metered_api' | 'judgment_api' | 'unknown'
  quotaDomainId?: string
  quotaScope?: 'account' | 'plan' | 'model' | 'pool' | 'unknown'
  poolId?: string
  capabilities?: { generation?: boolean; structuredOutput?: boolean; vision?: boolean; tools?: boolean }
}

/** Existing Codex wire contract: catalog ultra is sent as max; other providers retain their own levels. */
export const getWireReasoningEffort = (route: Pick<RouteInfo, 'provider' | 'reasoningEffort'>): string | undefined =>
  route.provider === 'codex' && route.reasoningEffort === 'ultra' ? 'max' : route.reasoningEffort

/** 已核验内置 provider 契约，不按模型名称猜额度域。自定义接入可显式覆盖为 unknown。 */
export const getRouteResourcePolicy = (route: RouteInfo): RouteResourcePolicy => {
  const inferred: RouteResourcePolicy = route.provider === 'qwen-token-plan-cn'
    ? { accessMode: 'subscription', quotaScope: 'plan', quotaDomainId: 'provider-instance:qwen-token-plan-cn' }
    : route.provider === 'opencode-go' ? { accessMode: 'subscription', quotaScope: 'model' }
      : route.provider === 'antigravity' ? { accessMode: 'subscription', quotaScope: 'model' }
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
const KINDS = new Set<FailureKind>(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'context_exceeded', 'capability_mismatch', 'protocol_incompatible', 'unknown'])
const POOL = /\bpool\s+["']([^"']+)["']\s+exhausted\b/i
const QUOTA = /\busage limit(?:\s+(?:reached|exceeded))?\b|\b(?:you(?:'|’)ve|you have) hit your (?:usage )?limit\b|\bexceeded (?:your )?(?:current )?quota\b|\b(?:quota|credits?)(?:\s+(?:has|have)\s+been)?\s+(?:exhausted|exceeded|depleted)\b|额度(?:已)?(?:耗尽|用尽)|计划(?:额度)?(?:耗尽|用尽)/i
const BALANCE = /insufficient (?:balance|funds)|balance (?:exhausted|depleted)|余额不足/i
const MODEL = /Unpurchased|Access to model denied|not eligible for (?:using )?(?:this|the) model|model[^\n]*not (?:found|exist)/i
const AUTH = /\binvalid (?:api key|credentials?)\b|\bauthentication failed\b|\btoken (?:(?:has|is) )?expired\b|\b(?:not logged in|login required|please (?:log in|login|sign in))\b/i
const RATE_WINDOW = /\b(?:rpm|tpm)\b|per (?:second|minute)|每(?:秒|分钟)|concurrent (?:requests|limit)|并发(?:请求|限制)/i
const CONTEXT = /context[_ -]window[_ -]exceeded|maximum context (?:length|window)|context (?:length|window)[^\n]*(?:exceeded|too (?:large|long))|exceeded (?:the )?model token limit|prompt (?:is )?too long/i
const THINKING_CONTRACT = /content\[\]\.thinking[^\n]*thinking mode[^\n]*must be passed back|thinking (?:content|block)s?[^\n]*must be passed back/i

/** Probe delays, not subscription reset times. A new logical request admits at most one half-open owner. */
export const ROUTE_RECOVERY_COOLDOWNS_MS: Readonly<Record<FailureKind, number>> = Object.freeze({
  quota_exhausted: 30 * 60_000, insufficient_balance: 30 * 60_000,
  pool_exhausted: 60_000, auth_invalid: 120_000, model_unavailable: 120_000,
  rate_limited: 30_000, network_transient: 10_000, service_transient: 15_000,
  context_exceeded: 0, capability_mismatch: 0, protocol_incompatible: 30 * 60_000, unknown: 30_000
})
const MAX_PROBE_DELAY_MS: Readonly<Record<FailureKind, number>> = Object.freeze({
  quota_exhausted: 4 * 60 * 60_000, insufficient_balance: 4 * 60 * 60_000,
  pool_exhausted: 5 * 60_000, auth_invalid: 15 * 60_000, model_unavailable: 15 * 60_000,
  rate_limited: 5 * 60_000, network_transient: 60_000, service_transient: 120_000,
  context_exceeded: 0, capability_mismatch: 0, protocol_incompatible: 4 * 60 * 60_000, unknown: 5 * 60_000
})
const POOL_AUTH_HINT_MAX_MS = 30 * 60_000
export const getRouteRecoveryPolicy = (failure: Pick<NormalizedRouteFailure, 'kind' | 'providerRetryAfterMs'>, retryCount = 1): { isolate: boolean; retryDelayMs: number } => {
  if (failure.kind === 'context_exceeded' || failure.kind === 'capability_mismatch') return { isolate: false, retryDelayMs: 0 }
  const count = Number.isFinite(retryCount) ? Math.min(32, Math.max(1, Math.floor(retryCount))) : 1
  const cooldown = Math.min(MAX_PROBE_DELAY_MS[failure.kind], ROUTE_RECOVERY_COOLDOWNS_MS[failure.kind] * 2 ** Math.min(8, count - 1))
  const hint = typeof failure.providerRetryAfterMs === 'number' && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0 ? failure.providerRetryAfterMs : 0
  // 模型池与认证冷却按宿主提示隔离，但至多 30 分钟重探一次：宿主可能提前恢复（如额度窗口刷新）；
  // 通用 adapter 更新只失效元数据；隔离到期或显式受控重试后才允许半开探测。
  const retryAfter = failure.kind === 'pool_exhausted' || failure.kind === 'auth_invalid' ? Math.min(hint, POOL_AUTH_HINT_MAX_MS) : hint
  return { isolate: true, retryDelayMs: Math.max(cooldown, retryAfter) }
}

/** Only this provider's observed, explicit UTC quota-reset sentence has a known contract. */
const getQwenQuotaReset = (message: string, at: number): string | undefined => {
  const match = /quota (?:will )?reset(?:s)? at (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) UTC\b/i.exec(message)
  if (match === null || !Number.isFinite(at)) return undefined
  const [, monthText, dayText, hourText, minuteText, secondText] = match
  const [month, day, hour, minute, second] = [monthText, dayText, hourText, minuteText, secondText].map(Number)
  if (month! < 1 || month! > 12 || day! < 1 || day! > 31 || hour! > 23 || minute! > 59 || second! > 59) return undefined
  const reference = new Date(at)
  if (!Number.isFinite(reference.getTime())) return undefined
  let year = reference.getUTCFullYear()
  let value = Date.UTC(year, month! - 1, day, hour, minute, second)
  // Only a December -> early-next-year boundary permits inferring the following year.
  if (value < at && reference.getUTCMonth() === 11 && month! <= 2) { year++; value = Date.UTC(year, month! - 1, day, hour, minute, second) }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return undefined
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) return undefined
  return parsed.toISOString()
}

/** 有确切终态事实才按额度处理，普通 rate-limit/quota-per-minute 不扩大成账号封禁。 */
export const normalizeRouteFailure = (failure: RouteFailureMetadata, route: RouteInfo, at: number = Date.now()): NormalizedRouteFailure => {
  const policy = getRouteResourcePolicy(route)
  const code = String(failure.code ?? '').toUpperCase()
  const message = failure.message ?? ''
  const pool = POOL.exec(message)?.[1]
  let kind: FailureKind = failure.kind !== undefined && KINDS.has(failure.kind as FailureKind) ? failure.kind as FailureKind : 'unknown'
  if (kind === 'unknown') {
    if (THINKING_CONTRACT.test(message)) kind = 'protocol_incompatible'
    else if (code === 'CONTEXT_WINDOW_EXCEEDED' || CONTEXT.test(message)) kind = 'context_exceeded'
    else if (['IMAGE_UNSUPPORTED', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_REASONING_EFFORT'].includes(code)) kind = 'capability_mismatch'
    // 订阅模型池以 AUTH 报告耗尽时，根因是池内账号凭据被拒，按认证失效处理（同 provider 其余模型一并跳过）；
    // 其他 AUTH 不够具体（任何带 401/403 的消息、可能因断网失败的令牌刷新），按状态码与消息细分
    else if (code === 'AUTH' && pool !== undefined && !MODEL.test(message)) kind = 'auth_invalid'
    else if (pool !== undefined || code === 'POOL_EXHAUSTED') kind = 'pool_exhausted'
    else if (BALANCE.test(message) || ['INSUFFICIENT_BALANCE', 'INSUFFICIENT_FUNDS'].includes(code)
      || (failure.status === 402 && (route.provider === 'deepseek-official' || policy.accessMode === 'metered_api'))) kind = 'insufficient_balance'
    else if (['QUOTA', 'QUOTA_EXHAUSTED', 'INSUFFICIENT_QUOTA', 'USAGE_LIMIT', 'BILLING_HARD_LIMIT_REACHED'].includes(code)) kind = 'quota_exhausted'
    else if (RATE_WINDOW.test(message) && (failure.status === 429 || code === 'RATE_LIMIT')) kind = 'rate_limited'
    else if (QUOTA.test(message) || (route.provider === 'antigravity' && /\bIndividual quota reached\b/i.test(message))) kind = 'quota_exhausted'
    // pi-ai 的 AUTH failure 可能仅有 code/message；只补明确认证文本，不把模型拒绝或刷新失败扩大为认证失效。
    else if (['MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'UNAUTHORIZED'].includes(code) || failure.status === 401 || (failure.status === 403 && !MODEL.test(message))
      || (code === 'AUTH' && !MODEL.test(message) && AUTH.test(message))) kind = 'auth_invalid'
    else if (code === 'NO_ADAPTER' && /transport failed|fetch failed/i.test(message)) kind = 'network_transient'
    else if (code === 'NO_ADAPTER' && /No eligible account/i.test(message)) kind = 'pool_exhausted'
    else if (MODEL.test(message) || ['NO_ADAPTER', 'UNKNOWN_MODEL', 'UNKNOWN_PROVIDER'].includes(code)) kind = 'model_unavailable'
    else if (['INVALID_CREDENTIAL', 'UNAUTHORIZED', 'FORBIDDEN'].includes(code) || failure.status === 401 || failure.status === 403) kind = 'auth_invalid'
    else if (['NETWORK', 'TRANSPORT', 'TIMEOUT'].includes(code)) kind = 'network_transient'
    else if (code === 'RATE_LIMIT' || failure.status === 429 || /rate.?limit|too many requests/i.test(message)) kind = 'rate_limited'
    else if (['OVERLOADED', 'SERVER_ERROR', 'SERVER', 'EMPTY_RESPONSE'].includes(code) || (failure.status ?? 0) >= 500) kind = 'service_transient'
  }
  // Google 的模型硬额度会返回独立重置时间；不能把 Argon 的限制扩大为整个订阅，
  // 也不能将分钟限流的 retry-after 当作订阅重置。
  const retryAfterMs = failure.providerRetryAfterMs
  const resetTime = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? at + retryAfterMs : undefined
  const googleReset = route.provider === 'antigravity' && kind === 'quota_exhausted'
    && resetTime !== undefined && Number.isFinite(resetTime) && Math.abs(resetTime) <= 8.64e15
    ? new Date(resetTime).toISOString() : undefined
  const resetAt = failure.resetAt ?? googleReset ?? (route.provider === 'qwen-token-plan-cn' && kind === 'quota_exhausted' ? getQwenQuotaReset(message, at) : undefined)
  return {
    ...failure, kind, provider: route.provider, model: route.model, message,
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(failure.quotaDomainId ?? policy.quotaDomainId ? { quotaDomainId: failure.quotaDomainId ?? policy.quotaDomainId } : {}),
    ...(failure.quotaScope ?? policy.quotaScope ? { quotaScope: failure.quotaScope ?? policy.quotaScope } : {}),
    // 文本里的池名称未证明跨 provider 是同一资源；只有显式opaque ID才跨别名共享。
    ...(failure.poolId ?? policy.poolId ?? pool ? { poolId: failure.poolId ?? policy.poolId ?? `provider-instance:${route.provider}:pool:${pool}` } : {})
  }
}
export const isTerminalRouteFailure = (failure: NormalizedRouteFailure): boolean =>
  ['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'protocol_incompatible'].includes(failure.kind)
