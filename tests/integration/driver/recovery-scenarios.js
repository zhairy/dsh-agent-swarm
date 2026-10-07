/** 真实宿主 AgentLoop 的恢复场景；driver 只模拟供应商响应，不模拟恢复动作。 */
const taskCard = {
  tool: 'swarm_task_card',
  args: { title: '模型故障恢复集成', goal: '验证恢复不会重复执行副作用', acceptance: ['故障路由只请求一次，备用继续原步骤'], scope: ['hello.txt'], flags: {} }
}
const delegate = (role, session) => ({ tool: 'swarm_delegate', args: { task_id: '$TASK', role, session, prompt: role === 'ji_feng' ? '创建 hello.txt，提交实际改动证据' : '检查 README.md，提交结构化结论' } })

export const RECOVERY_SCENARIOS = {
  'planning-enforced': {
    planning: true, preset: 'tian-shu', userText: '分析 README.md 并提交有证据的结论',
    root: [
      { tool: 'swarm_task_card', args: { title: '完整宿主规划双审', goal: '分析 README.md 并提交有证据的结论', acceptance: ['结论引用 README.md 并回应输入'], scope: ['README.md'], flags: {} } },
      { tool: 'swarm_delegate', args: { task_id: '$TASK', node_id: 'accept', role: 'mou_ding', prompt: '尝试跳过分析依赖', backend: 'api', session: 'oneshot' } },
      { tool: 'swarm_accept', args: { task_id: '$TASK', decision: 'accept', summary: '尝试提前验收', stopReason: '尚未分析' } },
      { tool: 'swarm_delegate', args: { task_id: '$TASK', node_id: 'analysis', role: 'mou_ding', prompt: '分析 README 并提交结论依据', backend: 'api', session: 'oneshot' } },
      { tool: 'swarm_accept', args: { task_id: '$TASK', decision: 'accept', summary: '分析完成且证据回应要求', stopReason: '全部要求满足' } },
      { tool: 'swarm_status', args: { task_id: '$TASK', verbose: true } },
      { text: 'PLANNING DONE' }
    ]
  },
  'recovery-pool-backup': { recovery: true, preset: 'tian-shu', root: [{ text: 'RECOVERY DONE' }] },
  'recovery-all-quota': { recovery: true, preset: 'tian-shu', root: [{ text: 'UNEXPECTED SUCCESS' }] },
  'recovery-child-oneshot': { recovery: true, preset: 'tian-shu', root: [taskCard, delegate('tan_wei', 'oneshot'), { text: 'RECOVERY DONE' }] },
  'recovery-child-continuable': { recovery: true, preset: 'tian-shu', root: [taskCard, delegate('tan_wei', 'new'), { text: 'RECOVERY DONE' }] },
  'recovery-write-once': { recovery: true, preset: 'tian-shu', root: [{ ...taskCard, args: { ...taskCard.args, flags: { changesCode: true } } }, delegate('ji_feng', 'oneshot'), { text: 'RECOVERY DONE' }] }
}

export const getRecoveryFailure = (model) => {
  if (model === 'fail-pool') return { code: 'SERVER_ERROR', status: 503, message: 'pool "claude-opus-5-5" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 }
  if (model === 'fail-quota-a' || model === 'fail-quota-b') return { code: 'QUOTA', status: 429, message: 'mock subscription quota exhausted' }
  return undefined
}

export const getRecoveryRetryPolicy = (mode = 'normal') => ({
  mode: mode === 'always' ? 'always' : 'normal',
  maxRetries: 3,
  retryableCodes: ['SERVER_ERROR', 'QUOTA', 'RATE_LIMIT'],
  initialDelayMs: 9060669,
  maxDelayMs: 9060669,
  jitterRatio: 0
})

export const recordRecoveryRequest = (state, options) => {
  if (options.purpose !== undefined) return
  state.recoveryRequests ??= []
  state.recoveryRequests.push({ provider: options.provider, model: options.model, sessionId: options.sessionId, at: Date.now() })
}

// 可作为独立 overlay 插件加载，不修改原 driver。LLM 只负责确定性模拟供应商响应。
export const name = 'swarm-recovery-test-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents']
const VALID = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))
function* textChunks (text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function* toolChunks (name, args) {
  const id = 'call_' + randomUUID().slice(0, 8)
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
const textOf = (message) => (message?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
const substitute = (value, taskId) => typeof value === 'string' ? value.replace('$TASK', taskId ?? 'T-1')
  : Array.isArray(value) ? value.map((item) => substitute(item, taskId))
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, taskId)])) : value

