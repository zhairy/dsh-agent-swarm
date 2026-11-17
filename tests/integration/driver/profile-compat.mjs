/** 真实 Host 组合回归：确定性文本，无外部 provider、工具重放或真实历史。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const name = 'profile-compat-proof'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents', 'agentTeams', 'tools', 'sessions']
export const apply = ctx => {
  const state = { checks: [], requests: [], errors: [], stage: 'boot' }
  const expectedModels = new Map()
  let finished = false
  const finish = (status, error) => {
    if (finished) return
    finished = true
    writeFileSync(process.env.PROFILE_COMPAT_OUT, JSON.stringify({ ...state, status, error: error?.stack }, null, 2), { mode: 0o600 })
    setTimeout(() => process.exit(status === 'passed' ? 0 : 1), 40)
  }
  ctx.on('agent/error', ({ error }) => state.errors.push(String(error?.stack ?? error)))
  const denial = (agent, name, args = {}) => {
    const result = ctx.tools.checkGuards({ agent, name, arguments: args, signal: new AbortController().signal })
    if (result !== undefined) {
      assert.equal(typeof result.then, 'undefined', 'ToolGuard denial must be synchronous')
      assert.equal(typeof result.reason, 'string')
    }
    return result
  }
  ctx.llm.registerAdapter(['profile-proof'], {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined, listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200000 } }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (!options.purpose) {
        const agent = ctx.agents.get(options.sessionId)
        const names = ctx.subagents.namesOf(agent)
        state.requests.push({ sessionId: options.sessionId, provider: options.provider, model: options.model, name: names.self })
        if (expectedModels.has(options.sessionId)) {
          assert.equal(options.provider, 'profile-proof')
          assert.equal(options.model, expectedModels.get(options.sessionId))
        }
        if (names.self === 'doublechecker-1') {
          assert.equal(options.model, 'proof-routed')
          assert.equal(options.tools?.some(tool => tool.name === 'web_fetch'), false)
          assert.ok(denial(agent, 'bash', { command: 'curl https://example.invalid' }))
          assert.ok(denial(agent, 'send_message', { agent: 'explorer-1' }))
          assert.equal(denial(agent, 'send_message', { agent: 'lead' }), undefined)
          assert.ok(denial(agent, 'subagent', { name: 'explorer-2' }))
          state.checks.push('native-child-routed-and-synchronous-guards')
        }
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'PROFILE_COMPAT_OK' } }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })
  const turn = async agent => {
    const before = state.requests.filter(request => request.sessionId === agent.id).length
    agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Reply PROFILE_COMPAT_OK without tools' }], source: { kind: 'user' } })
    await agent.whenIdle()
    assert.equal(state.errors.length, 0, state.errors.join('\n'))
    assert.ok(state.requests.filter(request => request.sessionId === agent.id).length > before)
    assert.ok(agent.session.deriveMessages().some(message => message.role === 'assistant'))
  }
  const runPreset = async preset => {
    state.stage = `create:${preset}`
    await ctx.agentPresets.resolve(preset)
    const scope = await ctx.agentPresets.acquireScope(preset)
    let handle
    try {
      const id = `profile-proof-${randomUUID()}`
      expectedModels.set(id, 'inherited')
      const setup = async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) }
      handle = await ctx.agents.create({ sessionId: id, meta: { cwd: process.cwd(), agentPreset: preset }, setup, agentOptions: { provider: 'profile-proof', model: 'inherited' } })
      assert.equal(ctx.agentTeams.isEnabled(handle.agent), false)
      await turn(handle.agent)
      const before = JSON.stringify(handle.agent.session.deriveMessages())
      await handle.dispose()
      state.stage = `resume:${preset}`
      handle = await ctx.agents.resume({ resumeSessionId: id, setup, agentOptions: { provider: 'profile-proof', model: 'inherited' } })
      assert.equal(JSON.stringify(handle.agent.session.deriveMessages()), before)
      await turn(handle.agent)
      state.checks.push(`${preset}:create-persist-resume-unchanged-history`)
      if (preset === 'rigorquant') {
        state.stage = 'rigorquant:native-team'
        await ctx.agentTeams.setEnabled(handle.agent, true)
        expectedModels.set(id, 'root-routed')
        await turn(handle.agent)
        assert.ok(denial(handle.agent, 'subagent_fork', {}))
        assert.equal(denial(handle.agent, 'subagent', { name: 'doublechecker-1' }), undefined)
        const activation = await ctx.subagents.startActivation({ parent: handle.agent, provider: 'spawn', name: 'doublechecker-1', label: 'isolated proof', prompt: [{ type: 'text', text: 'Reply PROFILE_COMPAT_OK without tools' }], delivery: 'caller', signal: new AbortController().signal })
        try { await activation.result } finally { await activation.dispose() }
        assert.equal(state.errors.length, 0, state.errors.join('\n'))
        assert.ok(state.checks.includes('native-child-routed-and-synchronous-guards'))
        assert.ok(denial(handle.agent, 'send_message', { agent: 'doublechecker-1' }))
        state.checks.push('native-lead-fresh-role-reuse-denied')
        await ctx.agentTeams.setEnabled(handle.agent, false)
        // 原生模型选择会记住上次有效路由；关闭 Team 后应尊重之后的人工选择。
        handle.agent.model.select({ provider: 'profile-proof', model: 'off-selected' })
        expectedModels.set(id, 'off-selected')
        await turn(handle.agent)
        assert.equal(denial(handle.agent, 'read', { path: 'synthetic.txt' }), undefined)
        state.checks.push('native-lead-mode-off-disarms-and-inherits-model')
      }
    } finally {
      await handle?.dispose()
      await scope?.[Symbol.asyncDispose]?.()
    }
  }
  setTimeout(() => { void (async () => {
    // 等 bundle 完成注册，避免把组合装载时序当作兼容失败。
    for (let attempt = 0; ; attempt++) {
      try { await ctx.agentPresets.resolve('rigorquant'); await ctx.agentPresets.resolve('tian-shu'); break }
      catch (error) { if (attempt >= 60) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    for (const preset of ['standard', 'tian-shu', 'rigorquant']) await runPreset(preset)
    assert.equal(state.errors.length, 0)
    finish('passed')
  })().catch(error => finish('failed', error)) }, 150)
  setTimeout(() => finish('timeout', new Error(`timeout at ${state.stage}`)), 45000).unref()
}
