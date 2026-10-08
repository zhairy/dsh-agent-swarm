import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

interface ElementInfo { type: unknown; props: Record<string, unknown>; children: unknown[] }

const DISPLAY = { presets: ['tian-shu', 'yu-shi'], providers: { claude: 'Claude 订阅', codex: 'ChatGPT 订阅' } }

/** 以 CommonJS 方式执行模块源码：注入数据与只记录结构的 React 桩 */
const loadModule = (): any => {
  const source = readFileSync(join(__dirname, '../../client/model-display.js'), 'utf8')
    .replace('const DISPLAY = __SWARM_DISPLAY__', `const DISPLAY = ${JSON.stringify(DISPLAY)}`)
  const module = { exports: {} as any }
  const react = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementInfo => ({ type, props: props ?? {}, children }),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()
  }
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'react') return react
    throw new Error(`unexpected require ${id}`)
  }, module, module.exports)
  return module.exports
}

const display = loadModule()
const { markerDefinition, headerDefinition, modelCallDefinition, ModelCallRow, ModelBadge, AgentModelController, getModelCallModeHook } = display.__test__

const t = (key: string) => key
const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  const element = node as ElementInfo
  return element.children.map(textOf).join('')
}

const message = (seq: number, provider: string, model: string, turn: number, stepStartSeq = seq - 1) => ({
  event: { type: 'assistant/message', seq, time: seq, data: { turn, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', provider, model } } } },
  location: { kind: 'step', turn: { turn }, step: { step: 1, start: { seq: stepStartSeq } } }
})

/** reader.previous 的桩：按 kind 返回预置的前一个状态 */
const reader = (states: Record<string, unknown>) => ({ previous: (kind: string) => (states[kind] === undefined ? undefined : { state: states[kind] }) })

describe('会话事件的识别', () => {
  it('会话标记：百工 persona 或百工预设为 true，其他预设为 false', () => {
    const system = { type: 'system/message', seq: 3, data: { message: { content: [{ type: 'text', text: '你是「天枢」，dsh-agent-swarm 的主持者' }] } } }
    expect(markerDefinition.match(system)).toEqual({ id: '3', role: 'start' })
    expect(markerDefinition.start(undefined, { event: system }, reader({}))).toEqual({ swarm: true })
    const standard = { type: 'agent-preset/selected', seq: 4, data: { agentPreset: 'standard' } }
    expect(markerDefinition.start(undefined, { event: standard }, reader({}))).toEqual({ swarm: false })
    expect(markerDefinition.start(undefined, { event: { ...standard, data: { agentPreset: 'yu-shi' } } }, reader({}))).toEqual({ swarm: true })
    expect(markerDefinition.match({ type: 'system/message' })).toBeNull()
    expect(markerDefinition.buildViewNode({})).toBeNull()
  })

  it('请求头只提供路由与推理强度', () => {
    const header = { type: 'request/header', seq: 9, data: { header: { config: { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high', maxTokens: 1 } } } }
    expect(headerDefinition.match(header)).toEqual({ id: '9', role: 'start' })
    expect(headerDefinition.start(undefined, { event: header })).toEqual({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' })
    expect(headerDefinition.match({ type: 'request/header', seq: 1, data: {} })).toBeNull()
  })
})

describe('「调用模型」行', () => {
  const opus = { provider: 'claude', model: 'claude-opus-5-5' }

  it('每轮第一次调用显示，附推理强度，锚在该步开头', () => {
    const state = modelCallDefinition.start(undefined, message(20, 'claude', 'claude-opus-5-5', 2), reader({
      'swarm-request-route': { ...opus, reasoningEffort: 'xhigh' },
      'swarm-session-marker': { swarm: true }
    }))
    expect(state).toMatchObject({ ...opus, turn: 2, reasoningEffort: 'xhigh', repeat: false, switched: false, swarm: true, anchorSeq: 19 })
    expect(modelCallDefinition.match({ type: 'assistant/message', seq: 5, data: { message: { source: { kind: 'user' } } } })).toBeNull()
  })

  it('失败/取消而无消息的真实assistant/attempt也显示对应请求路由，不从下一次选择猜实际模型', () => {
    const event = { type: 'assistant/attempt', seq: 99, time: 99, data: { turn: 2, step: 1, stream: [] } }
    expect(modelCallDefinition.match(event)).toEqual({ id: '99', role: 'start' })
    const state = modelCallDefinition.start(undefined, { event }, reader({ 'swarm-request-route': { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' }, 'swarm-session-marker': { swarm: true } }))
    expect(state).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max', source: 'request-header-attempt', failedAttempt: true })
    expect(modelCallDefinition.start(undefined, { event }, reader({}))).toBeUndefined()
  })

  it('同一轮同一模型标为 repeat；同一轮换了模型显示「切换模型」；新一轮不算重复', () => {
    const previous = { ...opus, turn: 2 }
    expect(modelCallDefinition.start(undefined, message(30, 'claude', 'claude-opus-5-5', 2), reader({ 'swarm-model-call': previous })).repeat).toBe(true)
    expect(modelCallDefinition.start(undefined, message(31, 'codex', 'gpt-6-sol', 2), reader({ 'swarm-model-call': previous })))
      .toMatchObject({ repeat: false, switched: true, from: opus })
    expect(modelCallDefinition.start(undefined, message(40, 'claude', 'claude-opus-5-5', 3), reader({ 'swarm-model-call': previous })))
      .toMatchObject({ repeat: false, switched: false })
  })

  it('节点：每次调用一个 visible 节点；明确不是百工会话时不出节点，已发布过的改为隐藏', () => {
    const start = message(20, 'claude', 'claude-opus-5-5', 2)
    const base = { key: 'k', id: '20', start, current: new Map() }
    expect(modelCallDefinition.buildViewNode({ ...base, state: { repeat: true, anchorSeq: 19 } })).toMatchObject({ kind: 'swarm-model-call', visibility: 'visible', anchorSeq: 19, target: 'chat' })
    expect(modelCallDefinition.buildViewNode({ ...base, state: { swarm: false, anchorSeq: 19 } })).toBeNull()
    expect(modelCallDefinition.buildViewNode({ ...base, current: new Map([['chat', { kind: 'swarm-model-call' }]]), state: { swarm: false, anchorSeq: 19 } }))
      .toMatchObject({ visibility: 'hidden' })
  })

  it('显示方式：默认每次调用都显示；「每轮首次」模式下重复的调用不渲染', () => {
    const data = { ...opus, repeat: true }
    expect(ModelCallRow({ node: { data }, t, useProjection: () => 'tian-shu' })).not.toBeNull()
    expect(ModelCallRow({ node: { data }, t, useProjection: () => 'tian-shu', useModelCallMode: () => 'every' })).not.toBeNull()
    expect(ModelCallRow({ node: { data }, t, useProjection: () => 'tian-shu', useModelCallMode: () => 'turn' })).toBeNull()
    expect(ModelCallRow({ node: { data: { ...data, repeat: false } }, t, useProjection: () => 'tian-shu', useModelCallMode: () => 'turn' })).not.toBeNull()
  })

  it('显示方式 Hook 读取 swarm-core 的 agents.modelCallDisplay，表单不可用时按每次显示', () => {
    let value: unknown = { agents: { modelCallDisplay: 'turn' } }
    const form = { getSnapshot: () => ({ value }), subscribe: () => () => undefined }
    const configForms = { get: (ns: string) => (ns === 'swarm-core' ? form : undefined) }
    const hook = getModelCallModeHook({ get: (name: string) => (name === 'configForms' ? configForms : undefined) })
    expect(hook()).toBe('turn')
    value = { agents: {} }
    expect(hook()).toBe('every')
    expect(getModelCallModeHook({ get: () => { throw new Error('no service') } })()).toBe('every')
    expect(getModelCallModeHook({ get: () => undefined })()).toBe('every')
  })

  it('渲染：百工会话显示「模型 · 供应商（路由名）· 推理」；其他会话不渲染', () => {
    const data = { ...opus, reasoningEffort: 'high', switched: true, from: { provider: 'codex', model: 'gpt-6-sol' } }
    const row = ModelCallRow({ node: { data }, t, useProjection: () => 'tian-shu' })
    expect(textOf(row)).toBe('switched' + 'claude-opus-5-5 · Claude 订阅（claude） · effort high（from gpt-6-sol · ChatGPT 订阅）')
    expect(ModelCallRow({ node: { data }, t, useProjection: () => 'standard' })).toBeNull()
    expect(ModelCallRow({ node: { data: { ...data, swarm: true } }, t, useProjection: () => 'standard' })).not.toBeNull()
    expect(ModelCallRow({ node: { data: {} }, t, useProjection: () => 'tian-shu' })).toBeNull()
  })
})

describe('会话头部徽标', () => {
  it('只在百工会话显示最近一次请求的模型与供应商', () => {
    const projections = (preset: unknown, selection: unknown) => (key: string) => (key === 'agentPreset' ? preset : selection)
    const badge = ModelBadge({ t, useProjection: projections('tian-shu', { lastUsed: { provider: 'codex', model: 'gpt-6-sol', reasoningEffort: 'high' }, next: null }) })
    expect(textOf(badge)).toBe('badge：gpt-6-sol · ChatGPT 订阅（codex） · effort high')
    expect((badge as ElementInfo).props.title).toBe('badge：gpt-6-sol · ChatGPT 订阅（codex） · effort high')
    expect(ModelBadge({ t, useProjection: projections('standard', { lastUsed: { provider: 'codex', model: 'gpt-6-sol' } }) })).toBeNull()
    expect(ModelBadge({ t, useProjection: projections('tian-shu', { lastUsed: null, next: null }) })).toBeNull()
    expect(ModelBadge({ t })).toBeNull()
    expect(textOf(ModelBadge({ t, useProjection: projections(undefined, { lastUsed: null, next: null }), useSession: () => ({ address: { mode: 'one-shot' } }) }))).toBe('unknownModel')
    const next = ModelBadge({ t, useProjection: projections('tian-shu', { lastUsed: null, next: { provider: 'codex', model: 'future' } }) })
    expect(textOf(next)).toContain('next：future')
    expect(textOf(next)).not.toContain('badge：')
  })
})

describe('client 入口', () => {
  it('注册 3 个会话定义、Chat 节点渲染与头部徽标', () => {
    const definitions: string[] = []
    const slots: unknown[] = []
    const ctx = {
      get: () => undefined,
      effect: (fn: () => unknown) => { fn() },
      locale: { register: vi.fn(() => () => undefined) },
      uiConversation: { events: { register: (definition: { kind: string }) => { definitions.push(definition.kind); return () => undefined } } },
      slots: {
        inject: (_name: string, fn: () => Generator<unknown>) => { for (const _ of fn()) { /* 执行生成器 */ } },
        register: (options: unknown) => { slots.push(options); return () => undefined }
      }
    }
    display.apply(ctx)
    expect(display.inject).toEqual(['slots', 'locale', 'uiConversation', 'connection', 'remote.session'])
    expect(definitions).toEqual(['swarm-session-marker', 'swarm-request-route', 'swarm-model-call'])
    expect(slots).toEqual([
      { name: 'conversation.chat.node', key: 'swarm-model-call', locale: 'swarmModelCalls', inject: expect.any(Function) },
      { name: 'conversation.session.header.actions', id: 'swarm-model-badge', order: -4, locale: 'swarmModelCalls' }
      , { name: 'conversation.session.header.actions', id: 'swarm-agent-model-controls', order: -3, locale: 'swarmModelCalls', inject: expect.any(Function) }
    ])
  })
})

describe('persistent child model controls', () => {
  it('CAS commands go to the real control plane; selection receipt never replaces actual attempt evidence', async () => {
    const address = { parentSessionId: 'root', childId: 'child' }
    let view = { ...address, revision: 3, persistent: true, phase: 'running', actual: { route: { provider: 'codex', model: 'old', reasoningEffort: 'high' }, attemptId: 'attempt-old' } }
    const command = vi.fn(async (input: any) => { view = { ...view, revision: 4, phase: 'stopping', selectedNext: input.route } as typeof view; return view })
    const controller = new AgentModelController(address, { view: async () => view, command, catalog: async () => ({ ok: true, value: { groups: [] } }) })
    await controller.load()
    controller.setDraft({ provider: 'qwen-token-plan-cn' })
    controller.setDraft({ model: 'deepseek-v4.1-flash' })
    controller.setDraft({ reasoningEffort: 'max' })
    await controller.command('select')
    expect(command).toHaveBeenCalledWith({ ...address, expectedRevision: 3, action: 'select', interruptRunning: true, route: { provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' } })
    expect(controller.getSnapshot().view).toMatchObject({ phase: 'stopping', actual: { route: { model: 'old' } }, selectedNext: { model: 'deepseek-v4.1-flash' } })
    await controller.command('continue')
    expect(command).toHaveBeenCalledTimes(1)
    view = { ...view, revision: 5, phase: 'paused' }
    await controller.load()
    await controller.command('continue')
    expect(command.mock.calls[1]?.[0]).toMatchObject({ action: 'continue', expectedRevision: 5 })
  })

  it('host denial remains visible after refresh, unknown child bindings never produce a fake ready state', async () => {
    const address = { parentSessionId: 'root', childId: 'child' }
    const controller = new AgentModelController(address, { view: async () => ({ ...address, revision: 1, persistent: true, phase: 'paused' }), command: async () => { throw new Error('stale task contract') } })
    await controller.load()
    await controller.command('continue')
    expect(controller.getSnapshot().error).toBe('stale task contract')
    const wrong = new AgentModelController(address, { view: async () => ({ ...address, childId: 'other', revision: 1, phase: 'idle' }) })
    await wrong.load()
    expect(wrong.getSnapshot()).toMatchObject({ status: 'error', view: undefined })
  })
})
