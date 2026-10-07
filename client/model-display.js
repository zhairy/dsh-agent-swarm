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
  badge: '当前模型'
}

const en = {
  title: 'Model call',
  switched: 'Model switched',
  effort: 'effort',
  from: 'was',
  badge: 'Current model'
}

const providerLabel = (provider) => DISPLAY.providers[provider] ?? provider

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
  match: (event) => event.type === 'assistant/message' && isDurable(event) && readMessageRoute(event) !== undefined ? startOnly(event) : null,
  start: (_context, match, reader) => {
    const route = readMessageRoute(match.event)
    const previous = reader?.previous?.(KIND)?.state
    const header = reader?.previous?.(HEADER_KIND)?.state
    const marker = reader?.previous?.(MARKER_KIND)?.state
    const turn = turnOf(match)
    const sameRoute = previous !== undefined && previous.provider === route.provider && previous.model === route.model
    const sameTurn = previous !== undefined && previous.turn === turn
    const effort = header !== undefined && header.provider === route.provider && header.model === route.model ? header.reasoningEffort : undefined
    const location = match.location
    return {
      seq: match.event.seq,
      time: match.event.time,
      ...(turn === undefined ? {} : { turn }),
      provider: route.provider,
      model: route.model,
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
  summary: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)' },
  badge: {
    display: 'inline-block', maxWidth: 260, padding: '0 8px', borderRadius: 999, fontSize: 12, lineHeight: '20px',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'middle',
    background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)'
  }
}

const isSwarmPreset = (value) => typeof value === 'string' && PRESETS.has(value)

const routeText = (t, route) =>
  `${route.model} · ${providerLabel(route.provider)}（${route.provider}）${route.reasoningEffort === undefined ? '' : ` · ${t('effort')} ${route.reasoningEffort}`}`

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
  if (!isSwarmPreset(preset)) return null
  const used = selection?.lastUsed ?? selection?.next
  if (used === null || used === undefined || typeof used.provider !== 'string' || typeof used.model !== 'string') return null
  return h('span', { style: style.badge, title: `${t('badge')}：${routeText(t, used)}`, 'data-swarm-model-badge': used.provider },
    `${used.model} · ${providerLabel(used.provider)}`)
}

const inject = ['slots', 'locale', 'uiConversation']

const NO_SUBSCRIBE = () => () => undefined

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
  })
}

exports.inject = inject
exports.apply = apply
exports.NS = NS
exports.__test__ = { markerDefinition, headerDefinition, modelCallDefinition, ModelCallRow, ModelBadge, readHeaderRoute, readMessageRoute, getModelCallModeHook, DISPLAY }
