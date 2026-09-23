import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import {
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
  type LlmFailureLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import type { RoleId } from './role-registry.js'
import { getFailureClass, getRouteKey, getRouteLabel, isSameRoute, isSwitchWorthy, type FailureClass, type RouteInfo } from './routes.js'

/** 一次路由回退 */
export interface FallbackEventInfo {
  agentId: string
  from: RouteInfo
  to: RouteInfo
  failure: LlmFailureLike
  scope: 'child' | 'root'
}

interface ChildStateInfo {
  chain: RouteInfo[]
  index: number
  role: RoleId
  tried: ReadonlySet<string>
  onFallback?: (event: FallbackEventInfo) => void
}

interface RootStateInfo {
  override?: RouteInfo
  /** 发生回退时选择器上的路由；宿主给出的路由与之不同，说明用户换了模型，覆盖作废 */
  picker?: RouteInfo
  tried: ReadonlySet<string>
}

/** 路由状态注册表：spawn 子智能体按链回退，swarm 预设的根会话按角色链回退 */
export interface RouteStateRegistry {
  AddChild: (agentId: string, state: { chain: RouteInfo[]; role: RoleId; onFallback?: (event: FallbackEventInfo) => void }) => void
  getChild: (agentId: string) => { route: RouteInfo | undefined; role: RoleId; switches: number } | undefined
  getChildRole: (agentId: string) => RoleId | undefined
  DelAgent: (agentId: string) => void
  getRequestOverride: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined) => CallConfigLike
  getErrorAction: (
    payload: RequestErrorPayloadLike,
    action: RequestErrorActionLike,
    presetRole: RoleId | undefined,
    config: SwarmConfigInfo
  ) => RequestErrorActionLike
}

/** 换路由时丢弃继承的推理强度，避免把上一模型的强度套到新模型上 */
const getRoutedConfig = (resolved: CallConfigLike, route: RouteInfo): CallConfigLike => {
  const { reasoningEffort: _inherited, ...rest } = resolved
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
  }
}

/** 从 start 起找第一条未试过的路由；认证失败时跳过同一 provider */
const FindNextIndex = (chain: RouteInfo[], start: number, tried: ReadonlySet<string>, failed: RouteInfo, failureClass: FailureClass): number | undefined => {
  for (let index = start; index < chain.length; index++) {
    const route = chain[index] as RouteInfo
    if (tried.has(getRouteLabel(route))) continue
    if (failureClass === 'auth' && route.provider === failed.provider) continue
    return index
  }
  return undefined
}

/**
 * 创建路由状态注册表
 * @param {(event: FallbackEventInfo) => void} [onRootFallback] - 根会话回退时的回调（记日志）
 * @returns {RouteStateRegistry} 注册表
 */
export const intRouteStateRegistry = (onRootFallback?: (event: FallbackEventInfo) => void): RouteStateRegistry => {
  const children = new Map<string, ChildStateInfo>()
  const roots = new Map<string, RootStateInfo>()
  const lastRoutes = new Map<string, RouteInfo>()
  /** 宿主给出的（改写前的）路由，用于判断用户是否换了模型 */
  const lastResolved = new Map<string, RouteInfo>()

  const getChildFallback = (agentId: string, state: ChildStateInfo, failure: LlmFailureLike, failureClass: FailureClass, action: RequestErrorActionLike): RequestErrorActionLike => {
    const current = state.chain[state.index] as RouteInfo
    const tried = new Set([...state.tried, getRouteLabel(current)])
    const next = FindNextIndex(state.chain, state.index + 1, tried, current, failureClass)
    if (next === undefined) {
      children.set(agentId, { ...state, tried })
      return action
    }
    const to = state.chain[next] as RouteInfo
    children.set(agentId, { ...state, index: next, tried })
    state.onFallback?.({ agentId, from: current, to, failure, scope: 'child' })
    return { kind: 'retry' }
  }

  const getRootFallback = (payload: RequestErrorPayloadLike, presetRole: RoleId, failureClass: FailureClass, action: RequestErrorActionLike, config: SwarmConfigInfo): RequestErrorActionLike => {
    const agentId = payload.agent.id
    const failed = lastRoutes.get(agentId) ?? { provider: payload.provider, model: '' }
    const previous = roots.get(agentId)
    const picker = previous?.picker ?? lastResolved.get(agentId) ?? failed
    const tried = new Set([...(previous?.tried ?? []), getRouteLabel(failed)])
    const chain = getRoleRoute(config, getRouteKey(presetRole)).chain
    const next = FindNextIndex(chain, 0, tried, failed, failureClass)
    if (next === undefined) {
      roots.set(agentId, { ...previous, picker, tried })
      return action
    }
    const to = chain[next] as RouteInfo
    roots.set(agentId, { override: to, picker, tried })
    onRootFallback?.({ agentId, from: failed, to, failure: payload.failure, scope: 'root' })
    return { kind: 'retry' }
  }

  return {
    AddChild: (agentId, state) => {
      children.set(agentId, { chain: state.chain, index: 0, role: state.role, tried: new Set(), ...(state.onFallback === undefined ? {} : { onFallback: state.onFallback }) })
    },
    getChild: (agentId) => {
      const state = children.get(agentId)
      return state === undefined ? undefined : { route: state.chain[state.index], role: state.role, switches: state.tried.size }
    },
    getChildRole: (agentId) => children.get(agentId)?.role,
    DelAgent: (agentId) => {
      children.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
      lastResolved.delete(agentId)
    },
    getRequestOverride: (agent, resolved) => {
      const child = children.get(agent.id)
      const root = roots.get(agent.id)
      // 宿主给出的路由与回退时的选择器路由不同：用户换了模型，覆盖与已试记录一并作废
      if (child === undefined && root?.picker !== undefined && !isSameRoute(resolved, root.picker)) roots.delete(agent.id)
      lastResolved.set(agent.id, { provider: resolved.provider, model: resolved.model })
      const route = child === undefined ? roots.get(agent.id)?.override : child.chain[child.index]
      const next = route === undefined ? resolved : getRoutedConfig(resolved, route)
      lastRoutes.set(agent.id, { provider: next.provider, model: next.model })
      return next
    },
    getErrorAction: (payload, action, presetRole, config) => {
      const failureClass = getFailureClass(payload.failure)
      if (!isSwitchWorthy(failureClass, action === undefined)) return action
      const child = children.get(payload.agent.id)
      if (child !== undefined) return getChildFallback(payload.agent.id, child, payload.failure, failureClass, action)
      if (!config.rootFallback || presetRole === undefined) return action
      if (getAgentHeader(payload.agent).parentSession !== undefined) return action
      return getRootFallback(payload, presetRole, failureClass, action, config)
    }
  }
}
