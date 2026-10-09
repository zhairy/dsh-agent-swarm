import Schema from '@deepseek-ai/schemastery'
import {
  SWARM_SERVICE,
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
  type ContextCompactionLike,
  type SessionProjectionsLike,
  type PluginContextLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import { ROLE_IDS, isRoleId } from './role-registry.js'
import type { SwarmService } from './service.js'
import { readLive } from './util/live.js'

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
    if (isTracked(payload.agent)) await service.routeState.WaitHealthReady(payload.agent.id, payload.signal)
    if (isTracked(payload.agent) && payload.turn !== undefined && payload.step !== undefined) service.routeState.BeginRequestStep(payload.agent.id, payload.turn, payload.step)
    const resolved = await next()
    const projection = (ctx.get('sessionProjections') as SessionProjectionsLike | undefined)?.stateOf(payload.agent.session, 'modelSelection')
    const explicitSelectionAvailable = projection !== null && typeof projection === 'object' && 'pending' in projection
    await service.routeState.PreparePreferredRecovery(payload.agent, resolved, presetRole, service.getConfig())
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
