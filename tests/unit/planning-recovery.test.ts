import { describe, expect, it } from 'vitest'
import { createExecutionBudget } from '../../src/execution-budget.js'
import { getPlanningRecovery, partitionLegacyPlanningBudget } from '../../src/planning-recovery.js'
import { getPlanningReviewQuestions, type PlanningReviewRecord } from '../../src/planning-review.js'

describe('planning control-plane recovery', () => {
  it('pauses automatic reviews without disabling edits or explicit review, including legacy exhausted tasks', () => {
    expect(getPlanningRecovery({ planningAutoReviewRuns: 3 }, 2)).toMatchObject({ automaticReviewPaused: true, contractEditable: true, resumeTool: 'swarm_review_plan' })
    expect(getPlanningRecovery({ planningFixRounds: 3 }, 2).automaticReviewPaused).toBe(true)
    expect(getPlanningRecovery({}, 0)).toMatchObject({ automaticReviews: 0, automaticReviewLimit: 1, automaticReviewPaused: false })
  })

  it('moves only exact legacy planning reservations and preserves real execution and Jev observations', () => {
    const old = createExecutionBudget({ maxDelegations: 4 })
    const planId = 'plan-78076430-652a-49ee-888c-69ff0d73bed2'
    for (const id of [planId, 'delegation-execution', 'plan-not-a-uuid']) {
      old.reserve({ id, source: 'delegate' }); old.start(id); old.settle(id)
    }
    old.observeJev({ inputTokens: 10, outputTokens: 1 }, 1)
    const before = old.getSnapshot()
    const moved = partitionLegacyPlanningBudget(before)
    expect(moved.planning?.reservations.map((r) => r.id)).toEqual([planId])
    expect(moved.execution.reservations.map((r) => r.id)).toEqual(['delegation-execution', 'plan-not-a-uuid'])
    expect(moved.execution.jev).toEqual(before.jev)
    expect(before.reservations).toHaveLength(3)
    expect(partitionLegacyPlanningBudget(moved.execution).planning).toBeUndefined()
  })

  it('审核服务未完成与Jev明确低分分别说明，缺答案不冒充低分', () => {
    const record = { status: 'unavailable', errors: ['审核通道未完成'], jev: { status: 'unavailable' }, reviewPolicy: { requireJev: true, reviewAbove: 0.8 } } as PlanningReviewRecord
    const unavailable = getPlanningRecovery({ planningReview: record }, 2)
    expect(unavailable.failureKind).toBe('service')
    expect(unavailable.guidance).not.toContain('同时存在语义低分')
    const mixed = getPlanningRecovery({ planningReview: { ...record, jev: { status: 'ok', answers: { mermaid_expression: { noul: 0.71 } } } } }, 2)
    expect(mixed.failureKind).toBe('service')
    expect(mixed.guidance).toContain('同时存在语义低分')
    expect(mixed.blockers).toContainEqual(expect.objectContaining({ dimension: 'mermaid_expression', probability: 0.71, threshold: 0.8 }))
  })

  it('审核已返回但结构无效时公开有界诊断，不能误报等待故障或授予批准', () => {
    const record = { status: 'unknown', errors: ['规划发现必须定位需求、验收或节点'], jev: { status: 'ok', answers: { mermaid_expression: { noul: 0.71 } } }, reviewPolicy: { reviewAbove: 0.8 },
      agent: { result: { verdict: 'changes_requested', findings: [{ issue: '旧诊断与当前出处冲突', evidence: 'requestRefs已有真实确认', suggestion: '修正合同中的陈旧说明' }, null, { issue: 1 },
        ...Array.from({ length: 20 }, () => ({ requirementId: 'R2', issue: 'i'.repeat(1000), evidence: 'e'.repeat(1000), suggestion: 's'.repeat(1000) }))] } } } as unknown as PlanningReviewRecord
    const recovery = getPlanningRecovery({ planningReview: record }, 2)
    expect(recovery.failureKind).toBe('structural')
    expect(recovery.guidance).toContain('已经返回')
    expect(recovery.guidance).not.toContain('服务故障恢复后')
    expect(recovery.findings?.[0]).toMatchObject({ location: '缺少有效定位', issue: '旧诊断与当前出处冲突' })
    expect(recovery.findings!.length).toBeLessThanOrEqual(12)
    expect(recovery.findings!.at(-1)!.issue).toHaveLength(600)
    expect(record.status).toBe('unknown')
  })

  it('通过规划中的非阻断建议不能被误报为服务故障或要求重复审核', () => {
    const record = { status: 'pass', errors: [], jev: { status: 'ok', answers: Object.fromEntries(Object.keys(getPlanningReviewQuestions()).map(id => [id, { noul: 0.95 }])) }, reviewPolicy: { reviewAbove: 0.8 },
      agent: { result: { findings: [{ requirementId: 'R1', issue: '非阻断建议', evidence: '现有计划已覆盖', suggestion: '后续精简说明' }] } } } as unknown as PlanningReviewRecord
    const recovery = getPlanningRecovery({ planningReview: record }, 2)
    expect(recovery.failureKind).toBe('none')
    expect(recovery.blockers).toEqual([])
    expect(recovery.findings).toHaveLength(1)
    expect(recovery.guidance).toContain('已通过')
    expect(recovery.guidance).not.toContain('服务故障')
  })
})
