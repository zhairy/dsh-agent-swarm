import { describe, expect, it } from 'vitest'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'
import {
  ACCEPTANCE_QUESTIONS,
  DEFAULT_REVIEW_THRESHOLDS,
  ParseAssessment,
  getAcceptanceState,
  getAssessmentText,
  getReviewQuestions,
  getReviewState
} from '../../src/review.js'
import { getUpgradeReasons, type UpgradeInfo } from '../../src/upgrade.js'

const card = ValidateTaskCard({ title: 't', goal: '证明 A 成立', acceptance: ['给出证明', '给出反例检查'], flags: {} }).card as TaskCard
const task: TaskRecord = { taskId: 'T-1', sessionId: 's', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1 }

const delegation = (patch: Partial<DelegationRecord> = {}): DelegationRecord => ({
  delegationId: 'D-1', taskId: 'T-1', role: 'suan_heng', mode: 'verify', roleName: '算衡', status: 'completed', summary: '结论成立',
  evidence: [{ kind: 'command', ref: 'npm test', exitCode: 0 }], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 1, ...patch
})

const answers = (score: number, supported: number) => ({
  supported: { type: 'noul', noul: supported },
  complete: { type: 'noul', noul: 0.8 },
  role_check: { type: 'noul', noul: 0.7 },
  reliability: { type: 'score', score, confidence: 0.9 }
})

describe('衡鉴复评：题目与状态', () => {
  it('三道通用题 + 角色专项题；算衡按模式出题', () => {
    const verify = getReviewQuestions('suan_heng', 'verify')
    expect(Object.keys(verify)).toEqual(['supported', 'complete', 'reliability', 'role_check'])
    expect((verify.role_check as { instructions: string }).instructions).toContain('验算独立完成')
    expect((getReviewQuestions('suan_heng', 'research').role_check as { instructions: string }).instructions).toContain('候选算法')
    expect((getReviewQuestions('fu_he').role_check as { instructions: string }).instructions).toContain('退出码')
    expect(Object.keys(ACCEPTANCE_QUESTIONS)).toEqual(['supported', 'complete', 'reliability'])
  })

  it('状态只含任务、要求、交付摘要与证据，并截断', () => {
    const state = getReviewState(task, delegation({ structured: { long: 'x'.repeat(5000) } }), '请验算')
    expect(state).toMatchObject({ role: '算衡', mode: '验算', task_goal: '证明 A 成立', request: '请验算', result_summary: '结论成立' })
    expect(state.acceptance).toEqual(['给出证明', '给出反例检查'])
    expect(state.evidence).toEqual([{ kind: 'command', ref: 'npm test', exitCode: 0 }])
    expect(state.structured.length).toBeLessThanOrEqual(3001)
    const accept = getAcceptanceState(task, [delegation({ assessment: { status: 'ok', verdict: 'doubtful' } })], { summary: '完成', unresolved: [], gates: [{ gate: 'G_VERIFY', satisfied: true }] })
    expect(accept.delegations[0]).toMatchObject({ role: '算衡', review: 'doubtful' })
    expect(accept.gates).toEqual([{ gate: 'G_VERIFY', satisfied: true }])
  })
})

describe('衡鉴复评：判定', () => {
  it('四档可信度归一化后按阈值判定；证据支撑过低直接存疑', () => {
    expect(ParseAssessment(answers(3, 0.9), DEFAULT_REVIEW_THRESHOLDS, 'jev-1')).toMatchObject({ status: 'ok', verdict: 'trusted', reliability: 1, confidence: 0.9, model: 'jev-1' })
    expect(ParseAssessment(answers(1.5, 0.7), DEFAULT_REVIEW_THRESHOLDS).verdict).toBe('review')
    expect(ParseAssessment(answers(1, 0.9), DEFAULT_REVIEW_THRESHOLDS).verdict).toBe('doubtful')
    expect(ParseAssessment(answers(3, 0.3), DEFAULT_REVIEW_THRESHOLDS).verdict).toBe('doubtful')
    expect(ParseAssessment(answers(2.4, 0.5), DEFAULT_REVIEW_THRESHOLDS).verdict).toBe('review')
    expect(ParseAssessment({ supported: { noul: 0.9 } }, DEFAULT_REVIEW_THRESHOLDS)).toEqual({ status: 'unavailable', reason: 'malformed-response' })
  })

  it('复评文本', () => {
    expect(getAssessmentText(undefined)).toBeUndefined()
    expect(getAssessmentText({ status: 'unavailable', reason: 'missing-api-key' })).toBe('衡鉴复评：未执行（missing-api-key）')
    expect(getAssessmentText(ParseAssessment(answers(3, 0.9), DEFAULT_REVIEW_THRESHOLDS))).toBe('衡鉴复评：可信（可信度 1.00；证据支撑 0.90；完整性 0.80；角色专项 0.70）')
  })

  it('复评存疑触发同角色（算衡按模式）的容灾升级', () => {
    const upgrade: UpgradeInfo = { enabled: true, chain: [{ provider: 'codex', model: 'gpt-6-astra' }], triggers: ['lowConfidence'] }
    const doubtful = delegation({ delegationId: 'D-7', assessment: { status: 'ok', verdict: 'doubtful' } })
    expect(getUpgradeReasons(upgrade, { task, delegations: [doubtful] })[0]).toContain('D-7')
    expect(getUpgradeReasons(upgrade, { task, delegations: [doubtful], role: 'suan_heng', mode: 'verify' })).toHaveLength(1)
    expect(getUpgradeReasons(upgrade, { task, delegations: [doubtful], role: 'suan_heng', mode: 'research' })).toEqual([])
    expect(getUpgradeReasons(upgrade, { task, delegations: [delegation({ assessment: { status: 'ok', verdict: 'review' } })] })).toEqual([])
  })
})
