/** Real DSH agents/subagents/tools; only model responses are deterministic fixtures. */
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'

export const name = 'swarm-upgrade-test-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents', 'agentSwarm']
export const UPGRADE_PROVIDER = 'swarm-upgrade-provider'
export const upgradeRoute = (model, accessMode = 'subscription') => ({ provider: UPGRADE_PROVIDER, model, reasoningEffort: 'high', policy: { accessMode } })

function* text(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function* tool(name, args) {
  const id = `upgrade_${randomUUID()}`
  const raw = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
const textOf = (message) => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const output = { summary: '0+0=0', unresolved: [], mode: 'verify', premises: ['整数加法以0为单位元'], invariants: ['加法单位元'],
  claims: [{ statement: '0+0=0', status: 'proved', proofOrCounterexample: '加法单位元a+0=a，取a=0', evidenceType: 'proof' }] }

export const apply = (ctx) => {
  const scenario = process.env.SWARM_UPGRADE_SCENARIO
  if (!scenario) return
  const state = { scenario, requests: [], results: [], retryEvents: [], childOutputSchema: undefined }
  let finished = false, rootStep = 0
  const finish = (status, extra = {}) => {
    if (finished) return
    finished = true
    writeFileSync(process.env.SWARM_UPGRADE_OUT, JSON.stringify({ status, ...state, ...extra }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 50)
  }
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'Upgrade routing fixture' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200000 },
      reasoning: { efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })), defaultEffort: 'high' } }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (options.purpose !== undefined) { yield* text('Upgrade fixture'); return }
      state.requests.push({ provider: options.provider, model: options.model, sessionId: options.sessionId })
      if (String(options.sessionId).startsWith('upgrade-host-')) {
        const last = options.messages?.at(-1)
        if (last?.role === 'tool') {
          const result = textOf(last)
          state.results.push({ isError: last.isError === true, text: result })
          state.taskId ??= /task_id: (T-\d+)/.exec(result)?.[1]
        }
        if (rootStep++ === 0) {
          yield* tool('swarm_task_card', { title: '升级兜底顺序', goal: '订阅可用时不提前调用按量API', acceptance: ['算衡验算提交0+0证明'], scope: [], flags: {},
            ...(scenario === 'root-base-go-ready' ? { upgrade: true } : {}) })
        } else if (scenario === 'root-base-go-ready') {
          yield* text('ROOT UPGRADE ROUTING DONE')
        } else if (rootStep === 2) {
          yield* tool('swarm_delegate', { task_id: state.taskId, role: 'suan_heng', mode: 'verify', backend: 'api', upgrade: true, session: 'new', prompt: '按整数单位元验证0+0=0，提交结构化验算结果' })
        } else yield* text('UPGRADE ROUTING DONE')
        return
      }
      if (scenario === 'base-go-fails' && options.model === 'go') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'pool "fixture-go" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 } } }
        return
      }
      const submit = options.tools?.find(schema => schema.name === 'structured_output')
      if (!submit) { yield* text('```json\n' + JSON.stringify(output) + '\n```'); return }
      state.childOutputSchema ??= submit.parameters
      yield* tool('structured_output', submit.parameters?.properties?.value ? { value: output } : output)
    }
  }
  ctx.llm.registerAdapter([UPGRADE_PROVIDER], adapter)
  ctx.on('session/event', (_session, event) => { if (event.type === 'llm/retry' || event.type === 'llm/retry-started') state.retryEvents.push(event.type) })
  setTimeout(() => { void (async () => {
    for (let n = 0; ; n++) {
      try { await ctx.agentPresets.resolve('tian-shu'); break } catch (error) { if (n > 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    if (scenario !== 'upgrade-subscription-ready') {
      for (const model of ['upgrade-codex', 'upgrade-claude']) await ctx.agentSwarm.routeState.ObserveRouteFailure(upgradeRoute(model), { code: 'POOL_EXHAUSTED', message: `pool "${model}" exhausted: every member is unavailable or failed` }, ctx.agentSwarm.getConfig())
    }
    const sessionId = `upgrade-host-${randomUUID()}`
    const handle = await ctx.agents.create({ sessionId, meta: { cwd: process.cwd(), agentPreset: 'tian-shu' }, agentOptions: { provider: UPGRADE_PROVIDER, model: 'root' },
      setup: async scope => { await ctx.agentPresets.mount(scope, 'tian-shu') } })
    handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'Verify subscription-before-fallback routing.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    finish('done', { sessionId })
  })().catch(error => finish('error', { error: String(error?.stack ?? error) })) }, 200)
  setTimeout(() => finish('timeout'), 25000).unref()
}
