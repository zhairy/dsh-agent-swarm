import type { CallConfigLike } from './host-contract.js';
import type { RouteInfo } from './domain/routing/routes.js';
export interface ModelContextInfo {
    context?: {
        contextWindow?: number;
    };
    defaultMaxTokens?: number;
}
export interface ContextAdmissionInfo {
    ok: boolean;
    measuredTokens?: number;
    contextWindow?: number;
    reservedOutputTokens?: number;
    safetyMarginTokens?: number;
    safeInputTokens?: number;
    metadataSource?: 'host' | 'openai-api-compat';
    reason?: string;
}
export declare const CONTEXT_SAFETY_MARGIN_TOKENS = 4096;
/**
 * Decide whether a route can hold the current session before a provider call.
 * Provider-reported/host-metered total tokens are treated as an upper bound;
 * unknown measurements or capacity remain compatible and do not block a route.
 */
export declare const getContextAdmission: (input: {
    route: Pick<RouteInfo, 'provider' | 'model'>;
    call: Pick<CallConfigLike, 'maxTokens'>;
    measurement?: {
        totalTokens: number;
    };
    modelInfo?: ModelContextInfo;
}) => ContextAdmissionInfo;
export declare const formatContextAdmissionError: (rejected: readonly ContextAdmissionInfo[]) => string;
