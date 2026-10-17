import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import { getTaskDiagrams, getArchifyTaskDiagrams, ValidateTaskDiagrams, TASK_DIAGRAM_KINDS, TASK_DIAGRAM_LIMITS } from '../../src/task-diagrams.js'
import { ValidateTaskCard, getRuleGates } from '../../src/policy.js'
import { getDefaultWorkflow, getWorkflowDigest, intWorkflowState, intOfficialMermaidParser } from '../../src/workflow.js'

const fixture = () => {
  const card = ValidateTaskCard({ title: '合同与图表', goal: '保持真实证据', acceptance: ['分别展示完成和验收'], scope: [], flags: { changesCode: true } }).card!
  const gates = getRuleGates(card)
  const workflowDefinition = getDefaultWorkflow(card, gates)
  const task: TaskRecord = { taskId: 'T-1', sessionId: 'session-1', card, gates, triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1000, updatedAt: 1000,
    cardRevision: 2, workflowRevision: 3, requestRevision: 4, workflowDefinition, workflowState: intWorkflowState(workflowDefinition), workflowDigest: getWorkflowDigest(workflowDefinition) }
  const record: DelegationRecord = { delegationId: 'D-1', taskId: task.taskId, role: 'ji_feng', roleName: '疾风', status: 'completed', summary: '', evidence: [], attempts: [], hardIsolation: true, unresolved: [], independence: 'n/a',
    cardRevision: 2, workflowRevision: 3, requestRevision: 4, nodeId: 'implementation', attemptId: 'attempt-1', finalization: 'ready', startedAt: 1000, durationMs: 100 }
  return { task, record }
}
const client = () => {
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', readFileSync(join(__dirname, '../../client/task-flow.js'), 'utf8'))((id: string) => {
    if (id === 'react') return { createElement: () => undefined }
    throw new Error('not loaded')
  }, module, module.exports)
  return module.exports.__test__
}

