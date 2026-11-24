import type { RouteInfo } from './domain/routing/routes.js';
/** Manual controls are a pause/selection latch, not a second task scheduler. */
export type AgentControlPhase = 'idle' | 'running' | 'waiting' | 'stopping' | 'paused' | 'recovery-required';
export interface AgentControlBinding {
    childId: string;
    parentSessionId: string;
    taskId: string;
    delegationId: string;
    persistent: boolean;
    needsSideEffectReview?: boolean;
    requestRevision?: number;
    cardRevision?: number;
    workflowRevision?: number;
}
export interface ActualAgentAttempt {
    attemptId: string;
    /** Host attempt counters may restart on cold attachment of the same persistent child. */
    delegationId?: string;
    route: RouteInfo;
    observedAt: number;
    state: 'running' | 'settled' | 'unknown';
    source: 'agent-loop-attempt';
}
export interface AgentControlRecord extends AgentControlBinding {
    revision: number;
    phase: AgentControlPhase;
    paused: boolean;
    selectedNext?: RouteInfo;
    /** Request assembly is separate from an observed dispatched attempt. */
    requestedRoute?: RouteInfo;
    actual?: ActualAgentAttempt;
    /** 一次性子会话的单调结算锁；显示原因或迟到选择不能重新开放它。 */
    oneShotSettled?: boolean;
    reason?: string;
    updatedAt: number;
}
export interface AgentControlAddress {
    parentSessionId: string;
    childId: string;
    expectedRevision: number;
}
export interface AgentControlDeps {
    validateRoute: (route: RouteInfo) => Promise<RouteInfo>;
    interrupt: (binding: AgentControlBinding) => void | Promise<void>;
    applyOverride: (childId: string, route: RouteInfo | undefined) => void;
    setPaused: (childId: string, paused: boolean) => void;
    /** The current task contract/lease is revalidated by the existing delegation pipeline. */
    resume: (binding: AgentControlBinding, input?: {
        steering?: string;
    }) => Promise<{
        accepted: true;
        delegationId?: string;
    }>;
    /** 原委派仍在执行（例如模型出错后正在退避等待自动重试）：此时人工继续会打断自动恢复 */
    isDelegationActive?: (binding: AgentControlBinding) => boolean;
    persist?: (records: AgentControlRecord[], parentSessionIds?: readonly string[]) => void | Promise<void>;
    /** A user-authorized, scoped one-time probe; never a provider-wide cache clear. */
    retryRoute?: (route: RouteInfo, childId: string, force: boolean) => void | Promise<void>;
    cancelRetryRoute?: (childId: string) => void;
    now?: () => number;
}
/** Durable state validation never imports an arbitrary browser-selected policy object. */
export declare const ValidateAgentControlRecords: (raw: unknown) => raw is AgentControlRecord[];
export declare const createAgentControl: (deps: AgentControlDeps) => {
    Export: (parentSessionId?: string) => AgentControlRecord[];
    getView: (parentSessionId: string, childId: string) => AgentControlRecord;
    get: (childId: string) => AgentControlRecord | undefined;
    isPaused: (childId: string) => boolean;
    Register: (binding: AgentControlBinding) => {
        childId: string;
        parentSessionId: string;
        taskId: string;
        delegationId: string;
        persistent: boolean;
        needsSideEffectReview?: boolean;
        requestRevision?: number;
        cardRevision?: number;
        workflowRevision?: number;
        phase: AgentControlPhase;
        paused: boolean;
        selectedNext?: RouteInfo;
        requestedRoute?: RouteInfo;
        actual?: ActualAgentAttempt;
        oneShotSettled?: boolean;
        reason?: string;
        revision: number;
        updatedAt: number;
    };
    /** Drop settled controls only after the owning task reaches a terminal decision. */
    ForgetTask: (parentSessionId: string, taskId: string) => Promise<string[]>;
    Restore: (raw: unknown, parentSessionId: string) => void;
    ObserveRequest: (childId: string, requestedRoute: RouteInfo) => void;
    ObserveSelection: (childId: string, selectedNext: RouteInfo) => void;
    MarkAttemptStarted: (childId: string, attemptId: string, effectiveRoute?: RouteInfo) => void;
    MarkWaiting: (childId: string, waiting: boolean) => void;
    /** Only the final allowed mutation tool boundary calls this; role names alone are insufficient. */
    MarkSideEffectRisk: (childId: string) => void;
    MarkBlocked: (childId: string, reason: string) => void;
    MarkAttemptSettled: (childId: string, attemptId: string) => void;
    MarkRunSettled: (childId: string, stopReason?: string) => void;
    MarkOneShotCancelled: (childId: string) => void;
    /** Trusted host reconciliation only, never a browser's claim that cancellation finished. */
    ReconcileIdle: (childId: string) => void;
    Select: (input: AgentControlAddress & {
        route: RouteInfo;
        interruptRunning?: boolean;
        retryRoute?: boolean;
        forceRetry?: boolean;
    }) => Promise<AgentControlRecord>;
    Stop: (input: AgentControlAddress) => Promise<AgentControlRecord>;
    Continue: (input: AgentControlAddress & {
        confirmSafeToContinue?: boolean;
        steering?: string;
    }) => Promise<{
        accepted: true;
        delegationId?: string;
        control: AgentControlRecord;
    }>;
};
export type AgentControl = ReturnType<typeof createAgentControl>;
