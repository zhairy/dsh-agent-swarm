import { getRouteResourcePolicy, normalizeRouteFailure } from './provider-policy.js';
export const evaluateRouteEligibility = (route, snapshot, requirement = {}) => {
    const resource = getRouteResourcePolicy(route);
    if (!snapshot.configuredProviders.includes(route.provider))
        return { eligible: false, reason: 'provider-not-configured' };
    if (resource.accessMode === 'judgment_api' || resource.capabilities?.generation === false)
        return { eligible: false, reason: 'generation-unavailable' };
    const model = snapshot.models[`${route.provider}/${route.model}`];
    if (model === undefined)
        return { eligible: false, reason: 'model-not-found' };
    if (requirement.reasoningEffort !== undefined && model.reasoning !== undefined && !model.reasoning.includes(requirement.reasoningEffort))
        return { eligible: false, reason: 'unsupported-effort' };
    if (requirement.vision === true && !model.inputModalities?.includes('image'))
        return { eligible: false, reason: 'vision-unsupported' };
    return { eligible: true, resource };
};
export const toFailureFact = (route, failure, at = Date.now()) => {
    const normalized = normalizeRouteFailure(failure, route, at);
    return { kind: normalized.kind, provider: route.provider, model: route.model, message: normalized.message,
        retryable: ['rate_limited', 'network_transient', 'service_transient', 'pool_exhausted'].includes(normalized.kind),
        isolate: ['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'protocol_incompatible'].includes(normalized.kind),
        ...(normalized.quotaScope === undefined ? {} : { quotaScope: normalized.quotaScope }),
        ...(normalized.resetAt === undefined ? {} : { resetAt: normalized.resetAt }),
        ...(normalized.providerRetryAfterMs === undefined ? {} : { retryAfterMs: normalized.providerRetryAfterMs }) };
};
/** Preserve declared priority; only explicit ineligibility removes a candidate. */
export const selectEligibleRoutes = (candidates) => candidates.filter((candidate) => candidate.eligibility.eligible).map((candidate) => candidate.route);
//# sourceMappingURL=eligibility.js.map