describe('单一版本源派生的五图与进度', () => {
  it('五图同快照、无状态写、初始0完成且不伪造时序', () => {
    const { task } = fixture()
    const before = JSON.stringify(task)
    const result = getTaskDiagrams(task, [])
    // 编排视角只在任务记录了编排方案时产出：本 fixture 没有编排，因此按无编排的期望集合比对。
    expect(result.views.map((view) => view.kind)).toEqual(TASK_DIAGRAM_KINDS.filter((kind) => kind !== 'orchestration'))
    expect(result.progress).toMatchObject({ total: 3, completed: 0, percent: 0, accepted: false })
    expect(result.views.find((view) => view.kind === 'sequence')!.mermaid).toContain('无可用执行时间记录')
    expect(getArchifyTaskDiagrams(result).diagrams.find((view) => view.kind === 'sequence')).toMatchObject({ ir: null, reason: expect.any(String) })
    expect(ValidateTaskDiagrams(result)).toEqual([])
    expect(JSON.stringify(task)).toBe(before)
  })
  it('完成需相同三修订、attempt、角色、最终提交证据；不等于验收', () => {
    const { task, record } = fixture()
    task.workflowState!.nodes.implementation = { status: 'succeeded', attemptId: 'attempt-1' }
    expect(getTaskDiagrams(task, [record]).progress).toMatchObject({ completed: 1, percent: 33, accepted: false })
    for (const patch of [{ workflowRevision: 2 }, { requestRevision: 3 }, { cardRevision: 1 }, { attemptId: 'old' }, { finalization: 'processing' }, { staleReason: '旧产物' }, { role: 'fu_he' }, { status: 'failed' }]) {
      const result = getTaskDiagrams(task, [{ ...record, ...patch } as DelegationRecord])
      expect(result.progress.completed).toBe(0)
      expect(result.progress.statuses.unknown).toBe(1)
      expect(result.diagnostics.some((item) => item.code === 'COMPLETION_NOT_BOUND')).toBe(true)
    }
    expect(getTaskDiagrams(task, [record, { ...record, delegationId: 'D-2' }]).progress.completed).toBe(0)
  })
  it('跳过、失败和阻塞不计完成；控制节点不进委派分母', () => {
    const { task } = fixture()
    task.workflowState!.nodes.implementation = { status: 'skipped' }
    task.workflowState!.nodes.verification = { status: 'failed' }
    task.workflowState!.nodes.checkpoint = { status: 'succeeded' }
    const result = getTaskDiagrams(task, [])
    expect(result.progress).toMatchObject({ total: 3, completed: 0, statuses: { skipped: 1, failed: 1 } })
  })
  it('缺状态、摘要错误与未满足依赖只诊断，重绘不通过审核或自动重放', () => {
    const { task } = fixture()
    delete task.workflowState!.nodes.implementation
    task.workflowState!.nodes.verification = { status: 'running' }
    task.workflowState!.nodes.extra = { status: 'pending' }
    task.workflowDigest = 'wrong'
    const before = JSON.stringify(task)
    expect(getTaskDiagrams(task, []).diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining(['WORKFLOW_DIGEST_MISMATCH', 'STATE_MISSING', 'STATE_NODE_UNKNOWN', 'DEPENDENCY_NOT_SETTLED']))
    expect(JSON.stringify(task)).toBe(before)
  })
  it('只展示真实时间事件，保留并发交错、历史版本与缺结束', () => {
    const { task, record } = fixture()
    const records = [record, { ...record, delegationId: 'D-2', startedAt: 1050, durationMs: 10, workflowRevision: 2 }, { ...record, delegationId: 'D-3', startedAt: 1060, status: 'running', durationMs: undefined }] as DelegationRecord[]
    const source = getTaskDiagrams(task, records).views.find((view) => view.kind === 'sequence')!.mermaid
    expect(source.indexOf('D-1 · 当前 · 委派登记')).toBeLessThan(source.indexOf('D-2 · 历史/失效 · 委派登记'))
    expect(source.indexOf('D-2 · 历史/失效 · completed')).toBeLessThan(source.indexOf('D-1 · 当前 · completed'))
    expect(source).not.toContain('D-3 · 当前 · running')
    expect(getTaskDiagrams(task, [{ ...record, startedAt: Number.NaN, durationMs: -10 }]).source.delegations[0]).toMatchObject({ startedAt: null, endedAt: null })
  })
  it('仅保留有界近期记录且明确截断；不导出原始提示、摘要、证据正文', () => {
    const { task, record } = fixture()
    const records = Array.from({ length: TASK_DIAGRAM_LIMITS.history + 5 }, (_, i) => ({ ...record, delegationId: `D-${i + 1}`, startedAt: 1000 + i, summary: 'SECRET-RAW-PROMPT', evidence: [{ ref: 'SECRET-PRIVATE-PATH', type: 'file', summary: 'SECRET-EVIDENCE-BODY' }] } as unknown as DelegationRecord))
    const result = getTaskDiagrams(task, records)
    expect(result.source.delegations).toHaveLength(TASK_DIAGRAM_LIMITS.history)
    expect(result.views.find((view) => view.kind === 'sequence')!.truncated).toBe(5)
    expect(JSON.stringify(result)).not.toContain('SECRET')
    for (const view of result.views) expect(Buffer.byteLength(view.mermaid)).toBeLessThanOrEqual(TASK_DIAGRAM_LIMITS.sourceBytes)
  })
  it('绘制与记录重排稳定，状态改变更新快照摘要', () => {
    const { task, record } = fixture()
    const second = { ...record, delegationId: 'D-2', startedAt: 1200 }
    const first = getTaskDiagrams(task, [record, second])
    expect(getTaskDiagrams(task, [second, record])).toEqual(first)
    task.workflowState!.nodes.implementation = { status: 'running', attemptId: 'attempt-1' }
    expect(getTaskDiagrams(task, [record, second]).snapshotDigest).not.toBe(first.snapshotDigest)
    const tampered = structuredClone(first)
    tampered.views[0]!.mermaid += '\nclick n_implementation "https://outside"'
    expect(ValidateTaskDiagrams(tampered)).not.toEqual([])
    expect(() => getArchifyTaskDiagrams(tampered)).toThrow('摘要')
  })
  it('无流程时进度未知而不是100%，原始任务仍可展示', () => {
    const { task } = fixture()
    delete task.workflowDefinition; delete task.workflowState; delete task.workflowDigest
    expect(getTaskDiagrams(task, []).progress).toMatchObject({ total: 0, completed: 0, percent: null })
  })
  it('五图均通过浏览器有界语法检查与真实官方Mermaid parser', async () => {
    const { task, record } = fixture()
    task.workflowDefinition!.nodes[0]!.label = '引号" <script> %%{init:evil}%%\n新行'
    task.workflowDigest = getWorkflowDigest(task.workflowDefinition!)
    const result = getTaskDiagrams(task, [record])
    const parser = intOfficialMermaidParser()
    for (const view of result.views) {
      expect(() => client().validateSource(view.mermaid)).not.toThrow()
      const parsed = await parser(view.mermaid)
      expect(parsed, `${view.kind}: ${parsed.error}`).toMatchObject({ ok: true, version: '11.12.0' })
    }
  }, 30000)
  it('客户端拒绝跨版本图表，保留原flow兼容；拒绝多图任意指令', () => {
    const { task, record } = fixture()
    const bundle = getTaskDiagrams(task, [record])
    const view = { task_id: task.taskId, cardRevision: 2, workflowRevision: 3, requestRevision: 4, diagrams: bundle }
    expect(client().getDiagramBundle(view)).toBe(bundle)
    expect(client().getDiagramBundle({ ...view, workflowRevision: 4 })).toBeNull()
    for (const source of ['sequenceDiagram\nparticipant p_root as Root\nclick p_root https://evil', 'sequenceDiagram\nparticipant p_root as Root\np_root->>p_9: unknown', 'stateDiagram-v2\nstate "<img>" as s_pending', 'flowchart LR\nn_a["ok"]\nclassDef ready fill:url(evil),stroke:#475569,color:#0f172a']) expect(() => client().validateSource(source)).toThrow()
  })
  it('导出真正Archify五种IR且时序几何不冒充耗时比例', () => {
    const { task, record } = fixture()
    const exported = getArchifyTaskDiagrams(getTaskDiagrams(task, [record]))
    expect(exported.contract).toMatchObject({ version: '3.0.1', commit: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect(exported.diagrams.map((view) => view.ir?.diagram_type)).toEqual(TASK_DIAGRAM_KINDS.filter((kind) => kind !== 'orchestration'))
    for (const { kind, ir } of exported.diagrams) expect(ir).toMatchObject({ schema_version: ['workflow', 'lifecycle'].includes(kind) ? 2 : 1, meta: { output: `${kind}.html`, animation: 'none', quality_profile: 'standard' } })
    // Explicit test fixture export, never production task/state.
    if (process.env.SWARM_DIAGRAM_FIXTURE_OUTPUT) {
      const output = process.env.SWARM_DIAGRAM_FIXTURE_OUTPUT
      writeFileSync(output, JSON.stringify(getTaskDiagrams(task, [record]), null, 2))
    }
  })
})
