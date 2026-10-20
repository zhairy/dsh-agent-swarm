import Schema from '@deepseek-ai/schemastery'
import {
  SWARM_SERVICE,
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
  type ContextCompactionLike,
  type PromptAssemblyLike,
  type SessionProjectionsLike,
  type PluginContextLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import { LANGUAGE_NAMES, LANGUAGE_PLACEHOLDER, getLanguageInstruction, type OutputLanguage } from './language.js'
import { getPromptStyle, type PromptStylePolicy } from './model-family.js'
import { ROLE_IDS, getChildPersona, isDelegableRoleId, isRoleId, type DelegableRoleId, type SuanHengMode } from './role-registry.js'
import type { SwarmService } from './service.js'
import { readLive } from './util/live.js'

export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
export const OUTPUT_LANGUAGE_SECTION = 'dsh-agent-swarm:output-language'

/** 委派出的子会话在系统提示里的身份：角色、算衡模式、语言；规划审核等特殊子会话可给出固定 persona */
export interface ChildPromptInfo {
  role: DelegableRoleId
  mode?: SuanHengMode
  language?: OutputLanguage
  explicitLanguage?: boolean
  persona?: string
}

/**
 * 每次组装系统提示时：把各段里的 {$language} 换成设置页选择的语言，并在末尾追加用该语言书写的输出语言要求；
 * 委派出的子会话（0.2.1 起其 persona 来自静态角色预设）换成按实际路由模型家族生成的委派专用 persona。
 * @param {PromptAssemblyLike} assembled - 宿主组装结果
 * @param {{ language: OutputLanguage; promptStyle: PromptStylePolicy; child?: ChildPromptInfo }} options - 语言、提示风格与子会话身份
 * @returns {PromptAssemblyLike} 新的组装结果
 */
export const getRuntimeAssembly = (assembled: PromptAssemblyLike, options: { language: OutputLanguage; promptStyle: PromptStylePolicy; child?: ChildPromptInfo }): PromptAssemblyLike => {
  const child = options.child
  const language = child?.language ?? options.language
  const variables = assembled.variables ?? {}
  const style = getPromptStyle({ ...(variables.provider === undefined ? {} : { provider: variables.provider }), ...(variables.model === undefined ? {} : { model: variables.model }) }, options.promptStyle)
  const sections = (Array.isArray(assembled.sections) ? assembled.sections : []).filter((section) => section.name !== OUTPUT_LANGUAGE_SECTION).map((section) => {
    if (child !== undefined && section.name === PERSONA_PREFIX_SECTION) return { name: section.name, text: child.persona ?? getChildPersona(child.role, child.mode, style, language), interpolate: false }
    return section.text.includes(LANGUAGE_PLACEHOLDER) ? { ...section, text: section.text.replaceAll(LANGUAGE_PLACEHOLDER, LANGUAGE_NAMES[language]) } : section
  })
  return { ...assembled, sections: [...sections, { name: OUTPUT_LANGUAGE_SECTION, text: getLanguageInstruction(language, child?.explicitLanguage === true), interpolate: false }] }
}

/** 预设行：挂在全部 13 个预设上，在预设作用域内改写路由并处理回退 */
export const name = 'dsh-agent-swarm-runtime'
export const inject = [SWARM_SERVICE]

export const Config = Schema.object({
  role: Schema.union([...ROLE_IDS]).required().description('本预设对应的角色 ID')
})

/**
 * 运行时插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 * @param {unknown} config - `{ role }`
 */
export const apply = (ctx: PluginContextLike, config: unknown): void => {
  const service = ctx.get(SWARM_SERVICE) as SwarmService | undefined
  if (service === undefined) return
  const role = readLive<unknown>((config as { role?: unknown } | undefined)?.role)
  const presetRole = isRoleId(role) ? role : undefined
  const isTracked = (agent: AgentLike): boolean => service.routeState.getChildRole(agent.id) !== undefined || (presetRole !== undefined && getAgentHeader(agent).parentSession === undefined)
  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: { agent?: AgentLike } | undefined, next: () => Promise<PromptAssemblyLike>) => {
    const assembled = await next()
    const agent = context?.agent
    const config = service.getConfig()
    // 宿主冷恢复的持久子会话可能早于本插件登记：按所在角色预设兜底
    const child = agent === undefined || getAgentHeader(agent).parentSession === undefined ? undefined
      : service.getChildPrompt(agent.id) ?? (isDelegableRoleId(presetRole) ? { role: presetRole } : undefined)
    return getRuntimeAssembly(assembled, { language: config.agents.language, promptStyle: config.agents.promptStyle, ...(child === undefined ? {} : { child }) })
  })
  // Only the Host's explicit selection event means the user changed the picker.
  // Automatic request/header updates are observations, not selection intent.
  ctx.on('session/event', (session: { id: string; header?: { parentSession?: string } }, event: { type: string; seq?: number; data?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }) => {
    if (event.type !== 'model/selection' || (service.routeState.getChildRole(session.id) === undefined && !(presetRole !== undefined && session.header?.parentSession === undefined))) return
    const data = event.data
    if (typeof data?.provider !== 'string' || typeof data.model !== 'string') return
    const selected = { provider: data.provider, model: data.model, ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}) }
    service.routeState.RecordUserSelection(session.id, selected, event.seq)
    service.agentControl?.ObserveSelection(session.id, selected)
  })
  ctx.on('agent/request', async (payload: { agent: AgentLike; turn?: number; step?: number; signal?: AbortSignal }, next: () => Promise<CallConfigLike>) => {
    await service.WaitAgentReady(payload.agent)
    // 0.2.1-alpha 起宿主不再接受启动期 toolFilter：子智能体的第一次请求在这里按角色限制继承工具面，
    // 发生在工具清单装配之前；旧宿主该方法为空实现，启动期 toolFilter 仍然生效。
    if (presetRole !== undefined && presetRole !== 'tian_shu' && getAgentHeader(payload.agent).parentSession !== undefined) {
      service.ApplyChildToolScope(payload.agent, presetRole, service.ChildAllowWebFor(payload.agent.id))
    }
    if (isTracked(payload.agent)) await service.routeState.WaitHealthReady(payload.agent.id, payload.signal)
    if (isTracked(payload.agent) && payload.turn !== undefined && payload.step !== undefined) service.routeState.BeginRequestStep(payload.agent.id, payload.turn, payload.step)
    const resolved = await next()
    const projection = (ctx.get('sessionProjections') as SessionProjectionsLike | undefined)?.stateOf(payload.agent.session, 'modelSelection')
    const explicitSelectionAvailable = projection !== null && typeof projection === 'object' && 'pending' in projection
    await service.routeState.PreparePreferredRecovery(payload.agent, resolved, presetRole, service.getConfig())
    await service.routeState.PrepareQuotaRouting(payload.agent, resolved, presetRole, service.getConfig(), payload.signal)
    if (isTracked(payload.agent)) await service.routeState.WaitHealthReady(payload.agent.id, payload.signal)
    const result = service.routeState.getRequestOverride(payload.agent, resolved, presetRole, service.getConfig(), explicitSelectionAvailable)
    service.agentControl?.ObserveRequest(payload.agent.id, result)
    const selected = service.routeState.getChildOverride(payload.agent.id)
    if (selected !== undefined) service.agentControl?.ObserveSelection(payload.agent.id, selected)
    return result
  })
  // prepend 在真实 Cordis waterfall 中先运行；没有调用 next 就截断宿主 retry 的 sleep。
  ctx.on('agent/request-error', async (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>) => {
    const result = await service.routeState.recover(payload, next, presetRole, service.getConfig(), ctx.get('compaction') as ContextCompactionLike | undefined)
    if (service.routeState.getTerminal(payload.agent.id) === 'context_recovery_required') service.agentControl?.MarkBlocked(payload.agent.id, 'context-recovery-required')
    return result
  }, { prepend: true })
  ctx.on('agent/assistant-stream', (payload: { agent: AgentLike; frame?: { type?: string; attemptId?: string; outcome?: { kind?: string; eventType?: string } } }) => {
    if (!isTracked(payload.agent)) return
    if (payload.frame?.type === 'start' && typeof payload.frame.attemptId === 'string') {
      const actual = payload.agent.session?.requestHeader?.()?.config
      service.routeState.MarkRequestStarted(payload.agent.id, payload.frame.attemptId, actual)
      service.agentControl?.MarkAttemptStarted(payload.agent.id, payload.frame.attemptId, service.routeState.getLastRoute(payload.agent.id))
    }
    // 真实宿主发布 end/committed（原始 finish 在 chunk 内）；失败只提交 assistant/attempt。
    if (payload.frame?.type === 'end' && payload.frame.outcome?.kind === 'committed' && payload.frame.outcome.eventType === 'assistant/message') service.routeState.MarkRequestSucceeded(payload.agent.id)
    if (payload.frame?.type === 'end' && typeof payload.frame.attemptId === 'string') service.agentControl?.MarkAttemptSettled(payload.agent.id, payload.frame.attemptId)
  })
  ctx.on('agent/disposed', (event: { agent?: AgentLike } | undefined) => {
    const id = event?.agent?.id
    if (id !== undefined) service.routeState.ReleaseAgent(id)
  })
}
