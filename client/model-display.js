// 百工会话的模型显示（浏览器端）：聊天窗口里的「调用模型」行与会话头部的当前模型徽标。
// 本文件是 client bundle 的模块体之一：scripts/build-client.mjs 把它与设置页一起打包，
// 并把 __SWARM_DISPLAY__ 替换为从 lib/ 读出的 13 个预设 ID 与供应商中文名。
//
// 「调用模型」行只读取宿主已经记录的会话事件，不写入任何自定义事件：
// - assistant/message 的 source 记录了每一步实际作答的供应商与模型（含回退与容灾升级之后的模型）；
// - request/header 记录请求配置，用来补充推理强度；
// - system/message（百工 persona 含 dsh-agent-swarm）与 agent-preset/selected 用来判断是否百工会话。
// 默认每次模型调用都显示一行；「设置 → 百工 Agent」可改为只在每轮首次调用与换模型时显示（swarm-core 的 agents.modelCallDisplay）。
// 同一轮里换了模型（回退、升级、手动切换）时显示为「切换模型」并注明原模型。

const React = require('react')
const h = React.createElement
let HostModal
try { HostModal = require('@deepseek-ai/dsh-client-ui-primitives').Modal } catch { HostModal = undefined }

/** @type {{ presets: string[], providers: Record<string, string> }} */
const DISPLAY = __SWARM_DISPLAY__

const NS = 'swarmModelCalls'
/** swarm-core 条目的设置命名空间（与设置页一致） */
const SWARM_NAMESPACE = 'swarm-core'
const KIND = 'swarm-model-call'
const HEADER_KIND = 'swarm-request-route'
const MARKER_KIND = 'swarm-session-marker'
/** 百工 persona（天枢、12 个角色预设与委派出的专家）都包含这个标记 */
const SWARM_MARKER = 'dsh-agent-swarm'
const PRESETS = new Set(DISPLAY.presets)

const zh = {
  title: '调用模型',
  switched: '切换模型',
  effort: '推理',
  from: '原为',
  badge: '最近请求模型', next: '下次选择', unknownEffort: '未报告', controls: '模型与恢复', actual: '实际调用', actualUnknown: '尚无宿主实际 attempt 观测', selectedNext: '下一次所选模型', state: '状态', refresh: '刷新状态', select: '选择模型', stop: '取消当前调用', continue: '安全继续任务', busy: '处理中…', provider: '供应商', model: '模型', effortDefault: '宿主默认', chooseProvider: '选择供应商', chooseModel: '选择模型', stopping: '已请求取消，等待宿主确认沉寂；尚未继续任务。', savedNext: '已记录下一次模型选择；只有新的实际调用才表示生效。', resumed: '继续请求已交给任务管线；执行与验收以任务状态为准。', reconcile: '我已核对取消可能留下的副作用与任务进度', reconcileHint: '此确认不会清除未知写入租约；宿主仍需完成实际工作区恢复检查。', steering: '继续说明（可选）', retryRoute: '受控重试所选路由一次', forceRetry: '提前结束插件冷却并试一次（不越过服务重置时间）', routeHint: '运行中切换会先取消旧调用；沉寂后点击安全继续，避免自动重放写入。', unavailable: '控制面暂不可用', phase_idle: '空闲', phase_running: '运行中', phase_waiting: '等待网络或重试', phase_stopping: '等待取消沉寂', phase_paused: '已暂停', 'phase_recovery-required': '需核对宿主运行状态', close: '收起'
}

