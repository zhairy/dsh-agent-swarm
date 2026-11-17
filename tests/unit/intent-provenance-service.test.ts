import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { inspectFeatureState } from '../../src/feature-session.js'
import type { TaskRecord } from '../../src/evidence.js'
import type { AgentLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { getPlanningReviewQuestions, type ReviewSnapshot } from '../../src/planning-review.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { intSwarmService } from '../../src/service.js'
import { getTaskIntentRefs, getTaskIntentText, mergeTaskIntentRefs } from '../../src/task-model.js'

// 本文件验证来源、修订与持久化；官方 Mermaid parser 另有集成回归。
vi.mock('../../src/workflow.js', async original => {
  const actual = await original<typeof import('../../src/workflow.js')>()
  return { ...actual, ParseWorkflowMermaid: async (workflow: Parameters<typeof actual.getWorkflowMermaid>[0], source = actual.getWorkflowMermaid(workflow)) => ({
    parseVerdict: 'pass', projectionVerdict: actual.ValidateMermaidProjection(workflow, source).length === 0 ? 'pass' : 'fail', errors: [],
    sourceDigest: actual.getValueDigest(source), generatorVersion: actual.WORKFLOW_GENERATOR_VERSION, parserVersion: actual.MERMAID_PARSER_VERSION
  }) }
})

type Message = NonNullable<NonNullable<AgentLike['session']>['deriveMessages']> extends () => readonly (infer T)[] ? T : never
const card = { title: '恢复维护', goal: '检查规划并按确认范围继续', acceptance: ['当前授权范围可追溯'], scope: [], flags: {} }
const human: Message = { id: 'human-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: card.goal }] }
const question: Message = { id: 'assistant-1', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'call-question', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'scope', question: '是否实施隔离修复？', options: [{ label: '允许隔离修复' }, { label: '仅诊断' }] }] }) }] }
const answer = (selected = '允许隔离修复'): Message => ({ id: 'answer-1', role: 'tool', source: { kind: 'tool', callId: 'call-question' }, toolCallId: 'call-question', isError: false,
  content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'scope', selected: [selected] }] }) }] })

const createRuntime = (home: string, messages: Message[]) => {
  const snapshots: ReviewSnapshot[] = []
  const root: AgentLike = { id: 'provenance-root', session: { header: { agentPreset: 'tian-shu', cwd: home }, deriveMessages: () => messages } }
  const config = getSwarmConfig({ workflow: { mode: 'enforced' }, persistence: { enabled: true }, planningReview: { enabled: true, requireJev: true },
    routes: { yu_shi: { chain: [{ provider: 'fixture', model: 'reviewer' }] } } })
  const start = vi.fn(async (_provider: string, request: SubagentStartRequestLike) => {
    const snapshot = JSON.parse(/快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(request.prompt[0]?.text ?? '')![1]!) as ReviewSnapshot
    snapshots.push(snapshot)
    const dimension = { verdict: 'pass', summary: '逐条对照当前需求来源与流程', evidenceRefs: ['R1', 'A1', 'analysis'] }
    return { id: `review-${snapshots.length}`, dispose: async () => undefined, result: Promise.resolve({ stopReason: 'completed', output: [], structured: {
      snapshotDigest: snapshot.snapshotDigest, verdict: 'pass', goalReview: dimension, designReview: dimension, mermaidReview: dimension,
      requirementCoverage: snapshot.requirements.map(item => ({ requirementId: item.id, covered: true, evidence: 'analysis 对照原文产出 A1' })), findings: [], assumptions: [], unresolved: []
    } }) }
  })
  const service = intSwarmService({ getConfig: () => config, getLlm: () => undefined, getAttachments: () => undefined,
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }), start }),
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'glob'].map(name => ({ name })) }),
    getCredentials: () => ({ resolve: async () => ({ value: 'fixture-nonsecret' }) }), dshHome: home,
    fetch: async () => new Response(JSON.stringify({ model: 'jev-fixture', answers: Object.fromEntries(Object.keys(getPlanningReviewQuestions()).map(id => [id, { noul: 0.95 }])) }), { status: 200 }),
    probe: async () => ({ ok: true, vision: true }), gitStatus: async () => undefined })
  return { service, snapshots, start, exec: () => ({ agent: root, signal: new AbortController().signal }) }
}

