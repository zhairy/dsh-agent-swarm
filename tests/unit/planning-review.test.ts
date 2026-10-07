import { describe, expect, it, vi } from 'vitest'
import { ValidateTaskCard, getRuleGates } from '../../src/policy.js'
import { RunPlanningReview, ValidatePlanningReviewResult, getPlanningReviewQuestions, getPlanningReviewRecord, getReviewSnapshot, intPlanningReviewStore, isPlanningReviewCurrent, type PlanningReviewResult, type ReviewSnapshot } from '../../src/planning-review.js'
import { getDefaultWorkflow } from '../../src/workflow.js'

const makeSnapshot = (revision = 1) => {
  const card = ValidateTaskCard({ title: '小改', goal: revision === 1 ? '修复局部边界' : '新用户要求', acceptance: ['边界行为通过实测'], scope: ['src/a.ts'], flags: { changesCode: true } }).card!
  const gates = getRuleGates(card)
  return getReviewSnapshot({ rootSessionId: 'root', workspaceId: 'work', taskId: 'T1', requestRevision: revision, requestText: '请修复 src/a.ts 的局部边界，并实际验证', requestSource: 'host', cardRevision: revision, workflowRevision: 1, card, workflow: getDefaultWorkflow(card, gates), gates })
}
const result = (snapshot: ReviewSnapshot): PlanningReviewResult => ({
  snapshotDigest: snapshot.snapshotDigest, verdict: 'pass',
  goalReview: { verdict: 'pass', summary: '原文的局部边界对应 A1', evidenceRefs: ['R1', 'A1'] },
  designReview: { verdict: 'pass', summary: '修改后复核并核对证据', evidenceRefs: ['implementation', 'verification'] },
  mermaidReview: { verdict: 'pass', summary: '标签与箭头忠实表达步骤', evidenceRefs: ['verification', 'accept'] },
  requirementCoverage: [{ requirementId: 'R1', covered: true, evidence: 'implementation 产生修复，verification 以实际命令检查 A1' }], findings: [], assumptions: [], unresolved: []
})
const structure = (snapshot: ReviewSnapshot) => ({ parserVersion: '11.12.0', parseVerdict: 'pass' as const, projectionVerdict: 'pass' as const, sourceDigest: snapshot.mermaidDigest, generatorVersion: '1', errors: [] })
const reviewer = { agentId: 'fresh-expert', role: 'yu_shi' as const, fresh: true, readOnly: true, authorAgentIds: ['author'] }
const jev = () => ({ status: 'ok' as const, model: 'jev', answers: Object.fromEntries(Object.keys(getPlanningReviewQuestions()).map((id) => [id, { noul: 0.95 }])) })

