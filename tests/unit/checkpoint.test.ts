import { describe, expect, it } from 'vitest'
import { getCheckpoint } from '../../src/checkpoint.js'

const input = { taskId: 'T1', cardRevision: 1, workflowRevision: 1, roundId: 'R1', evidenceRefs: ['E1'], unresolved: ['待复查'], allowedPaths: ['src'], changedPaths: ['src/a.ts'] }
describe('调度边界短检查点', () => {
  it('累计证据只算新增差量，未知 token/费用不用零冒充', () => {
    const first = getCheckpoint(input)
    const second = getCheckpoint({ ...input, roundId: 'R2', evidenceRefs: ['E1', 'E2'] }, first)
    const third = getCheckpoint({ ...input, roundId: 'R3', evidenceRefs: ['E1', 'E2'] }, second)
    expect(second.review.newEvidence).toEqual(['E2'])
    expect(third.review.newEvidence).toEqual([])
    expect(third.knownEvidenceRefs).toEqual(['E1', 'E2'])
    expect(first.resource.tokens).toBeNull()
    expect(first.resource.cost).toBeNull()
  })
  it('三轮 [a,b] → [a,b,c] → [a,b,c] 只把 c 算一次进展', () => {
    const first = getCheckpoint({ ...input, evidenceRefs: ['a', 'b'] })
    const second = getCheckpoint({ ...input, roundId: 'R2', evidenceRefs: ['a', 'b', 'c'] }, first)
    const third = getCheckpoint({ ...input, roundId: 'R3', evidenceRefs: ['a', 'b', 'c'] }, second)
    expect(first.review.newEvidence).toEqual(['a', 'b'])
    expect(second.review.newEvidence).toEqual(['c'])
    expect(third.review.newEvidence).toEqual([])
    expect(third.knownEvidenceRefs).toEqual(['a', 'b', 'c'])
    expect(third.convergence.repeatedWithoutProgress).toBe(1)
  })
  it('按轮差量提供证据时也累计已见集合，恢复旧记录后不虚构新进展', () => {
    const first = getCheckpoint({ ...input, evidenceRefs: ['a', 'b'] })
    const legacy = { ...first }
    delete legacy.knownEvidenceRefs
    const second = getCheckpoint({ ...input, roundId: 'R2', evidenceRefs: ['c'] }, legacy)
    const third = getCheckpoint({ ...input, roundId: 'R3', evidenceRefs: ['a', 'b', 'c'] }, second)
    expect(second.review.newEvidence).toEqual(['c'])
    expect(third.review.newEvidence).toEqual([])
    expect(third.knownEvidenceRefs).toEqual(['a', 'b', 'c'])
    expect(getCheckpoint({ ...input, roundId: 'R4', evidenceRefs: ['a', 'b', 'c'] }, third).convergence.blocked).toBe(true)
  })
  it('重复阻塞收敛，风险扩大改版，资源耗尽与冲突有明确动作', () => {
    const first = getCheckpoint(input)
    const second = getCheckpoint({ ...input, roundId: 'R2' }, first)
    expect(getCheckpoint({ ...input, roundId: 'R3' }, second).nextAction).toBe('incomplete')
    expect(getCheckpoint({ ...input, changedPaths: ['other/file'] }).nextAction).toBe('revise-plan')
    expect(getCheckpoint({ ...input, conflicts: ['两个结论不一致'] }).nextAction).toBe('escalate')
    expect(getCheckpoint({ ...input, resource: { exhausted: true } }).nextAction).toBe('incomplete')
    expect(getCheckpoint({ ...input, unresolved: [], acceptanceReady: true }).nextAction).toBe('accept-ready')
  })
  it('改版后重算基线，探索新增证据不被当作无进展', () => {
    const first = getCheckpoint(input)
    expect(getCheckpoint({ ...input, cardRevision: 2, roundId: 'R2' }, first).convergence.repeatedWithoutProgress).toBe(0)
    expect(getCheckpoint({ ...input, cardRevision: 2, roundId: 'R2', evidenceRefs: ['new'] }, first).knownEvidenceRefs).toEqual(['new'])
    expect(getCheckpoint({ ...input, evidenceRefs: ['E1', '风险证据'], roundId: 'R2' }, first).convergence.repeatedWithoutProgress).toBe(0)
  })
})
