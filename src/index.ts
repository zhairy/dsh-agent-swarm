import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config, getSwarmConfig, getRoleRoute } from './config.js'
import {
  MANAGED_AGENTS_KEY,
  SWARM_SERVICE,
  type AgentLike,
  type SessionHeaderLike,
  type ConnectionLike,
  type ManagedAgentsInfo,
  type PreStepDecisionLike,
  type PreToolDecisionLike,
  type ApprovalServiceLike,
  type ToolExecutionLike,
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
import { getSubscriptionPoolConfiguration } from './quota-routing.js'
import { createQuotaRoutingSource } from './quota-routing-source.js'
import { createQuotaReader, createSubscriptionQuotaInvoker } from './quota.js'
import { ROLE_INFO_LIST } from './role-registry.js'
import { getRouteKey } from './routes.js'
import { getRpcRoutes } from './rpc.js'
import { intSwarmService, type LoggerLike } from './service.js'
import { getHostApprovalPolicy, getToolApprovalDecision } from './approval-policy.js'
import { inspectChildRecovery, inspectRootPreference } from './host-recovery.js'
import type { RouteInfo } from './routes.js'

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
  const rootMetadata = new Map<string, Promise<{ header: SessionHeaderLike; preference?: RouteInfo } | undefined>>()
  const inspectRootMetadata = (id: string) => {
    let pending = rootMetadata.get(id)
    if (pending !== undefined) return pending
    pending = (async () => {
      const controller = ctx.get('sessionController') as { inspect: (id: string) => Promise<{ meta: SessionHeaderLike }> } | undefined
      if (controller === undefined) return undefined
      const inspection = await controller.inspect(id)
      const preference = inspectRootPreference(inspection)
      // Retain only bounded metadata, never an entire inspected conversation.
      return { header: inspection.meta, ...(preference === undefined ? {} : { preference }) }
    })().catch((error) => { rootMetadata.delete(id); throw error })
    rootMetadata.set(id, pending)
    return pending
  }
  let quotaConnection: ConnectionLike | undefined
  const quotaInvoke = createSubscriptionQuotaInvoker(() => quotaConnection?.createSharedFetchHandler?.('/api'))
  const quotaReader = createQuotaReader({ invoke: quotaInvoke })
  const quotaSource = createQuotaRoutingSource({ reader: quotaReader, invoke: quotaInvoke,
    available: () => quotaConnection?.createSharedFetchHandler !== undefined,
    getPoolConfiguration: () => getSubscriptionPoolConfiguration(ctx.get('configEditor') as { entries: () => readonly unknown[] } | undefined),
    getRegisteredProviders: () => (ctx.get('llm') as LlmLike | undefined)?.listProviders().map(provider => provider.id) ?? [] })
  ctx.on('llm/adapters-updated', () => quotaSource.invalidate())
  const service = intSwarmService({
    orderQuotaRoutes: quotaSource.orderQuotaRoutes, onQuotaRouteSuccess: quotaSource.succeeded, quotaDiagnostics: quotaSource.diagnostics,
    getConfig,
    getLlm: () => ctx.get('llm') as LlmLike | undefined,
    getSubagents: () => ctx.get('subagents') as SubagentsLike | undefined,
    getTools: () => ctx.get('tools') as ToolsLike | undefined,
    getAttachments: () => ctx.get('attachments') as AttachmentsLike | undefined,
    getCredentials: () => ctx.get('credentials') as CredentialsLike | undefined,
    getApproval: () => ctx.get('approval') as ApprovalServiceLike | undefined,
    getSessionProjections: () => ctx.get('sessionProjections') as SessionProjectionsLike | undefined,
    getAgent: (sessionId) => (ctx.get('agents') as { get: (id: string) => AgentLike | undefined } | undefined)?.get(sessionId),
    inspectParent: async (sessionId) => (await inspectRootMetadata(sessionId))?.header,
    inspectRootPreference: async (sessionId) => (await inspectRootMetadata(sessionId))?.preference,
    activateParent: async (sessionId) => {
      const controller = ctx.get('sessionController') as { resolveAgent: (id: string) => Promise<{ agent?: AgentLike; error?: unknown }> } | undefined
      return (await controller?.resolveAgent(sessionId))?.agent
    },
    inspectChild: async (parentSessionId, childId, notBefore) => {
      const controller = ctx.get('sessionController') as { inspect: (id: string) => Promise<unknown> } | undefined
      const subagents = ctx.get('subagents') as SubagentsLike | undefined
      if (controller === undefined || subagents?.listChildren === undefined) return undefined
      const [inspection, catalog] = await Promise.all([controller.inspect(childId), subagents.listChildren(parentSessionId)])
      return inspectChildRecovery({ parentSessionId, childId, inspection, catalog, ...(notBefore === undefined ? {} : { notBefore }) })
    },
    dshHome: getDshHome(ctx),
    fetch: fetchImpl,
    logger: getLogger(ctx),
    network: intNetworkMonitor({ fetch: fetchImpl, getUrls: () => getConfig().agents.networkProbeUrls })
  })
  ctx.effect(() => ctx.provide(SWARM_SERVICE, service))
  ctx.effect(() => () => { quotaSource.dispose(); return service.dispose() })
  ctx.effect(() => PublishManagedAgents((agent) => service.isManagedAgent(agent as AgentLike)))
  // 连续会话（continuable）的每一轮结束都经 subagent/end 通知；swarm_delegate 据此取回结果
  ctx.on('subagent/end', (info: SubagentEndInfoLike) => service.OnSubagentEnd(info))
  // 宿主还会把「子智能体已结束」通知投给天枢；结果已由 swarm_delegate 返回，重复的通知在进入上下文前滤掉
  ctx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<PreStepDecisionLike>) => service.FilterPreStep(await next()))
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (tools !== undefined) ctx.effect(() => tools.guard((execution) => service.getGuardReason(execution)))
  // This stage follows admission and the monotonic guards. A rejected tool is
  // never evidence that a writer actually entered the execution pipeline.
  ctx.on('tools/execute', (execution: ToolExecutionLike, next: () => Promise<unknown>) => {
    service.ObserveToolDispatch(execution)
    return next()
  })
  // Wrap the complete downstream policy, retaining its deny/cancel/ask. Host approval and
  // monotonic role/revision/workspace guards remain authoritative after this seam.
  ctx.on('tools/pre-execute', async (execution: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) => {
    const decision = await next()
    if (!service.isManagedAgent(execution.agent)) return decision
    const approvals = getConfig().approvals
    return getToolApprovalDecision(execution, decision, approvals, {
      ...(approvals.mode === 'ask' && decision.kind === 'allow' ? { hostPolicy: getHostApprovalPolicy(ctx.get('approval') as ApprovalServiceLike | undefined, execution.agent) } : {})
    })
  }, { prepend: true })
  // 使用宿主 connection 同一 profile owner 的认证，任务只读并要求已登记根会话。
  // 本层不宣称跨租户 ACL；无界面的 profile 没有 connection，跳过。
  ctx.inject?.(['connection'], (scoped) => {
    const connection = scoped.get('connection') as ConnectionLike | undefined
    if (connection?.fetch?.register === undefined) return
    quotaConnection = connection
    scoped.effect(() => () => { if (quotaConnection === connection) { quotaConnection = undefined; quotaSource.invalidate() } })
    const quotaRoutes = (): RouteInfo[] => {
      const config = getConfig(), routes: RouteInfo[] = []
      for (const role of ROLE_INFO_LIST) for (const mode of role.id === 'suan_heng' ? ['research', 'verify'] as const : [undefined]) {
        const selected = getRoleRoute(config, getRouteKey(role.id, mode))
        routes.push(...selected.chain, ...(selected.upgrade?.enabled ? selected.upgrade.chain : []))
      }
      const seen = new Set<string>()
      return routes.filter(route => { const key = JSON.stringify(route); if (seen.has(key)) return false; seen.add(key); return true })
    }
    for (const route of getRpcRoutes(() => service.jev, {
      quotaView: (force, signal) => { if (force) quotaSource.invalidate(); return quotaReader.read({ routes: quotaRoutes(), force, signal }) },
      taskView: (sessionId, taskId) => service.getTaskViewForRpc(sessionId, taskId),
      agentView: service.getAgentViewForRpc, agentControl: service.ControlAgentForRpc
    })) scoped.effect(() => connection.fetch.register(route))
  })
}
