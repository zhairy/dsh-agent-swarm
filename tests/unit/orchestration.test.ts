import { describe, expect, it } from 'vitest'
import { ValidateTaskCard } from '../../src/policy.js'
import { getOrchestrationMermaid, getOrchestrationQuestions, getRuleComplexity, getRuleDimensions, getRuleOrchestration, ParseOrchestrationPlan } from '../../src/orchestration.js'

const card = (overrides: Record<string, unknown> = {}) => ValidateTaskCard({
  title: '编排测试', goal: '验证拆分决策', acceptance: ['给出可检验的交付'], scope: [], flags: {}, ...overrides
}).card!

describe('orchestration complexity and dimensions', () => {
  it('keeps a small single-point task as one subtask without parallel groups', () => {
    const target = card({ flags: { changesCode: true } })
    const plan = getRuleOrchestration(target, target.flags)
    expect(plan.complexity).toBe('small')
    expect(plan.subtasks).toHaveLength(1)
    expect(plan.parallelGroups.flat()).toEqual(['slice-1'])
    expect(plan.source).toBe('rules')
  })

  it('splits a cross-module task into reconnaissance plus parallel slices', () => {
    const target = card({ scope: ['a', 'b', 'c'], acceptance: ['x', 'y', 'z'], flags: { crossModuleArchitecture: true, changesCode: true } })
    const plan = getRuleOrchestration(target, target.flags)
    expect(plan.complexity).toBe('large')
    // 先勘察、后并行：recon 必须存在，且至少有一组长度大于 1 的并行组。
    expect(plan.subtasks.map((item) => item.id)).toContain('recon')
    expect(plan.parallelGroups.some((group) => group.length > 1)).toBe(true)
    expect(plan.dimensions).toContain('domain-boundary')
    // parallelWith 必须对称且不含依赖方。
    for (const subtask of plan.subtasks) {
      for (const peerId of subtask.parallelWith) {
        const peer = plan.subtasks.find((candidate) => candidate.id === peerId)!
        expect(peer.parallelWith).toContain(subtask.id)
        expect(peer.dependsOn).not.toContain(subtask.id)
      }
    }
  })

  it('maps task flags to splitting dimensions deterministically', () => {
    const flagsOf = (overrides: Record<string, boolean>) => card({ flags: overrides }).flags
    expect(getRuleDimensions(flagsOf({ changesAlgorithm: true }))).toEqual(['risk-isolation'])
    expect(getRuleDimensions(flagsOf({ stateMachine: true }))).toContain('state-machine')
    expect(getRuleDimensions(flagsOf({ hasVisualInput: true }))).toContain('client-side')
    expect(getRuleDimensions(flagsOf({}))).toEqual(['vertical-slice'])
    const plain = card({ flags: {} })
    expect(getRuleComplexity(plain, plain.flags).level).toBe('small')
  })

  it('renders a mermaid orchestration graph with dependencies and parallel hints', () => {
    const target = card({ scope: ['a', 'b', 'c'], acceptance: ['x', 'y', 'z'], flags: { crossModuleArchitecture: true } })
    const plan = getRuleOrchestration(target, target.flags)
    expect(plan.mermaid.startsWith('flowchart TD')).toBe(true)
    expect(plan.mermaid).toContain('root --> ')
    expect(plan.mermaid).toContain('recon --> ')
    expect(plan.mermaid).toContain('可并行')
  })

  it('lists risks that come from the card itself', () => {
    const target = card({ flags: { touchesFinancialLogic: true, sharedStateConcurrency: true } })
    const plan = getRuleOrchestration(target, target.flags)
    expect(plan.risks.join(' ')).toContain('金融')
    expect(plan.risks.join(' ')).toContain('并发')
    // 没有风险标记时不编造风险条目。
    const plain = card({ flags: { changesCode: true } })
    expect(getRuleOrchestration(plain, plain.flags).risks).toEqual([])
  })
})

describe('Jev orchestration answers', () => {
  it('collapses to a single subtask when Jev says small and not worth splitting', () => {
    const target = card({ scope: ['a', 'b', 'c'], flags: { crossModuleArchitecture: true } })
    const plan = ParseOrchestrationPlan({ complexity: { type: 'choice', choice: 'small', confidence: 0.8 }, split: { type: 'noul', noul: 0.2 } }, target, target.flags)
    expect(plan?.complexity).toBe('small')
    expect(plan?.subtasks).toHaveLength(1)
    expect(plan?.source).toBe('jev')
  })

  it('keeps the rule baseline when Jev only adjusts the level', () => {
    const target = card({ scope: ['a', 'b', 'c'], acceptance: ['x', 'y', 'z'], flags: { crossModuleArchitecture: true } })
    const plan = ParseOrchestrationPlan({ complexity: { type: 'choice', choice: 'medium', confidence: 0.7 }, split: { type: 'noul', noul: 0.9 } }, target, target.flags)
    expect(plan?.complexity).toBe('medium')
    expect(plan?.source).toBe('jev')
    expect(plan?.dimensions).toContain('contract-first')
    expect(plan?.mermaid).toContain('flowchart TD')
  })

  it('returns undefined for incomplete or invalid answers so callers fall back to rules', () => {
    const target = card()
    expect(ParseOrchestrationPlan({}, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: 'huge', confidence: 0.9 }, split: { noul: 0.5 } }, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: 'medium', confidence: 0.9 } }, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: 'medium', confidence: 0.9 }, split: { noul: 1.5 } }, target, target.flags)).toBeUndefined()
  })

  it('asks two bounded questions with closed criteria', () => {
    const questions = getOrchestrationQuestions() as { complexity: { type: string; criteria: Record<string, string> }; split: { type: string; criteria: Record<string, string> } }
    expect(questions.complexity.type).toBe('choice')
    expect(Object.keys(questions.complexity.criteria)).toEqual(['small', 'medium', 'large'])
    expect(questions.split.type).toBe('noul')
    expect(questions.split.criteria.true.length).toBeGreaterThan(0)
  })
})

describe('orchestration mermaid shape', () => {
  it('does not fabricate progress or verification statements', () => {
    const target = card({ flags: { crossModuleArchitecture: true }, scope: ['a', 'b'], acceptance: ['x', 'y'] })
    const plan = getRuleOrchestration(target, target.flags)
    const graph = getOrchestrationMermaid(plan)
    expect(graph).not.toMatch(/已完成|通过|验收通过/)
    expect(graph).toContain('交付：')
  })
})
