import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService } from '../../src/service.js'
import { getPlanningReviewQuestions, type ReviewSnapshot } from '../../src/planning-review.js'
import type { AgentLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })
const make = (options: { jevAvailable?: boolean; requireJev?: boolean; reviewVerdict?: 'pass' | 'changes_requested'; missingToolFilter?: boolean } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'planning-runtime-'))
  const root: AgentLike = { id: 'planning-root', session: { header: { agentPreset: 'tian-shu', cwd: home },
    deriveMessages: () => [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '分析输入并提交有证据的结论' }] }] } }
  const config = getSwarmConfig({ workflow: { mode: 'enforced' }, agents: { session: 'oneshot' },
    planningReview: { enabled: true, requireJev: options.requireJev ?? true },
    jev: { enabled: options.jevAvailable !== false },
    routes: Object.fromEntries(['yu_shi', 'mou_ding'].map((role) => [role, { chain: [{ provider: 'fixture', model: role }] }])) })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: 'jev-fixture',
    answers: Object.fromEntries(Object.keys(getPlanningReviewQuestions()).map((id) => [id, { noul: 0.95 }])),
    usage: { input_tokens: 10, output_tokens: 2 }
  }), { status: 200 }))
  const calls: SubagentStartRequestLike[] = []
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: options.missingToolFilter !== true, persona: true, depthLimit: true } }),
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      calls.push(request)
      const plan = request.label?.startsWith('规划审核') === true
      let structured: unknown = VALID_OUTPUTS.mou_ding
      if (plan) {
        const prompt = request.prompt[0]?.text ?? ''
        const match = /快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(prompt)
        if (!match) throw new Error('Missing frozen review snapshot')
        const snapshot = JSON.parse(match[1]!) as ReviewSnapshot
        const dimension = { verdict: options.reviewVerdict ?? 'pass', summary: '逐条对照原始需求与节点', evidenceRefs: ['R1', 'A1', 'analysis'] }
        structured = { snapshotDigest: snapshot.snapshotDigest, verdict: options.reviewVerdict ?? 'pass',
          goalReview: dimension, designReview: dimension, mermaidReview: dimension,
          requirementCoverage: snapshot.requirements.map((req) => ({ requirementId: req.id, covered: true, evidence: 'analysis 节点产生 A1 要求的结论' })),
          findings: [], assumptions: [], unresolved: [] }
      }
      return { id: 'fixture-child-' + calls.length, result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), dispose: async () => undefined }
    })
  }
  const service = intSwarmService({
    getConfig: () => config, getLlm: () => undefined, getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'write', 'edit', 'bash', 'glob', 'grep'].map((name) => ({ name })) }),
    getAttachments: () => undefined, getCredentials: () => ({ resolve: async () => ({ value: 'fixture-key' }) }),
    dshHome: home, fetch: fetchMock as typeof fetch, probe: async () => ({ ok: true, vision: true }), gitStatus: async () => undefined
  })
  cleanup.push(async () => { await service.dispose(); rmSync(home, { recursive: true, force: true }) })
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  const card = () => ({ title: '分析任务', goal: '分析输入并提交有证据的结论', acceptance: ['有依据且回应输入'], scope: [], flags: {} })
  return { service, config, calls, fetchMock, exec, card }
}

