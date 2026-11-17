import Schema from '@deepseek-ai/schemastery'
import {
  SWARM_SERVICE,
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
  type ContextCompactionLike,
  type PromptAssemblyLike,
  type SessionProjectionsLike,
  type SystemPromptLike,
  type PluginContextLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import { LANGUAGE_NAMES, LANGUAGE_PLACEHOLDER, RELAXED_LANGUAGE_INSTRUCTION, getLanguageInstruction, type OutputLanguage } from './language.js'
import { getPromptStyle, type PromptStylePolicy } from './model-family.js'
import { ROLE_IDS, getChildPersona, isDelegableRoleId, isRoleId, type DelegableRoleId, type RoleId, type SuanHengMode } from './role-registry.js'
import type { SwarmService } from './service.js'
import { readLive } from './util/live.js'
import { SwarmError } from './util/errors.js'

export const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
export const OUTPUT_LANGUAGE_SECTION = 'dsh-agent-swarm:output-language'
/** Set only by the locally patched 0.2.2 Host that supports safe step re-preparation. */
export const STEP_MODEL_BRIDGE = Symbol.for('dsh-agent-swarm/step-model-bridge-v1')

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
export const getRuntimeAssembly = (assembled: PromptAssemblyLike, options: { language: OutputLanguage; languageExclusions?: readonly string[]; dynamicLanguage?: boolean; promptStyle: PromptStylePolicy; child?: ChildPromptInfo }): PromptAssemblyLike => {
  const child = options.child
  const language = child?.explicitLanguage === true ? child.language ?? options.language : options.language
  const variables = assembled.variables ?? {}
  const excluded = child !== undefined && child.explicitLanguage !== true && typeof variables.provider === 'string' && options.languageExclusions?.includes(variables.provider) === true
  const dynamic = child !== undefined && options.dynamicLanguage === true
  const style = getPromptStyle({ ...(variables.provider === undefined ? {} : { provider: variables.provider }), ...(variables.model === undefined ? {} : { model: variables.model }) }, options.promptStyle)
  const sections = (Array.isArray(assembled.sections) ? assembled.sections : []).filter((section) => section.name !== OUTPUT_LANGUAGE_SECTION).map((section) => {
    if (child !== undefined && section.name === PERSONA_PREFIX_SECTION) return { name: section.name, text: child.persona ?? getChildPersona(child.role, child.mode, style, excluded || dynamic ? null : language), interpolate: false }
    return section.text.includes(LANGUAGE_PLACEHOLDER) ? { ...section, text: section.text.replaceAll(LANGUAGE_PLACEHOLDER, LANGUAGE_NAMES[language]) } : section
  })
  return { ...assembled, sections: excluded || dynamic ? sections : [...sections, { name: OUTPUT_LANGUAGE_SECTION, text: getLanguageInstruction(language, child?.explicitLanguage === true), interpolate: false }] }
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
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined
  const dynamicLanguage = typeof systemPrompt?.context === 'function' && typeof systemPrompt.refreshContext === 'function'
  const admittedProviders = new Map<string, string>()
  const currentRole = (agent: AgentLike | undefined): RoleId | undefined => {
    const projected = service.getRoleForAgent?.(agent)
    if (projected !== undefined) return projected
    if (agent === undefined || getAgentHeader(agent).agentPreset !== undefined) return undefined
    const managed = service.isManagedAgent?.(agent)
    return managed === false ? undefined : presetRole
  }
  const childOf = (agent: AgentLike | undefined): ChildPromptInfo | undefined => {
    if (agent === undefined || getAgentHeader(agent).parentSession === undefined) return undefined
    const role = currentRole(agent)
    if (!isDelegableRoleId(role)) return undefined
    const remembered = service.getChildPrompt(agent.id)
    return remembered?.role === role ? remembered : { role }
  }
  if (dynamicLanguage) systemPrompt.context({
    name: OUTPUT_LANGUAGE_SECTION, order: 130, required: true, interpolate: false,
    text: ({ agent }) => {
      const child = childOf(agent)
      if (child === undefined || agent === undefined) return ''
      const policy = service.getConfig().agents
      const provider = admittedProviders.get(agent.id)
      if (child.explicitLanguage !== true && provider !== undefined && policy.languageExclusions.includes(provider)) return RELAXED_LANGUAGE_INSTRUCTION
      return getLanguageInstruction(child.explicitLanguage === true ? child.language ?? policy.language : policy.language, child.explicitLanguage === true)
    }
  })
  const isTracked = (agent: AgentLike): boolean => isRoleId(currentRole(agent))
    || getAgentHeader(agent).agentPreset === undefined && service.routeState.getChildRole(agent.id) !== undefined
  const hasStepModelBridge = (agent: AgentLike): boolean => (agent as unknown as Record<symbol, unknown>)[STEP_MODEL_BRIDGE] === true
  ctx.on('system-prompt/assemble', async (_assembly: unknown, context: { agent?: AgentLike } | undefined, next: () => Promise<PromptAssemblyLike>) => {
    const assembled = await next()
    const agent = context?.agent
    const config = service.getConfig()
    // 宿主冷恢复的持久子会话可能早于本插件登记：按所在角色预设兜底
    const child = childOf(agent)
    return getRuntimeAssembly(assembled, { language: config.agents.language, languageExclusions: config.agents.languageExclusions, dynamicLanguage, promptStyle: config.agents.promptStyle, ...(child === undefined ? {} : { child }) })
  })
  // Only the Host's explicit selection event means the user changed the picker.
  // Automatic request/header updates are observations, not selection intent.
  ctx.on('session/event', (session: { id: string; header?: { parentSession?: string } }, event: { type: string; seq?: number; data?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } }) => {
    const managedRole = currentRole({ id: session.id, session } as unknown as AgentLike)
    // Never create Source journal/session state for unrelated DSH sessions.
    if (!isRoleId(managedRole)) return
    try { service.ObserveSessionEvent?.(session.id, event) } catch (error) {
      ctx.logger?.('dsh-agent-swarm-runtime').warn(`Source event observation failed without blocking the Host turn: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`)
    }
    if (event.type !== 'model/selection' || !isRoleId(managedRole)) return
    const data = event.data
    if (typeof data?.provider !== 'string' || typeof data.model !== 'string') return
    const selected = { provider: data.provider, model: data.model, ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}) }
    service.routeState.RecordUserSelection(session.id, selected, event.seq)
    service.agentControl?.ObserveSelection(session.id, selected)
  })
  const prepareRoute = async (payload: { agent: AgentLike; turn?: number; step?: number; signal?: AbortSignal }, next: () => Promise<CallConfigLike>, beforeStep: boolean): Promise<CallConfigLike> => {
    await service.WaitAgentReady(payload.agent, payload.signal)
    if (!beforeStep) await service.BeforeManagedRequest(payload.agent)
    // 0.2.1-alpha 起宿主不再接受启动期 toolFilter：子智能体的第一次请求在这里按角色限制继承工具面，
    // 发生在工具清单装配之前；旧宿主该方法为空实现，启动期 toolFilter 仍然生效。
    const role = currentRole(payload.agent)
    if (isDelegableRoleId(role) && getAgentHeader(payload.agent).parentSession !== undefined) {
      service.ApplyChildToolScope(payload.agent, role, service.ChildAllowWebFor(payload.agent.id))
    }
    if (isTracked(payload.agent)) await service.routeState.WaitHealthReady(payload.agent.id, payload.signal)
    if (isTracked(payload.agent) && payload.turn !== undefined && payload.step !== undefined) service.routeState.BeginRequestStep(payload.agent.id, payload.turn, payload.step)
    const resolved = await next()
    const projection = (ctx.get('sessionProjections') as SessionProjectionsLike | undefined)?.stateOf(payload.agent.session, 'modelSelection')
    const explicitSelectionAvailable = projection !== null && typeof projection === 'object' && 'pending' in projection
    await service.routeState.PreparePreferredRecovery(payload.agent, resolved, presetRole, service.getConfig())
    await service.routeState.PrepareQuotaRouting(payload.agent, resolved, presetRole, service.getConfig(), payload.signal)
    if (isTracked(payload.agent)) await service.routeState.WaitHealthReady(payload.agent.id, payload.signal)
    const result = await service.routeState.AdmitRequest(payload.agent, resolved, presetRole, service.getConfig(), explicitSelectionAvailable, payload.signal)
    admittedProviders.set(payload.agent.id, result.provider)
    return result
  }
  // The bridge runs before the Host freezes the step's model, tools and prompt.
  // It is deliberately inert on stock Hosts and all existing 0.2.1 runtimes.
  ctx.on('agent/swarm-model-select', async (payload: { agent: AgentLike; turn?: number; step?: number; signal?: AbortSignal }, next: () => Promise<CallConfigLike>) => {
    if (!hasStepModelBridge(payload.agent) || service.isManagedAgent?.(payload.agent) === false) return next()
    const selected = await prepareRoute(payload, next, true)
    return { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }) }
  })
  ctx.on('agent/request', async (payload: { agent: AgentLike; turn?: number; step?: number; signal?: AbortSignal }, next: () => Promise<CallConfigLike>) => {
    if (service.isManagedAgent?.(payload.agent) === false) return next()
    const hostModel = (payload.agent as AgentLike & { model?: { current?: unknown; select?: unknown } }).model
    if (!hasStepModelBridge(payload.agent) && typeof hostModel?.current === 'function' && typeof hostModel.select === 'function') {
      throw new SwarmError('SERVICE_UNAVAILABLE', '当前 DSH 在步骤准备后冻结模型，百工需要匹配此版本的模型切换桥接；未发起模型请求')
    }
    // On the patched Host routing has already happened before assembly; never
    // change the selection inside this deprecated waterfall.
    let result: CallConfigLike
    if (hasStepModelBridge(payload.agent)) {
      try {
        await service.WaitAgentReady(payload.agent, payload.signal)
        await service.BeforeManagedRequest(payload.agent)
        result = await next()
      } catch (error) {
        service.routeState.ReleaseProbe(payload.agent.id)
        throw error
      }
    } else result = await prepareRoute(payload, next, false)
    service.agentControl?.ObserveRequest(payload.agent.id, result)
    const selected = service.routeState.getChildOverride(payload.agent.id)
    if (selected !== undefined) service.agentControl?.ObserveSelection(payload.agent.id, selected)
    return result
  })
  // prepend 在真实 Cordis waterfall 中先运行；没有调用 next 就截断宿主 retry 的 sleep。
  ctx.on('agent/request-error', async (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>) => {
    if (service.isManagedAgent?.(payload.agent) === false) return next()
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
    if (id !== undefined) admittedProviders.delete(id)
    if (id !== undefined) service.routeState.ReleaseAgent(id)
  })
}
