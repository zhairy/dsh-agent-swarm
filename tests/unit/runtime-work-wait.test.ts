import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike, ContentBlockLike, GoalViewLike, GoalsLike, SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import * as FeatureSessions from '../../src/feature-session.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

interface Message { id: string; role: string; source: { kind: string; callId?: string; outcome?: string }; toolCallId?: string; content: ContentBlockLike[]; [key: string]: unknown }
const homes: string[] = [], services: SwarmService[] = [], releases: Array<() => void> = [], operations: Promise<unknown>[] = []
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(operations.splice(0))
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-real-service-work-wait-')); homes.push(home)
  await writeFile(join(home, 'README.md'), 'Read-only deterministic delayed child fixture.\n')
  const messages: Message[] = [{ id: 'initial-human-goal', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '核对README并等待我选择后续范围；已执行的工作不重放。' }] }]
  const root: AgentLike = { id: 'work-wait-root', session: { header: { agentPreset: 'tian-shu', cwd: home }, deriveMessages: () => messages } }
  let goal: GoalViewLike = { id: 'work-goal', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 100 }
  const goals: GoalsLike = { get: () => ({ ...goal }), disarm: vi.fn(() => { goal = { ...goal, activation: 'disarmed' }; return { ...goal } }),
    resume: vi.fn((_agent, ref) => {
      if (goal.id !== ref.id || goal.revision !== ref.revision || goal.phase !== 'active' || goal.activation !== 'disarmed') throw new Error('public-goal-CAS-refused')
      goal = { ...goal, revision: goal.revision + 1, activation: 'armed' }
      return { ...goal }
    }) }
  let features!: FeatureSessions.FeatureSession
  const createFeatureSession = FeatureSessions.createFeatureSession
  vi.spyOn(FeatureSessions, 'createFeatureSession').mockImplementation(async input => { features = await createFeatureSession(input); return features })
  const childDone = deferred(); releases.push(childDone.release)
  const start = vi.fn(async (_provider: string, request: SubagentStartRequestLike) => {
    const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
    return { id: 'delayed-work-child', result: childDone.promise.then(() => ({ output: [], structured: VALID_OUTPUTS[role], stopReason: 'completed' } as SubagentResultLike)), dispose: async () => undefined }
  })
  const config = getSwarmConfig({ rootFallback: false, persistence: { enabled: false }, workflow: { mode: 'advisory' }, planningReview: { enabled: false },
    jev: { enabled: false }, review: { enabled: false }, agents: { session: 'oneshot', maxRetries: 0 }, routes: { mou_ding: { chain: [{ provider: 'wait-fixture', model: 'reader' }] } } })
  const service = intSwarmService({ getConfig: () => config, getAgent: id => id === root.id ? root : undefined,
    getLlm: () => ({ listProviders: () => [{ id: 'wait-fixture' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
    getGoals: () => goals, getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }), start }),
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'glob', 'grep', 'swarm_context_read', 'ask_user_question'].map(name => ({ name })) }),
    getAttachments: () => undefined, getCredentials: () => undefined, dshHome: home, probe: async () => ({ ok: true, vision: false }), gitStatus: async () => undefined,
    fetch: async () => { throw new Error('No external LLM or network in runtime-work-wait unit fixture') } })
  services.push(service)
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  const task = await service.AddTaskCard({ title: '等待工作和用户决定', goal: '只读核对README，后续动作等待范围选择', acceptance: ['真实工作结算和真实答复均可核对'],
    scope: ['README.md'], flags: {} }, exec())
  const pendingChild = service.delegate({ task_id: task.task_id, node_id: 'analysis', role: 'mou_ding', prompt: '只读核对README，提交有依据的分析', backend: 'api', session: 'oneshot' }, exec())
  operations.push(pendingChild.catch(() => undefined))
  await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(service.getStatus({ task_id: task.task_id }, exec()).tasks[0]!.delegations.some(record => record.status === 'running')).toBe(true))
  const questions = [{ id: 'next-scope', question: '后续只读核查范围如何选择？', options: [{ label: '仍只读README' }, { label: '拒绝后续动作' }] }]
  const ask = { name: 'ask_user_question', callId: 'real-service-call', agent: root, arguments: { questions, timeout: 1 } }
  const decision = () => features.authorizations.forTask(task.task_id, root.id)[0]!
  const pendingAsk = async () => {
    messages.push({ id: 'assistant-question', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: ask.callId, name: ask.name, arguments: JSON.stringify(ask.arguments) }] })
    await service.BeforeManagedTool(ask)
    const result = { content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: ask.callId }) }] }
    service.ObserveManagedToolResult(ask, result)
    const logged: Message = { id: 'pending-tool-result', role: 'tool', source: { kind: 'tool', callId: ask.callId }, toolCallId: ask.callId, content: result.content }
    messages.push(logged)
    service.ObserveManagedMessage(root.id, { type: 'tool/result', data: { message: logged } })
    expect(await service.BeforeManagedStep(root, { kind: 'enter', messages: [] })).toEqual({ kind: 'reject' })
    expect(decision().phase).toBe('waiting')
  }
  const answer = async (label = '仍只读README') => {
    const reply: Message = { id: 'actual-late-human-answer', role: 'user', source: { kind: 'user-question-reply', callId: ask.callId, outcome: 'answered' }, content: [{ type: 'text',
      text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: ask.callId, questions, answers: [{ id: 'next-scope', selected: [label] }] }) }] }
    const admitted = await service.BeforeManagedStep(root, { kind: 'enter', messages: [reply] })
    expect(admitted.kind).toBe('enter')
    await service.BeforeManagedRequest(root)
    expect(decision().phase).toBe('waiting')
    messages.push(reply)
    service.ObserveManagedMessage(root.id, { type: 'user/message', data: reply })
    await service.BeforeManagedRequest(root)
    return reply
  }
  return { root, service, task, exec, goals, features: () => features, goal: () => goal, changeGoal: (patch: Partial<GoalViewLike>) => { goal = { ...goal, ...patch } },
    start, childDone, pendingChild, pendingAsk, answer, decision, messages }
}

