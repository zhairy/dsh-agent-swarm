import type { FailureKind } from './domain/routing/provider-policy.js';
import type { RouteInfo } from './domain/routing/routes.js';
export type RouteObservationScope = 'root' | 'child';
export type RouteObservationFinal = 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'superseded' | 'released';
export type RouteObservationEndReason = 'host_success' | 'route_terminal' | 'signal_aborted' | 'manual_pause' | 'new_request' | 'logical_request_finished' | 'agent_released';
export type RouteObservationTerminal = 'route_chain_exhausted' | 'recovery_attempts_exhausted' | 'route_health_persist_failed' | 'context_recovery_required';
export interface RouteObservationPosition {
    turn: number;
    step: number;
}
export interface RouteObservationWaitOutcome {
    at: number;
    waitedMs?: number;
    outcome: 'completed' | 'timeout' | 'cancelled' | 'unknown';
    reportedRecovered?: boolean;
}
export interface RouteObservationBudget {
    maxLogicalAttempts: number | null;
    logicalAttemptsUsed: number;
    maxTransientRetries: number | null;
    transientRetriesUsed: number;
    maxTransientWaitMs: number | null;
    transientWaitUsedMs: number;
    maxHoldWaits: number | null;
    holdWaitsUsed: number;
    maxHoldWaitMs: number | null;
    holdWaitUsedMs: number;
}
export interface RouteObservationSelection {
    ordinal: number;
    at: number;
    route: RouteInfo;
    attemptId: string | null;
}
export interface RouteObservationAttempt {
    attemptId: string;
    startedAt: number;
    endedAt: number | null;
    route: RouteInfo | null;
    routeSource: 'host-request-header' | 'selected-admission' | 'unavailable';
    outcome: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unsettled';
}
export interface RouteObservationFailure {
    at: number;
    kind: FailureKind;
    route: RouteInfo;
    status: number | null;
    retryAfterMs: number | null;
    attemptId: string | null;
    terminal: RouteObservationTerminal | null;
}
export interface RouteObservationIgnoredFailure {
    at: number;
    kind: FailureKind;
    route: RouteInfo;
    status: number | null;
    retryAfterMs: number | null;
    reason: 'stale_request' | 'duplicate_failure' | 'manual_pause' | 'signal_aborted';
}
export interface RouteObservationWait {
    waitId: string;
    reason: 'network' | 'route' | 'retry' | 'context_compaction';
    startedAt: number;
    plannedMs: number | null;
    endedAt: number | null;
    waitedMs: number | null;
    outcome: 'waiting' | 'completed' | 'timeout' | 'cancelled' | 'unknown';
    reportedRecovered: boolean | null;
    route: RouteInfo | null;
    failureKind: FailureKind | null;
}
export interface RouteObservationRequest {
    requestId: string;
    scope: RouteObservationScope;
    position: RouteObservationPosition | null;
    startedAt: number;
    endedAt: number | null;
    final: RouteObservationFinal;
    endReason: RouteObservationEndReason | null;
    terminal: RouteObservationTerminal | null;
    selections: RouteObservationSelection[];
    attempts: RouteObservationAttempt[];
    failures: RouteObservationFailure[];
    ignoredFailures: RouteObservationIgnoredFailure[];
    waits: RouteObservationWait[];
    budget: RouteObservationBudget;
    omittedSelections: number;
    omittedAttempts: number;
    omittedFailures: number;
    omittedIgnoredFailures: number;
    omittedWaits: number;
}
export interface RouteObservabilitySnapshot {
    schemaVersion: 1;
    generatedAt: number;
    retainedRequests: number;
    /** 进程保留预算累计省略数；agent过滤只作用于请求列表。 */
    omittedRequests: number;
    requests: RouteObservationRequest[];
}
export interface RouteObservabilityOptions {
    now?: () => number;
    maxRequests?: number;
    maxSelections?: number;
    maxAttempts?: number;
    maxFailures?: number;
    maxIgnoredFailures?: number;
    maxWaits?: number;
}
export interface BeginRouteObservationInput {
    agentId: string;
    requestId: string;
    scope: RouteObservationScope;
    at: number;
    position?: RouteObservationPosition;
}
export interface AddRouteSelectionInput {
    agentId: string;
    requestId: string;
    ordinal: number;
    at: number;
    route: RouteInfo;
}
export interface AddRouteAttemptStartInput {
    agentId: string;
    requestId: string;
    attemptId: string;
    at: number;
    route?: RouteInfo;
}
export interface AddRouteFailureInput {
    agentId: string;
    requestId: string;
    at: number;
    kind: FailureKind;
    route: RouteInfo;
    status?: number;
    retryAfterMs?: number;
    terminal?: RouteObservationTerminal;
}
export interface AddIgnoredRouteFailureInput extends Omit<AddRouteFailureInput, 'terminal'> {
    reason: RouteObservationIgnoredFailure['reason'];
}
export interface BeginRouteWaitInput {
    agentId: string;
    requestId: string;
    at: number;
    reason: RouteObservationWait['reason'];
    plannedMs?: number;
    route?: RouteInfo;
    failureKind?: FailureKind;
}
export interface FinishRouteObservationInput {
    agentId: string;
    requestId: string;
    at: number;
    final: Exclude<RouteObservationFinal, 'pending'>;
    endReason: RouteObservationEndReason;
    terminal?: RouteObservationTerminal;
}
export interface UpdateRouteBudgetInput {
    agentId: string;
    requestId: string;
    budget: RouteObservationBudget;
}
export interface RouteObservabilityStore {
    BeginRequest: (input: BeginRouteObservationInput) => void;
    AddSelection: (input: AddRouteSelectionInput) => void;
    AddAttemptStart: (input: AddRouteAttemptStartInput) => void;
    AddFailure: (input: AddRouteFailureInput) => void;
    AddIgnoredFailure: (input: AddIgnoredRouteFailureInput) => void;
    BeginWait: (input: BeginRouteWaitInput) => string | null;
    EndWait: (waitId: string | null, result: RouteObservationWaitOutcome) => void;
    UpdateBudget: (input: UpdateRouteBudgetInput) => void;
    FinishRequest: (input: FinishRouteObservationInput) => void;
    getSnapshot: (agentIds?: readonly string[]) => RouteObservabilitySnapshot;
}
/**
 * 创建进程内有界路由观测器。
 *
 * 原始 agent/request/attempt 标识只在内部用于关联；投影使用进程随机密钥的
 * HMAC，重启后不可跨实例关联。调用方不得传入错误正文、账号标识或凭据。
 */
export declare const intRouteObservability: (options?: RouteObservabilityOptions) => RouteObservabilityStore;