const en = {
  title: 'Model call',
  switched: 'Model switched',
  effort: 'effort',
  from: 'was',
  badge: 'Last requested model', next: 'Next selection', unknownEffort: 'unreported', controls: 'Model & recovery', actual: 'Actual attempt', actualUnknown: 'No host attempt observation yet', selectedNext: 'Selected for next call', state: 'State', refresh: 'Refresh status', select: 'Select model', stop: 'Cancel current call', continue: 'Continue task safely', busy: 'Working…', provider: 'Provider', model: 'Model', effortDefault: 'Host default', chooseProvider: 'Select provider', chooseModel: 'Select model', stopping: 'Cancellation requested; waiting for host quiescence. The task has not resumed.', savedNext: 'Next model selection saved; a new observed attempt confirms it took effect.', resumed: 'Continuation admitted to the task pipeline; execution and acceptance remain separate.', reconcile: 'I checked possible side effects and current task progress', reconcileHint: 'This does not clear unknown mutation leases; the host must still perform workspace recovery checks.', steering: 'Continuation guidance (optional)', retryRoute: 'Allow one controlled retry of the selected route', forceRetry: 'Bypass plugin cooldown once, respecting the service reset time', routeHint: 'Switching during a run cancels the old call first. Continue after quiescence to avoid replaying writes.', unavailable: 'Control plane unavailable', phase_idle: 'Idle', phase_running: 'Running', phase_waiting: 'Waiting for network or retry', phase_stopping: 'Waiting for cancellation', phase_paused: 'Paused', 'phase_recovery-required': 'Host reconciliation required', close: 'Close'
}

const providerLabel = (provider) => DISPLAY.providers[provider] ?? provider
Object.assign(zh, { stopped: '宿主已确认本轮结束；可继续未完成任务。' })
Object.assign(en, { stopped: 'The host confirmed this run ended; unfinished work can be continued.' })
Object.assign(zh, { unknownModel: '实际模型未由宿主报告' })
Object.assign(en, { unknownModel: 'Actual model not reported by the host' })

/** request/header 的路由与推理强度 */
const readHeaderRoute = (event) => {
  const config = event?.data?.header?.config
  if (config === null || typeof config !== 'object' || typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
  return { provider: config.provider, model: config.model, ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}) }
}

/** assistant/message 记录的实际作答模型 */
const readMessageRoute = (event) => {
  const source = event?.data?.message?.source
  if (source === null || typeof source !== 'object' || source.kind !== 'model' || typeof source.provider !== 'string' || typeof source.model !== 'string') return undefined
  return { provider: source.provider, model: source.model }
}

const readSystemText = (event) => {
  const content = event?.data?.message?.content
  return Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : ''
}

const isDurable = (event) => Number.isInteger(event?.seq)

const startOnly = (event) => ({ id: String(event.seq), role: 'start' })

/** 会话标记：是否百工会话（未知时为 undefined，由渲染时的 agentPreset 投影决定） */
const markerDefinition = {
  kind: MARKER_KIND,
  target: 'chat',
  match: (event) => (event.type === 'system/message' || event.type === 'agent-preset/selected') && isDurable(event) ? startOnly(event) : null,
  start: (_context, match, reader) => {
    const previous = reader?.previous?.(MARKER_KIND)?.state
    if (match.event.type === 'agent-preset/selected') {
      const preset = match.event.data?.agentPreset
      return { swarm: typeof preset === 'string' ? PRESETS.has(preset) : previous?.swarm }
    }
    const text = readSystemText(match.event)
    return { swarm: text === '' ? previous?.swarm : text.includes(SWARM_MARKER) }
  },
  update: (context) => context.state,
  buildViewNode: () => null
}

/** 最近一次请求头：只提供推理强度，不渲染 */
const headerDefinition = {
  kind: HEADER_KIND,
  target: 'chat',
  match: (event) => event.type === 'request/header' && isDurable(event) && readHeaderRoute(event) !== undefined ? startOnly(event) : null,
  start: (_context, match) => readHeaderRoute(match.event),
  update: (context) => context.state,
  buildViewNode: () => null
}

const turnOf = (match) => {
  const location = match.location
  if (location?.kind === 'step' || location?.kind === 'turn') return location.turn.turn
  return typeof match.event.data?.turn === 'number' ? match.event.data.turn : undefined
}

