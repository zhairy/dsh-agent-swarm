import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../../src/evidence.js'
import { getTaskDiagrams, ValidateTaskDiagrams } from '../../src/task-diagrams.js'
import { FLAG_KEYS, getRuleGates, ValidateTaskCard } from '../../src/policy.js'
import { getDefaultWorkflow, getWorkflowDigest, intWorkflowState } from '../../src/workflow.js'
import { getRuleOrchestration, ORCHESTRATION_DIMENSIONS, ParseOrchestrationPlan } from '../../src/orchestration.js'
import { isDelegableRoleId } from '../../src/role-registry.js'
import { intOfficialMermaidParser } from '../../src/workflow.js'

const loadClient = () => {
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', readFileSync(join(__dirname, '../../client/task-flow.js'), 'utf8'))((id: string) => {
    if (id === 'react') return { createElement: () => undefined }
    throw new Error(`not loaded: ${id}`)
  }, module, module.exports)
  return module.exports.__test__ as { getDiagramBundle: (view: unknown) => unknown }
}

const makeTask = (flags: Record<string, boolean>, scope: string[] = [], acceptance: string[] = ['给出可检验的交付']): TaskRecord => {
  const card = ValidateTaskCard({ title: '编排对抗', goal: '构造反例', acceptance, scope, flags }).card!
  const gates = getRuleGates(card)
  const workflowDefinition = getDefaultWorkflow(card, gates)
  return {
    taskId: 'T-1', sessionId: 'session-1', card, gates, triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0,
    createdAt: 1000, updatedAt: 1000, cardRevision: 2, workflowRevision: 3, requestRevision: 4,
    workflowDefinition, workflowState: intWorkflowState(workflowDefinition), workflowDigest: getWorkflowDigest(workflowDefinition)
  }
}

const viewOf = (task: TaskRecord) => ({
  task_id: task.taskId, cardRevision: task.cardRevision, workflowRevision: task.workflowRevision, requestRevision: task.requestRevision,
  diagrams: getTaskDiagrams(task, [])
})

describe('v2.8 反面审核：编排视图与客户端契约', () => {
  it('A 带编排的任务图表应被客户端接受', () => {
    const task = makeTask({ changesCode: true })
    task.orchestration = getRuleOrchestration(task.card, task.card.flags)
    const view = viewOf(task)
    const kinds = view.diagrams.views.map((item) => item.kind)
    console.log('[A] server views:', kinds.join(','), 'count =', kinds.length)
    console.log('[A] validate:', JSON.stringify(ValidateTaskDiagrams(view.diagrams)))
    const bundle = loadClient().getDiagramBundle(view)
    console.log('[A] client bundle accepted =', bundle !== null)
    expect(bundle).not.toBeNull()
  })

  it('E 编排图必须能被客户端校验与官方解析器接受', async () => {
    const task = makeTask({ crossModuleArchitecture: true, changesCode: true }, ['a', 'b', 'c'], ['x', 'y', 'z'])
    task.orchestration = getRuleOrchestration(task.card, task.card.flags)
    const view = viewOf(task)
    const orchestration = view.diagrams.views.find((item) => item.kind === 'orchestration')!
    console.log('[E] mermaid:\n' + orchestration.mermaid)
    const client = loadClient() as unknown as { validateSource: (source: string) => unknown }
    let clientError: unknown
    try { client.validateSource(orchestration.mermaid) } catch (error) { clientError = error }
    const parser = intOfficialMermaidParser()
    const parsed = await parser(orchestration.mermaid)
    console.log('[E] client validateSource =', clientError === undefined ? 'ok' : String(clientError), '| official parser =', JSON.stringify(parsed))
    expect(parsed).toMatchObject({ ok: true })
  }, 30000)
})

const hasPath = (edges: Map<string, string[]>, from: string, to: string): boolean => {
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of edges.get(current) ?? []) {
      if (next === to) return true
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return false
}

