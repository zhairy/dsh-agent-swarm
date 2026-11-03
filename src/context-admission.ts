import type { CallConfigLike } from './host-contract.js'
import type { RouteInfo } from './routes.js'

export interface ModelContextInfo {
  context?: { contextWindow?: number }
  defaultMaxTokens?: number
}

export interface ContextAdmissionInfo {
  ok: boolean
  measuredTokens?: number
  contextWindow?: number
  reservedOutputTokens?: number
  safetyMarginTokens?: number
  safeInputTokens?: number
  reason?: string
}

export const CONTEXT_SAFETY_MARGIN_TOKENS = 4096

/**
 * Decide whether a route can hold the current session before a provider call.
 * Provider-reported/host-metered total tokens are treated as an upper bound;
 * unknown measurements or capacity remain compatible and do not block a route.
 */
export const getContextAdmission = (input: {
  route: Pick<RouteInfo, 'provider' | 'model'>
  call: Pick<CallConfigLike, 'maxTokens'>
  measurement?: { totalTokens: number }
  modelInfo?: ModelContextInfo
}): ContextAdmissionInfo => {
  const measured = input.measurement?.totalTokens
  const contextWindow = input.modelInfo?.context?.contextWindow
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured < 0
    || typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 1) {
    return { ok: true, ...(typeof measured === 'number' ? { measuredTokens: measured } : {}), ...(typeof contextWindow === 'number' ? { contextWindow } : {}) }
  }
  const requested = typeof input.call.maxTokens === 'number' && Number.isSafeInteger(input.call.maxTokens) && input.call.maxTokens > 0
    ? input.call.maxTokens : 0
  const configured = typeof input.modelInfo?.defaultMaxTokens === 'number' && Number.isSafeInteger(input.modelInfo.defaultMaxTokens) && input.modelInfo.defaultMaxTokens > 0
    ? input.modelInfo.defaultMaxTokens : 0
  const reservedOutputTokens = Math.min(Math.max(requested, configured), contextWindow - 1)
  const safetyMarginTokens = Math.min(CONTEXT_SAFETY_MARGIN_TOKENS, Math.max(0, contextWindow - reservedOutputTokens - 1))
  const safeInputTokens = Math.max(0, contextWindow - reservedOutputTokens - safetyMarginTokens)
  return {
    ok: measured <= safeInputTokens,
    measuredTokens: measured,
    contextWindow,
    reservedOutputTokens,
    safetyMarginTokens,
    safeInputTokens,
    ...(measured <= safeInputTokens ? {} : { reason: 'context-window-insufficient' })
  }
}

export const formatContextAdmissionError = (rejected: readonly ContextAdmissionInfo[]): string => {
  const measured = Math.max(0, ...rejected.map((item) => item.measuredTokens ?? 0))
  const largest = Math.max(0, ...rejected.map((item) => item.safeInputTokens ?? 0))
  return `当前会话约 ${Math.ceil(measured).toLocaleString('en-US')} tokens，超出现有路由可安全承接的上下文（最大安全输入约 ${Math.ceil(largest).toLocaleString('en-US')} tokens）。请新建会话/分支，或先切换到上下文更大的模型；未调用模型。`
}
