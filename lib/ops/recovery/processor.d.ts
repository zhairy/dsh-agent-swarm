import { type RepairBudget, type RepairBudgetPolicy } from './budget.js';
import type { DedupStore } from './dedup-store.js';
import type { RecoveryActionResult, RecoveryRunner } from './runner.js';
import { type FailureEvent, type ModelUsage, type RepairAction, type RepairOutcome, type ReviewReport } from './schema.js';
import type { RouteInfo } from '../../domain/routing/routes.js';
export interface RepairProcessorOptions {
    getStore: (event: FailureEvent) => DedupStore;
    getRoute: () => RouteInfo | undefined;
    assertCurrent: (event: FailureEvent) => void;
    plan: (event: FailureEvent, route: RouteInfo, signal: AbortSignal, usage: (value: ModelUsage) => void) => Promise<unknown>;
    reconcile: (event: FailureEvent, signal: AbortSignal) => Promise<boolean>;
    validateResult: (event: FailureEvent, action: RepairAction, result: RecoveryActionResult) => boolean;
    runner: (event: FailureEvent, budget: RepairBudget, checkpoint: () => void, assertCurrent: () => void) => RecoveryRunner;
    /** 必须按 key 幂等交回；不启动主目标、不绕过暂停状态。 */
    handoff: (report: ReviewReport, key: string) => Promise<{
        key: string;
        persisted: true;
    }>;
    onReport?: (report: ReviewReport) => void | Promise<void>;
    log?: (message: string) => void;
    signal?: (event: FailureEvent) => AbortSignal | undefined;
    budgetPolicy?: Partial<RepairBudgetPolicy>;
    now?: () => number;
}
/** 执行器与订阅入口分离；所有 Host 能力由可信闭包提供，模型只能提出待验证动作。 */
export declare const createRepairProcessor: (options: RepairProcessorOptions) => {
    drainHandoffs: (event: FailureEvent, signal?: AbortSignal) => Promise<void>;
    process: (input: FailureEvent) => Promise<RepairOutcome>;
};