/** 「调用模型」行：每次调用一个节点；repeat 表示与同一轮上一次调用的模型相同（「每轮首次」模式下不渲染） */
const modelCallDefinition = {
  kind: KIND,
  target: 'chat',
  match: (event) => isDurable(event) && ((event.type === 'assistant/message' && readMessageRoute(event) !== undefined) || event.type === 'assistant/attempt') ? startOnly(event) : null,
  start: (_context, match, reader) => {
    const previous = reader?.previous?.(KIND)?.state
    const header = reader?.previous?.(HEADER_KIND)?.state
    const route = readMessageRoute(match.event) ?? (match.event.type === 'assistant/attempt' ? header : undefined)
    if (route === undefined) return undefined
    const marker = reader?.previous?.(MARKER_KIND)?.state
    const turn = turnOf(match)
    const effort = header !== undefined && header.provider === route.provider && header.model === route.model ? header.reasoningEffort : undefined
    const sameRoute = previous !== undefined && previous.provider === route.provider && previous.model === route.model && previous.reasoningEffort === effort
    const sameTurn = previous !== undefined && previous.turn === turn
    const location = match.location
    return {
      seq: match.event.seq,
      time: match.event.time,
      ...(turn === undefined ? {} : { turn }),
      provider: route.provider,
      model: route.model,
      source: match.event.type === 'assistant/attempt' ? 'request-header-attempt' : 'assistant-message',
      failedAttempt: match.event.type === 'assistant/attempt',
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      repeat: sameRoute && sameTurn,
      switched: sameTurn && !sameRoute,
      ...(sameTurn && !sameRoute ? { from: { provider: previous.provider, model: previous.model } } : {}),
      ...(marker?.swarm === undefined ? {} : { swarm: marker.swarm }),
      anchorSeq: location?.kind === 'step' ? (location.step.start?.seq ?? match.event.seq) : match.event.seq
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (context.start === undefined || state === undefined) return null
    const visible = state.swarm !== false
    // 已经发布过的行改为隐藏而不是删除，保持 Chat 的节点键稳定
    if (!visible && context.current?.get?.('chat')?.kind !== KIND) return null
    return {
      key: context.key,
      kind: KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: state.anchorSeq,
      location: context.start.location,
      visibility: visible ? 'visible' : 'hidden',
      data: state
    }
  }
}

const style = {
  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 13, lineHeight: '22px', minWidth: 0 },
  title: { flex: 'none', color: 'var(--dsw-alias-label-secondary)' },
  switched: { flex: 'none', color: 'var(--dsw-alias-state-warn-primary, #d9480f)' },
  sep: { flex: 'none', width: 2, height: 2, borderRadius: 1, background: 'var(--dsw-alias-label-caption)' },
  summary: { flex: '1 1 auto', minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere', color: 'var(--dsw-alias-label-tertiary)' },
  badge: {
    display: 'inline-block', maxWidth: 260, padding: '0 8px', borderRadius: 999, fontSize: 12, lineHeight: '20px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
    background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)'
  }
}

const isSwarmPreset = (value) => typeof value === 'string' && PRESETS.has(value)

const routeText = (t, route) =>
  `${route.model} · ${providerLabel(route.provider)}（${route.provider}） · ${t('effort')} ${route.reasoningEffort ?? t('unknownEffort')}`

/**
 * 一行「调用模型」：模型 · 供应商（路由名）· 推理强度
 * @param props - Chat 节点槽位的属性（node、t 与会话标准属性）
 */
function ModelCallRow (props) {
  const { node, t } = props
  const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined
  const mode = typeof props.useModelCallMode === 'function' ? props.useModelCallMode() : 'every'
  const data = node?.data
  if (data === null || typeof data !== 'object' || typeof data.provider !== 'string' || typeof data.model !== 'string') return null
  if (data.swarm !== true && !isSwarmPreset(preset)) return null
  if (data.repeat === true && mode === 'turn') return null
  const text = routeText(t, data) + (data.from === undefined ? '' : `（${t('from')} ${data.from.model} · ${providerLabel(data.from.provider)}）`)
  return h('div', { style: style.row, role: 'note', 'data-swarm-model-call': data.provider },
    h('span', { style: data.switched ? style.switched : style.title }, data.switched ? t('switched') : t('title')),
    h('span', { style: style.sep, 'aria-hidden': 'true' }),
    h('span', { style: style.summary, title: text }, text))
}

/**
 * 会话头部的当前模型徽标：只在百工会话（天枢、角色预设与委派出的专家会话）显示
 * @param props - 会话头部槽位的属性
 */
