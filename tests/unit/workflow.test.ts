import { describe, expect, it } from 'vitest'
import { ValidateTaskCard, getRuleGates } from '../../src/policy.js'
import { ParseWorkflowMermaid, ReconcileWorkflow, getLenientWorkflow, UpdateWorkflowNode, ValidateMermaidProjection, ValidateWorkflow, WORKFLOW_LIMITS, getDefaultWorkflow, getMatchingNode, getReadyNodes, getTaskCardMarkdown, getWorkflowDigest, getWorkflowMermaid, intOfficialMermaidParser, intWorkflowState } from '../../src/workflow.js'

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

  it('只读默认节点明确交付真实目标，不停留在抽象需求分析或宣称已经完成', () => {
    const task = ValidateTaskCard({ title: '只读标记核对', goal: '读取 README.md 的 marker 并如实回报', acceptance: ['marker 与实际文件一致'], flags: {}, scope: ['README.md'] }).card!
    const graph = getDefaultWorkflow(task, [])
    expect(graph.nodes.map(({ label: _label, ...node }) => node)).toEqual([
      { id: 'analysis', operation: 'delegate', role: 'mou_ding', dependsOn: [], gates: [], outputContractVersion: '1' },
      { id: 'checkpoint', operation: 'checkpoint', dependsOn: ['analysis'], gates: [], outputContractVersion: '1' },
      { id: 'accept', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
    ])
    expect(graph.nodes[0]!.label).toContain(task.goal)
    expect(graph.nodes[0]!.label).toContain('提交结果证据')
    expect(graph.nodes[0]!.label).toContain('任务卡验收')
    expect(intWorkflowState(graph).nodes.analysis?.status).toBe('ready')
    expect(ValidateWorkflow(graph, task, []).errors).toEqual([])
  })

  it('默认实施与验证节点明确目标和验收，同时保留门禁依赖', () => {
    const task = card({ changesCode: true })
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    const implementation = graph.nodes.find(node => node.id === 'implementation')!
    const verification = graph.nodes.find(node => node.id === 'verification')!
    expect(implementation.label).toContain(`实现并交付：${task.goal}`)
    expect(verification.label).toContain(task.goal)
    expect(verification.label).toContain('A1 边界行为一致')
    expect(implementation.dependsOn).toEqual([])
    expect(verification.dependsOn).toEqual(['implementation'])
    expect(verification.gates).toEqual(['G_VERIFY'])
    expect(intWorkflowState(graph).nodes.verification?.status).toBe('pending')
  })

  it('长目标与验收标签有界且显式引用完整合同，不截断原始合同或 Unicode 代理对', () => {
    const task = { ...card({ changesCode: true }), goal: '验算📈'.repeat(100), acceptance: ['边界🧪'.repeat(100)] }
    const original = structuredClone(task)
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    for (const node of graph.nodes.filter(node => ['implementation', 'verification'].includes(node.id))) {
      expect(node.label.length).toBeLessThanOrEqual(WORKFLOW_LIMITS.labelChars)
      expect(node.label.endsWith('…（完整目标与验收以任务卡为准）')).toBe(true)
      expect(node.label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
    }
    expect(task).toEqual(original)
    expect(ValidateWorkflow(graph, task, getRuleGates(task)).errors).toEqual([])
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

  it('天枢的流程草稿缺必需门禁或写错字段时由宿主补齐，不打回任务卡（B3-e 真实输入）', () => {
    const task = card({ changesCode: true, touchesFinancialLogic: true, securitySensitive: true, crossModuleArchitecture: true })
    const gates = getRuleGates(task)
    expect(gates.map((gate) => gate.gate)).toEqual(expect.arrayContaining(['G_VERIFY', 'G_REVIEW', 'G_MATH_VERIFY']))
    const draft = { schemaVersion: 1, mode: 'standard', nodes: [
      { id: 'implement', label: '铸剑：实现条件单创建', operation: 'delegate', role: 'zhu_jian', dependsOn: [], gates: [], outputContractVersion: '1' },
      { id: 'verify', label: '复核', operation: 'delegate', role: 'fu_he', dependsOn: ['implement'], gates: ['G_VERIFY', 'G_MATH_VERIFY'], outputContractVersion: '1', description: '模型多写的字段' },
      { id: 'positive', label: '谋定正方', operation: 'delegate', role: 'mou_ding', dependsOn: ['implement'], gates: [], outputContractVersion: '1' },
      { id: 'adversarial', label: '御史反方', operation: 'delegate', role: 'yu_shi', dependsOn: ['implement'], gates: ['G_REVIEW'], outputContractVersion: '1' },
      { id: 'checkpoint', label: '检查点', operation: 'checkpoint', dependsOn: ['verify', 'positive', 'adversarial'], gates: [], outputContractVersion: '1' },
      { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
    ] }
    expect(ValidateWorkflow(draft, task, gates).errors.join()).toContain('不能由 fu_he 产生门禁 G_MATH_VERIFY')
    const next = ReconcileWorkflow(getLenientWorkflow(draft, task, gates), task, gates)
    expect(next.errors).toEqual([])
    const math = next.definition.nodes.find((node) => node.gates.includes('G_MATH_VERIFY'))!
    expect(math).toMatchObject({ role: 'suan_heng', mathMode: 'verify' })
    expect(math.dependsOn).toContain('implement')
    expect(next.definition.nodes.find((node) => node.id === 'verify')!.gates).toEqual(['G_VERIFY'])
    expect(next.definition.nodes.find((node) => node.operation === 'checkpoint')!.dependsOn).toContain(math.id)
  })

  it('宽松读取：算衡节点按门禁推断模式、省略字段补齐、没有业务节点时退回默认流程', () => {
    const task = card({ changesCode: true, numericPrecision: true })
    const gates = getRuleGates(task)
    const lenient = getLenientWorkflow({ nodes: [{ id: 'build', role: 'ji_feng' }, { id: 'math', role: 'suan_heng', gates: ['G_MATH_VERIFY'], dependsOn: ['build'] }] }, task, gates)
    expect(lenient.nodes.find((node) => node.id === 'math')).toMatchObject({ mathMode: 'verify', gates: ['G_MATH_VERIFY'], outputContractVersion: '1' })
    const next = ReconcileWorkflow(lenient, task, gates)
    expect(next.errors).toEqual([])
    expect(next.definition.nodes.filter((node) => node.operation === 'accept')).toHaveLength(1)
    expect(getLenientWorkflow({ nodes: [] }, task, gates)).toEqual(getDefaultWorkflow(task, gates))
    expect(ReconcileWorkflow(getLenientWorkflow({ nodes: [{ id: 'x', role: '铸剑' }] }, task, gates), task, gates).errors.join()).toContain('zhu_jian')
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
  it('来自任务目标与验收的特殊字符仍按现有规范转义并可被官方 parser 解析', async () => {
    const task = { ...card({ changesCode: true }), goal: '读取 "marker" <script>\nclick bad', acceptance: ['保留 "值" & 不执行 <tag>'] }
    const graph = getDefaultWorkflow(task, getRuleGates(task))
    const source = getWorkflowMermaid(graph)
    expect(source).toContain('#34;marker#34;')
    expect(source).not.toContain('<script>')
    expect(source).not.toContain('<tag>')
    expect(source.split('\n').some(line => line.trimStart().startsWith('click'))).toBe(false)
    expect(await ParseWorkflowMermaid(graph, source)).toMatchObject({ parseVerdict: 'pass', projectionVerdict: 'pass' })
  }, 20000)
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
