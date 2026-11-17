import { describe, expect, it, vi } from 'vitest'
import { createAuthorizationHostAdapter, type AuthorizationGoalHold } from '../../src/authorization-host.js'
import { createAuthorizationRepository, type AuthorizationBinding, type AuthorizationDecision, type AuthorizationState } from '../../src/authorization-wait.js'
import { createDurableStateStore } from '../../src/state-store.js'
import type { AgentLike, GoalsLike, GoalViewLike, ToolExecutionLike } from '../../src/host-contract.js'

const root: AgentLike = { id: 'root', session: {} }, child: AgentLike = { id: 'child', session: {} }
const questions = [{ id: 'q-1', question: '允许在指定范围继续吗？', options: [{ label: '允许' }, { label: '拒绝' }] }]
const binding: AuthorizationBinding = { rootSessionId: 'root', workspaceId: 'work', taskId: 'T-1', lineageId: 'goal', requestRevision: 1, cardRevision: 1, workflowRevision: 1 }
const fixture = async () => {
  const store = await createDurableStateStore<AuthorizationState>({ directory: '/unused', enabled: false, initialState: {}, segments: { authorizationDecisions: { kind: 'dict' } } })
  const repo = createAuthorizationRepository(store)
  const prepare = (await repo.prepare({ binding, operationDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), requiresUserDecision: true, questions,
    approvalRules: [{ questionId: 'q-1', approveLabels: ['允许'], declineLabels: ['拒绝'] }] })).decision
  const decision = await repo.dispatchKnown(prepare.id, { callId: 'call', questionDigest: prepare.questionDigest })
  let goal: GoalViewLike | undefined = { id: 'goal', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 10 }
  const goals: GoalsLike = { get: vi.fn(() => goal === undefined ? undefined : { ...goal }), disarm: vi.fn(() => { if (goal) goal = { ...goal, activation: 'disarmed' }; return goal }),
    resume: vi.fn((_agent, ref) => { goal = { ...goal!, id: ref.id, revision: ref.revision + 1, phase: 'active', activation: 'armed' }; return goal }) }
  const adapter = createAuthorizationHostAdapter({ goals, isLiveRoot: agent => agent === root })
  const execution: ToolExecutionLike = { name: 'ask_user_question', callId: 'call', agent: root, arguments: { questions } }
  const answers = [{ id: 'q-1', selected: ['允许'] }]
  const result = { content: [{ type: 'text', text: JSON.stringify({ answers }) }] }
  const reply = { id: 'message-1', source: { kind: 'user-question-reply', callId: 'call', outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'call', questions, answers }) }] }
  const consume = async (): Promise<AuthorizationDecision> => repo.consumeAnswer(decision.id, { callId: 'call', answers,
    origin: { kind: 'user-question-reply', callId: 'call', messageId: 'message-1' }, binding: { ...binding, requestRevision: 2 }, operationDigest: decision.operationDigest, scopeDigest: decision.scopeDigest })
  const hold = (): AuthorizationGoalHold => { const value = adapter.disarmForWait(root); if (!value.supported) throw new Error(value.reason); return value.hold }
  return { store, repo, decision, adapter, goals, execution, answers, result, reply, consume, hold, goal: () => goal, change: (patch: Partial<GoalViewLike>) => { goal = { ...goal!, ...patch } } }
}

