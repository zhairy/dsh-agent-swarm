import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, getSwarmConfig } from './config.js'
import {
  SWARM_SERVICE,
  type AttachmentsLike,
  type CredentialsLike,
  type LlmLike,
  type PluginContextLike,
  type SubagentsLike,
  type ToolsLike
} from './host-contract.js'
import { intSwarmService, type LoggerLike } from './service.js'

/** 宿主行：提供 agentSwarm 服务并注册写操作守卫，本身不向模型注册工具 */
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
 * 宿主插件入口
 * @param {PluginContextLike} ctx - 插件上下文
 * @param {unknown} config - swarm-core 行的 Config（volatile）
 */
export const apply = (ctx: PluginContextLike, config: unknown): void => {
  const service = intSwarmService({
    getConfig: () => getSwarmConfig(config),
    getLlm: () => ctx.get('llm') as LlmLike | undefined,
    getSubagents: () => ctx.get('subagents') as SubagentsLike | undefined,
    getTools: () => ctx.get('tools') as ToolsLike | undefined,
    getAttachments: () => ctx.get('attachments') as AttachmentsLike | undefined,
    getCredentials: () => ctx.get('credentials') as CredentialsLike | undefined,
    dshHome: getDshHome(ctx),
    fetch: (input, init) => globalThis.fetch(input, init),
    logger: getLogger(ctx)
  })
  ctx.effect(() => ctx.provide(SWARM_SERVICE, service))
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools !== undefined) ctx.effect(() => tools.guard((execution) => service.getGuardReason(execution)))
}
