import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** The real Host owns sessions, cancellation, settlement, leases and request routing.
 * Only the model response is deterministic, including one genuinely cancellable hang. */
export const name = 'swarm-agent-control-integration'
export const inject = ['agentSwarm', 'llm', 'agents', 'agentPresets', 'subagents']
export const CONTROL_MODEL_CATALOG = [{ id: 'swarm-control-mock', name: '隔离测试供应商', models: ['hang', 'recovered', 'fail-pool', 'writer-hang', 'preferred', 'backup'].map((id) => ({ id, name: id, reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' } })) }]
const validOutputs = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))
function* tool (name, args) {
  const id = 'call_' + randomUUID().slice(0, 8); const raw = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
function* text (value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (test, message) => {
  for (let index = 0; index < 200; index++) { const value = await test(); if (value) return value; await delay(25) }
  throw new Error(message)
}
export const apply = (ctx) => {
  const browser = process.env.SWARM_AGENT_CONTROL_SCENARIO === 'browser-manual'
  const retryIsolated = process.env.SWARM_AGENT_CONTROL_SCENARIO === 'manual-retry-isolated'
  const isolated = retryIsolated || process.env.SWARM_AGENT_CONTROL_SCENARIO === 'manual-isolated'
  const restartSave = process.env.SWARM_AGENT_CONTROL_SCENARIO === 'restart-save'
  const restartLoad = process.env.SWARM_AGENT_CONTROL_SCENARIO === 'restart-load'
  const writer = process.env.SWARM_AGENT_CONTROL_SCENARIO === 'manual-writer'
  const longrun = process.env.SWARM_AGENT_CONTROL_SCENARIO === 'preferred-recovery'
  if (!browser && !isolated && !restartSave && !restartLoad && !writer && !longrun && process.env.SWARM_AGENT_CONTROL_SCENARIO !== 'manual-switch') return
  const state = { requests: [], ends: [], controls: [], writeCalls: [], writeResults: [], headerModels: [], selectionEvents: [] }
  let finished = false
  const finish = (status, error) => {
    if (finished) return
    finished = true
    writeFileSync(process.env.SWARM_DRIVER_OUT, JSON.stringify({ status, ...state, ...(error === undefined ? {} : { error: String(error.stack ?? error) }) }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 50)
  }
  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Agent control integration model' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => CONTROL_MODEL_CATALOG[0].models,
    resolveModel: async (provider, model) => ({ provider, ...(CONTROL_MODEL_CATALOG[0].models.find((item) => item.id === model) ?? { id: model, name: model }), inputModalities: ['text'], context: { contextWindow: 200000 } }),
    async prepareCall (provider, model) { return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) } },
    async *stream (options) {
      if (options.purpose !== undefined) { yield* text('Integration session'); return }
      // Parent-only background notices are outside the delegated child attempt assertions.
      if (options.model === 'root') { yield* text('Parent received child status'); return }
      if (state.verifyRootPicker && String(options.sessionId) === state.parentSessionId) {
        state.rootPickerRequest = { provider: options.provider, model: options.model, reasoningEffort: options.reasoningEffort }
        yield* text('ROOT PICKER VERIFIED')
        return
      }
      state.requests.push({ provider: options.provider, model: options.model, sessionId: String(options.sessionId), reasoningEffort: options.reasoningEffort })
      if (longrun) state.routing ??= []
      if (longrun) state.routing.push({ recovery: ctx.get('agentSwarm').routeState.getRecovery(String(options.sessionId)), child: ctx.get('agentSwarm').routeState.getChild(String(options.sessionId)), override: ctx.get('agentSwarm').routeState.getChildOverride(String(options.sessionId)), health: ctx.get('agentSwarm').routeState.getHealth() })
      if (longrun && options.model === 'preferred' && state.requests.length === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_REQUEST', status: 400, message: 'deterministic initial route failure' } } }
        return
      }
      if (longrun && options.model === 'backup') { await delay(5100); yield* tool('read', { file_path: 'README.md' }); return }
      if (longrun) state.realReadResult = (options.messages?.at(-1)?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
      if (writer && options.model === 'writer-hang' && state.requests.filter((item) => item.model === 'writer-hang').length === 1) {
        const properties = Object.keys((options.tools ?? []).find((item) => item.name === 'write')?.parameters?.properties ?? {})
        if (properties.length === 0) throw new Error('actual writer tool not available')
        yield* tool('write', { [properties.find((key) => /path|file/i.test(key)) ?? 'file_path']: 'hello.txt', [properties.find((key) => /content|text|data/i.test(key)) ?? 'content']: 'one controlled write\n' })
        return
      }
      if (options.model === 'fail-pool' && state.requests.filter((item) => item.model === 'fail-pool').length === 1) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER_ERROR', status: 503, message: 'pool "manual-control-test" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 } } }
        return
      }
      if (options.model === 'hang' || options.model === 'writer-hang') {
        await new Promise((resolve) => { if (options.signal.aborted) resolve(); else options.signal.addEventListener('abort', resolve, { once: true }) })
        return
      }
      if (writer && options.model === 'recovered' && state.requests.filter((item) => item.model === 'recovered').length === 1) { yield* tool('read', { file_path: 'hello.txt' }); return }
      if (writer) state.writerReadResult = (options.messages?.at(-1)?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
      yield* text('```json\n' + JSON.stringify(writer ? validOutputs.ji_feng : validOutputs.tan_wei) + '\n```')
    }
  }
  ctx.llm.registerAdapter(['swarm-control-mock'], adapter)
  ctx.on('subagent/end', (info) => state.ends.push({ id: info.id, stopReason: info.stopReason }))
  ctx.on('session/event', (session, event) => {
    if (session.header.parentSession !== state.parentSessionId) return
    if (event.type === 'request/header') state.headerModels.push(event.data.header.config.model)
    if (event.type === 'model/selection') state.selectionEvents.push(event.data)
    if (event.type === 'tool/call' && event.data.name === 'write') state.writeCalls.push({ callId: event.data.callId, arguments: event.data.arguments })
    if (event.type === 'tool/result' && state.writeCalls.some((item) => item.callId === event.data.message.toolCallId)) state.writeResults.push({ isError: event.data.message.isError === true })
  })
  ctx.on('agent/error', ({ error }) => { state.agentErrors ??= []; state.agentErrors.push({ message: String(error?.message ?? error), code: error?.code }) })
  const run = async () => {
    for (let index = 0; ; index++) { try { await ctx.agentPresets.resolve('tian-shu'); break } catch (error) { if (index > 100) throw error; await delay(50) } }
    if (restartSave || restartLoad) await until(() => ctx.get('sessionController'), 'real SessionController did not load')
    if (restartLoad) {
      const manifest = JSON.parse(readFileSync(process.env.SWARM_CONTROL_RESTART_MANIFEST, 'utf8'))
      const service = ctx.get('agentSwarm')
      state.parentSessionId = manifest.parentSessionId; state.childId = manifest.childId
      state.parentLiveBeforeView = ctx.agents.get(manifest.parentSessionId) !== undefined
      let view = await service.getAgentViewForRpc(manifest.parentSessionId, manifest.childId)
      view = view.control ?? view
      state.coldView = view
      state.parentLiveAfterView = ctx.agents.get(manifest.parentSessionId) !== undefined
      state.requestsAfterColdView = [...state.requests]
      await service.ControlAgentForRpc({ parentSessionId: manifest.parentSessionId, childId: manifest.childId, expectedRevision: view.revision, action: 'select', route: { provider: 'swarm-control-mock', model: 'recovered', reasoningEffort: 'max' } })
      state.parentLiveAfterSelect = ctx.agents.get(manifest.parentSessionId) !== undefined
      view = await service.getAgentViewForRpc(manifest.parentSessionId, manifest.childId); view = view.control ?? view
      state.continueReceipt = await service.ControlAgentForRpc({ parentSessionId: manifest.parentSessionId, childId: manifest.childId, expectedRevision: view.revision, action: 'continue', steering: '跨进程继续未完成的只读任务，不重放已完成操作' })
      state.restoredControl = await until(async () => { const raw = await service.getAgentViewForRpc(manifest.parentSessionId, manifest.childId); const current = raw.control ?? raw; return current.phase === 'idle' && current.actual?.route?.model === 'recovered' && state.requests.some((item) => item.sessionId === manifest.childId && item.model === 'recovered') ? current : undefined }, 'cold same-child continuation did not become an actual successful call')
      await service.dispose()
      finish('done')
      return
    }
    const scope = await ctx.agentPresets.acquireScope('tian-shu')
    const handle = await ctx.agents.create({ sessionId: 'agent-control-it-' + randomUUID(), meta: { cwd: process.cwd(), agentPreset: 'tian-shu' }, agentOptions: { provider: 'swarm-control-mock', model: 'root' }, setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, 'tian-shu') } })
    try {
      const service = ctx.get('agentSwarm')
      const exec = { agent: handle.agent, signal: new AbortController().signal }
      if (restartSave) {
        handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '只读检查 README.md，验证持久专家恢复' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      state.parentSessionId = handle.agent.id
      const card = await service.AddTaskCard({ title: writer ? '人工恢复真实写入' : '人工恢复只读探索', goal: writer ? '只写 hello.txt 一次，核对中断与继续不会重复已完成写入' : '检查 README.md，核对模型切换与取消不会伪造任务成功', acceptance: [writer ? '真实写入一次且继续后没有重放' : '提交有依据的探索报告'], scope: [writer ? 'hello.txt' : 'README.md'], flags: writer ? { changesCode: true } : {} }, exec)
      state.taskId = card.task_id
      const delegated = service.delegate({ task_id: card.task_id, role: writer ? 'ji_feng' : 'tan_wei', session: 'new', backend: 'api', prompt: writer ? '只写 hello.txt 一次，再核对；已完成的写入不要重放' : '只读检查 README.md' }, exec)
      delegated.catch(() => undefined)
      const initialModel = longrun ? 'preferred' : writer ? 'writer-hang' : isolated ? 'fail-pool' : 'hang'
      const nextModel = retryIsolated ? 'fail-pool' : 'recovered'
      const first = await until(() => state.requests.find((item) => item.model === initialModel), 'the real child attempt did not start')
      const childId = first.sessionId
      state.childId = childId
      const read = async () => { const view = await service.getAgentViewForRpc(handle.agent.id, childId); return view.control ?? view }
      if (longrun) {
        state.firstDelegation = await delegated
        state.manualOverride = service.routeState.getChildOverride(childId)
        state.controls.push(await read())
        // Use the real Host's validated explicit-selection event, independent of
        // its automatic request/header updates. No synthetic Agent is created.
        state.verifyRootPicker = true
        handle.agent.session.append('model/selection', { provider: 'swarm-control-mock', model: 'recovered', reasoningEffort: 'max' })
        state.rootHumanPreference = service.routeState.getRootPreference(handle.agent.id)
        handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: '用当前人工选择的模型回复一个简短确认' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        finish('done')
        return
      }
      let view = await until(async () => { const item = await read(); return item.actual?.attemptId ? item : undefined }, 'no actual attempt observation')
      state.controls.push(view)
      if (writer) {
        await until(() => state.requests.filter((item) => item.model === 'writer-hang').length >= 2, 'real write did not reach the following hanging model call')
        view = await read()
        state.fileBeforeStop = readFileSync('hello.txt', 'utf8')
        state.writerRiskBeforeStop = view.needsSideEffectReview
      }
      if (browser) {
        const { serveAgentControlPreview } = await import('./agent-control-preview.js')
        await serveAgentControlPreview({ service, parentSessionId: handle.agent.id, childId, state })
        return
      }
      if (isolated) { state.firstDelegation = await delegated; view = await until(async () => { const item = await read(); return item.phase === 'paused' ? item : undefined }, 'a real failed child did not expose direct paused recovery') }
      await service.ControlAgentForRpc({ parentSessionId: handle.agent.id, childId, expectedRevision: view.revision, action: 'select', route: { provider: 'swarm-control-mock', model: nextModel, reasoningEffort: 'max' }, interruptRunning: !isolated, ...(retryIsolated ? { retryRoute: true, forceRetry: true } : {}) })
      state.firstDelegation = await delegated
      view = await until(async () => { const item = await read(); return item.phase === 'paused' ? item : undefined }, 'interrupt receipt incorrectly failed to reach real host settlement')
      state.controls.push(view)
      state.requestsBeforeContinue = [...state.requests]
      if (writer) {
        try { await service.ControlAgentForRpc({ parentSessionId: handle.agent.id, childId, expectedRevision: view.revision, action: 'continue' }) }
        catch (error) { state.noConfirmationRefusal = { code: error.code, message: error.message } }
        state.requestsAfterRefusal = [...state.requests]
        view = await read()
      }
      if (restartSave) {
        const manifest = { parentSessionId: handle.agent.id, childId, taskId: card.task_id }
        await ctx.subagents.drainContinuableChildren(handle.agent, [childId])
        await handle.agent.whenIdle()
        await service.dispose()
        await handle.dispose()
        if (ctx.get('sessionController') === undefined) throw new Error('the actual public SessionController must be composed for restart integration')
        state.persistedChild = await ctx.get('sessionController').inspect(childId)
        state.persistedParent = await ctx.get('sessionController').inspect(handle.agent.id)
        writeFileSync(process.env.SWARM_CONTROL_RESTART_MANIFEST, JSON.stringify(manifest))
        finish('done')
        return
      }
      state.continueReceipt = await service.ControlAgentForRpc({ parentSessionId: handle.agent.id, childId, expectedRevision: view.revision, action: 'continue', steering: writer ? '真实写入已完成，仅read当前 hello.txt核对，不重做write' : '继续未完成的只读探索，保留当前任务合同', ...(writer ? { confirmSafeToContinue: true } : {}) })
      await until(() => state.requests.length >= 2 && state.requests.at(-1)?.model === nextModel, 'manual route did not become an actual model request')
      view = await until(async () => { const item = await read(); return item.phase === 'idle' && item.actual?.route?.model === nextModel && item.actual?.delegationId !== state.controls[0].delegationId ? item : undefined }, 'resumed real child did not settle on selected model')
      state.controls.push(view)
      state.statusAfterContinue = service.getStatus({ task_id: card.task_id, verbose: true }, exec)
      state.healthAfterContinue = service.routeState.getHealth()
      if (writer) { state.fileAfterContinue = readFileSync('hello.txt', 'utf8'); finish('done'); return }
      const second = await service.AddTaskCard({ title: '后续只读任务', goal: '复用同一专家会话并保留用户模型选择', acceptance: ['提交探索报告'], scope: ['README.md'], flags: {} }, exec)
      state.secondDelegation = await service.delegate({ task_id: second.task_id, role: 'tan_wei', session: 'continue', backend: 'api', prompt: '继续只读核对 README.md' }, exec)
      state.controls.push(await read())
      finish('done')
    } finally { await handle.dispose(); await scope?.[Symbol.asyncDispose]?.() }
  }
  setTimeout(() => run().catch((error) => finish('error', error)), 300)
  setTimeout(() => finish('timeout', 'Host integration deadline exceeded'), browser ? 900000 : 25000)
}
