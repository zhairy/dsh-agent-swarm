import type { TaskRecord } from './evidence.js'
import type { ExecutionBudgetSnapshot } from './execution-budget.js'
import { getPlanningReviewDiagnostics } from './planning-review.js'

export interface PlanningRecoveryInfo {
  automaticReviewPaused: boolean
  automaticReviews: number
  automaticReviewLimit: number
  contractEditable: true
  nextAction: 'edit-or-review' | 'explicit-review' | 'revise-contract'
  resumeTool: 'swarm_review_plan'
  blockers: ReturnType<typeof getPlanningReviewDiagnostics>
  errors: string[]
  guidance: string
}

/** Bounds automatic generation; this is never permission to reject a valid contract edit. */
export const getPlanningRecovery = (task: Pick<TaskRecord, 'planningAutoReviewRuns' | 'planningFixRounds' | 'planningReview'>, maxFixRounds: number): PlanningRecoveryInfo => {
  const automaticReviews = task.planningAutoReviewRuns ?? ((task.planningFixRounds ?? 0) + (task.planningReview === undefined ? 0 : 1))
  const automaticReviewLimit = Math.max(0, Math.floor(maxFixRounds)) + 1
  const automaticReviewPaused = automaticReviews >= automaticReviewLimit
  const rejected = ['changes_requested', 'needs-clarification', 'review_required'].includes(task.planningReview?.status ?? '')
  return { automaticReviewPaused, automaticReviews, automaticReviewLimit, contractEditable: true,
    nextAction: rejected ? 'revise-contract' : automaticReviewPaused ? 'explicit-review' : 'edit-or-review', resumeTool: 'swarm_review_plan',
    blockers: task.planningReview === undefined ? [] : getPlanningReviewDiagnostics(task.planningReview),
    errors: task.planningReview?.errors ?? [],
    guidance: rejected ? '先读取阻塞维度与独立审查发现，修正实质缺口；阶段任务显式填写 planningScope，保留延期事项及全部安全限制。同一负结论不会通过重复评分改变；维护故障请在已授权独立维护会话隔离验证并部署，不能让原任务自免审。'
      : '服务故障恢复后可显式复审；没有新的需求、合同或证据时停止重复改卡和评分。' }
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