function ModelBadge (props) {
  const { t } = props
  if (typeof props.useProjection !== 'function') return null
  const preset = props.useProjection('agentPreset')
  const selection = props.useProjection('modelSelection')
  const subagent = typeof props.useSession === 'function' ? props.useSession((session) => session?.subagent) : undefined
  if (!isSwarmPreset(preset) && subagent === null) return null
  if (!isSwarmPreset(preset) && subagent === undefined) return null
  const used = selection?.lastUsed ?? selection?.next
  if (used === null || used === undefined || typeof used.provider !== 'string' || typeof used.model !== 'string') return subagent === undefined || subagent === null ? null : h('span', { style: style.badge, 'data-swarm-model-badge': 'unknown', title: t('unknownModel') }, t('unknownModel'))
  const label = selection?.lastUsed === null || selection?.lastUsed === undefined ? t('next') : t('badge')
  return h('span', { style: style.badge, title: `${label}：${routeText(t, used)}`, 'data-swarm-model-badge': used.provider },
    `${label}：${routeText(t, used)}`)
}

const inject = ['slots', 'locale', 'uiConversation', 'connection', 'remote.session']

const NO_SUBSCRIBE = () => () => undefined

/** The browser only requests changes; actual/settled state always comes back from the host. */
class AgentModelController {
  constructor (address, transport) {
    this.address = address
    this.transport = transport
    this.listeners = new Set()
    this.generation = 0
    this.disposed = false
    this.state = { status: 'idle', view: undefined, groups: [], catalogStatus: 'idle', busy: false, error: undefined, notice: undefined, draft: { provider: '', model: '', reasoningEffort: '' }, retryRoute: false, forceRetry: false, confirmSafeToContinue: false, steering: '' }
    this.subscribe = (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
    this.getSnapshot = () => this.state
  }
  update (patch) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }
  dispose () { this.disposed = true; this.generation += 1; this.listeners.clear() }
  getView (raw) {
    const value = raw?.control ?? raw
    if (value?.childId !== this.address.childId || value?.parentSessionId !== this.address.parentSessionId || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.phase !== 'string') throw new Error('invalid host agent-control view')
    return value
  }
  async load () {
    if (this.disposed) return
    const generation = ++this.generation
    this.update({ status: this.state.view === undefined ? 'loading' : this.state.status, error: undefined })
    try {
      const view = this.getView(await this.transport.view(this.address))
      if (generation !== this.generation) return
      const selected = view.selectedNext ?? view.requestedRoute ?? view.actual?.route
      const draft = this.state.view === undefined && selected !== undefined ? { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort ?? '' } : this.state.draft
      this.update({ status: 'ready', view, draft, ...(view.phase === 'paused' && this.state.notice === 'stopping' ? { notice: 'stopped' } : {}) })
    } catch (error) { if (generation === this.generation) this.update({ status: 'error', error: error instanceof Error ? error.message : String(error) }) }
  }
  async loadCatalog () {
    if (this.disposed || this.state.catalogStatus === 'loading') return
    this.update({ catalogStatus: 'loading' })
    try {
      const raw = await this.transport.catalog()
      const value = raw?.ok === true ? raw.value : raw
      if (!Array.isArray(value?.groups)) throw new Error('model catalog unavailable')
      this.update({ groups: value.groups, catalogStatus: 'ready' })
    } catch (error) { this.update({ catalogStatus: 'error', error: error instanceof Error ? error.message : String(error) }) }
  }
  setDraft (patch) {
    const draft = { ...this.state.draft, ...patch }
    if (patch.provider !== undefined) { draft.model = ''; draft.reasoningEffort = '' }
    else if (patch.model !== undefined) draft.reasoningEffort = ''
    this.update({ draft, notice: undefined })
  }
  setOptions (patch) { this.update(patch) }
  async command (action) {
    if (this.state.busy || this.state.view === undefined || this.disposed) return
    const view = this.state.view
    const input = { ...this.address, expectedRevision: view.revision, action }
    if (action === 'select') {
      const route = this.state.draft
      if (route.provider === '' || route.model === '') return
      input.route = { provider: route.provider, model: route.model, ...(route.reasoningEffort === '' ? {} : { reasoningEffort: route.reasoningEffort }) }
      input.interruptRunning = ['running', 'waiting', 'stopping'].includes(view.phase)
      if (this.state.retryRoute) input.retryRoute = true
      if (this.state.retryRoute && this.state.forceRetry) input.forceRetry = true
    } else if (action === 'continue') {
      if (view.phase !== 'paused' || (view.needsSideEffectReview === true && !this.state.confirmSafeToContinue)) return
      if (this.state.confirmSafeToContinue) input.confirmSafeToContinue = true
      if (this.state.steering.trim() !== '') input.steering = this.state.steering.trim()
    }
    this.update({ busy: true, error: undefined, notice: undefined })
    this.generation += 1
    try {
      const result = await this.transport.command(input)
      const returned = result?.control ?? (result?.childId === this.address.childId ? result : undefined)
      if (returned !== undefined) this.update({ view: this.getView(returned) })
      await this.load()
      if (this.state.status === 'ready') this.update({ notice: action === 'continue' ? 'resumed' : action === 'stop' || this.state.view?.phase === 'stopping' ? 'stopping' : 'savedNext', confirmSafeToContinue: false })
    } catch (error) { await this.load().then(() => undefined); this.update({ error: error instanceof Error ? error.message : String(error) }) }
    finally { this.update({ busy: false }) }
  }
}

