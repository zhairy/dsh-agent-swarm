import type { TaskRecord } from './evidence.js';
import type { ExecutionBudgetSnapshot } from './execution-budget.js';
import { getPlanningReviewDiagnostics } from './planning-review.js';
export interface PlanningRecoveryInfo {
    automaticReviewPaused: boolean;
    automaticReviews: number;
    automaticReviewLimit: number;
    contractEditable: true;
    nextAction: 'edit-or-review' | 'explicit-review' | 'revise-contract';
    resumeTool: 'swarm_review_plan';
    blockers: ReturnType<typeof getPlanningReviewDiagnostics>;
    errors: string[];
    failureKind: 'none' | 'service' | 'semantic' | 'structural';
    /** 不合格审核输出也可提供诊断材料，但这些文本从不构成批准。 */
    findings?: Array<{
        location: string;
        issue: string;
        evidence: string;
        suggestion: string;
    }>;
    guidance: string;
}
/** Bounds automatic generation; this is never permission to reject a valid contract edit. */
export declare const getPlanningRecovery: (task: Pick<TaskRecord, 'planningAutoReviewRuns' | 'planningFixRounds' | 'planningReview'>, maxFixRounds: number) => PlanningRecoveryInfo;
/** Move only positively identified old planning calls out of execution accounting. */
export declare const partitionLegacyPlanningBudget: (snapshot: ExecutionBudgetSnapshot) => {
    execution: ExecutionBudgetSnapshot;
    planning?: ExecutionBudgetSnapshot;
};
