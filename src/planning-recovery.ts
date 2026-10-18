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
  /** 不合格审核输出也可提供诊断材料，但这些文本从不构成批准。 */
  findings?: Array<{ location: string; issue: string; evidence: string; suggestion: string }>
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
  const raw = task.planningReview?.agent?.result
  const rows = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { findings?: unknown }).findings : undefined
  const findings = Array.isArray(rows) ? rows.slice(0, 12).flatMap((value: unknown) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    if (typeof row.issue !== 'string' || typeof row.evidence !== 'string' || typeof row.suggestion !== 'string') return []
    return [{ location: ['requirementId', 'acceptanceId', 'nodeId'].flatMap(key => typeof row[key] === 'string' ? [row[key].slice(0, 80)] : []).join('/') || '缺少有效定位',
      issue: row.issue.slice(0, 600), evidence: row.evidence.slice(0, 600), suggestion: row.suggestion.slice(0, 600) }]
  }) : []
  return { automaticReviewPaused, automaticReviews, automaticReviewLimit, contractEditable: true,
    nextAction: rejected ? 'revise-contract' : automaticReviewPaused ? 'explicit-review' : 'edit-or-review', resumeTool: 'swarm_review_plan',
    blockers, failureKind, findings,
    errors: task.planningReview?.errors ?? [],
    guidance: failureKind === 'service' ? `审核通道未完成，不能据此推断用户未授权或任务目标无效。用 swarm_status 查看当前审核进度与模型；服务恢复后显式 swarm_review_plan，不重复改写同义任务卡。${hasLowScore ? '本次同时存在语义低分，仍须根据独立审查发现修正，不能因服务恢复而忽略。' : ''}继续保留执行门禁；本插件不自动修改宿主长期 goal 的 blocked 状态。`
      : failureKind === 'structural' ? '独立审核已经返回，但输出格式或引用校验不合格；这不是模型等待超时。读取校验错误和下列发现，修正有依据的合同缺口或审核输出约束，不把未知结果当作批准，也不靠重复评分消除已存在的语义低分。'
      : rejected ? '先读取阻塞维度与独立审查发现，修正实质缺口；阶段任务显式填写 planningScope，保留延期事项及全部安全限制。同一负结论不会通过重复评分改变；维护故障请在已授权独立维护会话隔离验证并部署，不能让原任务自免审。'
      : ['pass', 'pass_with_degradation'].includes(task.planningReview?.status ?? '') ? '当前规划已通过；非阻断建议不撤销批准，也不要求重复审核。执行与验收仍须核对当前版本、角色授权和真实证据。'
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
