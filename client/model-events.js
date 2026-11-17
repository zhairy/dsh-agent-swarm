// 百工会话模型事件投影：把宿主事件折叠成模型调用状态，不依赖 React。
// scripts/build-client.mjs 会把本模块作为内部依赖合并进 client bundle。

/** @type {{ presets: string[], providers: Record<string, string> }} */
const DISPLAY = __SWARM_DISPLAY__

const NS = 'swarmModelCalls'
const SWARM_NAMESPACE = 'swarm-core'
const KIND = 'swarm-model-call'
const HEADER_KIND = 'swarm-request-route'
const MARKER_KIND = 'swarm-session-marker'
const SWARM_MARKER = 'dsh-agent-swarm'
// 独立规划审核使用专用 persona；它仍带同源角色标记，但没有通用 persona 的包名。
const SWARM_ROLE_MARKER = /\[\[swarm:role=[a-z_]+\]\]/
const PRESETS = new Set(DISPLAY.presets)

/** 供应商中文名；未知供应商保留真实 ID。 */
const providerLabel = (provider) => DISPLAY.providers[provider] ?? provider
const isSwarmPreset = (value) => typeof value === 'string' && PRESETS.has(value)

/** request/header 的路由与推理强度。 */
const readHeaderRoute = (event) => {
  const config = event?.data?.header?.config
  if (config === null || typeof config !== 'object' || typeof config.provider !== 'string' || typeof config.model !== 'string') return undefined
  return { provider: config.provider, model: config.model, ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}) }
}

/** assistant/message 记录的实际作答模型。 */
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

/** 会话标记：是否百工会话。未知时由渲染时的 agentPreset 投影决定。 */
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
    return { swarm: text === '' ? previous?.swarm : text.includes(SWARM_MARKER) || SWARM_ROLE_MARKER.test(text) }
  },
  update: (context) => context.state,
  buildViewNode: () => null
}

/** 最近一次请求头：只提供推理强度，不渲染。 */
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

/** 「调用模型」行：每次调用一个节点；repeat 表示与同一轮上一次调用相同。 */
const modelCallDefinition = {
  kind: KIND,
  target: 'chat',
  match: (event) => isDurable(event) && ((event.type === 'assistant/message' && readMessageRoute(event) !== undefined) || event.type === 'assistant/attempt') ? startOnly(event) : null,
  start: (_context, match, reader) => {
    const previous = reader?.previous?.(KIND)?.state
    const header = reader?.previous?.(HEADER_KIND)?.state
    const route = readMessageRoute(match.event) ?? (match.event.type === 'assistant/attempt' ? header : undefined)
    const turn = turnOf(match)
    // conversation definition 的 start() 必须始终返回状态。分页窗口从中途 assistant/attempt
    // 开始时可能没有 request/header；返回继承上一状态的隐藏占位，既保持契约又不污染模型切换判断。
    if (route === undefined) {
      return {
        ...(previous ?? {}),
        seq: match.event.seq,
        ...(match.event.time === undefined ? {} : { time: match.event.time }),
        ...(turn === undefined ? {} : { turn }),
        anchorSeq: match.event.seq,
        __hidden: true
      }
    }
    const marker = reader?.previous?.(MARKER_KIND)?.state
    const headerEffort = header !== undefined && header.provider === route.provider && header.model === route.model ? header.reasoningEffort : undefined
    // 分页或压缩窗口可能先看到隐藏占位，再看到没有请求头的 assistant 消息。
    // 同一路由沿用上一条已观测强度，避免把“缺少窗口起点”误画成模型切换。
    const effort = headerEffort ?? (previous?.provider === route.provider && previous?.model === route.model ? previous.reasoningEffort : undefined)
    const sameModel = previous !== undefined && previous.provider === route.provider && previous.model === route.model
    const sameEffort = previous !== undefined && previous.reasoningEffort === effort
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
      repeat: sameModel && sameEffort && sameTurn,
      switched: sameTurn && !sameModel,
      effortChanged: sameTurn && sameModel && !sameEffort,
      ...(sameTurn && !sameModel ? { from: { provider: previous.provider, model: previous.model } } : {}),
      ...(marker?.swarm === undefined ? {} : { swarm: marker.swarm }),
      anchorSeq: location?.kind === 'step' ? (location.step.start?.seq ?? match.event.seq) : match.event.seq
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (context.start === undefined || state === undefined || state.__hidden === true) return null
    const visible = state.swarm !== false
    // 已经发布过的行改为隐藏而不是删除，保持 Chat 的节点键稳定。
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

exports.DISPLAY = DISPLAY
exports.NS = NS
exports.SWARM_NAMESPACE = SWARM_NAMESPACE
exports.KIND = KIND
exports.providerLabel = providerLabel
exports.isSwarmPreset = isSwarmPreset
exports.readHeaderRoute = readHeaderRoute
exports.readMessageRoute = readMessageRoute
exports.markerDefinition = markerDefinition
exports.headerDefinition = headerDefinition
exports.modelCallDefinition = modelCallDefinition
