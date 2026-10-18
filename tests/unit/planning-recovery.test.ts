import { describe, expect, it } from 'vitest'
import { createExecutionBudget } from '../../src/execution-budget.js'
import { getPlanningRecovery, partitionLegacyPlanningBudget } from '../../src/planning-recovery.js'
import type { PlanningReviewRecord } from '../../src/planning-review.js'

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
})
