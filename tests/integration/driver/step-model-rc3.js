import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
export const name = 'step-model-rc3-driver'
export const inject = ['llm', 'agents', 'tools', 'systemPrompt']
export const apply = ctx => {
  const state = { requests: [], assemblies: [], resolutions: [], executions: 0, errors: [] }
  let selected = 'primary', finished = false
  const finish = status => {
    if (finished) return
    finished = true
    writeFileSync(process.env.STEP_OUT, JSON.stringify({ ...state, status }, null, 2))
    setTimeout(() => process.exit(0), 50)
  }
  const text = function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  ctx.tools.register({ name: 'step_once', description: 'Count durable tool execution', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { state.executions++; return 'executed-once' }
  }, { when: ({ modelSelection }) => { state.resolutions.push(modelSelection.model); return modelSelection.model === 'primary' } })
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    state.assemblies.push(context.modelSelection.model)
    const result = await next()
    return { ...result, sections: [...result.sections, { name: 'step-marker', text: `STEP_MODEL_${context.modelSelection.model}`, interpolate: false }] }
  })
  ctx.on('agent/swarm-model-select', async (_payload, next) => ({ ...await next(), model: selected }))
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), model: selected }))
  ctx.on('agent/request-error', async () => { selected = 'backup'; return { kind: 'retry' } })
  ctx.on('agent/error', payload => { state.errors.push(String(payload.error?.stack ?? payload.error ?? payload)) })
  ctx.llm.registerAdapter(['step-fixture'], {
    providerInfo: id => ({ id, name: id }), providerRetryPolicy: () => undefined, imageRequestPricing: () => undefined, listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200000 } }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (options.purpose !== undefined) { yield* text(); return }
      state.requests.push({ model: options.model, tools: options.tools?.map(t => t.name), prompt: JSON.stringify(options), messages: options.messages })
      if (state.requests.length === 1) {
        const raw = '{}'
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'step-once-id', name: 'step_once', arguments: raw } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else if (options.model === 'primary') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'deterministic primary failure' } } }
      } else yield* text()
    }
  })
  setTimeout(() => { void (async () => {
    const handle = await ctx.agents.create({ sessionId: `step-${randomUUID()}`, meta: { cwd: process.cwd() }, agentOptions: { provider: 'step-fixture', model: process.env.STEP_INITIAL ?? 'primary' } })
    handle.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Execute once then recover' }], source: { kind: 'user' } })
    await handle.agent.whenIdle()
    state.messages = handle.agent.session.deriveMessages()
    finish('done')
  })().catch(error => { state.errors.push(String(error.stack)); finish('error') }) }, 200)
  setTimeout(() => finish('timeout'), 15000).unref()
}
