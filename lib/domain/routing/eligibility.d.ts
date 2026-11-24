import { type FailureKind, type RouteResourcePolicy } from './provider-policy.js';
import type { RouteFailureInput, RouteInfo } from './routes.js';
export interface RouteEligibilitySnapshot {
    configuredProviders: readonly string[];
    models: Readonly<Record<string, {
        reasoning?: readonly string[];
        inputModalities?: readonly string[];
    }>>;
}
export interface RouteRequirement {
    vision?: boolean;
    reasoningEffort?: string;
}
export type RouteEligibility = {
    eligible: true;
    resource: RouteResourcePolicy;
} | {
    eligible: false;
    reason: 'provider-not-configured' | 'model-not-found' | 'unsupported-effort' | 'vision-unsupported' | 'generation-unavailable';
};
export declare const evaluateRouteEligibility: (route: RouteInfo, snapshot: RouteEligibilitySnapshot, requirement?: RouteRequirement) => RouteEligibility;
export interface FailureFact {
    kind: FailureKind;
    provider: string;
    model: string;
    message: string;
    retryable: boolean;
    isolate: boolean;
    quotaScope?: RouteResourcePolicy['quotaScope'];
    resetAt?: string;
    retryAfterMs?: number;
}
export declare const toFailureFact: (route: RouteInfo, failure: RouteFailureInput, at?: number) => FailureFact;
export interface RouteCandidate {
    route: RouteInfo;
    eligibility: RouteEligibility;
}
/** Preserve declared priority; only explicit ineligibility removes a candidate. */
export declare const selectEligibleRoutes: (candidates: readonly RouteCandidate[]) => RouteInfo[];
