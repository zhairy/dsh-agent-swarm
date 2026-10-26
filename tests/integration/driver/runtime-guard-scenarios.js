import { randomUUID, createHash } from 'node:crypto'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

export const name = 'swarm-auth-313-host'
export const inject = ['agentSwarm', 'llm', 'agents', 'agentPresets', 'goals', 'userQuestions', 'sessionProjections']
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (value, reason) => { if (!value) throw new Error(reason) }
const questions = [{ id: 'scope', question: '隔离验收请选择只读维护范围。', options: [{ label: '仅此隔离范围' }, { label: '拒绝' }] }]
function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function* ask() {
  const id = 'call_auth_' + randomUUID().slice(0, 8), args = JSON.stringify({ questions, timeout: 1 })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name: 'ask_user_question', argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'ask_user_question', arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
export const apply = ctx => {
  const directory = process.env.SWARM_AUTH_EVIDENCE_DIR
  mkdirSync(directory, { recursive: true })
  const waitMs = Number(process.env.SWARM_AUTH_WAIT_MS ?? 300000)
  const state = { hostVersion: '0.2.1-rc.3', provider: 'deterministic-local-fixture', requestedWaitMs: waitMs, sessions: {}, errors: [], startedAt: new Date().toISOString() }
  const handles = [], scopes = [], byId = new Map()
  let finished = false
  const save = phase => writeFileSync(join(directory, 'host-auth-live.json'), JSON.stringify({ ...state, phase }, null, 2))
  const finish = (status, error) => {
    if (finished) return
    finished = true
    writeFileSync(join(directory, 'host-auth-result.json'), JSON.stringify({ ...state, status, finishedAt: new Date().toISOString(), ...(error ? { error: String(error.stack ?? error) } : {}) }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 100)
  }
  const until = async (test, reason, timeout = 15000) => {
    const start = Date.now()
    while (Date.now() - start < timeout) { const result = await test(); if (result) return result; await delay(25) }
    throw new Error(reason)
  }
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'isolated authorization fixture' }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined,
    listModels: async () => [{ id: 'root', name: 'root', inputModalities: ['text'] }],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200000 } }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (options.purpose !== undefined) { yield* text('isolated fixture'); return }
      const current = byId.get(String(options.sessionId))
      if (!current) throw new Error('unregistered fixture session')
      current.requests.push({ at: Date.now(), model: options.model, provider: options.provider })
      if (current.requests.length === 1) { current.timedSchema = (options.tools ?? []).find(tool => tool.name === 'ask_user_question')?.parameters?.properties?.timeout !== undefined; yield* ask(); return }
      yield* text('实际答复输入已接纳；测试不执行文件写入、网络请求或目标完成。')
    }
  }
  ctx.llm.registerAdapter(['swarm-auth-313-mock'], adapter)
  ctx.on('user-questions/request', async (request, next) => {
    const current = byId.get(request.agent?.id)
    if (!current) return next()
    current.questionRequests++
    if (current.kind === 'inline-answer') return { answers: request.questions.map(question => ({ id: question.id, selected: ['仅此隔离范围'] })) }
    if (current.kind === 'no-answerer') return next()
    return new Promise((resolve, reject) => {
      if (request.signal?.aborted) reject(request.signal.reason)
      else request.signal?.addEventListener('abort', () => reject(request.signal.reason), { once: true })
    })
  }, { prepend: true })
  ctx.on('session/event', (session, event) => {
    const current = byId.get(session.id)
    if (!current) return
    current.events.push({ seq: event.seq, type: event.type, ...(event.type === 'goal/change' ? { operation: event.data.operation, phase: event.data.goal?.phase } : {}),
      ...(event.type === 'turn/end' ? { reason: event.data.reason.kind } : {}) })
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') current.callId = event.data.callId
    if (event.type === 'tool/result' && event.data.message.toolCallId === current.callId) {
      const raw = event.data.message.content?.find(block => block.type === 'text')?.text
      let parsed
      try { parsed = JSON.parse(raw) } catch { parsed = undefined }
      current.questionResult = { isError: event.data.message.isError === true, pending: parsed?.pending === true, answerBatch: Array.isArray(parsed?.answers), callId: parsed?.callId }
    }
  })
  ctx.on('agent/error', ({ agent, error }) => {
    const current = byId.get(agent.id)
    const detail = { sessionId: agent.id, code: error?.code, message: String(error?.message ?? error).slice(0, 1000) }
    state.errors.push(detail)
    if (current) current.errors.push(detail)
  })
  ctx.on('goal/changed', ({ agent, change }) => {
    const current = byId.get(agent.id)
    if (current) current.goalChanges.push({ operation: change.operation, id: change.goal?.id, revision: change.goal?.revision, phase: change.goal?.phase, activation: change.goal?.activation })
  })
  const create = async (kind, stopDuringQuestion = false) => {
    const scope = await ctx.agentPresets.acquireScope('tian-shu'); scopes.push(scope)
    const handle = await ctx.agents.create({ sessionId: 'auth-313-' + kind + '-' + randomUUID(), meta: { cwd: process.cwd(), agentPreset: 'tian-shu' },
      agentOptions: { provider: 'swarm-auth-313-mock', model: 'root' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'tian-shu') } })
    handles.push(handle)
    const current = { kind, sessionId: handle.agent.id, requests: [], questionRequests: 0, events: [], errors: [], goalChanges: [] }
    byId.set(handle.agent.id, current); state.sessions[kind] = current
    const exec = { agent: handle.agent, signal: new AbortController().signal }
    const card = await ctx.get('agentSwarm').AddTaskCard({ title: '隔离授权验收 ' + kind, goal: '验证真实宿主等待和来源，不实施业务', acceptance: ['pending不批准，晚答复可追溯'], scope: ['README.md'], flags: {} }, exec)
    current.taskId = card.task_id
    ctx.goals.create(handle.agent, { objective: '隔离授权验收 ' + kind, maxGoalRounds: 100 })
    if (kind === 'inline-answer') {
      await until(() => current.questionResult?.answerBatch === true && current.requests.length >= 2, 'synchronous answer did not settle through actual tool/result')
      await handle.agent.whenIdle()
      ctx.goals.disarm(handle.agent)
      current.inlineResult = { requests: current.requests.length, goal: ctx.goals.get(handle.agent), requestRevision: ctx.get('agentSwarm').getStatus({ task_id: current.taskId }, exec).tasks?.[0]?.requestRevision }
      return { handle, current, exec }
    }
    if (stopDuringQuestion) {
      await until(() => current.questionRequests > 0 && current.callId && handle.agent.status === 'running', 'blocking ask did not become cancellable')
      handle.agent.cancel({ kind: 'user' })
      await handle.agent.whenIdle(); await delay(200)
      current.waitBaseline = { requests: current.requests.length, goal: ctx.goals.get(handle.agent), at: Date.now() }
      return { handle, current, exec }
    }
    await until(() => current.questionResult?.pending === true, 'actual timed ask did not return pending for ' + kind)
    await handle.agent.whenIdle()
    await delay(150)
    current.waitBaseline = { requests: current.requests.length, goal: ctx.goals.get(handle.agent), at: Date.now() }
    assert(current.timedSchema, 'actual ask schema is not timed')
    assert(current.waitBaseline.goal.phase === 'active' && current.waitBaseline.goal.activation === 'disarmed', 'pending goal did not stay active/disarmed: ' + JSON.stringify(current.waitBaseline.goal))
    return { handle, current, exec }
  }
  const answer = async item => {
    const { handle, current } = item
    const payload = { answers: [{ id: 'scope', selected: ['仅此隔离范围'] }] }
    current.answerAccepted = ctx.userQuestions.answer(handle.agent, current.callId, payload)
    try { current.duplicateReplyAccepted = ctx.userQuestions.answer(handle.agent, current.callId, payload) } catch (error) { current.duplicateReplyError = error.code ?? error.name }
    await until(() => handle.agent.session.deriveMessages().some(message => message.source.kind === 'user-question-reply' && message.source.callId === current.callId), 'actual late answer did not enter Session for ' + current.kind)
    await until(() => current.requests.length > current.waitBaseline.requests, 'late answer did not reach one actual model request for ' + current.kind)
    await handle.agent.whenIdle()
    await delay(100)
    const status = ctx.get('agentSwarm').getStatus({ task_id: current.taskId }, item.exec).tasks?.[0]
    current.afterAnswer = { goal: ctx.goals.get(handle.agent), requests: current.requests.length,
      status: status && { task_id: status.task_id, cardRevision: status.cardRevision, workflowRevision: status.workflowRevision, requestRevision: status.requestRevision, intentSource: status.intentSource } }
    // Stop the deterministic post-answer fixture from requesting unrelated autonomous rounds.
    ctx.goals.disarm(handle.agent)
  }
  const run = async () => {
    await until(async () => { try { await ctx.agentPresets.resolve('tian-shu'); return true } catch { return false } }, 'preset not ready')
    const main = await create('five-minute-pending')
    save('five-minute-observation')
    const start = performance.now()
    while (performance.now() - start < waitMs) {
      await delay(Math.min(5000, waitMs - (performance.now() - start)))
      const current = main.current, goal = ctx.goals.get(main.handle.agent)
      assert(current.requests.length === current.waitBaseline.requests, 'model requests grew while pending')
      assert(goal.roundsStarted === current.waitBaseline.goal.roundsStarted, 'goal rounds grew while pending')
      assert(goal.phase === 'active' && goal.activation === 'disarmed', 'pending mutated durable goal phase')
      current.observedMs = Math.floor(performance.now() - start)
      save('five-minute-observation')
    }
    main.current.waitFinal = { requests: main.current.requests.length, goal: ctx.goals.get(main.handle.agent), observedMs: performance.now() - start, at: Date.now() }
    // Deliberately wrong Host source/call identity must not release the original pending decision.
    main.handle.agent.steer(Object.freeze({ id: randomUUID(), role: 'user', source: { kind: 'user-question-reply', callId: 'wrong-fixture-call', outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId: 'wrong-fixture-call', questions, answers: [{ id: 'scope', selected: ['仅此隔离范围'] }] }) }] }))
    await main.handle.agent.whenIdle(); await delay(100)
    main.current.afterWrongSource = { requests: main.current.requests.length, goal: ctx.goals.get(main.handle.agent) }
    assert(main.current.afterWrongSource.requests === main.current.waitBaseline.requests, 'wrong-source answer released a model request')
    await answer(main)
    assert(main.current.answerAccepted, 'late answer not accepted')
    assert(main.current.goalChanges.filter(change => change.operation === 'resume').length === 1, 'owned pending goal was not resumed exactly once')
    const paused = await create('manual-paused')
    const beforePause = ctx.goals.get(paused.handle.agent)
    ctx.goals.pause(paused.handle.agent, { id: beforePause.id, revision: beforePause.revision })
    await answer(paused)
    assert(paused.current.afterAnswer.goal.phase === 'paused', 'late answer resumed a manually paused goal')
    assert(paused.current.goalChanges.filter(change => change.operation === 'resume').length === 0, 'manual pause gained resume')
    const replaced = await create('replaced-goal')
    const old = ctx.goals.get(replaced.handle.agent)
    ctx.goals.clear(replaced.handle.agent, { id: old.id, revision: old.revision })
    ctx.goals.create(replaced.handle.agent, { objective: '替换后的隔离目标，不得由旧回答恢复', maxGoalRounds: 100 })
    await replaced.handle.agent.whenIdle(); await delay(100)
    await answer(replaced)
    assert(replaced.current.afterAnswer.goal.id !== old.id, 'replacement goal did not change identity')
    assert(replaced.current.goalChanges.filter(change => change.operation === 'resume').length === 0, 'old answer resumed replacement goal')
    const stopped = await create('manual-stopped', true)
    stopped.current.answerAfterStop = ctx.userQuestions.answer(stopped.handle.agent, stopped.current.callId, { answers: [{ id: 'scope', selected: ['仅此隔离范围'] }] })
    await delay(200)
    stopped.current.afterStop = { requests: stopped.current.requests.length, goal: ctx.goals.get(stopped.handle.agent) }
    assert(stopped.current.answerAfterStop === false, 'stopped question still accepted a late answer')
    assert(stopped.current.afterStop.requests === stopped.current.waitBaseline.requests, 'manual stop restarted model requests')
    assert(stopped.current.goalChanges.filter(change => change.operation === 'resume').length === 0, 'manual stop gained resume')
    const absent = await create('no-answerer')
    await delay(1200)
    absent.current.noAnswererStable = { requests: absent.current.requests.length, goal: ctx.goals.get(absent.handle.agent) }
    assert(absent.current.noAnswererStable.requests === absent.current.waitBaseline.requests, 'missing answerer caused model loop')
    const inline = await create('inline-answer')
    assert(inline.current.inlineResult.requestRevision === 2, 'synchronous answer did not refresh and bind the real request revision')
    for (const handle of handles) await handle.dispose()
    await ctx.get('agentSwarm').dispose()
    const plugin = resolve(process.env.SWARM_AUTH_PLUGIN)
    const { createDurableStateStore } = await import(join(plugin, 'lib/state-store.js'))
    const { SWARM_LAYOUT_OPTIONS } = await import(join(plugin, 'lib/state-chunks.js'))
    const { inspectFeatureState } = await import(join(plugin, 'lib/feature-session.js'))
    const { getWorkspaceId } = await import(join(plugin, 'lib/artifacts.js'))
    const workspaceId = await getWorkspaceId(process.cwd())
    for (const current of Object.values(state.sessions)) {
      const hash = createHash('sha256').update(JSON.stringify(current.sessionId)).digest('hex')
      const scope = { rootSessionId: current.sessionId, workspaceId }
      const initialState = { schemaVersion: 2, tasks: [], delegations: [], threads: [], budgets: {}, contexts: [], bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {}, runtimeControls: {}, progressHistory: {}, authorizationDecisions: {} }
      const store = await createDurableStateStore({ directory: join(process.env.SWARM_AUTH_STATE, workspaceId, hash), initialState, ...SWARM_LAYOUT_OPTIONS, validate: raw => inspectFeatureState(raw, scope) })
      const records = Object.values(store.read().authorizationDecisions)
      current.persistedDecisions = records.map(value => ({ phase: value.phase, hostCallId: value.hostCallId, questionBinding: value.questionBinding,
        appliesToBinding: value.appliesToBinding, answerOrigin: value.answerOrigin, answers: value.answers }))
      await store.dispose()
      if (current.kind === 'manual-stopped') assert(records.length === 1 && records[0].phase === 'cancelled', 'user stop did not persist cancellation')
      else if (current.kind !== 'no-answerer') assert(records.length === 1 && records[0].phase === 'answered', 'real Session reply did not persist answered for ' + current.kind)
      else assert(records.length === 1 && ['waiting', 'reconcile-required', 'unavailable'].includes(records[0].phase), 'missing answerer manufactured a grant')
    }
    assert(state.errors.length === 0, 'actual Host emitted unexpected Agent errors')
    finish('done')
  }
  setTimeout(() => run().catch(error => finish('error', error)), 300)
  setTimeout(() => finish('timeout', new Error('isolated Host observation exceeded deadline')), waitMs + 90000)
}
