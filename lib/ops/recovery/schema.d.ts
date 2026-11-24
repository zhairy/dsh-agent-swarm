export interface FailureEvent {
    source: 'host-failure';
    failureKind: string;
    exceptionType: string;
    message: string;
    projectRoot: string;
    taskType: string;
    toolName: string;
    affectedFiles: string[];
    rootSessionId: string;
    taskId: string;
    nodeId: string;
    attemptId: string;
    contractRevision: number;
    sideEffectState: 'none' | 'confirmed' | 'unknown';
    repairDepth: number;
}
export interface BudgetConsumed {
    wall_ms: number;
    tool_calls: number;
    writes: number;
    write_bytes: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    retries: number;
}
export interface ModelUsage {
    callId: string;
    provider: string;
    model: string;
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
}
export interface RepairAction {
    id: string;
    tool: string;
    kind: 'read' | 'write' | 'process' | 'rollback';
    arguments: Record<string, unknown>;
    paths: string[];
    writeBytes: number;
    idempotent: boolean;
    reversibleConfirmed: boolean;
}
export interface RepairPlan {
    summary: string;
    actions: RepairAction[];
    verification: RepairAction;
}
export interface ReviewReport {
    fingerprint: string;
    failureKind?: string;
    binding?: {
        rootSessionId: string;
        taskId: string;
        nodeId: string;
        attemptId: string;
        contractRevision: number;
    };
    status: 'succeeded' | 'failed' | 'manual_required';
    occurrences: number;
    attempts: number;
    consumed: BudgetConsumed;
    actions: Array<{
        id: string;
        tool: string;
        status: string;
    }>;
    modelCalls: ModelUsage[];
    usageCoverage: {
        tokensComplete: boolean;
        costComplete: boolean;
    };
    reason: string;
    recommendations: string[];
}
export interface RepairOutcome {
    status: ReviewReport['status'] | 'deduped';
    report?: ReviewReport;
    delivery?: 'pending' | 'delivered';
    repairTaskId?: string;
}
export declare const emptyBudget: () => BudgetConsumed;
export declare const record: (raw: unknown) => Record<string, unknown>;
export declare const text: (value: unknown, name: string, max?: number) => string;
export declare const nonnegative: (value: unknown) => value is number;
export declare const count: (value: unknown, name: string) => number;
export declare const relativeFile: (root: string, raw: unknown) => string;
export declare const validateFailureEvent: (raw: unknown) => FailureEvent;
export declare const validateBudget: (raw: unknown) => BudgetConsumed;
export declare const validateAction: (raw: unknown) => RepairAction;
export declare const validateRepairPlan: (raw: unknown) => RepairPlan;
export declare const validateReviewReport: (raw: unknown) => ReviewReport;