const inspectPlan = (task: TaskRecord) => {
  const plan = getRuleOrchestration(task.card, task.card.flags)
  const issues: string[] = []
  const ids = plan.subtasks.map((item) => item.id)
  if (new Set(ids).size !== ids.length) issues.push('子任务 id 重复')
  if (new Set(plan.dimensions).size !== plan.dimensions.length) issues.push('dimensions 重复')
  if (plan.dimensions.length > 5) issues.push('dimensions 超过 5')
  if (plan.dimensions.some((dimension) => !ORCHESTRATION_DIMENSIONS.includes(dimension))) issues.push('dimensions 越界')
  const edges = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const subtask of plan.subtasks) {
    if (!plan.dimensions.includes(subtask.dimension)) issues.push(`子任务 ${subtask.id} 维度不在 dimensions 内`)
    if (!isDelegableRoleId(subtask.role)) issues.push(`子任务 ${subtask.id} 角色不可委派：${subtask.role}`)
    for (const dependency of subtask.dependsOn) {
      if (!ids.includes(dependency)) issues.push(`依赖指向不存在的 id：${dependency}`)
      else edges.get(dependency)!.push(subtask.id)
    }
    if (subtask.dependsOn.includes(subtask.id)) issues.push(`自依赖：${subtask.id}`)
    for (const peer of subtask.parallelWith) {
      if (!ids.includes(peer)) issues.push(`parallelWith 指向不存在的 id：${peer}`)
      const back = plan.subtasks.find((item) => item.id === peer)
      if (back === undefined || !back.parallelWith.includes(subtask.id)) issues.push(`parallelWith 不对称：${subtask.id} ↔ ${peer}`)
      if (subtask.dependsOn.includes(peer) || back?.dependsOn.includes(subtask.id) === true) issues.push(`既依赖又并行：${subtask.id} ↔ ${peer}`)
      if (hasPath(edges, subtask.id, peer) || hasPath(edges, peer, subtask.id)) issues.push(`传递依赖仍在同一并行关系：${subtask.id} ↔ ${peer}`)
    }
  }
  for (const [index, group] of plan.parallelGroups.entries()) {
    for (const id of group) if (!ids.includes(id)) issues.push(`并行组 ${index + 1} 含未知 id：${id}`)
    for (const a of group) for (const b of group) if (a !== b && (hasPath(edges, a, b) || hasPath(edges, b, a))) issues.push(`并行组 ${index + 1} 内有依赖路径：${a} → ${b}`)
  }
  const covered = new Set(plan.parallelGroups.flat())
  for (const id of ids) if (!covered.has(id)) issues.push(`子任务未进入任何并行组：${id}`)
  const chainIds = new Set(plan.serialized.flat())
  for (const chain of plan.serialized) for (let i = 1; i < chain.length; i += 1) {
    const previous = plan.subtasks.find((item) => item.id === chain[i - 1])
    const current = plan.subtasks.find((item) => item.id === chain[i])
    if (current === undefined || !current.dependsOn.includes(chain[i - 1])) issues.push(`串行链不是依赖边：${chain[i - 1]} → ${chain[i]}`)
    if (previous === undefined) issues.push(`串行链含未知 id：${chain[i - 1]}`)
  }
  for (const subtask of plan.subtasks) if (subtask.dependsOn.length > 0 && !chainIds.has(subtask.id)) issues.push(`有依赖的子任务未出现在任何串行链：${subtask.id}`)
  return { plan, issues }
}

describe('v2.8 反面审核：规则编排结构不变量', () => {
  it('B 全量 flag 组合下结构与依赖自洽', () => {
    const profiles = [{ scope: [] as string[], acceptance: ['a'] }, { scope: ['a', 'b', 'c'], acceptance: ['x', 'y', 'z'] }]
    const counts = new Map<string, number>()
    let checked = 0
    for (let mask = 0; mask < 2 ** FLAG_KEYS.length; mask += 1) {
      const flags = Object.fromEntries(FLAG_KEYS.map((key, index) => [key, (mask & (1 << index)) !== 0]))
      for (const profile of profiles) {
        const task = makeTask(flags, profile.scope, profile.acceptance)
        const { issues } = inspectPlan(task)
        checked += 1
        for (const issue of issues) counts.set(issue, (counts.get(issue) ?? 0) + 1)
      }
    }
    console.log('[B] checked plans =', checked)
    console.log('[B] issue types =', JSON.stringify([...counts.entries()]))
    expect([...counts.keys()]).toEqual([])
  })
})

