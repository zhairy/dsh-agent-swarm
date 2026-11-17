/** 原生历史副本的新文本回合：所有工具受拒绝守卫、所有模型响应均来自本地确定性适配器。 */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const name = 'session-continue-proof'
export const inject = ['agents', 'agentPresets', 'llm', 'tools', 'sessions', 'agentSwarm']
export const apply = ctx => {
  const rootId = process.env.CONTINUE_ROOT_ID, childId = process.env.CONTINUE_CHILD_ID
  const state = { modelRequests: 0, auxiliaryModelRequests: 0, toolAttempts: 0, childStarts: 0, errors: [], stage: 'boot' }
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  let finished = false
  const finish = (status, error) => {
    if (finished) return
    finished = true
    writeFileSync(process.env.CONTINUE_OUT, JSON.stringify({ ...state, status, error: error?.message }, null, 2), { mode: 0o600 })
    setTimeout(() => process.exit(status === 'passed' ? 0 : 1), 40)
  }
  ctx.tools.guard(() => { state.toolAttempts++; return 'session continuation fixture refuses every tool' })
  ctx.on('subagent/start', () => { state.childStarts++ })
  ctx.on('agent/error', ({ error }) => { state.errors.push(error.message) })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id === rootId) agent.model.select({ provider: 'continue-proof', model: 'safe-text' })
  })
  ctx.llm.registerAdapter(['continue-proof'], {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 2_000_000 } }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (!options.purpose) state.modelRequests++
      else state.auxiliaryModelRequests++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SESSION_CONTINUE_FIXED' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  setTimeout(() => { void (async () => {
    const preset = process.env.CONTINUE_PRESET
    await ctx.agentPresets.resolve(preset)
    const scope = await ctx.agentPresets.acquireScope(preset)
    let handle
    try {
      state.stage = 'resume-original-identity'
      handle = await ctx.agents.resume({ resumeSessionId: rootId, agentOptions: { provider: 'continue-proof', model: 'safe-text' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) } })
      const before = handle.agent.session.deriveMessages()
      state.oldMessageCount = before.length
      state.oldMessageDigest = digest(before)
      const isMarker = message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === 'SESSION_CONTINUE_FIXED')
      assert.equal(before.some(isMarker), false)
      state.stage = 'recover-swarm-state'
      const child = await ctx.get('agentSwarm').getAgentViewForRpc(rootId, childId)
      // 原生冷读可依据已关闭回合把显示 phase 调整为 paused；这不解除暂停、
      // 副作用核验或写租约，也不是允许重放的证明。
      assert.ok(child.phase === 'recovery-required' || (child.phase === 'paused' && child.reason === 'host-confirmed-idle'))
      assert.equal(child.paused, true)
      assert.equal(child.needsSideEffectReview, true)
      state.workerControl = { phase: child.phase, reason: child.reason, paused: child.paused, needsSideEffectReview: child.needsSideEffectReview }
      state.oldWorkerFenced = true
      state.stage = 'safe-new-turn'
      handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Only reply SESSION_CONTINUE_FIXED. Do not execute or repeat any historical tool.' }], source: { kind: 'user' } })
      await handle.agent.whenIdle()
      assert.deepEqual(state.errors, [])
      assert.ok(state.modelRequests > 0)
      assert.equal(state.toolAttempts, 0)
      assert.equal(state.childStarts, 0)
      const after = handle.agent.session.deriveMessages()
      // deriveMessages 会重组活动视图；不可把其数组切片当成不可变日志身份。
      // runner 在 Host 退出后逐条核验压缩日志原始前缀，以此证明旧记录未改。
      assert.ok(after.some(isMarker))
      state.newMessageCount = after.length - state.oldMessageCount
      const afterControl = await ctx.get('agentSwarm').getAgentViewForRpc(rootId, childId)
      assert.equal(afterControl.paused, true)
      assert.equal(afterControl.needsSideEffectReview, true)
      assert.ok(['recovery-required', 'paused'].includes(afterControl.phase))
      state.workerStillFencedAfterTurn = true
      await ctx.sessions.flush(handle.agent.session)
    } finally {
      await handle?.dispose()
      await scope?.[Symbol.asyncDispose]?.()
    }
    finish('passed')
  })().catch(error => finish('failed', error)) }, 200)
  setTimeout(() => finish('timeout', new Error(`timeout at ${state.stage}`)), 45000).unref()
}
