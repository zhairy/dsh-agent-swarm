import { type QuotaRouteInput, type QuotaView } from './resources.js';
/** Only the active subscription entry's public pool projection belongs here. */
export interface QuotaPoolConfiguration {
    source: 'dsh-config-editor';
    namespace: string;
    providers?: readonly string[];
    pool: unknown;
}
export interface QuotaRoutingInput {
    quota: QuotaView;
    poolConfiguration?: QuotaPoolConfiguration;
    /** Unwrapped responses from the public subscriptions-auth.providerSettings RPC. */
    providerSettings: Readonly<Record<string, unknown>>;
    registeredProviders: readonly string[];
    now?: number;
}
export interface QuotaRouteMember {
    provider: string;
    model: string;
    accountId: string;
}
export interface QuotaMembership {
    status: 'proven' | 'unknown';
    source: 'independent-account' | 'public-pool-configuration' | 'public-account-fallback' | 'unavailable';
    members: QuotaRouteMember[];
    reason: string;
}
export interface QuotaRouteDecision {
    routeId: string;
    eligibility: 'eligible' | 'exhausted' | 'unknown';
    hardSkip: boolean;
    preference: 'neutral';
    hint: 'reported-capacity' | 'reported-full' | 'unknown';
    confidence: 'reported-possibly-cached' | 'insufficient-evidence';
    source: 'dsh-plugin-subscriptions';
    freshness: 'upstream-not-disclosed';
    sampledAt: null;
    readAt: number;
    scope: 'account' | 'pool' | 'unknown';
    /** Stable across re-reads of the same cached windows; excludes readAt. */
    fingerprint: string;
    membership: QuotaMembership;
    windowIds: string[];
    reason: string;
}
/** Read only the exact active subscription entry and its non-secret pool projection. */
export declare const getSubscriptionPoolConfiguration: (editor: {
    entries(): readonly unknown[];
} | undefined) => QuotaPoolConfiguration | undefined;
/** Standalone calls deliberately do not retain normalized catalog state. */
export declare const getQuotaRouteMembership: (route: QuotaRouteInput, input: QuotaRoutingInput) => QuotaMembership;
export declare const getQuotaRouteDecision: (route: QuotaRouteInput, input: QuotaRoutingInput) => QuotaRouteDecision;
/**
 * One synchronous ordering batch gets one detached quota/config snapshot and
 * one normalized account catalog per provider. Nothing survives outside the
 * returned evaluator's scope; there is no global eligibility/health cache.
 * Create a new evaluator for the next ordering, source generation, or request.
 */
export declare const createQuotaRouteEvaluator: (input: QuotaRoutingInput) => ((route: QuotaRouteInput) => QuotaRouteDecision);
/** Stable soft ordering: never drop a route, move a subscription after an API,
 * or move a protected manual/preferred trial. Only the reported-full hint is
 * deferred; reported-capacity and unknown remain in their original order. */
export declare const stableOrderQuotaRoutes: <T extends QuotaRouteInput>(routes: readonly T[], getDecision: (route: T) => QuotaRouteDecision | undefined, protectedRoutes?: readonly QuotaRouteInput[]) => T[];
