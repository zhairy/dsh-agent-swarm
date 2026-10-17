import { describe, expect, it } from 'vitest'
import { FLAG_KEYS, ValidateTaskCard } from '../../src/policy.js'
import { getOrchestrationMermaid, getOrchestrationQuestions, getRuleComplexity, getRuleDimensions, getRuleOrchestration, ORCHESTRATION_DIMENSIONS, ParseOrchestrationPlan } from '../../src/orchestration.js'
import { isDelegableRoleId } from '../../src/role-registry.js'

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

  it('covers every dependency edge with real serialized chains', () => {
    const target = card({ scope: ['a', 'b', 'c'], acceptance: ['x', 'y', 'z'], flags: { crossModuleArchitecture: true, changesCode: true } })
    const plan = getRuleOrchestration(target, target.flags)
    const edges = plan.subtasks.flatMap((item) => item.dependsOn.map((dependency) => `${dependency}->${item.id}`))
    const chains = plan.serialized.flatMap((chain) => chain.slice(1).map((id, index) => `${chain[index]}->${id}`))
    expect(edges.length).toBeGreaterThan(0)
    expect(new Set(chains)).toEqual(new Set(edges))
    // 同层切片可并行，串行链不能把它们排成先后顺序。
    expect(plan.serialized.every((chain) => chain.filter((id) => id.startsWith('slice-')).length <= 1)).toBe(true)
  })

  it('keeps dependencies acyclic and parallel groups free of transitive dependencies for every flag combination', () => {
    const ancestors = (plan: ReturnType<typeof getRuleOrchestration>, from: string): Set<string> => {
      const seen = new Set<string>()
      const queue = [from]
      while (queue.length > 0) {
        const current = queue.shift()!
        for (const dependency of plan.subtasks.find((item) => item.id === current)?.dependsOn ?? []) {
          if (!seen.has(dependency)) { seen.add(dependency); queue.push(dependency) }
        }
      }
      return seen
    }
    const issues: string[] = []
    for (let mask = 0; mask < 2 ** FLAG_KEYS.length; mask += 1) {
      const flags = Object.fromEntries(FLAG_KEYS.map((key, index) => [key, (mask & (1 << index)) !== 0]))
      const target = card({ flags, scope: ['a', 'b', 'c'], acceptance: ['x', 'y', 'z'] })
      const plan = getRuleOrchestration(target, target.flags)
      const ids = plan.subtasks.map((item) => item.id)
      if (new Set(ids).size !== ids.length) issues.push('子任务 id 重复')
      if (plan.dimensions.length > 5 || new Set(plan.dimensions).size !== plan.dimensions.length) issues.push('维度超过 5 或重复')
      if (plan.dimensions.some((dimension) => !ORCHESTRATION_DIMENSIONS.includes(dimension))) issues.push('维度越界')
      if (plan.subtasks.some((item) => !plan.dimensions.includes(item.dimension))) issues.push('子任务维度不在 dimensions 内')
      if (plan.subtasks.some((item) => !isDelegableRoleId(item.role))) issues.push('子任务角色不可委派')
      if (plan.subtasks.some((item) => ancestors(plan, item.id).has(item.id))) issues.push('依赖成环')
      for (const group of plan.parallelGroups) for (const left of group) for (const right of group) {
        if (left !== right && (ancestors(plan, left).has(right) || ancestors(plan, right).has(left))) issues.push('并行组含传递依赖')
      }
      for (const item of plan.subtasks) for (const peer of item.parallelWith) {
        const other = plan.subtasks.find((candidate) => candidate.id === peer)
        if (other === undefined || !other.parallelWith.includes(item.id) || item.dependsOn.includes(peer)
          || ancestors(plan, item.id).has(peer) || ancestors(plan, peer).has(item.id)) issues.push('parallelWith 与依赖不自洽')
      }
      const edges = plan.subtasks.flatMap((item) => item.dependsOn.map((dependency) => `${dependency}->${item.id}`))
      const chains = plan.serialized.flatMap((chain) => chain.slice(1).map((id, index) => `${chain[index]}->${id}`))
      if (edges.some((edge) => !chains.includes(edge))) issues.push('serialized 未覆盖全部依赖边')
    }
    expect([...new Set(issues)]).toEqual([])
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

  it('rejects type-confused answers and keeps extra fields out of the decision', () => {
    const target = card({ crossModuleArchitecture: true, changesCode: true })
    expect(ParseOrchestrationPlan({ complexity: { choice: 'Medium' }, split: { noul: 0.6 } }, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: 'medium' }, split: { noul: '0.6' } }, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: 'medium' }, split: { noul: true } }, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: { value: 'medium' } }, split: { noul: 0.6 } }, target, target.flags)).toBeUndefined()
    expect(ParseOrchestrationPlan({ complexity: { choice: 'medium', extra: true }, split: { noul: 0.6, extra: 'x' } }, target, target.flags)?.source).toBe('jev')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
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
