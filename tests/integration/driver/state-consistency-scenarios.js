/** Real DSH AgentLoop/tool/storage regression. Only model responses are mocked. */
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'swarm-state-consistency-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'agentSwarm']
export const STATE_PROVIDER = 'swarm-state-consistency-provider'
const pluginRoot = process.env.SWARM_PLUGIN_ROOT || fileURLToPath(new URL('../../../', import.meta.url))
const { getWorkspaceId } = await import(pathToFileURL(join(pluginRoot, 'lib/artifacts.js')))
const { digest } = await import(pathToFileURL(join(pluginRoot, 'lib/task-model.js')))
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')

function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function* tool(name, args) {
  const id = `state_${randomUUID()}`, raw = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
const writeArgs = options => {
  const schema = options.tools?.find(item => item.name === 'write')
  const keys = Object.keys(schema?.parameters?.properties ?? {})
  return { [keys.find(key => /path|file/i.test(key)) ?? 'file_path']: 'source.ts',
    [keys.find(key => /content|text|data/i.test(key)) ?? 'content']: 'export const stableSum = () => 42\n' }
}
const output = {
  tan_wei: { summary: '真实读取 source.ts', unresolved: [], findings: [{ path: 'source.ts', symbol: 'stableSum', callChain: ['stableSum'], evidence: '读取 source.ts 中的函数声明' }] },
  ji_feng: { summary: '真实写入一次 source.ts', unresolved: [], changedFiles: ['source.ts'], localChecks: [] },
  fu_he: { summary: '真实读取编辑后的文件；未运行业务测试', unresolved: [], plan: ['读取 source.ts'], commands: [], coverage: '仅校验宿主状态写入与实际文件读取', failures: [], verdict: 'partial' }
}

export const apply = ctx => {
  const scenario = process.env.SWARM_STATE_CONSISTENCY_SCENARIO
  if (!scenario) return
  const state = { scenario, requests: [], results: [], writes: 0, errors: [], observations: {} }
  const children = new Map()
  let rootStep = 0, finished = false, stateDirectory
  const committed = () => {
    const snapshot = JSON.parse(readFileSync(join(stateDirectory, 'snapshot.json'), 'utf8'))
    const journal = readFileSync(join(stateDirectory, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    return [snapshot, ...journal].reduce((latest, entry) => entry.sequence > latest.sequence ? entry : latest)
  }
  const finish = (status, extra = {}) => {
    if (finished) return
    finished = true
    writeFileSync(process.env.SWARM_STATE_CONSISTENCY_OUT, JSON.stringify({ status, ...state, ...extra }, null, 2))
    setTimeout(() => process.exit(status === 'done' ? 0 : 1), 50)
  }
  const card = { title: '宿主全状态一致性', goal: '验证状态写入与原始证据版本，修改只执行一次', acceptance: ['历史证据不换版且修改不重放'], scope: ['source.ts'], flags: {},
    workflow: { schemaVersion: 1, mode: 'quick', nodes: [
      { id: 'explore', label: '探索源码', operation: 'delegate', role: 'tan_wei', dependsOn: [], gates: [], outputContractVersion: '1' },
      ...(scenario === 'writer-completion' ? [{ id: 'implementation', label: '修改一次', operation: 'delegate', role: 'ji_feng', dependsOn: ['explore'], gates: [], outputContractVersion: '1' }] : []),
      { id: 'checkpoint', label: '核对', operation: 'checkpoint', dependsOn: scenario === 'writer-completion' ? ['explore', 'implementation'] : ['explore'], gates: [], outputContractVersion: '1' },
      { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
    ] } }
  const adapter = {
    providerInfo: provider => ({ id: provider, name: 'State consistency isolated model fixture' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 200000 } }),
    async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) } },
    async *stream(options) {
      if (options.purpose !== undefined) { yield* text('State consistency fixture'); return }
      state.requests.push({ sessionId: options.sessionId, model: options.model })
      const submit = value => tool('structured_output', options.tools?.find(item => item.name === 'structured_output')?.parameters?.properties?.value ? { value } : value)
      const reviewPrompt = options.messages?.map(textOf).find(value => value.includes('快照（完整当前合同与源码）：'))
      if (reviewPrompt !== undefined) {
        const snapshot = JSON.parse(/快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(reviewPrompt)[1])
        const dimension = { verdict: 'pass', summary: '隔离宿主流程一致性夹具：逐条对照冻结流程', evidenceRefs: ['R1', 'A1', 'workflow', 'mermaid'] }
        yield* submit({ snapshotDigest: snapshot.snapshotDigest, verdict: 'pass', goalReview: dimension, designReview: dimension, mermaidReview: dimension,
          requirementCoverage: snapshot.requirements.map(requirement => ({ requirementId: requirement.id, covered: true, evidence: '隔离流程读取文件、执行一次修改，再验证状态' })), findings: [], assumptions: [], unresolved: [] })
        return
      }
      if (options.model === 'root') {
        const last = options.messages?.at(-1)
        if (last?.role === 'tool') {
          const result = textOf(last)
          state.results.push({ step: rootStep - 1, isError: last.isError === true, text: result })
          state.taskId ??= /task_id: (T-\d+)/.exec(result)?.[1]
        }
        const step = rootStep++
        if (step === 0) { yield* tool('swarm_task_card', card); return }
        if (step === 1) { yield* tool('swarm_delegate', { task_id: state.taskId, node_id: 'explore', role: 'tan_wei', backend: 'api', session: 'oneshot', prompt: '读取真实 source.ts 后提交发现' }); return }
        if (step === 2) {
          state.observations.afterExplore = committed()
          yield* tool('read', { file_path: 'source.ts' })
          return
        }
        if (step === 3) {
          if (scenario === 'root-write') yield* tool('write', writeArgs(options))
          else yield* tool('swarm_delegate', { task_id: state.taskId, node_id: 'implementation', role: 'ji_feng', backend: 'api', session: 'oneshot', prompt: '真实写入一次 source.ts 并提交修改清单' })
          return
        }
        if (step === 4) { state.observations.beforeStatus = committed(); yield* tool('swarm_status', { task_id: state.taskId, verbose: true }); return }
        if (step === 5) {
          state.observations.afterStatus = committed()
          state.projection = ctx.agentSwarm.getStatus({ task_id: state.taskId, verbose: true }, { agent: ctx.agents.get(state.sessionId), signal: new AbortController().signal })
          yield* tool('swarm_delegate', { task_id: state.taskId, node_id: 'verification', role: 'fu_he', backend: 'api', session: 'oneshot', prompt: '读取当前文件，不重复任何修改；未运行测试需如实标明' })
          return
        }
        if (step === 6) { yield* tool('swarm_review_plan', { task_id: state.taskId, bypass_cache: true }); return }
        if (step === 7) { yield* tool('swarm_task_card', { ...card, task_id: state.taskId, workflow: state.projection.tasks[0].flow.definition }); return }
        if (step === 8) { yield* tool('swarm_status', { task_id: state.taskId, verbose: true }); return }
        yield* text('STATE CONSISTENCY DONE')
        return
      }
      const role = options.model.replace(/^role-/, ''), step = children.get(options.sessionId) ?? 0
      children.set(options.sessionId, step + 1)
      if (step === 0) { yield* tool('read', { file_path: 'source.ts' }); return }
      if (role === 'ji_feng' && step === 1) { yield* tool('write', writeArgs(options)); return }
      if (step === (role === 'ji_feng' ? 2 : 1)) { yield* submit(output[role]); return }
      yield* text('CHILD DONE')
    }
  }
  ctx.llm.registerAdapter([STATE_PROVIDER], adapter)
  ctx.on('tools/execute', (execution, next) => {
    if (execution.name === 'write') state.writes++
    return next()
  })
  ctx.on('agent/error', ({ error }) => state.errors.push({ code: error?.code, message: String(error?.message ?? error) }))
  setTimeout(() => { void (async () => {
    for (let attempt = 0; ; attempt++) {
      try { await ctx.agentPresets.resolve('tian-shu'); break } catch (error) { if (attempt > 60) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    state.sessionId = `state-consistency-${randomUUID()}`
    state.workspaceId = await getWorkspaceId(process.cwd())
    stateDirectory = join(process.env.DSH_HOME, 'share', 'dsh-agent-swarm', 'state', state.workspaceId, digest(state.sessionId))
    const handle = await ctx.agents.create({ sessionId: state.sessionId, meta: { cwd: process.cwd(), agentPreset: 'tian-shu' },
      agentOptions: { provider: STATE_PROVIDER, model: 'root' }, setup: async scope => { await ctx.agentPresets.mount(scope, 'tian-shu') } })
    handle.agent.followup(Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: card.goal }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    state.final = committed()
    finish('done')
  })().catch(error => finish('error', { error: String(error?.stack ?? error) })) }, 200)
  setTimeout(() => finish('timeout'), 40000).unref()
}
