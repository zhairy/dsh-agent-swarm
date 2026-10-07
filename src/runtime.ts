import Schema from '@deepseek-ai/schemastery'
import {
  SWARM_SERVICE,
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
  ctx.on('agent/request', async (payload: { agent: AgentLike }, next: () => Promise<CallConfigLike>) =>
    service.routeState.getRequestOverride(payload.agent, await next(), presetRole, service.getConfig()))
  ctx.on('agent/request-error', async (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>) =>
    service.routeState.getErrorAction(payload, await next(), presetRole, service.getConfig()))
  ctx.on('agent/disposed', (event: { agent?: AgentLike } | undefined) => {
    const id = event?.agent?.id
    if (id !== undefined) service.routeState.ReleaseAgent(id)
  })
}