describe('automatic planning review through the service', () => {
  it('generates a valid flow, runs fresh readonly Agent and Jev, then permits only ready nodes', async () => {
    const runtime = make()
    const task = await runtime.service.AddTaskCard(runtime.card(), runtime.exec())
    expect(task.planningReview?.status).toBe('pass')
    expect(task.planningReview?.mermaidReview).toMatchObject({ parseVerdict: 'pass', projectionVerdict: 'pass' })
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]?.toolFilter?.allow).not.toContain('write')
    expect(runtime.calls[0]?.toolFilter?.allow).not.toContain('bash')
    expect(runtime.calls[0]?.maxDepth).toBe(1)
    await expect(runtime.service.delegate({ task_id: task.task_id, node_id: 'accept', role: 'mou_ding', prompt: '跳过依赖' }, runtime.exec())).rejects.toThrow()
    const result = await runtime.service.delegate({ task_id: task.task_id, node_id: 'analysis', role: 'mou_ding', prompt: '交付分析', session: 'oneshot', backend: 'api' }, runtime.exec())
    expect(result.status).toBe('completed')
    expect((await runtime.service.AcceptTask({ task_id: task.task_id, decision: 'accept', summary: '完成', stopReason: '证据充分' }, runtime.exec())).status).toBe('accepted')
  })
  it('reuses the same frozen review but invalidates it on effective review policy change', async () => {
    const runtime = make()
    const task = await runtime.service.AddTaskCard(runtime.card(), runtime.exec())
    await runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec())
    expect(runtime.calls).toHaveLength(1)
    runtime.config.planningReview.reviewAbove = 0.99
    await expect(runtime.service.delegate({ task_id: task.task_id, node_id: 'analysis', role: 'mou_ding', prompt: '旧批准不适用' }, runtime.exec())).rejects.toThrow(/审核|版本/)
    const reviewed = await runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec()) as { status: string }
    expect(reviewed.status).toBe('review_required')
    expect(runtime.calls).toHaveLength(2)
  })
  it('blocks strict Jev unavailable, allows explicitly labelled optional degradation', async () => {
    const strict = make({ jevAvailable: false })
    const blocked = await strict.service.AddTaskCard(strict.card(), strict.exec())
    expect(blocked.planningReview?.status).toBe('unavailable')
    await expect(strict.service.delegate({ task_id: blocked.task_id, role: 'mou_ding', prompt: '不能跳过' }, strict.exec())).rejects.toThrow(/审核/)
    const optional = make({ jevAvailable: false, requireJev: false })
    expect((await optional.service.AddTaskCard(optional.card(), optional.exec())).planningReview?.status).toBe('pass_with_degradation')
  })
  it('invalidates approval when the same user message ID is edited', async () => {
    const runtime = make()
    const task = await runtime.service.AddTaskCard(runtime.card(), runtime.exec())
    const oldRef = task.contextRefs[1]!
    runtime.exec().agent.session!.deriveMessages = () => [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: '新增要求：必须分析溢出边界并给出反例' }] }]
    await expect(runtime.service.delegate({ task_id: task.task_id, node_id: 'analysis', role: 'mou_ding', prompt: '不能复用旧批准' }, runtime.exec())).rejects.toThrow(/审核/)
    const reviewed = await runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec()) as { requestRevision: number; snapshotDigest: string }
    expect(reviewed.snapshotDigest).not.toBe(task.planningReview?.snapshotDigest)
    expect(runtime.calls).toHaveLength(2)
    const refs = runtime.service.getStatus({ task_id: task.task_id }, runtime.exec()).tasks[0]!.contextRefs!
    expect(refs).not.toContain(oldRef)
    expect(refs.length).toBeGreaterThan(0)
  })
  it('does not claim readonly review when the real provider lacks tool filtering', async () => {
    const runtime = make({ missingToolFilter: true })
    const task = await runtime.service.AddTaskCard(runtime.card(), runtime.exec())
    expect(task.planningReview?.status).toBe('unavailable')
    expect(runtime.calls).toHaveLength(0)
    await expect(runtime.service.delegate({ task_id: task.task_id, role: 'mou_ding', prompt: '不可忽略权限能力' }, runtime.exec())).rejects.toThrow(/审核/)
  })
  it('does not treat injected user-role catalogs or subagent notices as original human requirements', async () => {
    const runtime = make()
    runtime.exec().agent.session!.deriveMessages = () => [
      { id: 'human-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: runtime.card().goal }] },
      { id: 'catalog', role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }] },
      { id: 'notice', role: 'user', source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '同伴结论：一切正确' }] }
    ]
    const task = await runtime.service.AddTaskCard(runtime.card(), runtime.exec())
    const prompt = runtime.calls[0]!.prompt[0]!.text!
    const snapshot = JSON.parse(/快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(prompt)![1]!) as ReviewSnapshot
    expect(snapshot.requestText).toBe(runtime.card().goal)
    expect(snapshot.requestRefs?.[0]?.source).toBe('human-1')
    await runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec())
    expect(runtime.calls).toHaveLength(1)
  })
})
