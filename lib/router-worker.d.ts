export declare const EVENT_FILTER_REASONS: readonly ['duplicate', 'self-echo', 'ignored-kind', 'stale-request-revision', 'stale-card-revision', 'stale-workflow-revision', 'stale-lease'];
export type EventFilterReason = typeof EVENT_FILTER_REASONS[number];
export interface EventFilterInput {
    eventId: string;
    idempotencyKey?: string;
    kind: string;
    senderAgentId?: string;
    rootAgentId: string;
    ignoredKinds?: readonly string[];
    requestRevision: number;
    cardRevision: number;
    workflowRevision: number;
    leaseEpoch: number;
    current: {
        requestRevision: number;
        cardRevision: number;
        workflowRevision: number;
        leaseEpoch: number;
    };
    seen: {
        has(key: string): boolean;
    };
}
export type EventFilterResult = {
    accepted: true;
} | {
    accepted: false;
    reason: EventFilterReason;
};
/** Filter host events before they can mutate a ticket or start a model call. */
export declare const filterEvent: (input: EventFilterInput) => EventFilterResult;
export declare const ROUTER_DENIED_TOOLS: Set<string>;
/** 天枢默认不应在模型工具清单中看到的执行、写入与可写工作树能力。 */
export declare const ROUTER_HIDDEN_MODEL_TOOLS: readonly ["bash", "pwsh", "run_code", "swarm_kernel_execute", "write", "edit", "apply_patch", "nb_save", "create_worktree", "enter_worktree", "exit_worktree", "swarm_restore_worktree", "swarm_bind_primary_workspace", "swarm_git_save", "swarm_prepare_verification"];
/** DSH 的 PTC 传输名由执行器保留，不能被 tools.restrict() 过滤。 */
export declare const ROUTER_RESERVED_TRANSPORT_TOOLS: readonly ["run_code"];
export interface RouterToolVisibility {
    /** 可由 Host 作用域隐藏的全局工具。 */
    deny: readonly string[];
    /** 已出现但只能通过 Host 组合层排除的保留传输工具。 */
    reservedTransport: readonly string[];
}
/**
 * 计算天枢当前步骤的模型可见工具边界。
 *
 * 非 human 顶层轮次（例如 goal round）隐藏 create_goal；直接 human 轮次保留，
 * 但命令、文件写入和可写工作树能力始终由 Worker 执行。run_code 是 PTC 保留传输，
 * 不能传给 tools.restrict()，由调用方在真实出现时 fail closed。
 */
export declare const getRouterToolVisibility: (visibleNames: readonly string[], directHumanTurn: boolean, workspaceWritesAllowed?: boolean) => RouterToolVisibility;
/** The router may route and read evidence; host denial and writes stay with workers. */
export declare const getRouterToolDenial: (toolName: string, argumentsValue?: unknown) => string | undefined;
export interface AssignmentEnvelope {
    ticketId: string;
    assignmentId: string;
    role: string;
    workerKind: 'expert' | 'native-codex' | 'native-claude';
    provider: string;
    model: string;
    reasoningEffort?: string;
    requestRevision: number;
    cardRevision: number;
    workflowRevision: number;
    leaseEpoch: number;
    inputDigest: string;
    permissions: readonly string[];
    createdAt: number;
}
export interface WorkerSubmission {
    ticketId: string;
    assignmentId: string;
    requestRevision: number;
    cardRevision: number;
    workflowRevision: number;
    leaseEpoch: number;
    inputDigest: string;
}
export type WorkerSubmissionResult = {
    accepted: true;
} | {
    accepted: false;
    reason: 'ticket-mismatch' | 'assignment-mismatch' | 'stale-request-revision' | 'stale-card-revision' | 'stale-workflow-revision' | 'stale-lease' | 'input-mismatch';
};
export declare const ValidateAssignmentEnvelope: (value: unknown) => value is AssignmentEnvelope;
export declare const validateWorkerSubmission: (envelope: AssignmentEnvelope, submission: WorkerSubmission) => WorkerSubmissionResult;
