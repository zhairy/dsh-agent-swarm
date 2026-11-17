import { describe, expect, it } from 'vitest'
import { getBlockedRecovery } from '../../src/blocked-recovery.js'

const task = { acceptance: { status: 'blocked' as const, missing: ['G_VERIFY 未运行'], unresolved: [] } }
const gates = [{ gate: 'G_VERIFY' as const, satisfied: false, missing: '需要真实退出码' }]

describe('blocked recovery diagnosis', () => {
  it('thinking 协议失败优先建议切换路由和只读核对，不重复业务任务', () => {
    const view = getBlockedRecovery({
      task, gates,
      recovery: { lastFailure: { kind: 'protocol_incompatible', provider: 'deepseek-official', model: 'deepseek-flash', message: 'content[].thinking must be passed back', status: 400 } }
    })
    expect(view).toMatchObject({ cause: 'provider-protocol', nextAction: 'delegate-readonly-diagnosis', allowReadOnlyAutoDelegate: true, requiresUser: false })
    expect(view.recommendedRoles).toEqual([{ role: 'fu_he', reason: expect.stringContaining('只读核对') }])
    expect(view.evidence[0]).toContain('deepseek-official/deepseek-flash')
  })

  it('路由终态不会诱导重复改卡', () => {
    const view = getBlockedRecovery({ task, gates, recovery: { terminal: 'route_chain_exhausted' } })
    expect(view).toMatchObject({ cause: 'route-exhausted', nextAction: 'switch-route', allowReadOnlyAutoDelegate: false })
    expect(view.recommendedRoles).toEqual([])
  })

  it('连续无进展回到合同修正和独立审查', () => {
    const view = getBlockedRecovery({ task: { ...task, checkpoint: { convergence: { blocked: true }, nextAction: 'incomplete', unresolved: ['同一缺口'] } }, gates: [] })
    expect(view).toMatchObject({ cause: 'no-progress', nextAction: 'revise-plan' })
    expect(view.recommendedRoles.map((item) => item.role)).toEqual(['mou_ding', 'yu_shi'])
  })

  it('按未满足门禁映射到负责角色并去重', () => {
    const view = getBlockedRecovery({ task: { acceptance: { status: 'blocked', missing: [], unresolved: [] } }, gates: [
      { gate: 'G_MATH_VERIFY', satisfied: false, missing: '反例未处理' },
      { gate: 'G_REVIEW', satisfied: false }
    ] })
    expect(view).toMatchObject({ cause: 'missing-gate', nextAction: 'delegate-gate' })
    expect(view.recommendedRoles.map((item) => item.role)).toEqual(['suan_heng', 'yu_shi'])
  })

  it('没有证据时不伪造自动恢复', () => {
    const view = getBlockedRecovery({ task: { acceptance: { status: 'blocked', missing: [], unresolved: [] } }, gates: [] })
    expect(view).toMatchObject({ cause: 'unknown', nextAction: 'wait-external', requiresUser: true })
  })

  it('历史失败不会撤销已验收任务', () => {
    const view = getBlockedRecovery({
      task: { acceptance: { status: 'accepted', missing: [], unresolved: [] } },
      gates: [],
      recovery: { lastFailure: { kind: 'protocol_incompatible', provider: 'deepseek-official', model: 'deepseek-flash', message: 'old failure' } }
    })
    expect(view).toMatchObject({ active: false, nextAction: 'none', allowReadOnlyAutoDelegate: false })
  })

  it('回退后已经完成的逻辑请求不再显示为当前故障', () => {
    const view = getBlockedRecovery({
      task: { acceptance: { status: 'recorded', missing: [], unresolved: [] } },
      gates: [],
      recovery: { completed: true, lastFailure: { kind: 'protocol_incompatible', provider: 'deepseek-official', model: 'deepseek-flash', message: 'old failure' } }
    })
    expect(view).toMatchObject({ active: false, nextAction: 'none' })
  })
})