describe('真实SwarmService的工作等待与授权等待交错', () => {
  it.each([{ answer: '仍只读README' }, { answer: '拒绝后续动作' }])('工作先拥有hold、ask pending、工作先结算、答复$answer后恰好恢复一次', async ({ answer }) => {
    const f = await fixture()
    expect(await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).toEqual({ kind: 'reject' })
    expect(f.goal()).toMatchObject({ phase: 'active', activation: 'disarmed', revision: 1 })
    expect(f.goals.disarm).toHaveBeenCalledTimes(1)
    await f.pendingAsk()
    // The auth hold observes an already-disarmed goal; it cannot own the work hold's recovery.
    expect(f.goals.disarm).toHaveBeenCalledTimes(1)
    f.childDone.release()
    expect((await f.pendingChild).status).toBe('completed')
    expect(f.goal()).toMatchObject({ activation: 'disarmed', revision: 1 })
    expect(f.goals.resume).not.toHaveBeenCalled()
    expect(f.decision().phase).toBe('waiting')
    const reply = await f.answer(answer)
    expect(f.decision()).toMatchObject({ phase: 'answered', appliesToBinding: { requestRevision: 2 } })
    expect(f.goal()).toMatchObject({ phase: 'active', activation: 'armed', revision: 2 })
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    expect(f.start).toHaveBeenCalledTimes(1)
    f.service.ObserveManagedMessage(f.root.id, { type: 'user/message', data: reply })
    await f.service.BeforeManagedRequest(f.root)
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
  })
  it.each([{ kind: 'pause' }, { kind: 'replace' }])('同一交错中人工$kind后，旧答复不恢复暂停或替换目标', async ({ kind }) => {
    const f = await fixture()
    await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    await f.pendingAsk()
    if (kind === 'pause') f.changeGoal({ phase: 'paused', activation: 'disarmed', revision: 2 })
    else f.changeGoal({ id: 'replacement-goal', activation: 'armed', revision: 1 })
    f.childDone.release()
    expect((await f.pendingChild).status).toBe('completed')
    await f.answer()
    expect(f.decision().phase).toBe('answered')
    expect(f.goals.resume).not.toHaveBeenCalled()
    expect(f.goal()).toMatchObject(kind === 'pause' ? { id: 'work-goal', phase: 'paused', activation: 'disarmed' } : { id: 'replacement-goal', activation: 'disarmed' })
    expect(f.start).toHaveBeenCalledTimes(1)
  })
  it('同一交错中明确stop取消待答决定，工作结算和迟到答复均不复活目标', async () => {
    const f = await fixture()
    await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    await f.pendingAsk()
    f.service.ObserveManagedMessage(f.root.id, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    f.childDone.release()
    expect((await f.pendingChild).status).toBe('completed')
    await f.service.BeforeManagedRequest(f.root)
    expect(f.decision().phase).toBe('cancelled')
    expect(f.goals.resume).not.toHaveBeenCalled()
    expect(f.goal().activation).toBe('disarmed')
    const reply: Message = { id: 'cancelled-late-answer', role: 'user', source: { kind: 'user-question-reply', callId: 'real-service-call', outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'real-service-call', questions: [{ id: 'next-scope', question: '后续只读核查范围如何选择？', options: [{ label: '仍只读README' }, { label: '拒绝后续动作' }] }], answers: [{ id: 'next-scope', selected: ['仍只读README'] }] }) }] }
    expect(await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [reply] })).toEqual({ kind: 'reject' })
    expect(f.goals.resume).not.toHaveBeenCalled()
  })
})
