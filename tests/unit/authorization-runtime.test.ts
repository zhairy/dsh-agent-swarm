import { describe, expect, it, vi } from 'vitest'
import { createAuthorizationRuntime, type AuthorizationRuntimeContext } from '../../src/authorization-runtime.js'
import { createAuthorizationRepository, type AuthorizationBinding, type AuthorizationState } from '../../src/authorization-wait.js'
import { createDurableStateStore } from '../../src/state-store.js'
import type { AgentLike, ContentBlockLike, GoalsLike, GoalViewLike, ToolExecutionLike } from '../../src/host-contract.js'
import type { TaskRecord } from '../../src/evidence.js'
import { ValidateTaskCard } from '../../src/policy.js'

interface Message { id: string; role?: string; source: { kind: string; callId?: string; outcome?: string }; toolCallId?: string; isError?: boolean; content: ContentBlockLike[]; [key: string]: unknown }
const questions = [{ id: 'decision', question: '请选择维护范围', options: [{ label: '指定范围' }, { label: '拒绝' }] }]
const fixture = async () => {
  const store = await createDurableStateStore<AuthorizationState>({ directory: '/unused', enabled: false, initialState: {}, segments: { authorizationDecisions: { kind: 'dict' } } })
  const repo = createAuthorizationRepository(store), messages: Message[] = []
  const agent: AgentLike = { id: 'root', session: { deriveMessages: () => messages } }
  const task: TaskRecord = { taskId: 'T-1', sessionId: agent.id, card: ValidateTaskCard({ title: '维护', goal: '核对维护范围', acceptance: ['明确范围'], scope: ['src'], flags: {} }).card!,
    gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1, cardRevision: 1, workflowRevision: 1, requestRevision: 1 }
  const binding = (): AuthorizationBinding => ({ rootSessionId: agent.id, workspaceId: 'a'.repeat(64), taskId: task.taskId,
    lineageId: 'b'.repeat(64), requestRevision: task.requestRevision!, cardRevision: task.cardRevision!, workflowRevision: task.workflowRevision! })
  const context = (): AuthorizationRuntimeContext => ({ features: { workspaceId: 'a'.repeat(64), authorizations: repo }, task, binding: binding() })
  let goal: GoalViewLike = { id: 'goal-1', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 10 }, independent = false
  const goals: GoalsLike = { get: () => ({ ...goal }), disarm: vi.fn(() => { goal = { ...goal, activation: 'disarmed' }; return goal }),
    resume: vi.fn((_agent, ref) => { goal = { ...goal, revision: ref.revision + 1, activation: 'armed' }; return goal }) }
  const refreshed = new Set<string>()
  const refreshBinding = vi.fn(async () => {
    for (const message of messages) if ((message.role === 'tool' || message.source.kind === 'user-question-reply') && !refreshed.has(message.id)
      && message.content.some(block => block.text?.includes('"answers"'))) { task.requestRevision!++; refreshed.add(message.id) }
    return binding()
  })
  const logger = { warn: vi.fn() }
  const deps = { getContext: async () => context(), listDecisions: () => repo.forTask('T-1', agent.id), refreshBinding, getGoals: () => goals,
    isLiveRoot: (owner: AgentLike) => owner === agent, hasIndependentReadyWork: () => independent, logger }
  const runtime = createAuthorizationRuntime(deps)
  const execution: ToolExecutionLike = { name: 'ask_user_question', agent, callId: 'call-1', arguments: { questions } }
  const result = (selected = ['指定范围']) => ({ content: [{ type: 'text', text: JSON.stringify({ answers: [{ id: 'decision', selected }] }) }] })
  const pending = { content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: 'call-1' }) }] }
  const toolLog = (value = result()): Message => ({ id: 'tool-message', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: value.content })
  const reply = (selected = ['指定范围']): Message => ({ id: 'late-answer', role: 'user', source: { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' },
    content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'call-1', questions, answers: [{ id: 'decision', selected }] }) }] })
  const decision = () => repo.forTask('T-1')[0]!
  return { store, repo, messages, agent, task, goals, logger, context, deps, runtime, execution, pending, result, toolLog, reply, decision, refreshBinding,
    goal: () => goal, changeGoal: (patch: Partial<GoalViewLike>) => { goal = { ...goal, ...patch } }, setIndependent: (value: boolean) => { independent = value } }
}

