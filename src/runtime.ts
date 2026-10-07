import Schema from '@deepseek-ai/schemastery'
import {
  SWARM_SERVICE,
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
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
  ctx.on('agent/request', async (payload: { agent: AgentLike; turn?: number; step?: number }, next: () => Promise<CallConfigLike>) => {
    await service.WaitAgentReady(payload.agent)
    if (isTracked(payload.agent) && payload.turn !== undefined && payload.step !== undefined) service.routeState.BeginRequestStep(payload.agent.id, payload.turn, payload.step)
    return service.routeState.getRequestOverride(payload.agent, await next(), presetRole, service.getConfig())
  })
  // prepend 在真实 Cordis waterfall 中先运行；没有调用 next 就截断宿主 retry 的 sleep。
  ctx.on('agent/request-error', (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>) =>
    service.routeState.recover(payload, next, presetRole, service.getConfig()), { prepend: true })
  ctx.on('agent/assistant-stream', (payload: { agent: AgentLike; frame?: { type?: string; attemptId?: string; outcome?: { kind?: string; eventType?: string } } }) => {
    if (!isTracked(payload.agent)) return
    if (payload.frame?.type === 'start' && typeof payload.frame.attemptId === 'string') service.routeState.MarkRequestStarted(payload.agent.id, payload.frame.attemptId)
    // 真实宿主发布 end/committed（原始 finish 在 chunk 内）；失败只提交 assistant/attempt。
    if (payload.frame?.type === 'end' && payload.frame.outcome?.kind === 'committed' && payload.frame.outcome.eventType === 'assistant/message') service.routeState.MarkRequestSucceeded(payload.agent.id)
  })
  ctx.on('agent/disposed', (event: { agent?: AgentLike } | undefined) => {
    const id = event?.agent?.id
    if (id !== undefined) service.routeState.ReleaseAgent(id)
  })
}
