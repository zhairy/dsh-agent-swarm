import { type RouteResourcePolicy } from './provider-policy.js';
/** The installed subscriptions plugin's public read-only RPC surface. */
export declare const SUBSCRIPTION_QUOTA_PROVIDERS: readonly ['codex', 'claude', 'grok', 'copilot', 'antigravity'];
export type SubscriptionQuotaProvider = typeof SUBSCRIPTION_QUOTA_PROVIDERS[number];
export declare const QUOTA_FRESHNESS_NOTICE = "\u4E0A\u6E38\u91C7\u6837\u65F6\u95F4\u672A\u516C\u5F00\uFF0C\u53EF\u80FD\u4E3A\u8BA2\u9605\u63D2\u4EF6\u7F13\u5B58\uFF1B\u8BFB\u53D6\u65F6\u95F4\u4E0D\u7B49\u4E8E\u4F9B\u5E94\u5546\u91C7\u6837\u65F6\u95F4\u3002";
export declare const QUOTA_UNAVAILABLE_NOTICE = "\u5F53\u524D\u5BBF\u4E3B\u672A\u516C\u5F00\u6B64\u6A21\u578B\u7684\u989D\u5EA6\u8BFB\u53D6\u63A5\u53E3\uFF1B\u989D\u5EA6\u672A\u77E5\uFF0C\u4E0D\u4EE5\u672C\u5730\u8C03\u7528\u6570\u3001Token \u6D88\u8017\u6216\u4EF7\u683C\u63A8\u7B97\u3002";
export interface QuotaRouteInput {
    provider: string;
    model: string;
    policy?: RouteResourcePolicy;
}
export interface QuotaWindow {
    id: string;
    kind: 'session' | 'weekly' | 'other';
    scope?: string;
    unit: 'percent';
    usedPercent: number;
    resetsAt?: number;
    resetState: 'future' | 'elapsed' | 'unknown';
}
export type QuotaStatus = 'reported' | 'unknown' | 'unsupported' | 'logged-out' | 'error';
export interface QuotaAccount {
    /** Opaque stable identity; account emails and raw store keys are not exposed. */
    id: string;
    label: string;
    isDefault: boolean;
    status: QuotaStatus;
    completeness: 'complete' | 'partial' | 'unknown';
    readAt: number;
    sampledAt: null;
    freshness: 'upstream-not-disclosed';
    plan?: string;
    windows: QuotaWindow[];
    warnings: string[];
}
export interface QuotaProvider {
    provider: SubscriptionQuotaProvider;
    status: QuotaStatus;
    readAt: number;
    accounts: QuotaAccount[];
    warnings: string[];
}
export interface QuotaRouteView {
    routeId: string;
    provider: string;
    /** Independent-account identifiers are reduced to their wire model id. */
    model: string;
    modelIdentity: 'wire' | 'account-redacted';
    accessMode: NonNullable<RouteResourcePolicy['accessMode']>;
    policyConflict?: boolean;
    status: QuotaStatus;
    /** Provider account views are not proof of the actual pool member selected. */
    mapping: 'independent-account' | 'provider-accounts' | 'unmapped';
    accountIds: string[];
    windowIds: string[];
    warnings: string[];
}
export interface QuotaView {
    source: 'dsh-plugin-subscriptions';
    readAt: number;
    sampledAt: null;
    freshness: 'upstream-not-disclosed';
    providers: QuotaProvider[];
    routes: QuotaRouteView[];
    warnings: string[];
    delivery: 'read' | 'local-cache' | 'shared-read';
    cacheAgeMs: number;
    refreshRequested: boolean;
    refreshJoinedExisting: boolean;
}
export type QuotaRpcMethod = 'subscriptions-auth.status' | 'subscriptions-auth.usage' | 'subscriptions-auth.providerSettings';
export type QuotaRpcInvoke = (method: QuotaRpcMethod, payload: {
    provider?: SubscriptionQuotaProvider;
    account?: string;
    force?: boolean;
}, signal: AbortSignal) => Promise<unknown>;
export interface QuotaReader {
    invalidate?: () => void;
    read(input?: {
        routes?: readonly QuotaRouteInput[];
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<QuotaView>;
}
export declare const getQuotaAccountId: (provider: string, account: string) => string;
export declare const getQuotaRouteId: (provider: string, model: string) => string;
/**
 * Normalize provider-reported percentages only. No conversion into tokens,
 * money, a five-hour duration, or an inferred remaining subscription allowance.
 */
export declare const normalizeSubscriptionUsage: (provider: SubscriptionQuotaProvider, account: string, raw: unknown, readAt: number) => Pick<QuotaAccount, 'status' | 'completeness' | 'plan' | 'windows' | 'warnings'>;
export declare const parseQuotaAccountModel: (model: string) => {
    account: string;
    model: string;
} | undefined;
/** Reasoning levels do not create another account allowance for the same model. */
export declare const mapQuotaRoutes: (routes: readonly QuotaRouteInput[], providers: readonly QuotaProvider[]) => QuotaRouteView[];
/**
 * Read the subscriptions plugin's supported RPCs, not its auth store, private
 * controller, or cached internals. There is no local quota estimate. The
 * 30-second view cache preserves its original read time; overlapping reads
 * share work, and a newly started manual refresh passes force upstream.
 */
export declare const createQuotaReader: (deps: {
    invoke: QuotaRpcInvoke;
    now?: () => number;
}) => QuotaReader;
/**
 * Trusted in-process carrier for the fixed public read-only endpoints. Wire
 * this only from an already-authorized Host operation/RPC; never expose the
 * handler as an arbitrary proxy or supply browser credentials to it.
 */
export declare const createSubscriptionQuotaInvoker: (getHandler: () => {
    fetch(request: Request): Promise<Response>;
} | ((request: Request) => Promise<Response>) | undefined) => QuotaRpcInvoke;
