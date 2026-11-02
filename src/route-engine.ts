import type { LlmFailureLike } from './host-contract.js'
import { getRouteResourcePolicy, normalizeRouteFailure, type FailureKind, type RouteResourcePolicy } from './provider-policy.js'
import type { RouteInfo } from './routes.js'

export interface RouteEligibilitySnapshot {
  configuredProviders: readonly string[]
  models: Readonly<Record<string, { reasoning?: readonly string[]; inputModalities?: readonly string[] }>>
}

export interface RouteRequirement { vision?: boolean; reasoningEffort?: string }
export type RouteEligibility = { eligible: true; resource: RouteResourcePolicy } | { eligible: false; reason: 'provider-not-configured' | 'model-not-found' | 'unsupported-effort' | 'vision-unsupported' | 'generation-unavailable' }

export const evaluateRouteEligibility = (route: RouteInfo, snapshot: RouteEligibilitySnapshot, requirement: RouteRequirement = {}): RouteEligibility => {
  const resource = getRouteResourcePolicy(route)
  if (!snapshot.configuredProviders.includes(route.provider)) return { eligible: false, reason: 'provider-not-configured' }
  if (resource.accessMode === 'judgment_api' || resource.capabilities?.generation === false) return { eligible: false, reason: 'generation-unavailable' }
  const model = snapshot.models[`${route.provider}/${route.model}`]
  if (model === undefined) return { eligible: false, reason: 'model-not-found' }
  if (requirement.reasoningEffort !== undefined && model.reasoning !== undefined && !model.reasoning.includes(requirement.reasoningEffort)) return { eligible: false, reason: 'unsupported-effort' }
  if (requirement.vision === true && !model.inputModalities?.includes('image')) return { eligible: false, reason: 'vision-unsupported' }
  return { eligible: true, resource }
}

export interface FailureFact {
  kind: FailureKind
  provider: string
  model: string
  message: string
  retryable: boolean
  isolate: boolean
  quotaScope?: RouteResourcePolicy['quotaScope']
  resetAt?: string
  retryAfterMs?: number
}

export const toFailureFact = (route: RouteInfo, failure: LlmFailureLike, at = Date.now()): FailureFact => {
  const normalized = normalizeRouteFailure(failure, route, at)
  return { kind: normalized.kind, provider: route.provider, model: route.model, message: normalized.message,
    retryable: ['rate_limited', 'network_transient', 'service_transient', 'pool_exhausted'].includes(normalized.kind),
    isolate: ['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'protocol_incompatible'].includes(normalized.kind),
    ...(normalized.quotaScope === undefined ? {} : { quotaScope: normalized.quotaScope }),
    ...(normalized.resetAt === undefined ? {} : { resetAt: normalized.resetAt }),
    ...(normalized.providerRetryAfterMs === undefined ? {} : { retryAfterMs: normalized.providerRetryAfterMs }) }
}

export interface RouteCandidate { route: RouteInfo; eligibility: RouteEligibility }

/** Preserve declared priority; only explicit ineligibility removes a candidate. */
export const selectEligibleRoutes = (candidates: readonly RouteCandidate[]): RouteInfo[] =>
  candidates.filter((candidate) => candidate.eligibility.eligible).map((candidate) => candidate.route)