describe('独立规划审核与 CAS', () => {
  it('parser/策略变化需要新审核，伪造非空依据引用不会通过', () => {
    const snapshot = makeSnapshot()
    const base = { rootSessionId: snapshot.rootSessionId, workspaceId: snapshot.workspaceId, taskId: snapshot.taskId, requestRevision: snapshot.requestRevision, requestText: snapshot.requestText, requestSource: snapshot.requestSource, cardRevision: snapshot.cardRevision, workflowRevision: snapshot.workflowRevision, card: snapshot.card, workflow: snapshot.workflow, gates: snapshot.gates }
    expect(getReviewSnapshot({ ...base, reviewPolicy: { requireJev: true } }).snapshotDigest).not.toBe(snapshot.snapshotDigest)
    expect(getReviewSnapshot({ ...base, parserVersion: 'future' }).snapshotDigest).not.toBe(snapshot.snapshotDigest)
    const invalid = result(snapshot)
    invalid.goalReview.evidenceRefs = ['随意编造']
    expect(ValidatePlanningReviewResult(snapshot, invalid).join()).toContain('不存在的依据')
    expect(getPlanningReviewRecord(snapshot, { structure: { ...structure(snapshot), sourceDigest: 'old' }, agent: { result: result(snapshot), reviewer }, jev: jev() }).status).toBe('changes_requested')
  })
  it('需求/图冻结，语义改版改变快照；作者映射不是自行审核通过', () => {
    const snapshot = makeSnapshot()
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.workflow.nodes)).toBe(true)
    expect(makeSnapshot(2).snapshotDigest).not.toBe(snapshot.snapshotDigest)
    const assessment = getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent: {}, jev: jev() })
    expect(assessment.status).toBe('unavailable')
    expect(isPlanningReviewCurrent(assessment, snapshot)).toBe(false)
  })

  it('仅标题或节点列表展示顺序变化不失效，目标语义改变则失效', () => {
    const snapshot = makeSnapshot()
    const input = { rootSessionId: snapshot.rootSessionId, workspaceId: snapshot.workspaceId, taskId: snapshot.taskId, requestRevision: snapshot.requestRevision, requestText: snapshot.requestText, requestSource: snapshot.requestSource, cardRevision: snapshot.cardRevision, workflowRevision: snapshot.workflowRevision, card: structuredClone(snapshot.card), workflow: structuredClone(snapshot.workflow), gates: structuredClone(snapshot.gates) }
    input.card.title = '更清楚的标题'
    input.workflow.nodes.reverse()
    expect(getReviewSnapshot(input).snapshotDigest).toBe(snapshot.snapshotDigest)
    input.card.workflow = structuredClone(input.workflow)
    expect(getReviewSnapshot(input).snapshotDigest).toBe(snapshot.snapshotDigest)
    input.card.goal = '另一个目标'
    expect(getReviewSnapshot(input).snapshotDigest).not.toBe(snapshot.snapshotDigest)
  })

  it('泛泛通过、过期快照、缺需求覆盖与严重发现均不能放行', () => {
    const snapshot = makeSnapshot()
    const bad = result(snapshot)
    bad.goalReview.evidenceRefs = []
    bad.requirementCoverage = []
    bad.snapshotDigest = 'old'
    bad.findings = [{ severity: 'high', requirementId: 'R1', issue: '漏项', evidence: '原文限定没有对应步骤', suggestion: '补验收与步骤' }]
    const errors = ValidatePlanningReviewResult(snapshot, bad).join('\n')
    expect(errors).toContain('过期')
    expect(errors).toContain('未完整覆盖')
    expect(errors).toContain('具体依据')
    expect(errors).toContain('严重问题')
  })

  it('三项独立审核必须通过；新会话只读且非作者', () => {
    const snapshot = makeSnapshot()
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent: { result: result(snapshot), reviewer }, jev: jev() }).status).toBe('pass')
    for (const invalid of [{ ...reviewer, fresh: false }, { ...reviewer, readOnly: false }, { ...reviewer, agentId: 'author' }]) expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent: { result: result(snapshot), reviewer: invalid }, jev: jev() }).status).toBe('unknown')
    const bad = result(snapshot)
    bad.designReview.verdict = 'unknown'
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent: { result: bad, reviewer }, jev: jev() }).status).not.toBe('pass')
  })

  it('缺答案或语义反对需要复核，只有明确服务不可用可以降级', () => {
    const snapshot = makeSnapshot()
    const agent = { result: result(snapshot), reviewer }
    const missing = { status: 'ok' as const, answers: {} }
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent, jev: missing }).status).toBe('review_required')
    const disagree = jev()
    disagree.answers.goal_alignment!.noul = 0.2
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent, jev: disagree }).status).toBe('review_required')
    const unavailable = { status: 'unavailable' as const, reason: 'missing-api-key' }
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent, jev: unavailable }).status).toBe('pass_with_degradation')
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent, jev: unavailable, policy: { requireJev: true } }).status).toBe('unavailable')
    expect(getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent, jev: { status: 'unavailable' } }).status).toBe('unknown')
  })

  it('代码结构/parser 失败不能被 Agent/Jev 高分覆盖', async () => {
    const snapshot = makeSnapshot()
    const agent = vi.fn(async () => ({ result: result(snapshot), reviewer }))
    const judge = vi.fn(async () => jev())
    const record = await RunPlanningReview(snapshot, { parser: async () => ({ version: '11.12.0', ok: false, error: '非法源码' }), reviewAgent: agent, reviewJev: judge })
    expect(record.status).toBe('changes_requested')
    expect(agent).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('parser 环境异常明确 unavailable，不调用模型或宣称通过', async () => {
    const snapshot = makeSnapshot()
    const agent = vi.fn(async () => ({ result: result(snapshot), reviewer }))
    const judge = vi.fn(async () => jev())
    const record = await RunPlanningReview(snapshot, { parser: async () => { throw new Error('worker unavailable') }, reviewAgent: agent, reviewJev: judge })
    expect(record.status).toBe('unavailable')
    expect(record.errors.join()).toContain('worker unavailable')
    expect(agent).not.toHaveBeenCalled()
    expect(judge).not.toHaveBeenCalled()
  })

  it('Agent 和 Jev 独立并行读同一完整快照', async () => {
    const snapshot = makeSnapshot()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let agentStarted = false
    const record = await RunPlanningReview(snapshot, {
      parser: async () => ({ version: '11.12.0', ok: true }),
      reviewAgent: async (seen) => { expect(seen).toBe(snapshot); agentStarted = true; await barrier; return { result: result(seen), reviewer } },
      reviewJev: async (seen) => { expect(seen).toBe(snapshot); expect(agentStarted).toBe(true); expect(JSON.stringify(seen)).not.toContain('fresh-expert'); release(); return jev() }
    })
    expect(record.status).toBe('pass')
  })

  it('旧快照不能 CAS 提交，返修计数不会被改图或标题重置', () => {
    const snapshot = makeSnapshot()
    const store = intPlanningReviewStore()
    store.SetSnapshot(snapshot)
    const record = getPlanningReviewRecord(snapshot, { structure: structure(snapshot), agent: { result: result(snapshot), reviewer }, jev: jev() })
    expect(store.Commit(record)).toBe(true)
    expect(store.ConsumeFixRound(snapshot)).toBe(true)
    store.SetSnapshot(makeSnapshot(2))
    expect(store.Commit(record)).toBe(false)
    expect(store.ConsumeFixRound(snapshot)).toBe(true)
    expect(store.ConsumeFixRound(snapshot)).toBe(false)
  })
})