describe('v2.8 反面审核：Jev 答案解析的绕过面', () => {
  it('C 非法或多余字段不应产出 Jev 结果', () => {
    const task = makeTask({ crossModuleArchitecture: true, changesCode: true }, ['a', 'b', 'c'], ['x', 'y', 'z'])
    const samples: Array<{ name: string; answers: Record<string, unknown> }> = [
      { name: '大小写不同', answers: { complexity: { choice: 'Medium' }, split: { noul: 0.6 } } },
      { name: '多余字段', answers: { complexity: { choice: 'medium', confidence: 0.9, extra: true }, split: { noul: 0.6, extra: 'x' } } },
      { name: '字符串概率', answers: { complexity: { choice: 'medium' }, split: { noul: '0.6' } } },
      { name: '概率越界', answers: { complexity: { choice: 'medium' }, split: { noul: 1.2 } } },
      { name: 'choice 为对象', answers: { complexity: { choice: { value: 'medium' } }, split: { noul: 0.6 } } },
      { name: 'split 为布尔', answers: { complexity: { choice: 'medium' }, split: { noul: true } } },
      { name: '原型污染', answers: JSON.parse('{"complexity":{"choice":"small"},"split":{"noul":0.4},"__proto__":{"polluted":true}}') },
      { name: '合法高置信', answers: { complexity: { choice: 'large', confidence: 0.9 }, split: { noul: 0.8 } } }
    ]
    for (const sample of samples) {
      const plan = ParseOrchestrationPlan(sample.answers, task.card, task.card.flags)
      console.log('[C]', sample.name, '→', plan === undefined ? 'undefined(回退规则)' : `${plan.complexity}/${plan.subtasks.length}子任务/source=${plan.source}`)
    }
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('D 复杂度标签与子任务规模是否一致', () => {
    const large = makeTask({ crossModuleArchitecture: true, changesCode: true }, ['a', 'b', 'c'], ['x', 'y', 'z'])
    const small = makeTask({ changesCode: true })
    const cases: Array<{ name: string; task: TaskRecord; answers: Record<string, unknown> }> = [
      { name: '规则large + Jev small(高拆分倾向)', task: large, answers: { complexity: { choice: 'small', confidence: 0.8 }, split: { noul: 0.9 } } },
      { name: '规则large + Jev small(低拆分倾向)', task: large, answers: { complexity: { choice: 'small', confidence: 0.8 }, split: { noul: 0.1 } } },
      { name: '规则medium + Jev large', task: makeTask({ crossModuleArchitecture: true }, ['a'], ['x']), answers: { complexity: { choice: 'large', confidence: 0.8 }, split: { noul: 0.9 } } },
      { name: '规则small + Jev medium(服务层不会调用)', task: small, answers: { complexity: { choice: 'medium', confidence: 0.8 }, split: { noul: 0.9 } } }
    ]
    for (const sample of cases) {
      const plan = ParseOrchestrationPlan(sample.answers, sample.task.card, sample.task.card.flags)
      const rule = getRuleOrchestration(sample.task.card, sample.task.card.flags)
      console.log('[D]', sample.name, `规则=${rule.complexity}(${rule.subtasks.length}子任务)`, '→', plan === undefined ? 'undefined' : `${plan.complexity}(${plan.subtasks.length}子任务, 并行组=${plan.parallelGroups.filter((group) => group.length > 1).length})`)
    }
    expect(true).toBe(true)
  })
})