export const apply = (ctx) => {
  const scenarioName = process.env.SWARM_RECOVERY_SCENARIO
  if (!scenarioName) return
  const scenario = RECOVERY_SCENARIOS[scenarioName]
  const out = process.env.SWARM_DRIVER_OUT
  const state = { scenario: scenarioName, recoveryRequests: [], recoveryEvents: [], agentErrors: [], results: [], children: [], rootTools: [], failQuotaHits: 0, childMessages: [], rootNotices: 0, planningReviewers: [] }
  let finished = false
  const finish = (status, extra = {}) => {
    if (finished) return
    finished = true
    if (out) writeFileSync(out, JSON.stringify({ status, ...state, ...extra }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 100)
  }
  if (!scenario) { finish('unknown-scenario'); return }
  let rootStep = 0
  const childSteps = new Map()
  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Recovery integration mock' }),
    providerRetryPolicy: () => scenario.planning ? undefined : getRecoveryRetryPolicy(process.env.SWARM_RECOVERY_RETRY_MODE),
    imageRequestPricing: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200000 } }),
    async prepareCall (provider, model) { return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) } },
    async *stream (options) {
      if (options.purpose !== undefined) { yield* textChunks('Recovery test'); return }
      recordRecoveryRequest(state, options)
      const failure = getRecoveryFailure(options.model)
      if (failure) { state.failQuotaHits += failure.code === 'QUOTA' ? 1 : 0; yield { type: 'finish', reason: { kind: 'error', failure } }; return }
      const reviewPrompt = (options.messages ?? []).map(textOf).find((text) => text.includes('快照（完整当前合同与源码）：'))
      if (reviewPrompt !== undefined) {
        const match = /快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(reviewPrompt)
        if (!match) throw new Error('Planning review snapshot not readable by real spawn')
        const snapshot = JSON.parse(match[1])
        const tools = (options.tools ?? []).map((tool) => tool.name)
        const outputSchema = (options.tools ?? []).find((tool) => tool.name === 'structured_output')?.parameters
        const sessionId = String(options.sessionId)
        const step = childSteps.get(sessionId) ?? 0
        childSteps.set(sessionId, step + 1)
        let reviewer = state.planningReviewers.find((item) => item.sessionId === options.sessionId)
        if (reviewer === undefined) {
          reviewer = { sessionId: options.sessionId, model: options.model, tools,
            outputSchemaProperties: Object.keys(outputSchema?.properties ?? {}), snapshotDigest: snapshot.snapshotDigest,
            requestText: snapshot.requestText, mermaid: snapshot.mermaid, workflow: snapshot.workflow,
            seesAgentResult: Object.hasOwn(snapshot, 'agent'), seesJevResult: Object.hasOwn(snapshot, 'jev') }
          state.planningReviewers.push(reviewer)
        }
        if (step === 0) { yield* toolChunks('read', { file_path: 'README.md' }); return }
        if (step === 1) {
          reviewer.readResult = textOf(options.messages?.at(-1))
          yield* toolChunks('write', { file_path: 'planner-should-not-write.txt', content: 'must be rejected\n' }); return
        }
        reviewer.mutationResult = textOf(options.messages?.at(-1))
        reviewer.mutationIsError = options.messages?.at(-1)?.isError === true
        const dimension = { verdict: 'pass', summary: '独立对照 R1/A1/analysis：分析步骤产出对应结论，源码箭头与冻结流程相同', evidenceRefs: ['R1', 'A1', 'analysis', 'workflow', 'mermaid'] }
        yield* toolChunks('structured_output', { snapshotDigest: snapshot.snapshotDigest, verdict: 'pass',
          goalReview: dimension, designReview: dimension, mermaidReview: dimension,
          requirementCoverage: snapshot.requirements.map((requirement) => ({ requirementId: requirement.id, covered: true, evidence: 'analysis 读取 README.md 后形成 A1 要求的结论' })),
          findings: [], assumptions: [], unresolved: [] })
        return
      }
      const role = /^(?:role|writer)-([a-z_]+)$/.exec(options.model)?.[1]
      if (role === undefined) {
        const last = options.messages?.at(-1)
        if (last?.role === 'tool') {
          const text = textOf(last)
          state.results.push({ step: rootStep - 1, isError: last.isError === true, text })
          state.taskId ??= /task_id: (T-\d+)/.exec(text)?.[1]
        }
        state.rootTools = (options.tools ?? []).map((tool) => tool.name)
        const action = scenario.root[rootStep++]
        if (!action || action.text !== undefined) yield* textChunks(action?.text ?? 'DONE')
        else yield* toolChunks(action.tool, substitute(action.args, state.taskId))
        return
      }
      const sessionId = String(options.sessionId)
      const step = childSteps.get(sessionId) ?? 0
      childSteps.set(sessionId, step + 1)
      const tools = (options.tools ?? []).map((tool) => tool.name)
      if (step === 0) state.children.push({ role, model: options.model, tools, images: false })
      if (scenario.planning && role === 'mou_ding') {
        if (step === 0) { yield* toolChunks('read', { file_path: 'README.md' }); return }
        state.analysisReadResult = textOf(options.messages?.at(-1))
        yield* toolChunks('structured_output', { summary: 'README.md 第一行声明 recovery fixture；结论依据已读取的文件', unresolved: [], constraints: ['结论引用 README.md'],
          options: [{ name: '按文件事实报告', summary: '读取并核对第一行', pros: ['证据可复查'], cons: [] }],
          decisions: [{ point: '输入是什么', recommendation: '测试恢复工作区', reason: 'README.md:1 为 # recovery fixture' }], dependencies: [] })
        return
      }
      if (options.model.startsWith('writer-') && step === 0) {
        const schema = (options.tools ?? []).find((tool) => tool.name === 'write')
        const keys = Object.keys(schema?.parameters?.properties ?? {})
        yield* toolChunks('write', { [keys.find((key) => /path|file/i.test(key)) ?? 'path']: 'hello.txt', [keys.find((key) => /content|text|data/i.test(key)) ?? 'content']: 'hello swarm\n' })
        return
      }
      if (tools.includes('structured_output')) yield* toolChunks('structured_output', VALID[role])
      else yield* textChunks('```json\n' + JSON.stringify(VALID[role]) + '\n```')
    }
  }
  ctx.llm.registerAdapter(['swarm-mock'], adapter)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'llm/retry' || event.type === 'llm/retry-started') state.recoveryEvents.push({ type: event.type, data: event.data, sessionId: session.id })
  })
  ctx.on('agent/error', ({ error }) => state.agentErrors.push({ message: String(error?.message ?? error), code: error?.code }))
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try { await ctx.agentPresets.resolve(scenario.preset); break } catch (error) { if (attempt > 75) throw error; await new Promise((resolve) => setTimeout(resolve, 200)) }
    }
    const sessionId = 'recovery-it-' + randomUUID()
    const scope = await ctx.agentPresets.acquireScope(scenario.preset)
    try {
      const handle = await ctx.agents.create({ sessionId,
        meta: { cwd: process.cwd(), agentPreset: scenario.preset },
        agentOptions: { provider: 'swarm-mock', model: process.env.SWARM_ROOT_MODEL ?? 'root' },
        setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, scenario.preset) }
      })
      state.sessionId = sessionId
      state.subagentProviders = ctx.subagents.list()
      handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: scenario.userText ?? 'recovery integration test' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      state.recoveryTerminal = ctx.get('agentSwarm')?.routeState.getTerminal(handle.agent.id)
      if (scenario.planning && state.taskId) state.planningStatus = ctx.get('agentSwarm')?.getStatus({ task_id: state.taskId, verbose: true }, { agent: handle.agent, signal: new AbortController().signal })
      finish('done')
    } finally { await scope?.[Symbol.asyncDispose]?.() }
  }
  setTimeout(() => { run().catch((error) => finish('error', { error: String(error?.stack ?? error) })) }, 300)
  setTimeout(() => finish('timeout'), 25000)
}
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