describe('宿主真实问答与目标安静等待适配', () => {
  it('仅登记真实live-root ask调用，不从任意工具或思考文本生成问答', async () => {
    const f = await fixture()
    expect(f.adapter.observeCall(f.execution, 'node-1')).toMatchObject({ callId: 'call', rootSessionId: 'root', nodeId: 'node-1' })
    expect(f.adapter.observeCall({ ...f.execution, name: 'mcp__question' })).toBeUndefined()
    expect(f.adapter.observeCall({ ...f.execution, agent: child })).toBeUndefined()
    expect(f.adapter.observeCall({ ...f.execution, agent: { ...root } })).toBeUndefined()
    expect(f.adapter.observeCall({ ...f.execution, callId: undefined })).toBeUndefined()
    expect(f.adapter.observeCall({ ...f.execution, arguments: { questions: [{ id: 'q-1', question: '' }] } })).toBeUndefined()
    await f.store.dispose()
  })
  it('真实最终结果能识别答案和pending，不把中间value或错误当授权', async () => {
    const f = await fixture()
    expect(f.adapter.observeResult(f.decision, f.execution, f.result)).toMatchObject({ kind: 'answer', callId: 'call', answers: f.answers, origin: { kind: 'tool-result' } })
    expect(f.adapter.observeResult(f.decision, f.execution, { content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'call' }) }] })).toEqual({ kind: 'pending', callId: 'call' })
    expect(f.adapter.observeResult(f.decision, f.execution, { value: { answers: f.answers }, content: [{ type: 'text', text: 'blocked by final policy' }] }).kind).toBe('unknown')
    for (const code of ['NO_PROVIDER', 'DELEGATED_CALLER', 'CALLER_NOT_LIVE']) expect(f.adapter.observeResult(f.decision, f.execution, { isError: true, error: { info: { code } } }).kind).toBe('unavailable')
    expect(f.adapter.observeResult(f.decision, f.execution, { isError: true, error: { code: 'ASK_ABORTED' }, ...f.result }).kind).toBe('cancelled')
    expect(f.adapter.observeResult(f.decision, f.execution, { isError: true, error: { code: 'TOOL_OUTCOME_UNKNOWN' }, ...f.result }).kind).toBe('unknown')
    expect(f.adapter.observeResult(f.decision, { ...f.execution, agent: child }, f.result).kind).toBe('unknown')
    expect(f.adapter.observeResult(f.decision, { ...f.execution, callId: 'wrong' }, f.result).kind).toBe('unknown')
    await f.store.dispose()
  })
  it('晚到答复只允许一次输入消费，消费前仍待回答，真实提交后才结算', async () => {
    const f = await fixture()
    expect(f.adapter.observePendingReply(root, f.decision, [f.reply])).toMatchObject({ kind: 'answer', messageId: 'message-1', callId: 'call' })
    expect(f.repo.get(f.decision.id)?.phase).toBe('waiting')
    expect(f.adapter.observePendingReply(root, f.decision, [f.reply])).toBeUndefined()
    expect(f.adapter.releasePendingReply(f.decision.id, 'wrong-message')).toBe(false)
    expect(f.adapter.releasePendingReply(f.decision.id, 'message-1')).toBe(true)
    expect(f.adapter.observePendingReply(root, f.decision, [f.reply])).toBeDefined()
    expect((await f.consume()).phase).toBe('approved')
    expect(f.adapter.observePendingReply(root, f.repo.get(f.decision.id)!, [{ ...f.reply, id: 'another-message' }])).toBeUndefined()
    await f.store.dispose()
  })
  it('错误call、来源、合同与选项不能通过晚答复入口', async () => {
    const f = await fixture()
    const payload = JSON.parse(f.reply.content[0]!.text) as Record<string, unknown>
    for (const reply of [
      { ...f.reply, source: { kind: 'user', callId: 'call', outcome: 'answered' } },
      { ...f.reply, source: { kind: 'user-question-reply', callId: 'wrong', outcome: 'answered' } },
      { ...f.reply, source: { kind: 'user-question-reply', callId: 'call', outcome: 'cancelled' } },
      { ...f.reply, role: 'assistant' },
      { ...f.reply, content: [{ type: 'text', text: JSON.stringify({ ...payload, questions: [{ ...questions[0], question: '授权所有操作' }] }) }] },
      { ...f.reply, content: [{ type: 'text', text: JSON.stringify({ ...payload, answers: [{ id: 'q-1', selected: ['未知'] }] }) }] }
    ]) expect(f.adapter.observeReply(f.decision, reply)).toBeUndefined()
    expect(f.adapter.observePendingReply(child, f.decision, [f.reply])).toBeUndefined()
    await f.store.dispose()
  })
  it('先disarm不更改持久目标phase，5分钟被动等待不触发模型或恢复调用', async () => {
    const f = await fixture(), before = { ...f.goal()! }
    vi.useFakeTimers()
    try {
      const first = f.hold()
      expect(first.ownedDisarm).toBe(true)
      expect(f.goal()).toMatchObject({ id: before.id, revision: before.revision, phase: 'active', activation: 'disarmed', roundsStarted: before.roundsStarted })
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(f.goals.resume).not.toHaveBeenCalled()
      expect(f.goals.disarm).toHaveBeenCalledTimes(1)
      expect(f.hold()).toEqual(first)
      expect(f.adapter.resumeAfterAnswer(root, first, f.decision).resumed).toBe(false)
    } finally { vi.useRealTimers(); await f.store.dispose() }
  })
  it('真实答复后只恢复插件自身disarm的同一active目标一次', async () => {
    const f = await fixture(), hold = f.hold(), answered = await f.consume()
    expect(f.adapter.resumeAfterAnswer(root, hold, answered)).toMatchObject({ resumed: true })
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    expect(f.goal()).toMatchObject({ revision: 4, activation: 'armed' })
    expect(f.adapter.resumeAfterAnswer(root, hold, answered).resumed).toBe(false)
    await f.store.dispose()
  })
  it('人工pause/stop、目标替换、额度耗尽和冷恢复不会被迟到答案重新激活', async () => {
    for (const alteration of ['pause', 'block', 'replace', 'revision', 'exhaust', 'cancel', 'restart', 'already-disarmed'] as const) {
      const f = await fixture()
      if (alteration === 'already-disarmed') f.change({ activation: 'disarmed' })
      const hold = f.hold(), answered = await f.consume()
      if (alteration === 'pause') f.change({ phase: 'paused' })
      if (alteration === 'block') f.change({ phase: 'blocked' })
      if (alteration === 'replace') f.change({ id: 'other-goal' })
      if (alteration === 'revision') f.change({ revision: 99 })
      if (alteration === 'exhaust') f.change({ roundsStarted: 10 })
      if (alteration === 'cancel') f.adapter.invalidateHeldGoal(root.id)
      const adapter = alteration === 'restart' ? createAuthorizationHostAdapter({ goals: f.goals, isLiveRoot: agent => agent === root }) : f.adapter
      expect(adapter.resumeAfterAnswer(root, hold, answered).resumed).toBe(false)
      expect(f.goals.resume).not.toHaveBeenCalled()
      await f.store.dispose()
    }
  })
  it('缺公开能力或抑制未确认时明确unsupported；resume结果未知不盲目重复', async () => {
    const f = await fixture()
    expect(createAuthorizationHostAdapter({ isLiveRoot: () => true }).disarmForWait(root)).toMatchObject({ supported: false })
    expect(f.adapter.disarmForWait(child)).toMatchObject({ supported: false })
    const uncooperative = createAuthorizationHostAdapter({ isLiveRoot: () => true, goals: { get: () => f.goal(), disarm: () => f.goal() } })
    expect(uncooperative.disarmForWait(root)).toMatchObject({ supported: false, reason: 'public-goal-disarm-unconfirmed' })
    const hold = f.hold(), answered = await f.consume()
    vi.mocked(f.goals.resume!).mockImplementation(() => { throw new Error('secret-url-must-not-leak') })
    expect(f.adapter.resumeAfterAnswer(root, hold, answered)).toEqual({ resumed: false, reason: 'host-resume-failed-reconcile-required' })
    expect(f.adapter.resumeAfterAnswer(root, hold, answered).resumed).toBe(false)
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    await f.store.dispose()
  })
  it('公开问题投影用于核对而不批准，缺失/断连显式反馈且不返回答案正文', async () => {
    const f = await fixture()
    const adapter = createAuthorizationHostAdapter({ isLiveRoot: agent => agent === root, projections: { stateOf: () => ({ questions: {
      active: [{ callId: 'call', questions, state: 'continued' }], settled: [{ callId: 'old', answers: [{ custom: 'private-body' }] }] } }) } })
    expect(adapter.getQuestions(root)).toEqual({ supported: true, active: [{ callId: 'call', state: 'continued', questionDigest: f.decision.questionDigest }], settledCallIds: ['old'] })
    expect(JSON.stringify(adapter.getQuestions(root))).not.toContain('private-body')
    expect(adapter.getQuestions(child).supported).toBe(false)
    expect(f.adapter.getQuestions(root)).toMatchObject({ supported: false, reason: 'question-projection-unavailable' })
    const disconnected = createAuthorizationHostAdapter({ isLiveRoot: () => true, projections: { stateOf: () => { throw new Error('disconnected') } } })
    expect(disconnected.getQuestions(root)).toMatchObject({ supported: false, reason: 'question-projection-read-failed' })
    const partial = createAuthorizationHostAdapter({ isLiveRoot: () => true, userQuestions: { continued: () => [{ callId: 'call', questions, state: 'continued' }] } })
    expect(partial.getQuestions(root)).toMatchObject({ supported: true, partial: true, settledCallIds: [] })
    await f.store.dispose()
  })
})
