import { describe, expect, it } from 'vitest'
import { ValidateTaskCard, getRuleGates } from '../../src/policy.js'
import { ParseWorkflowMermaid, ReconcileWorkflow, UpdateWorkflowNode, ValidateMermaidProjection, ValidateWorkflow, getDefaultWorkflow, getMatchingNode, getReadyNodes, getTaskCardMarkdown, getWorkflowDigest, getWorkflowMermaid, intOfficialMermaidParser, intWorkflowState } from '../../src/workflow.js'

const card = (flags = {}, scope = ['src/a.ts']) => ValidateTaskCard({ title: '改任务', goal: '满足真实合同', acceptance: ['边界行为一致'], scope, flags }).card!

describe('有界任务 DAG', () => {
  it('低风险代码只有局部修改、真实复核、检查点与验收；只读任务不空跑命令', () => {
    const code = card({ changesCode: true })
    const graph = getDefaultWorkflow(code, getRuleGates(code))
    expect(graph.mode).toBe('quick')
    expect(graph.nodes.map((node) => node.id)).toEqual(['implementation', 'verification', 'checkpoint', 'accept'])
    expect(graph.nodes[1]?.gates).toEqual(['G_VERIFY'])
    expect(ValidateWorkflow(graph, code, getRuleGates(code)).errors).toEqual([])
    const read = card()
    expect(getDefaultWorkflow(read, []).nodes.filter((node) => node.role === 'fu_he' || node.role === 'ji_feng')).toHaveLength(0)
  })

  it('算法研算先于实现，所有有效门禁都有可产生证据的角色', () => {
    const algorithm = card({ changesCode: true, changesAlgorithm: true, numericPrecision: true }, [])
    const gates = getRuleGates(algorithm)
    const graph = getDefaultWorkflow(algorithm, gates)
    expect(graph.mode).toBe('algorithm')
    expect(graph.nodes.find((node) => node.id === 'implementation')?.dependsOn).toContain('math_research')
    expect(ValidateWorkflow(graph, algorithm, gates).errors).toEqual([])
    const bad = structuredClone(graph)
    bad.nodes.find((node) => node.id === 'implementation')!.dependsOn = ['tan_wei']
    expect(ValidateWorkflow(bad, algorithm, gates).errors.join()).toContain('必须依赖已完成研算')
  })

  it('拒绝重复 ID、环、缺依赖、角色冒用、遗漏门禁与断开的验收路径', () => {
    const task = card({ changesCode: true })
    const gates = getRuleGates(task)
    const base = getDefaultWorkflow(task, gates)
    const mutate = (run: (graph: typeof base) => void) => { const graph = structuredClone(base); run(graph); return ValidateWorkflow(graph, task, gates).errors }
    expect(mutate((graph) => { graph.nodes[1]!.id = graph.nodes[0]!.id }).join()).toContain('重复')
    expect(mutate((graph) => { graph.nodes[0]!.dependsOn = ['accept'] }).join()).toContain('无环')
    expect(mutate((graph) => { graph.nodes[0]!.dependsOn = ['missing'] }).join()).toContain('不存在')
    expect(mutate((graph) => { graph.nodes[1]!.role = 'ji_feng' }).join()).toContain('不能由')
    expect(mutate((graph) => { graph.nodes[1]!.gates = [] }).join()).toContain('缺少必需门禁')
    expect(mutate((graph) => { graph.nodes[2]!.dependsOn = [] }).join()).toContain('没有通向验收')
  })

  it('新增门禁补入图并改变摘要，保留原实现 ID', () => {
    const task = card({ changesCode: true })
    const initial = getDefaultWorkflow(task, getRuleGates(task))
    const risk = card({ changesCode: true, crossModuleArchitecture: true })
    const next = ReconcileWorkflow(initial, risk, getRuleGates(risk))
    expect(next.errors).toEqual([])
    expect(next.changed).toBe(true)
    expect(next.definition.nodes.some((node) => node.id === 'implementation')).toBe(true)
    expect(next.definition.nodes.find((node) => node.gates.includes('G_REVIEW'))?.dependsOn).toContain('implementation')
    expect(getWorkflowDigest(next.definition)).not.toBe(getWorkflowDigest(initial))
  })

  it('门禁重整保留被后续业务节点依赖的中间检查点', () => {
    const task = card({ changesCode: true })
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    graph.nodes.unshift({ id: 'first_check', label: '先核对范围', operation: 'checkpoint', dependsOn: [], gates: [], outputContractVersion: '1' })
    graph.nodes.find((node) => node.id === 'implementation')!.dependsOn = ['first_check']
    const next = ReconcileWorkflow(graph, task, getRuleGates(task))
    expect(next.errors).toEqual([])
    expect(next.definition.nodes.some((node) => node.id === 'first_check')).toBe(true)
  })

  it('按依赖匹配唯一 ready 节点，拒绝过期 attempt 与终态重跑', () => {
    const task = card({ changesCode: true })
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    let state = intWorkflowState(graph)
    expect(getReadyNodes(graph, state).map((node) => node.id)).toEqual(['implementation'])
    expect(getMatchingNode(graph, state, { role: 'fu_he' }).reason).toBeDefined()
    state = UpdateWorkflowNode(state, 'implementation', 'running', { attemptId: 'attempt-1' })
    expect(() => UpdateWorkflowNode(state, 'implementation', 'succeeded', { attemptId: 'attempt-old' })).toThrow('过期')
    state = UpdateWorkflowNode(state, 'implementation', 'succeeded', { attemptId: 'attempt-1' })
    expect(getMatchingNode(graph, state, { role: 'fu_he', gate: 'G_VERIFY' }).node?.id).toBe('verification')
    expect(() => UpdateWorkflowNode(state, 'implementation', 'running')).toThrow('不允许')
  })
})

