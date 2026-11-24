import type { RouteInfo } from './routes.js';
import { type NormalizedRouteFailure } from './provider-policy.js';
export interface RouteHealthEntry {
    key: string;
    kind: NormalizedRouteFailure['kind'];
    failedAt: number;
    /** Identifies one observed failure across independent root snapshots. */
    failureId?: string;
    /** Explicit provider reset timestamp; manual retries cannot bypass this floor. */
    resetAt?: number;
    /** Earliest plugin recovery probe, not a claim that a subscription has reset. */
    retryAt?: number;
    retryCount?: number;
    halfOpenAgent?: string;
    route: RouteInfo;
    aliases?: string[];
}
export interface RouteHealthClear {
    key: string;
    failedAt: number;
    failureId?: string;
    clearedAt: number;
}
export interface RouteHealthSnapshot {
    schemaVersion: 1;
    entries: RouteHealthEntry[];
    cleared: RouteHealthClear[];
}
/** All aliases and clear barriers share one bounded identity space; none are evicted by age/LRU. */
export declare const MAX_ROUTE_HEALTH_KEYS = 4096;
export interface RouteManualRetryResult {
    ok: boolean;
    keys: string[];
    reason?: 'provider-reset-pending' | 'cooldown-pending' | 'retry-in-flight' | 'invalid-owner';
    retryAt?: number;
}
/** One stable validator is shared by persistence and the live registry. */
export declare const validateRouteHealthSnapshot: (raw: unknown) => raw is RouteHealthSnapshot | RouteHealthEntry[];
/** 一个 profile 内所有根会话、角色与线程共享。释放 Agent 不会清除隔离状态。 */
export declare const intRouteHealth: (now?: () => number) => {
    record: (route: RouteInfo, failure: NormalizedRouteFailure, cooldownMs?: number) => void;
    /** 最早可以重新尝试的时刻（没有隔离记录为 0）；只用于等待调度，准入仍以 claim 为准。 */
    getDueAt: (route: RouteInfo) => number;
    /** Admission eligibility only: an elapsed cooldown permits a probe, not a claim of restored quota. */
    isAvailable: (route: RouteInfo) => boolean;
    claim: (route: RouteInfo, agentId: string) => boolean;
    /** User-controlled, scoped permit. force only bypasses plugin cooldown, never provider reset. */
    claimManualRetry: (route: RouteInfo, agentId: string, options?: {
        force?: boolean;
    }) => RouteManualRetryResult;
    getRelatedEntries: (route: RouteInfo) => RouteHealthEntry[];
    /** Cancellation releases an in-flight probe; it never restores a failed resource as healthy. */
    release: (agentId: string) => void;
    succeeded: (route: RouteInfo, agentId: string) => boolean;
    failHalfOpen: (route: RouteInfo, agentId: string) => boolean;
    clear: (key?: string) => void;
    list: () => RouteHealthEntry[];
    getSnapshot: () => RouteHealthSnapshot;
    restore: (raw: unknown) => void;
};
export type RouteHealth = ReturnType<typeof intRouteHealth>;
