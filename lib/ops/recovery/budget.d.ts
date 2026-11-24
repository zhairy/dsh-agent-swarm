import { type BudgetConsumed, type ModelUsage } from './schema.js';
export declare const DEFAULT_REPAIR_BUDGET: Readonly<{
    wallMs: 900000;
    toolCalls: 60;
    writes: 20;
    writeBytes: number;
    concurrentProcesses: 2;
    actionRetries: 3;
    maxDepth: 0;
}>;
export interface RepairBudgetPolicy {
    wallMs: number;
    toolCalls: number;
    writes: number;
    writeBytes: number;
    concurrentProcesses: number;
    actionRetries: number;
    maxDepth: number;
}
export declare class RepairBudgetError extends Error {
    readonly code: string;
    constructor(code: string);
}
/** 额度先扣后执行；未知副作用不退款。Token/费用仅观察，不参与任何限额分支。 */
export declare const createRepairBudget: (options?: {
    initial?: BudgetConsumed;
    initialModelCalls?: ModelUsage[];
    initialRetryCounts?: Record<string, number>;
    now?: () => number;
    policy?: Partial<RepairBudgetPolicy>;
}) => {
    policy: {
        wallMs: number;
        toolCalls: number;
        writes: number;
        writeBytes: number;
        concurrentProcesses: number;
        actionRetries: number;
        maxDepth: number;
    };
    check: () => void;
    reserveTool: () => void;
    admitPlan: (calls: number) => void;
    reserveValidation: () => (() => void);
    reserveWrite: (bytes: number) => void;
    acquireProcess: () => (() => void);
    retry: (key: string) => void;
    beginAction: (key: string) => void;
    observeModel: (usage: ModelUsage) => void;
    modelCalls: () => ModelUsage[];
    retryCounts: () => Record<string, number>;
    snapshot: () => BudgetConsumed;
};
export type RepairBudget = ReturnType<typeof createRepairBudget>;