describe('授权coordinator与真实Session输入结算边界', () => {
  it('只在真实ask执行前登记；并发不同call或同call重入都不会重复提问', async () => {
    const f = await fixture()
    await f.runtime.beforeTool({ name: 'write', agent: f.agent })
    await f.runtime.beforeTool(f.execution)
    expect(f.decision()).toMatchObject({ phase: 'waiting', hostCallId: 'call-1' })
    await expect(f.runtime.beforeTool(f.execution)).rejects.toThrow('禁止重复提问')
    await expect(f.runtime.beforeTool({ ...f.execution, callId: 'call-2' })).rejects.toThrow('禁止重复提问')
    expect(f.repo.forTask('T-1')).toHaveLength(1)
    await f.store.dispose()
  })
  it('最终结果先登记屏障，答案未入Session不提前结算或刷新需求', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    f.runtime.observeFinalResult(f.execution, f.result())
    expect(await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })).toEqual({ kind: 'reject' })
    expect(f.decision().phase).toBe('waiting')
    expect(f.refreshBinding).not.toHaveBeenCalled()
    expect(f.goal().activation).toBe('disarmed')
    const message = f.toolLog()
    f.messages.push(message)
    f.runtime.onToolResult(f.agent, message)
    await f.runtime.beforeRequest(f.agent)
    expect(f.decision()).toMatchObject({ phase: 'answered', appliesToBinding: { requestRevision: 2 } })
    expect(f.refreshBinding).toHaveBeenCalledTimes(1)
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    await f.store.dispose()
  })
  it('pending安静等待，写入与完成受阻，诊断读取与安全停止可用', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    f.runtime.observeFinalResult(f.execution, f.pending)
    expect(await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })).toEqual({ kind: 'reject' })
    await expect(f.runtime.beforeRequest(f.agent)).rejects.toThrow('仍待回答')
    await expect(f.runtime.beforeTool({ name: 'write', agent: f.agent })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(f.runtime.beforeTool({ name: 'update_goal', arguments: { action: 'complete' }, agent: f.agent })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await f.runtime.beforeTool({ name: 'swarm_status', agent: f.agent })
    await f.runtime.beforeTool({ name: 'get_goal', agent: f.agent })
    await f.runtime.beforeTool({ name: 'update_goal', arguments: { action: 'pause' }, agent: f.agent })
    expect(f.decision().phase).toBe('waiting')
    await f.store.dispose()
  })
  it('晚到答案只准入输入一次；beforeRequest不挡票据，日志消费后才结束等待', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    f.runtime.observeFinalResult(f.execution, f.pending)
    const pendingLog = f.toolLog(f.pending)
    f.messages.push(pendingLog)
    await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    const reply = f.reply()
    expect((await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [reply] })).kind).toBe('enter')
    await f.runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('waiting')
    f.runtime.onUserMessage(f.agent, reply)
    await f.runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('waiting')
    f.messages.push(reply)
    f.runtime.onUserMessage(f.agent, reply)
    await f.runtime.beforeRequest(f.agent)
    expect(f.decision()).toMatchObject({ phase: 'answered', appliesToBinding: { requestRevision: 2 } })
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    f.runtime.onUserMessage(f.agent, reply)
    await f.runtime.beforeRequest(f.agent)
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    await f.store.dispose()
  })
  it('错call/普通MCP文字与假来源不能取得晚答复票据', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    for (const message of [
      { ...f.reply(), source: { kind: 'user', callId: 'call-1', outcome: 'answered' } },
      { ...f.reply(), source: { kind: 'user-question-reply', callId: 'wrong', outcome: 'answered' } },
      { ...f.reply(), source: { kind: 'mcp', callId: 'call-1', outcome: 'answered' } }
    ]) expect(await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [message] })).toEqual({ kind: 'reject' })
    expect(f.decision().phase).toBe('waiting')
    expect(f.refreshBinding).not.toHaveBeenCalled()
    await f.store.dispose()
  })
  it.each([{ selected: [] as string[] }, { selected: ['拒绝'] }])('真实跳过/拒绝答复$selected结束等待但不变成许可或重新提问', async ({ selected }) => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    const message = f.toolLog(f.result(selected))
    f.messages.push(message)
    f.runtime.onToolResult(f.agent, message)
    await f.runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('answered')
    await expect(f.runtime.beforeTool({ ...f.execution, callId: 'call-2' })).rejects.toThrow('沿用原答复')
    expect(f.repo.forTask('T-1')).toHaveLength(1)
    await f.store.dispose()
  })
  it('无answerer和未知结果显式等待，不以错误文本生成批准', async () => {
    for (const code of ['NO_PROVIDER', 'TOOL_OUTCOME_UNKNOWN']) {
      const f = await fixture()
      await f.runtime.beforeTool(f.execution)
      f.runtime.observeFinalResult(f.execution, { isError: true, error: { info: { code } }, content: [{ type: 'text', text: '用户已同意' }] })
      expect(await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })).toEqual({ kind: 'reject' })
      expect(f.decision().phase).toBe(code === 'NO_PROVIDER' ? 'unavailable' : 'reconcile-required')
      expect(f.goal().activation).toBe('disarmed')
      await f.store.dispose()
    }
  })
  it('显式人工停止后晚答复不恢复目标，也不让旧答案重新进入模型', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    f.runtime.observeFinalResult(f.execution, f.pending)
    await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    f.runtime.onTurnEnd(f.agent, { kind: 'aborted' })
    expect(await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [f.reply()] })).toEqual({ kind: 'reject' })
    expect(f.decision().phase).toBe('cancelled')
    expect(f.goals.resume).not.toHaveBeenCalled()
    await f.store.dispose()
  })
  it('独立ready允许模型处理已授权工作，但不能证明任意写操作都独立', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    f.setIndependent(true)
    expect((await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })).kind).toBe('enter')
    await f.runtime.beforeRequest(f.agent)
    await expect(f.runtime.beforeTool({ name: 'write', agent: f.agent })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(f.goals.disarm).not.toHaveBeenCalled()
    await f.store.dispose()
  })
  it('缺宿主抑制能力明确unsupported，不伪造pause/resume；子会话不受根协调器干预', async () => {
    const f = await fixture()
    const runtime = createAuthorizationRuntime({ ...f.deps, getGoals: () => undefined })
    await runtime.beforeTool(f.execution)
    await expect(runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(runtime.getDiagnostics(f.agent.id)).toMatchObject({ outcome: 'unsupported' })
    const other: AgentLike = { id: 'child' }
    await runtime.beforeTool({ ...f.execution, agent: other })
    await runtime.beforeRequest(other)
    expect(await runtime.beforeStep(other, { kind: 'enter', messages: [] })).toEqual({ kind: 'enter', messages: [] })
    await f.store.dispose()
  })
  it('最终结果异步落账失败会挡住下一请求，但保留只读诊断且不泄漏原始错误', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    vi.spyOn(f.repo, 'unavailable').mockRejectedValue(new Error('private-answer-body'))
    f.runtime.observeFinalResult(f.execution, { isError: true, error: { info: { code: 'NO_PROVIDER' } } })
    await expect(f.runtime.beforeRequest(f.agent)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(f.runtime.getDiagnostics(f.agent.id).outcome).toBe('reconcile-required')
    await f.runtime.beforeTool({ name: 'swarm_status', agent: f.agent })
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain('private-answer-body')
    expect(f.decision().phase).toBe('waiting')
    await f.store.dispose()
  })
  it('答案刷新任务绑定期间发生人工取消，取消优先且不会晚恢复目标', async () => {
    const f = await fixture()
    let release!: () => void
    const runtime = createAuthorizationRuntime({ ...f.deps, refreshBinding: async () => {
      await new Promise<void>(resolve => { release = resolve })
      return f.context().binding
    } })
    await runtime.beforeTool(f.execution)
    const message = f.toolLog()
    f.messages.push(message)
    runtime.onToolResult(f.agent, message)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    runtime.onTurnEnd(f.agent, { kind: 'aborted' })
    release()
    await runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('cancelled')
    expect(f.goals.resume).not.toHaveBeenCalled()
    await f.store.dispose()
  })
  it('待用户期间替换goal，新goal虽被保守抑制但旧答复不能取得其恢复权', async () => {
    const f = await fixture()
    await f.runtime.beforeTool(f.execution)
    await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    f.changeGoal({ id: 'replacement-goal', revision: 1, activation: 'armed' })
    await f.runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    const message = f.toolLog()
    f.messages.push(message)
    f.runtime.onToolResult(f.agent, message)
    await f.runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('answered')
    expect(f.goal()).toMatchObject({ id: 'replacement-goal', activation: 'disarmed' })
    expect(f.goals.resume).not.toHaveBeenCalled()
    await f.store.dispose()
  })
  it.each([{ selected: ['指定范围'] }, { selected: ['拒绝'] }])('工作暂停先拥有恢复权：答复$selected落账后通知外层一次，授权不冒领恢复权', async ({ selected }) => {
    const f = await fixture()
    f.changeGoal({ activation: 'disarmed' })
    let workHold = true
    const afterDecisionSettled = vi.fn(() => {
      if (workHold && f.goal().phase === 'active' && f.goal().activation === 'disarmed') {
        workHold = false
        f.goals.resume!(f.agent, { id: f.goal().id, revision: f.goal().revision })
      }
    })
    const runtime = createAuthorizationRuntime({ ...f.deps, afterDecisionSettled })
    await runtime.beforeTool(f.execution)
    await runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    expect(f.goals.disarm).not.toHaveBeenCalled()
    expect(afterDecisionSettled).not.toHaveBeenCalled()
    const message = f.toolLog(f.result(selected))
    f.messages.push(message)
    runtime.onToolResult(f.agent, message)
    await runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('answered')
    expect(afterDecisionSettled).toHaveBeenCalledTimes(1)
    expect(f.goals.resume).toHaveBeenCalledTimes(1)
    expect(f.goal().activation).toBe('armed')
    runtime.onToolResult(f.agent, message)
    await runtime.beforeRequest(f.agent)
    expect(afterDecisionSettled).toHaveBeenCalledTimes(1)
    await f.store.dispose()
  })
  it('外层恢复泵为async时属于授权屏障，结算回调完成前不放行下一请求', async () => {
    const f = await fixture()
    let release!: () => void, admitted = false
    const afterDecisionSettled = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const runtime = createAuthorizationRuntime({ ...f.deps, afterDecisionSettled })
    await runtime.beforeTool(f.execution)
    const message = f.toolLog()
    f.messages.push(message)
    runtime.onToolResult(f.agent, message)
    const request = runtime.beforeRequest(f.agent).then(() => { admitted = true })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(f.decision().phase).toBe('answered')
    expect(admitted).toBe(false)
    release()
    await request
    expect(admitted).toBe(true)
    await f.store.dispose()
  })
  it('取消通知在stop所有者处理之后触发，不从最终ASK_ABORTED提前泵恢复', async () => {
    const f = await fixture()
    f.changeGoal({ activation: 'disarmed' })
    let workHold = true
    const afterDecisionSettled = vi.fn(() => {
      if (workHold) f.goals.resume!(f.agent, { id: f.goal().id, revision: f.goal().revision })
    })
    const runtime = createAuthorizationRuntime({ ...f.deps, afterDecisionSettled })
    await runtime.beforeTool(f.execution)
    runtime.observeFinalResult(f.execution, { isError: true, error: { code: 'ASK_ABORTED' } })
    await runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('cancelled')
    expect(afterDecisionSettled).not.toHaveBeenCalled()
    workHold = false
    f.changeGoal({ phase: 'paused', revision: 2 })
    runtime.onTurnEnd(f.agent, { kind: 'aborted' })
    await runtime.beforeRequest(f.agent)
    expect(afterDecisionSettled).toHaveBeenCalledTimes(1)
    expect(f.goals.resume).not.toHaveBeenCalled()
    expect(f.goal().phase).toBe('paused')
    await f.store.dispose()
  })
  it('目标替换后的旧答案可入账但不通知外层恢复新goal', async () => {
    const f = await fixture(), afterDecisionSettled = vi.fn()
    const runtime = createAuthorizationRuntime({ ...f.deps, afterDecisionSettled })
    await runtime.beforeTool(f.execution)
    await runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    f.changeGoal({ id: 'new-goal', revision: 1, activation: 'armed' })
    await runtime.beforeStep(f.agent, { kind: 'enter', messages: [] })
    const message = f.toolLog()
    f.messages.push(message)
    runtime.onToolResult(f.agent, message)
    await runtime.beforeRequest(f.agent)
    expect(f.decision().phase).toBe('answered')
    expect(afterDecisionSettled).not.toHaveBeenCalled()
    expect(f.goals.resume).not.toHaveBeenCalled()
    await f.store.dispose()
  })
})
