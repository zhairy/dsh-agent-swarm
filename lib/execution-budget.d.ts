export type BudgetSource = 'delegate' | 'model' | 'native' | 'math' | 'jev';
export interface ExecutionBudgetLimits {
    maxDelegations?: number;
    maxModelAttempts?: number;
    maxMathCalls?: number;
    maxMathWorkUnits?: number;
    maxTokens?: number;
    maxCostUsd?: number;
}
export interface UsageObservation {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    workUnits?: number;
}
export interface BudgetReservation {
    id: string;
    source: BudgetSource;
    state: 'reserved' | 'started' | 'settled' | 'cancelled';
    estimatedTokens: number;
    estimatedCostUsd: number;
    estimatedWorkUnits: number;
    tokenEstimateKnown?: boolean;
    costEstimateKnown?: boolean;
    usage?: UsageObservation;
    usageUnknown?: boolean;
    exempt: boolean;
}
export interface ExecutionBudgetSnapshot {
    schemaVersion: 1;
    limits: ExecutionBudgetLimits;
    reservations: BudgetReservation[];
    jev: {
        attempts: number;
        inputTokens: number;
        outputTokens: number;
        costUsd: number;
        unknownUsage: number;
        unknownCost?: number;
    };
    coverage: string[];
}
export declare class ExecutionBudgetError extends Error {
    readonly code: 'BUDGET_EXHAUSTED' | 'BUDGET_INVALID' | 'BUDGET_TRANSITION' | 'BUDGET_UNSUPPORTED' | 'REQUEST_CONFLICT';
    constructor(code: 'BUDGET_EXHAUSTED' | 'BUDGET_INVALID' | 'BUDGET_TRANSITION' | 'BUDGET_UNSUPPORTED' | 'REQUEST_CONFLICT', message: string);
}
export interface ExecutionBudget {
    reserve: (input: {
        id: string;
        source: BudgetSource;
        estimatedTokens?: number;
        estimatedCostUsd?: number;
        estimatedWorkUnits?: number;
    }) => BudgetReservation;
    start: (id: string) => BudgetReservation;
    settle: (id: string, usage?: UsageObservation) => BudgetReservation;
    cancel: (id: string) => BudgetReservation;
    observeJev: (usage?: UsageObservation, attempts?: number) => void;
    getReservation: (id: string) => BudgetReservation | undefined;
    getSnapshot: () => ExecutionBudgetSnapshot;
    remainingMathWork: () => number | undefined;
}
/** Synchronous reservation makes check-and-consume atomic within one JS isolate; Jev never enters limits. */
export declare const createExecutionBudget: (limits?: ExecutionBudgetLimits, restored?: ExecutionBudgetSnapshot, coverage?: string[]) => ExecutionBudget;