const controlStyle = {
  panel: { position: 'relative', width: '100%', maxWidth: '100%', maxHeight: 'min(70vh, 600px)', overflowY: 'auto', boxSizing: 'border-box', padding: 10, background: 'var(--dsw-alias-bg-layer-3, white)', color: 'var(--dsw-alias-label-primary, #24344a)', fontSize: 13, lineHeight: 1.6 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, marginTop: 8 },
  input: { minWidth: 0, width: '100%', boxSizing: 'border-box', padding: 6 },
  line: { overflowWrap: 'anywhere', whiteSpace: 'normal', margin: '5px 0' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  button: { padding: '4px 8px', cursor: 'pointer' }
}

function AgentControlPanel ({ controller, t }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const view = state.view
  React.useEffect(() => { controller.load(); controller.loadCatalog() }, [controller])
  React.useEffect(() => {
    if (view === undefined) return undefined
    const timer = setInterval(() => { if (!controller.getSnapshot().busy) controller.load() }, 2000)
    return () => clearInterval(timer)
  }, [controller, view !== undefined])
  const provider = state.groups.find((item) => item.id === state.draft.provider)
  const models = provider?.models ?? []
  const model = models.find((item) => item.id === state.draft.model)
  const efforts = model?.reasoning?.efforts ?? []
  const readonly = view?.persistent !== true
  const disabled = state.busy || state.status !== 'ready'
  const field = (label, element) => h('label', { style: controlStyle.field }, h('span', null, t(label)), element)
  const route = view?.actual?.route
  return h('div', { style: controlStyle.panel, 'data-swarm-agent-control': controller.address.childId, role: 'region', 'aria-label': t('controls') },
    h('p', { style: controlStyle.line }, `${t('actual')}：${route === undefined ? t('actualUnknown') : routeText(t, route)}`),
    view?.selectedNext === undefined ? null : h('p', { style: controlStyle.line }, `${t('selectedNext')}：${routeText(t, view.selectedNext)}`),
    h('p', { style: controlStyle.line, role: 'status' }, `${t('state')}：${view === undefined ? t('unavailable') : t(`phase_${view.phase}`)}`),
    state.error === undefined ? null : h('p', { role: 'alert', style: { ...controlStyle.line, color: 'var(--dsw-alias-state-error-primary, #c92a2a)' } }, state.error),
    state.notice === undefined ? null : h('p', { role: 'status', style: controlStyle.line }, t(state.notice)),
    readonly ? null : h(React.Fragment, null,
      field('provider', state.catalogStatus === 'ready' ? h('select', { style: controlStyle.input, value: state.draft.provider, disabled, 'aria-label': t('provider'), onChange: (event) => controller.setDraft({ provider: event.target.value }) }, h('option', { value: '' }, t('chooseProvider')), ...state.groups.map((item) => h('option', { key: item.id, value: item.id }, `${item.name ?? providerLabel(item.id)}（${item.id}）`)), state.draft.provider !== '' && provider === undefined ? h('option', { value: state.draft.provider }, state.draft.provider) : null) : h('input', { style: controlStyle.input, value: state.draft.provider, disabled, 'aria-label': t('provider'), onChange: (event) => controller.setDraft({ provider: event.target.value }) })),
      field('model', state.catalogStatus === 'ready' ? h('select', { style: controlStyle.input, value: state.draft.model, disabled, 'aria-label': t('model'), onChange: (event) => controller.setDraft({ model: event.target.value }) }, h('option', { value: '' }, t('chooseModel')), ...models.map((item) => h('option', { key: item.id, value: item.id }, item.id)), state.draft.model !== '' && model === undefined ? h('option', { value: state.draft.model }, state.draft.model) : null) : h('input', { style: controlStyle.input, value: state.draft.model, disabled, 'aria-label': t('model'), onChange: (event) => controller.setDraft({ model: event.target.value }) })),
      field('effort', efforts.length > 0 ? h('select', { style: controlStyle.input, value: state.draft.reasoningEffort, disabled, 'aria-label': t('effort'), onChange: (event) => controller.setDraft({ reasoningEffort: event.target.value }) }, h('option', { value: '' }, t('effortDefault')), ...efforts.map((item) => h('option', { key: item.id, value: item.id }, item.id))) : h('input', { style: controlStyle.input, value: state.draft.reasoningEffort, disabled: disabled || state.catalogStatus === 'ready', placeholder: t('effortDefault'), 'aria-label': t('effort'), onChange: (event) => controller.setDraft({ reasoningEffort: event.target.value }) })),
      h('label', { style: { ...controlStyle.line, display: 'block' } }, h('input', { type: 'checkbox', checked: state.retryRoute, disabled, onChange: (event) => controller.setOptions({ retryRoute: event.target.checked, forceRetry: false }) }), t('retryRoute')),
      state.retryRoute ? h('label', { style: { ...controlStyle.line, display: 'block' } }, h('input', { type: 'checkbox', checked: state.forceRetry, disabled, onChange: (event) => controller.setOptions({ forceRetry: event.target.checked }) }), t('forceRetry')) : null,
      h('p', { style: controlStyle.line }, t('routeHint'))),
    view?.phase !== 'paused' ? null : h(React.Fragment, null,
      view.needsSideEffectReview === true ? h('label', { style: { ...controlStyle.line, display: 'block' } }, h('input', { type: 'checkbox', checked: state.confirmSafeToContinue, disabled, onChange: (event) => controller.setOptions({ confirmSafeToContinue: event.target.checked }) }), t('reconcile'), h('p', { style: controlStyle.line }, t('reconcileHint'))) : null,
      field('steering', h('textarea', { style: controlStyle.input, value: state.steering, maxLength: 8000, disabled, 'aria-label': t('steering'), onChange: (event) => controller.setOptions({ steering: event.target.value }) }))),
    h('div', { style: controlStyle.actions },
      h('button', { type: 'button', style: controlStyle.button, disabled: state.busy, onClick: () => controller.load() }, t('refresh')),
      readonly ? null : h('button', { type: 'button', style: controlStyle.button, disabled: disabled || state.draft.provider === '' || state.draft.model === '', onClick: () => controller.command('select') }, state.busy ? t('busy') : t('select')),
      ['running', 'waiting', 'recovery-required'].includes(view?.phase) ? h('button', { type: 'button', style: controlStyle.button, disabled, onClick: () => controller.command('stop') }, t('stop')) : null,
      view?.phase === 'paused' && !readonly ? h('button', { type: 'button', style: controlStyle.button, disabled: disabled || (view.needsSideEffectReview === true && !state.confirmSafeToContinue), onClick: () => controller.command('continue') }, t('continue')) : null))
}

function AgentModelControls (props) {
  const subagent = typeof props.useSession === 'function' ? props.useSession((session) => session?.subagent) : undefined
  const address = subagent?.address
  const parentId = address?.parentSessionId
  const childId = address?.childSessionId
  const [open, setOpen] = React.useState(false)
  const controller = React.useMemo(() => parentId === undefined || childId === undefined ? undefined : new AgentModelController({ parentSessionId: parentId, childId }, props.transport), [parentId, childId, props.transport])
  React.useEffect(() => () => controller?.dispose(), [controller])
  if (controller === undefined) return null
  const panel = open ? h(AgentControlPanel, { controller, t: props.t }) : null
  return h(React.Fragment, null,
    h('button', { type: 'button', style: controlStyle.button, 'aria-expanded': open, onClick: () => setOpen(!open) }, props.t(open ? 'close' : 'controls')),
    HostModal === undefined
      ? open ? h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': props.t('controls'), style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: '#0004' } }, h('div', null, h('button', { type: 'button', onClick: () => setOpen(false) }, props.t('close')), panel)) : null
      : h(HostModal, { open, onClose: () => setOpen(false), title: props.t('controls'), closeLabel: props.t('close') }, panel))
}

const getAgentControlTransport = (ctx) => {
  const rpc = async (method, payload) => {
    const connection = ctx.get('connection')
    if (typeof connection?.rpc?.call !== 'function') throw new Error('swarm control RPC unavailable')
    const result = await connection.rpc.call('/api', `swarm.${method}`, payload)
    if (result?.ok !== true) throw Object.assign(new Error(`${result?.error?.message ?? 'agent control RPC failed'}${result?.error?.code === undefined ? '' : ` (${result.error.code})`}`), { code: result?.error?.code })
    return result.value
  }
  return { view: (address) => rpc('agentView', address), command: (input) => rpc('agentControl', input), catalog: () => ctx.remote.session.modelCatalog() }
}

/**
 * 读取 swarm-core 的 agents.modelCallDisplay 的 Hook；配置表单不可用时按「每次调用都显示」
 * @param ctx - 浏览器端插件上下文
 * @returns {() => 'every' | 'turn'} Hook
 */
const getModelCallModeHook = (ctx) => {
  let form
  try {
    form = ctx.get('configForms')?.get?.(SWARM_NAMESPACE)
  } catch {
    form = undefined
  }
  const read = () => {
    const value = form?.getSnapshot?.()?.value
    return value?.agents?.modelCallDisplay === 'turn' ? 'turn' : 'every'
  }
  const subscribe = typeof form?.subscribe === 'function' ? (listener) => form.subscribe(listener) : NO_SUBSCRIBE
  return () => React.useSyncExternalStore(subscribe, read)
}

/**
 * 注册会话定义、Chat 节点渲染与会话头部徽标
 * @param ctx - 浏览器端插件上下文
 */
function apply (ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'swarm-model-calls: dictionaries')
  for (const definition of [markerDefinition, headerDefinition, modelCallDefinition]) {
    ctx.effect(() => ctx.uiConversation.events.register(definition), `swarm-model-calls: ${definition.kind}`)
  }
  const useModelCallMode = getModelCallModeHook(ctx)
  ctx.slots.inject('conversation.chat.node', function * () {
    yield ctx.slots.register({ name: 'conversation.chat.node', key: KIND, locale: NS, inject: () => ({ useModelCallMode }) }, ModelCallRow)
  })
  ctx.slots.inject('conversation.session.header.actions', function * () {
    yield ctx.slots.register({ name: 'conversation.session.header.actions', id: 'swarm-model-badge', order: -4, locale: NS }, ModelBadge)
    const transport = getAgentControlTransport(ctx)
    yield ctx.slots.register({ name: 'conversation.session.header.actions', id: 'swarm-agent-model-controls', order: -3, locale: NS, inject: () => ({ transport }) }, AgentModelControls)
  })
}

exports.inject = inject
exports.apply = apply
exports.NS = NS
exports.__test__ = { markerDefinition, headerDefinition, modelCallDefinition, ModelCallRow, ModelBadge, AgentModelController, AgentControlPanel, AgentModelControls, getAgentControlTransport, readHeaderRoute, readMessageRoute, getModelCallModeHook, routeText, DISPLAY }
