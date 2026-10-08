import type { EvidenceItem } from './contracts.js'
import type { AssessmentInfo, DelegationRecord, TaskRecord } from './evidence.js'
import { getRedactedText, isJevProbability, isJevScore } from './jev.js'
import type { DelegableRoleId, SuanHengMode } from './role-registry.js'

/**
 * 衡鉴复评：每位专家交付后、以及天枢验收时，把交付的结构化摘要交给 Jev，
 * 回答「结论有依据吗」「回应完整吗」「角色专项要求达到了吗」并给出四档可信度。
 * Jev 的置信度是判断的集中程度，不等于正确性，所以复评只作提示与升级触发，不作硬门槛。
 */

/** 复评阈值 */
export interface ReviewThresholdsInfo {
  /** 可信度不低于此值且证据支撑不低于 0.6 时判为「可信」 */
  trustedAbove: number
  /** 可信度低于此值，或证据支撑低于 0.35 时判为「存疑」 */
  doubtfulBelow: number
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholdsInfo = { trustedAbove: 0.67, doubtfulBelow: 0.4 }

const SUPPORTED_TRUSTED = 0.6
const SUPPORTED_DOUBTFUL = 0.35

/** 四档可信度（低 → 高） */
export const RELIABILITY_LEVELS = [
  '不可靠：结论与证据矛盾，或基本没有依据',
  '存疑：关键结论缺少证据，或推导有明显跳跃',
  '基本可信：结论有依据，存在次要缺口',
  '可信：结论与证据一致，覆盖完整'
] as const

const COMMON_QUESTIONS = {
  supported: {
    type: 'noul',
    instructions: '交付中的主要结论有证据、推导或可复现的命令结果支撑',
    criteria: { true: '结论与给出的证据或推导一致，且依据具体', false: '结论缺少依据、依据笼统，或与证据矛盾' }
  },
  complete: {
    type: 'noul',
    instructions: '交付完整回应了任务目标与验收标准，没有遗漏关键部分',
    criteria: { true: '目标与每条验收标准都有对应的结论或产出', false: '有目标或验收标准没有被回应，或只回应了一部分' }
  },
  reliability: { type: 'score', instructions: '这份交付整体可以信赖的程度', criteria: [...RELIABILITY_LEVELS] }
} as const

/** 角色专项检查：审核结论是否成立、方案是否站得住 */
const ROLE_CHECKS: Readonly<Record<DelegableRoleId | 'suan_heng:research' | 'suan_heng:verify', string>> = {
  mou_ding: '候选方案都满足约束表，推荐方案与决策点的理由和约束一致，没有遗漏明显更优的方案',
  shu_ji: '边界、接口与故障场景具体到模块，迁移与回退方案可以执行',
  suan_heng: '结论都有证明或反例，前提、不变量与复杂度分析前后自洽',
  'suan_heng:research': '候选算法的不变量、复杂度与数值误差分析自洽，结论都有证明或明确标为未证实',
  'suan_heng:verify': '验算独立完成：证明或反例具体可复核，没有默认任何已有结论正确',
  tan_wei: '每条发现都给出具体路径与证据片段，调用链可以核对',
  bo_wen: '来源权威且与结论直接相关，版本与日期明确',
  guan_xiang: '观察只陈述图中可见的事实，推断与观察区分清楚，不确定处已标出',
  zhu_jian: '改动与任务范围一致，列出了需要验证的假设与待验证事项',
  xing_zhou: '每条命令都记录了退出码，未执行的步骤给出了原因',
  ji_feng: '改动小而局部，并有通过的本地检查',
  yu_shi: '每条发现都有具体位置、可复现依据与严重度理由',
  fu_he: '判定与实际命令的退出码一致，失败都有解释，覆盖缺口已说明',
  miao_bi: '候选贴合使用场景与约束，推荐理由具体'
}

/**
 * 专家交付的复评题目：三道通用题 + 一道角色专项题
 * @param {DelegableRoleId} role - 角色
 * @param {SuanHengMode} [mode] - 算衡模式
 * @returns {Record<string, unknown>} Jev 题目
 */
export const getReviewQuestions = (role: DelegableRoleId, mode?: SuanHengMode): Record<string, unknown> => {
  const key = role === 'suan_heng' && mode !== undefined ? `suan_heng:${mode}` as const : role
  return {
    ...COMMON_QUESTIONS,
    role_check: { type: 'noul', instructions: ROLE_CHECKS[key] ?? ROLE_CHECKS[role] }
  }
}

const MAX_STRUCTURED = 3000
const MAX_EVIDENCE = 20

const getEvidenceView = (evidence: EvidenceItem[]) => evidence.slice(0, MAX_EVIDENCE).map((item) => ({
  kind: item.kind,
  ref: getRedactedText(item.ref, 200),
  ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
  ...(item.severity === undefined ? {} : { severity: item.severity }),
  ...(item.detail === undefined ? {} : { detail: getRedactedText(item.detail, 200) })
}))

/**
 * 专家交付的复评状态：任务目标与验收标准、委派要求、交付摘要、结构化结果与证据（全部脱敏截断）
 * @param {TaskRecord} task - 任务
 * @param {DelegationRecord} record - 委派记录
 * @param {string} [request] - 天枢给专家的任务说明
 * @returns {object} state
 */
export const getReviewState = (task: TaskRecord, record: DelegationRecord, request?: string) => ({
  role: record.roleName,
  ...(record.mode === undefined ? {} : { mode: record.mode === 'research' ? '研算' : '验算' }),
  task_goal: getRedactedText(task.card.goal),
  acceptance: task.card.acceptance.slice(0, 8).map((item) => getRedactedText(item, 200)),
  ...(request === undefined ? {} : { request: getRedactedText(request, 1200) }),
  result_summary: getRedactedText(record.summary, 1200),
  unresolved: record.unresolved.slice(0, 10).map((item) => getRedactedText(item, 200)),
  structured: getRedactedText(JSON.stringify(record.structured ?? {}), MAX_STRUCTURED),
  evidence: getEvidenceView(record.evidence),
  changed_files: (record.changedFiles ?? []).slice(0, 30)
})

/** 天枢验收时的复评题目：验收结论是否与专家证据、门禁结果一致 */
export const ACCEPTANCE_QUESTIONS: Record<string, unknown> = {
  supported: {
    type: 'noul',
    instructions: '天枢的验收结论与各专家交付的证据、门禁结果一致',
    criteria: { true: '验收结论有专家交付或门禁结果支撑', false: '验收结论与证据矛盾，或缺少证据' }
  },
  complete: {
    type: 'noul',
    instructions: '验收覆盖了任务的每一条验收标准，未解决的问题如实列出'
  },
  reliability: { type: 'score', instructions: '这次验收结论整体可以信赖的程度', criteria: [...RELIABILITY_LEVELS] }
}

/**
 * 天枢验收的复评状态
 * @param {TaskRecord} task - 任务
 * @param {DelegationRecord[]} delegations - 本任务委派
 * @param {{ summary: string; unresolved: string[]; gates: Array<{ gate: string; satisfied: boolean }> }} acceptance - 验收说明与门禁
 * @returns {object} state
 */
export const getAcceptanceState = (
  task: TaskRecord,
  delegations: DelegationRecord[],
  acceptance: { summary: string; unresolved: string[]; gates: Array<{ gate: string; satisfied: boolean }> }
) => ({
  task_goal: getRedactedText(task.card.goal),
  acceptance_criteria: task.card.acceptance.slice(0, 8).map((item) => getRedactedText(item, 200)),
  gates: acceptance.gates.map((gate) => ({ gate: gate.gate, satisfied: gate.satisfied })),
  delegations: delegations.slice(0, 20).map((d) => ({
    role: d.roleName,
    status: d.status,
    summary: getRedactedText(d.summary, 300),
    ...(d.assessment?.verdict === undefined ? {} : { review: d.assessment.verdict })
  })),
  conclusion: getRedactedText(acceptance.summary, 1200),
  unresolved: acceptance.unresolved.slice(0, 10).map((item) => getRedactedText(item, 200))
})

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/**
 * 解析复评答案并给出判定
 * @param {Record<string, unknown>} answers - Jev 原始答案
 * @param {ReviewThresholdsInfo} thresholds - 阈值
 * @param {string} [model] - Jev 模型版本
 * @returns {AssessmentInfo} 复评结果；答案缺少可信度评分时为 unavailable
 */
export const ParseAssessment = (answers: Record<string, unknown>, thresholds: ReviewThresholdsInfo, model?: string): AssessmentInfo => {
  const reliability = asRecord(answers.reliability)
  if (!isJevScore(reliability.score, RELIABILITY_LEVELS.length) || (reliability.confidence !== undefined && !isJevProbability(reliability.confidence))
    || !isJevProbability(asRecord(answers.supported).noul) || !isJevProbability(asRecord(answers.complete).noul)) return { status: 'unavailable', reason: 'malformed-response' }
  const levels = RELIABILITY_LEVELS.length - 1
  const normalized = reliability.score / levels
  const checks: Record<string, number> = {}
  for (const [id, value] of Object.entries(answers)) {
    const noul = asRecord(value).noul
    if (noul !== undefined) {
      if (!isJevProbability(noul)) return { status: 'unavailable', reason: 'malformed-response' }
      checks[id] = noul
    }
  }
  const supported = asRecord(answers.supported).noul as number
  const verdict: AssessmentInfo['verdict'] = normalized < thresholds.doubtfulBelow || supported < SUPPORTED_DOUBTFUL
    ? 'doubtful'
    : normalized >= thresholds.trustedAbove && supported >= SUPPORTED_TRUSTED ? 'trusted' : 'review'
  return {
    status: 'ok',
    verdict,
    reliability: normalized,
    ...(isJevProbability(reliability.confidence) ? { confidence: reliability.confidence } : {}),
    checks,
    ...(model === undefined ? {} : { model })
  }
}

/** 复评结论的中文标签 */
export const VERDICT_LABELS: Readonly<Record<NonNullable<AssessmentInfo['verdict']>, string>> = {
  trusted: '可信',
  review: '需核实',
  doubtful: '存疑'
}

const CHECK_LABELS: Readonly<Record<string, string>> = {
  supported: '证据支撑',
  complete: '完整性',
  role_check: '角色专项'
}

/**
 * 复评结果的一行说明
 * @param {AssessmentInfo | undefined} assessment - 复评
 * @returns {string | undefined} 文本；没有复评时为 undefined
 */
export const getAssessmentText = (assessment: AssessmentInfo | undefined): string | undefined => {
  if (assessment === undefined) return undefined
  if (assessment.status !== 'ok' || assessment.verdict === undefined) return `衡鉴复评：无有效结论（${assessment.reason ?? '未知原因'}）`
  const checks = Object.entries(assessment.checks ?? {}).map(([id, value]) => `${CHECK_LABELS[id] ?? id} ${value.toFixed(2)}`)
  return `衡鉴复评：${VERDICT_LABELS[assessment.verdict]}（可信度 ${(assessment.reliability ?? 0).toFixed(2)}${checks.length > 0 ? `；${checks.join('；')}` : ''}）`
}
