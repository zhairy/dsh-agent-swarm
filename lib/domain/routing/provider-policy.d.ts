import type { RouteFailureInput, RouteInfo } from './routes.js';
export type FailureKind = 'quota_exhausted' | 'pool_exhausted' | 'insufficient_balance' | 'auth_invalid' | 'model_unavailable' | 'rate_limited' | 'network_transient' | 'service_transient' | 'context_exceeded' | 'capability_mismatch' | 'protocol_incompatible' | 'unknown';
/** 只存适配器返回的不透明身份，不保存账号或凭据。缺失时只隔离当前路由。 */
export interface RouteResourcePolicy {
    accessMode?: 'subscription' | 'metered_api' | 'judgment_api' | 'unknown';
    quotaDomainId?: string;
    quotaScope?: 'account' | 'plan' | 'model' | 'pool' | 'unknown';
    poolId?: string;
    capabilities?: {
        generation?: boolean;
        structuredOutput?: boolean;
        vision?: boolean;
        tools?: boolean;
    };
}
/**
 * Provider IDs with a verified built-in resource contract.
 *
 * Client generation uses this list instead of deriving the settings-page map
 * from display labels. A provider can therefore have a resource type even
 * when its product label is missing, and the two concerns no longer drift.
 */
export declare const BUILTIN_ROUTE_PROVIDERS: readonly ['qwen-token-plan-cn', 'opencode-go', 'dsh-opencode-go', 'opencode', 'antigravity', 'codex', 'claude', 'grok', 'copilot', 'deepseek-official', 'jev'];
export type BuiltinRouteProvider = typeof BUILTIN_ROUTE_PROVIDERS[number];
/** Existing Codex wire contract: catalog ultra is sent as max; other providers retain their own levels. */
export declare const getWireReasoningEffort: (route: Pick<RouteInfo, 'provider' | 'reasoningEffort'>) => string | undefined;
/** 已核验内置 provider 契约，不按模型名称猜额度域。自定义接入可显式覆盖为 unknown。 */
export declare const getRouteResourcePolicy: (route: RouteInfo) => RouteResourcePolicy;
export interface RouteFailureMetadata extends RouteFailureInput {
    kind?: string;
    quotaDomainId?: string;
    quotaScope?: RouteResourcePolicy['quotaScope'];
    poolId?: string;
    resetAt?: string;
    providerRetryAfterMs?: number;
    requestId?: string;
}
export interface NormalizedRouteFailure extends RouteFailureMetadata {
    kind: FailureKind;
    provider: string;
    model: string;
    message: string;
}
/** DSH LlmError.failure 是已发布的结构化事实；无该字段时只保留实际错误自身字段。 */
export declare const getRouteFailure: (error: unknown) => RouteFailureMetadata;
/** 这类拒绝依赖当前历史，不能据此判定同模型对所有新会话都不可用。 */
export declare const isConversationProtocolFailure: (failure: Pick<NormalizedRouteFailure, 'kind'> & {
    message?: string;
}) => boolean;
/** Probe delays, not subscription reset times. A new logical request admits at most one half-open owner. */
export declare const ROUTE_RECOVERY_COOLDOWNS_MS: Readonly<Record<FailureKind, number>>;
export declare const getRouteRecoveryPolicy: (failure: Pick<NormalizedRouteFailure, 'kind' | 'providerRetryAfterMs'> & {
    message?: string;
}, retryCount?: number) => {
    isolate: boolean;
    retryDelayMs: number;
};
/** 有确切终态事实才按额度处理，普通 rate-limit/quota-per-minute 不扩大成账号封禁。 */
export declare const normalizeRouteFailure: (failure: RouteFailureMetadata, route: RouteInfo, at?: number) => NormalizedRouteFailure;
export declare const isTerminalRouteFailure: (failure: NormalizedRouteFailure) => boolean;
