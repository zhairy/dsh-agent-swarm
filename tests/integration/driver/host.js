// 集成测试驱动（只用于 .sandbox）：注册 mock LLM「swarm-mock」，在指定预设中创建会话并按场景脚本驱动，结果写入 SWARM_DRIVER_OUT
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { SCENARIOS } from './scenarios.js'

export const name = 'swarm-test-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents']

const VALID_OUTPUTS = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolChunks(name, args) {
  const id = `call_${randomUUID().slice(0, 8)}`
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

const getText = (message) => (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')

const getWriteArgs = (options, path, content) => {
  const schema = (options.tools ?? []).find((tool) => tool.name === 'write')
  const keys = Object.keys(schema?.parameters?.properties ?? {})
  const pathKey = keys.find((key) => /path|file/i.test(key)) ?? 'path'
  const contentKey = keys.find((key) => /content|text|data/i.test(key)) ?? 'content'
  return { [pathKey]: path, [contentKey]: content }
}

const getResolvedArgs = (value, state) => {
  if (typeof value === 'string') return value.replace('$TASK', state.taskId ?? 'T-1')
  if (Array.isArray(value)) return value.map((item) => getResolvedArgs(item, state))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getResolvedArgs(item, state)]))
  return value
}

const getModelRole = (model) => /^(?:role|writer|textonly|badjson)-([a-z_]+?)(?:-verify)?$/.exec(model)?.[1]

class MockAdapter {
  constructor(scenario, state) {
    this.scenario = scenario
    this.state = state
    this.rootStep = 0
    this.childSteps = new Map()
  }

  providerInfo(provider) { return { id: provider, name: 'Swarm Mock' } }
  providerRetryPolicy() { return undefined }
  imageRequestPricing() { return undefined }
  async listModels(provider) { return [] }

  async resolveModel(provider, model) {
    const vision = !model.startsWith('textonly')
    return { provider, id: model, name: model, inputModalities: vision ? ['text', 'image'] : ['text'], context: { contextWindow: 200000 } }
  }

  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) }
  }

  async *stream(options) {
    if (options.purpose !== undefined) {
      yield* textChunks('Swarm test')
      return
    }
    if (options.model === 'fail-quota') {
      this.state.failQuotaHits += 1
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'mock quota exhausted', status: 429 } } }
      return
    }
    const role = getModelRole(options.model)
    if (role === undefined) yield* this.streamRoot(options)
    else yield* this.streamChild(options, role)
  }

  *streamRoot(options) {
    const last = options.messages?.at(-1)
    if (this.rootStep === 0) this.state.rootTools = (options.tools ?? []).map((tool) => tool.name)
    const notices = (options.messages ?? []).filter((m) => m.role === 'user' && getText(m).includes('Background subagent'))
    this.state.rootNotices = Math.max(this.state.rootNotices ?? 0, notices.length)
    if (last?.role === 'tool') {
      const text = getText(last)
      this.state.results.push({ step: this.rootStep - 1, isError: last.isError === true, text })
      const match = /task_id: (T-\d+)/.exec(text)
      if (match !== null && this.state.taskId === undefined) this.state.taskId = match[1]
    }
    const action = this.scenario.root[this.rootStep++]
    if (action === undefined || action.text !== undefined) {
      yield* textChunks(action?.text ?? 'DONE')
      return
    }
    const args = action.write === undefined ? getResolvedArgs(action.args, this.state) : getWriteArgs(options, action.write.path, action.write.content)
    yield* toolChunks(action.tool, args)
  }

  *streamChild(options, role) {
    const key = String(options.sessionId)
    const step = this.childSteps.get(key) ?? 0
    this.childSteps.set(key, step + 1)
    const tools = (options.tools ?? []).map((tool) => tool.name)
    if (step === 0) {
      this.state.children.push({ role, model: options.model, tools, images: JSON.stringify(options.messages ?? []).includes('"type":"image"') })
    }
    if (options.model.startsWith('writer') && step === 0) {
      yield* toolChunks('write', getWriteArgs(options, 'hello.txt', 'hello swarm\n'))
      return
    }
    const output = options.model.endsWith('-verify') ? { ...VALID_OUTPUTS[role], mode: 'verify' } : VALID_OUTPUTS[role]
    if (tools.includes('structured_output') && step <= 1) {
      yield* toolChunks('structured_output', output)
      return
    }
    if (tools.includes('structured_output')) {
      yield* textChunks('CHILD DONE')
      return
    }
    // 连续会话没有 structured_output 工具：以 json 代码块回复；badjson- 模型第一次故意漏掉 json，验证修正重试
    const turn = (this.state.childTurns[key] = (this.state.childTurns[key] ?? 0) + 1)
    this.state.childMessages.push({ role, sessionId: key, turn, text: getText(options.messages?.filter((m) => m.role === 'user').at(-1)).slice(0, 200) })
    if (options.model.startsWith('badjson') && turn === 1) {
      yield* textChunks('完成了，但这里没有 json')
      return
    }
    yield* textChunks('完成。\n```json\n' + JSON.stringify(output) + '\n```')
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const apply = (ctx) => {
  const scenarioName = process.env.SWARM_SCENARIO
  if (scenarioName === undefined || scenarioName === '') return
  const out = process.env.SWARM_DRIVER_OUT
  const state = { scenario: scenarioName, results: [], children: [], rootTools: [], failQuotaHits: 0, childTurns: {}, childMessages: [], rootNotices: 0 }
  let finished = false
  const finish = (status, extra = {}) => {
    if (finished) return
    finished = true
    if (out) writeFileSync(out, JSON.stringify({ status, ...state, ...extra }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 100)
  }
  const scenario = SCENARIOS[scenarioName]
  if (scenario === undefined) {
    finish('unknown-scenario')
    return
  }
  ctx.llm.registerAdapter(['swarm-mock'], new MockAdapter(scenario, state))
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await ctx.agentPresets.resolve(scenario.preset)
        break
      } catch (error) {
        if (attempt > 75) throw error
        await sleep(200)
      }
    }
    const sessionId = `swarm-it-${randomUUID()}`
    const scope = await ctx.agentPresets.acquireScope(scenario.preset)
    try {
      const handle = await ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), agentPreset: scenario.preset },
        agentOptions: { provider: 'swarm-mock', model: process.env.SWARM_ROOT_MODEL ?? 'root' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, scenario.preset) }
      })
      state.sessionId = sessionId
      state.subagentProviders = ctx.subagents.list()
      handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'integration test' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      finish('done')
    } finally {
      await scope?.[Symbol.asyncDispose]?.()
    }
  }
  setTimeout(() => { run().catch((error) => finish('error', { error: String(error?.stack ?? error) })) }, 300)
  setTimeout(() => finish('timeout'), 150000)
}
