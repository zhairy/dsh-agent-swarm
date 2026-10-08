import type { TaskRecord } from './evidence.js'
import type { ExecutionBudgetSnapshot } from './execution-budget.js'

export interface PlanningRecoveryInfo {
  automaticReviewPaused: boolean
  automaticReviews: number
  automaticReviewLimit: number
  contractEditable: true
  nextAction: 'edit-or-review' | 'explicit-review'
  resumeTool: 'swarm_review_plan'
}

/** Bounds automatic generation; this is never permission to reject a valid contract edit. */
export const getPlanningRecovery = (task: Pick<TaskRecord, 'planningAutoReviewRuns' | 'planningFixRounds' | 'planningReview'>, maxFixRounds: number): PlanningRecoveryInfo => {
  const automaticReviews = task.planningAutoReviewRuns ?? ((task.planningFixRounds ?? 0) + (task.planningReview === undefined ? 0 : 1))
  const automaticReviewLimit = Math.max(0, Math.floor(maxFixRounds)) + 1
  const automaticReviewPaused = automaticReviews >= automaticReviewLimit
  return { automaticReviewPaused, automaticReviews, automaticReviewLimit, contractEditable: true,
    nextAction: automaticReviewPaused ? 'explicit-review' : 'edit-or-review', resumeTool: 'swarm_review_plan' }
}

/** Move only positively identified old planning calls out of execution accounting. */
export const partitionLegacyPlanningBudget = (snapshot: ExecutionBudgetSnapshot): { execution: ExecutionBudgetSnapshot; planning?: ExecutionBudgetSnapshot } => {
  const execution = structuredClone(snapshot)
  const planningCalls = execution.reservations.filter((record) => record.source === 'delegate'
    && /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id))
  if (planningCalls.length === 0) return { execution }
  const moved = new Set(planningCalls.map((record) => record.id))
  execution.reservations = execution.reservations.filter((record) => !moved.has(record.id))
  return { execution, planning: { schemaVersion: 1, limits: {}, reservations: planningCalls,
    jev: { attempts: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unknownUsage: 0, unknownCost: 0 },
    coverage: ['planning-review-control-plane', 'migrated-legacy-planning-calls'] } }
}