describe('Mermaid 唯一派生视图', () => {
  it('可见任务说明包括合同字段、同源图和不限预算', () => {
    const task = card({ changesCode: true })
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    const markdown = getTaskCardMarkdown(task, graph, { taskId: 'T1', delegationLimit: 0 })
    expect(markdown).toContain('A1：边界行为一致')
    expect(markdown).toContain('src/a.ts')
    expect(markdown).toContain('性能预算：待测')
    expect(markdown).toContain('委派预算：不限')
    expect(markdown).toContain(getWorkflowMermaid(graph))
    expect(markdown).not.toContain('最多 0')
  })
  it('节点/依赖的展示重排不改变语义摘要与生成源码', () => {
    const task = card({ changesCode: true, crossModuleArchitecture: true })
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    const reordered = structuredClone(graph)
    reordered.nodes.reverse()
    for (const node of reordered.nodes) node.dependsOn.reverse()
    expect(getWorkflowDigest(reordered)).toBe(getWorkflowDigest(graph))
    expect(getWorkflowMermaid(reordered)).toBe(getWorkflowMermaid(graph))
  })
  it('稳定生成，标签不能注入指令；合法但反向的源码也拒绝', async () => {
    const task = card()
    const graph = getDefaultWorkflow(task, [])
    graph.nodes[0]!.label = '引号"\nclick a "https://bad" <script>'
    const source = getWorkflowMermaid(graph)
    expect(source).toContain('#34;')
    expect(source).not.toContain('<script>')
    expect(source.split('\n').filter((line) => line.trim().startsWith('click'))).toHaveLength(0)
    expect(ValidateMermaidProjection(graph, source.replace('n_analysis --> n_checkpoint', 'n_checkpoint --> n_analysis'))).not.toEqual([])
    const parsed = await ParseWorkflowMermaid(graph, source, async () => ({ version: 'test-parser', ok: true }))
    expect(parsed.projectionVerdict).toBe('pass')
  })

  it('实际官方 parser 解析生成的中文流程，并拒绝未闭合括号', async () => {
    const task = card({ changesCode: true, changesAlgorithm: true, numericPrecision: true })
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    const parser = intOfficialMermaidParser()
    const good = await ParseWorkflowMermaid(graph, undefined, parser)
    expect(good.parseVerdict).toBe('pass')
    expect(good.parserVersion).toBe('11.12.0')
    const bad = await parser('flowchart TD\n A["未闭合')
    expect(bad.ok).toBe(false)
  }, 20000)
})
