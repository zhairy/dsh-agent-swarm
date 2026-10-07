import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, getSwarmConfig } from './config.js'
import {
  MANAGED_AGENTS_KEY,
  SWARM_SERVICE,
  type AgentLike,
  type ConnectionLike,
  type ManagedAgentsInfo,
  type PreStepDecisionLike,
  type SubagentEndInfoLike,
  type AttachmentsLike,
  type CredentialsLike,
  type LlmLike,
  type PluginContextLike,
  type SessionProjectionsLike,
  type SubagentsLike,
  type ToolsLike
} from './host-contract.js'
import { intNetworkMonitor } from './network.js'
import { getRpcRoutes } from './rpc.js'
import { intSwarmService, type LoggerLike } from './service.js'

/** 宿主行：提供 agentSwarm 服务、注册写操作守卫与设置页 RPC，本身不向模型注册工具 */
export const name = 'dsh-agent-swarm'
export const inject = ['llm', 'subagents', 'tools']
export { Config }

const getLogger = (ctx: PluginContextLike): LoggerLike => {
  const logger = ctx.logger?.('dsh-agent-swarm')
  return {
    info: (message) => logger?.info(message),
    warn: (message) => logger?.warn(message)
  }
}

/**
 * DSH 主目录：profileContext.home → DSH_HOME → ~/.dsh
 * @param {PluginContextLike} ctx - 插件上下文
 * @returns {string} 目录
 */
export const getDshHome = (ctx: PluginContextLike): string => {
  const profile = ctx.get('profileContext') as { home?: string } | undefined
  return profile?.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'))
}

/**
 * 在 globalThis 登记百工管理的会话，供 dsh-llm-fallbacks 等插件跳过全局回退
 * @param {(agent: unknown) => boolean} isManaged - 判定函数
 * @returns {() => void} 撤销登记（只撤销自己登记的那一份）
 */
export const PublishManagedAgents = (isManaged: (agent: unknown) => boolean): (() => void) => {
  const registry: ManagedAgentsInfo = {
    version: 1,
    isManaged: (agent) => {
      if (agent === null || typeof agent !== 'object' || typeof (agent as { id?: unknown }).id !== 'string') return false
      try {
        return isManaged(agent)
      } catch {
        return false
      }
    }
  }
  const store = globalThis as Record<symbol, unknown>
  store[MANAGED_AGENTS_KEY] = registry
  return () => {
    if (store[MANAGED_AGENTS_KEY] === registry) delete store[MANAGED_AGENTS_KEY]
  }
}

/**
 * 宿主插件入口
 * @param {PluginContextLike} ctx - 插件上下文
 * @param {unknown} config - swarm-core 行的 Config（volatile）
 */
export const apply = (ctx: PluginContextLike, config: unknown): void => {
  const getConfig = () => getSwarmConfig(config)
  const fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
  const service = intSwarmService({
    getConfig,
    getLlm: () => ctx.get('llm') as LlmLike | undefined,
    getSubagents: () => ctx.get('subagents') as SubagentsLike | undefined,
    getTools: () => ctx.get('tools') as ToolsLike | undefined,
    getAttachments: () => ctx.get('attachments') as AttachmentsLike | undefined,
    getCredentials: () => ctx.get('credentials') as CredentialsLike | undefined,
    getSessionProjections: () => ctx.get('sessionProjections') as SessionProjectionsLike | undefined,
    dshHome: getDshHome(ctx),
    fetch: fetchImpl,
    logger: getLogger(ctx),
    network: intNetworkMonitor({ fetch: fetchImpl, getUrls: () => getConfig().agents.networkProbeUrls })
  })
  ctx.effect(() => ctx.provide(SWARM_SERVICE, service))
  ctx.effect(() => PublishManagedAgents((agent) => service.isManagedAgent(agent as AgentLike)))
  // 连续会话（continuable）的每一轮结束都经 subagent/end 通知；swarm_delegate 据此取回结果
  ctx.on('subagent/end', (info: SubagentEndInfoLike) => service.OnSubagentEnd(info))
  // 宿主还会把「子智能体已结束」通知投给天枢；结果已由 swarm_delegate 返回，重复的通知在进入上下文前滤掉
  ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<PreStepDecisionLike>) => service.FilterPreStep(await next()))
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools !== undefined) ctx.effect(() => tools.guard((execution) => service.getGuardReason(execution)))
  // 设置页「Jev API key」卡片的状态与测试连接；无界面的 profile 没有 connection，跳过
  ctx.inject?.(['connection'], (scoped) => {
    const connection = scoped.get('connection') as ConnectionLike | undefined
    if (connection?.fetch?.register === undefined) return
    for (const route of getRpcRoutes(() => service.jev)) scoped.effect(() => connection.fetch.register(route))
  })
}
