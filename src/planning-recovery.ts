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
  failureKind: 'none' | 'service' | 'semantic' | 'structural'
  guidance: string
}

/** Bounds automatic generation; this is never permission to reject a valid contract edit. */
export const getPlanningRecovery = (task: Pick<TaskRecord, 'planningAutoReviewRuns' | 'planningFixRounds' | 'planningReview'>, maxFixRounds: number): PlanningRecoveryInfo => {
  const automaticReviews = task.planningAutoReviewRuns ?? ((task.planningFixRounds ?? 0) + (task.planningReview === undefined ? 0 : 1))
  const automaticReviewLimit = Math.max(0, Math.floor(maxFixRounds)) + 1
  const automaticReviewPaused = automaticReviews >= automaticReviewLimit
  const rejected = ['changes_requested', 'needs-clarification', 'review_required'].includes(task.planningReview?.status ?? '')
  const blockers = task.planningReview === undefined ? [] : getPlanningReviewDiagnostics(task.planningReview)
  const hasLowScore = blockers.some(item => item.probability !== null && item.probability < item.threshold)
  const failureKind = task.planningReview?.status === 'unavailable' ? 'service'
    : rejected ? 'semantic' : task.planningReview?.status === 'unknown' ? 'structural' : 'none'
  return { automaticReviewPaused, automaticReviews, automaticReviewLimit, contractEditable: true,
    nextAction: rejected ? 'revise-contract' : automaticReviewPaused ? 'explicit-review' : 'edit-or-review', resumeTool: 'swarm_review_plan',
    blockers, failureKind,
    errors: task.planningReview?.errors ?? [],
    guidance: failureKind === 'service' ? `审核通道未完成，不能据此推断用户未授权或任务目标无效。用 swarm_status 查看当前审核进度与模型；服务恢复后显式 swarm_review_plan，不重复改写同义任务卡。${hasLowScore ? '本次同时存在语义低分，仍须根据独立审查发现修正，不能因服务恢复而忽略。' : ''}继续保留执行门禁；本插件不自动修改宿主长期 goal 的 blocked 状态。`
      : rejected ? '先读取阻塞维度与独立审查发现，修正实质缺口；阶段任务显式填写 planningScope，保留延期事项及全部安全限制。同一负结论不会通过重复评分改变；维护故障请在已授权独立维护会话隔离验证并部署，不能让原任务自免审。'
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
