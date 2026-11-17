import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService } from '../../src/service.js'
import type { AgentLike, SubagentResultLike } from '../../src/host-contract.js'

// 此测试核对授权，不为每个任务启动解析 worker；真实语法另由 workflow/Host 回归覆盖。
vi.mock('../../src/workflow.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/workflow.js')>()
  return { ...actual, ParseWorkflowMermaid: (definition: Parameters<typeof actual.ParseWorkflowMermaid>[0], source?: string) =>
    actual.ParseWorkflowMermaid(definition, source, async () => ({ version: actual.MERMAID_PARSER_VERSION, ok: true })) }
})

it('admits only the live planning reviewer snapshot without inventing a delegation record', async () => {
  const home = mkdtempSync(join(tmpdir(), 'planning-admission-'))
  const root: AgentLike = { id: 'root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const child: AgentLike = { id: 'reviewer', session: { header: { agentPreset: 'yu-shi', parentSession: root.id, cwd: home } } }
  let finish!: (value: SubagentResultLike) => void
  const result = new Promise<SubagentResultLike>(resolve => { finish = resolve })
  const config = getSwarmConfig({ workflow: { mode: 'advisory' }, jev: { enabled: false }, planningReview: { requireJev: false },
    routes: { yu_shi: { chain: [{ provider: 'fixture', model: 'reviewer' }] } } })
  const recordNotebookBinding = vi.fn(async () => undefined)
  const service = intSwarmService({
    recordNotebookBinding,
    getConfig: () => config, getLlm: () => undefined,
    getSubagents: () => ({ getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, persona: true, toolFilter: true, depthLimit: true } }),
      start: async () => ({ id: child.id, result, dispose: async () => undefined }) }),
    getTools: () => ({ schemas: () => ['read', 'write', 'glob', 'grep'].map(name => ({ name })), register: () => () => undefined, guard: () => () => undefined }),
    getAttachments: () => undefined, getCredentials: () => undefined, dshHome: home, fetch: globalThis.fetch,
    probe: async () => ({ ok: true, vision: false }), gitStatus: async () => undefined
  })
  const exec = { agent: root, signal: new AbortController().signal }
  let review: Promise<unknown> | undefined
  try {
    const card = { title: '只读规划审核', goal: '审核当前合同', acceptance: ['只读检查'], scope: [], flags: {} }
    const task = await service.AddTaskCard(card, exec)
    review = service.ReviewPlan({ task_id: task.task_id }, exec)
    await expect.poll(() => service.agentControl.get(child.id), { timeout: 5000 }).toBeDefined()
    await service.WaitAgentReady(child)
    // 规划审核不是执行委派，不制造普通 task/attempt marker，也不能获得 Notebook 能力。
    expect(recordNotebookBinding).not.toHaveBeenCalled()
    expect(service.GetNotebookTaskBinding(child.id)).toBeUndefined()
    expect(service.getGuardReason({ name: 'nb_new', agent: child, arguments: {} })).toBeDefined()
    expect(service.getGuardReason({ name: 'read', agent: child, arguments: { path: 'README.md' } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'structured_output', agent: child, arguments: {} })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write', agent: child, arguments: { path: 'README.md' } })).toBeDefined()
    await service.AddTaskCard({ ...card, task_id: task.task_id, expected_card_revision: task.cardRevision, scope: ['README.md'] }, exec)
    expect(service.getGuardReason({ name: 'read', agent: child, arguments: { path: 'README.md' } })).toBeDefined()
    expect(service.getStatus({ task_id: task.task_id }, exec).tasks[0]!.delegations).toHaveLength(0)
  } finally {
    finish({ output: [], structured: {}, stopReason: 'completed' })
    await review
    await service.dispose()
    rmSync(home, { recursive: true, force: true })
  }
}, 10000)