describe('用户确认的服务与持久化来源', () => {
  it('真实问答形状触发需求换版、新材料和新审核；重复复审与改卡不增长，恢复后保留逐条出处', async () => {
    const home = mkdtempSync(join(tmpdir(), 'intent-provenance-'))
    const messages = [human]
    const runtime = createRuntime(home, messages)
    let restored: ReturnType<typeof createRuntime> | undefined
    try {
      const initial = await runtime.service.AddTaskCard(card, runtime.exec())
      expect(initial.planningReview?.status).toBe('pass')
      expect(runtime.snapshots[0]?.requestRefs?.map(ref => ref.source)).toEqual(['human-1'])
      const oldRefs = initial.contextRefs
      messages.push(question, answer())
      const projection = runtime.service.getStatus({ task_id: initial.task_id }, runtime.exec()).tasks[0]!
      expect(projection.requestRevision).toBe(2)
      expect(projection.planningReview).toBeNull()
      await expect(runtime.service.ReadContext({ task_id: initial.task_id, ref: oldRefs[0] }, runtime.exec())).rejects.toThrow(/旧|同步|版本/)
      await runtime.service.ReviewPlan({ task_id: initial.task_id }, runtime.exec())
      const revised = runtime.snapshots[1]!
      expect(revised.requestRevision).toBe(2)
      expect(revised.requestRefs?.map(ref => ref.source)).toEqual(['human-1', 'answer-1'])
      expect(revised.requestRefs?.[0]?.text).toBe(card.goal)
      expect(revised.requestRefs?.[1]?.text).toContain('是否实施隔离修复')
      expect(revised.snapshotDigest).not.toBe(initial.planningReview?.snapshotDigest)
      const view = runtime.service.getStatus({ task_id: initial.task_id }, runtime.exec()).tasks[0]!
      expect(view.contextRefs).not.toEqual(oldRefs)
      await runtime.service.ReviewPlan({ task_id: initial.task_id }, runtime.exec())
      await runtime.service.AddTaskCard({ ...card, task_id: initial.task_id }, runtime.exec())
      expect(runtime.start).toHaveBeenCalledTimes(2)
      expect(runtime.service.getStatus({ task_id: initial.task_id }, runtime.exec()).tasks[0]?.requestRevision).toBe(2)
      await runtime.service.dispose()
      restored = createRuntime(home, messages)
      await restored.service.ReviewPlan({ task_id: initial.task_id, bypass_cache: true }, restored.exec())
      expect(restored.snapshots[0]?.requestRefs).toEqual(revised.requestRefs)
      expect(restored.snapshots[0]?.requestText).toBe(revised.requestText)
    } finally { await restored?.service.dispose(); await runtime.service.dispose(); rmSync(home, { recursive: true, force: true }) }
  })

  it('同来源答案编辑替换该条而非追加旧答案，普通工具的授权字样不会触发修订', async () => {
    const home = mkdtempSync(join(tmpdir(), 'intent-edit-'))
    const messages = [human, question, answer()]
    const runtime = createRuntime(home, messages)
    try {
      const initial = await runtime.service.AddTaskCard(card, runtime.exec())
      expect(runtime.snapshots[0]?.requestRefs?.map(ref => ref.source)).toEqual(['answer-1'])
      messages[2] = answer('仅诊断')
      await runtime.service.ReviewPlan({ task_id: initial.task_id }, runtime.exec())
      const revised = runtime.snapshots[1]!
      expect(revised.requestRefs).toHaveLength(1)
      const referenceText = revised.requestRefs![0]!.text ?? revised.requestText
      expect(JSON.parse(referenceText.split('\n')[1]!).answers[0].selected).toEqual(['仅诊断'])
      messages.push({ id: 'other-tool', role: 'tool', source: { kind: 'tool', callId: 'unmatched' }, toolCallId: 'unmatched', isError: false,
        content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'scope', selected: ['允许隔离修复'] }] }) }] })
      await runtime.service.ReviewPlan({ task_id: initial.task_id }, runtime.exec())
      expect(runtime.start).toHaveBeenCalledTimes(2)
    } finally { await runtime.service.dispose(); rmSync(home, { recursive: true, force: true }) }
  })

  it('旧记录使用明确聚合来源，不把累计全文归给最后一条消息；追加同来源保持唯一', () => {
    const task: TaskRecord = { taskId: 'T-old', sessionId: 'root', card: ValidateTaskCard(card).card!, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 0, updatedAt: 0,
      intentText: '旧版累计需求，包含多个消息', intentSourceRef: 'last-human', requestRevision: 7 }
    const refs = getTaskIntentRefs(task)
    expect(refs).toEqual([{ source: 'legacy-aggregate:T-old:r7', text: task.intentText }])
    const intent = { source: 'host' as const, sourceRef: 'answer-2', digest: 'unused', text: '新回答', refs: [{ source: 'answer-2', text: '新回答' }] }
    const merged = mergeTaskIntentRefs(task, intent)
    expect(mergeTaskIntentRefs({ ...task, intentRefs: merged }, intent)).toEqual(merged)
    expect(getTaskIntentText(merged)).toContain('逐条出处不可恢复')
  })

  it('持久化校验允许旧缺省与真实新 refs，拒绝重复、空白或额外伪造字段', () => {
    const task = { taskId: 'T-1', sessionId: 'root', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 0, updatedAt: 0 }
    const state = { schemaVersion: 1, tasks: [task], delegations: [], threads: [], contexts: [], budgets: {}, bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {} }
    const expected = { rootSessionId: 'root', workspaceId: 'workspace' }
    expect(inspectFeatureState(state, expected)).toEqual({ ok: true })
    expect(inspectFeatureState({ ...state, tasks: [{ ...task, intentRefs: [{ source: 'human-1', text: '确认' }] }] }, expected)).toEqual({ ok: true })
    for (const intentRefs of [null, [], [{ source: '', text: '确认' }], [{ source: 'human', text: '' }], [{ source: 'human', text: 'a' }, { source: 'human', text: 'b' }], [{ source: 'human', text: 'a', authorized: true }]]) {
      expect(inspectFeatureState({ ...state, tasks: [{ ...task, intentRefs }] }, expected)).toEqual({ ok: false, issues: [{ path: '$.tasks[0].intentRefs', code: 'INTENT_REFERENCE_FORMAT' }] })
    }
  })
})
