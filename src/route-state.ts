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
import { isNetworkSuspect, type NetworkMonitorInfo } from './network.js'
import { PROVIDER_CODEX, getFailureClass, getRouteKey, getRouteLabel, isSameRoute, isSwitchWorthy, type FailureClass, type RouteInfo, type RouteProbe } from './routes.js'
import { getUpgradedChain } from './upgrade.js'

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
  /** 连续会话：每次沉寂都会释放 Agent（触发 agent/disposed），路由状态要跨轮保留 */
  persistent?: boolean
}

/** 天枢根会话的容灾升级：升级期间请求改走升级链；picker 记录升级生效时对话框所选的模型 */
interface RootUpgradeStateInfo {
  chain: RouteInfo[]
  picker?: RouteInfo
}

interface RootStateInfo {
  override?: RouteInfo
  /** 回退覆盖生效的时刻；超过 rootRecoverMs 后重新尝试对话框所选模型 */
  at?: number
  /** 发生回退时选择器上的路由；宿主给出的路由与之不同，说明用户换了模型，覆盖作废 */
  picker?: RouteInfo
  tried: ReadonlySet<string>
}

/** 一次断网等待：开始等待（recovered 未定义）或等待结束 */
export interface NetworkWaitEventInfo {
  agentId: string
  scope: 'child' | 'root'
  route?: RouteInfo
  failure: LlmFailureLike
  /** 等待结束时：网络是否已恢复 */
  recovered?: boolean
  waitedMs?: number
}

/** 路由状态注册表的可选依赖 */
export interface RouteStateOptionsInfo {
  now?: () => number
  /** 联网探测；缺省时不做断网等待 */
  network?: NetworkMonitorInfo
  onNetworkWait?: (event: NetworkWaitEventInfo) => void
}

/** 同一会话连续断网等待的上限；超过后按常规回退，避免网络时断时续时无限等待 */
const MAX_NETWORK_WAITS = 3
/** 距上次等待超过这段时间，等待次数重新计数 */
const NETWORK_WAIT_RESET_MS = 30 * 60_000

/** 路由状态注册表：spawn 子智能体按链回退，swarm 预设的根会话按角色链回退 */
export interface RouteStateRegistry {
  /** 登记子智能体（或连续会话的新一轮）：路由链从头开始，已试记录清空 */
  AddChild: (agentId: string, state: { chain: RouteInfo[]; role: RoleId; onFallback?: (event: FallbackEventInfo) => void; persistent?: boolean }) => void
  getChild: (agentId: string) => { route: RouteInfo | undefined; role: RoleId; switches: number } | undefined
  getChildRole: (agentId: string) => RoleId | undefined
  /** 设置或撤销根会话的容灾升级链（已预检可用的路由） */
  SetRootUpgrade: (agentId: string, chain: RouteInfo[] | undefined) => void
  getRootUpgrade: (agentId: string) => RouteInfo[] | undefined
  DelAgent: (agentId: string) => void
  /** 宿主释放 Agent 时调用：连续会话子智能体的路由状态保留，其余清理 */
  ReleaseAgent: (agentId: string) => void
  getRequestOverride: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config?: SwarmConfigInfo) => CallConfigLike
  getErrorAction: (
    payload: RequestErrorPayloadLike,
    action: RequestErrorActionLike,
    presetRole: RoleId | undefined,
    config: SwarmConfigInfo
  ) => RequestErrorActionLike | Promise<RequestErrorActionLike>
}

/**
 * 发往 Codex 的推理强度：DSH 目录把 GPT-6 的最高档列为 ultra，而 Codex 线上协议只接受 max，
 * 订阅插件的本机补丁会做同样的映射；这里再兜底一次，补丁随插件升级丢失时也不会被 400 拒绝
 * @param {RouteInfo} route - 路由
 * @returns {string | undefined} 推理强度
 */
export const getWireEffort = (route: RouteInfo): string | undefined =>
  route.provider === PROVIDER_CODEX && route.reasoningEffort === 'ultra' ? 'max' : route.reasoningEffort

/** 换路由时丢弃继承的推理强度，避免把上一模型的强度套到新模型上 */
const getRoutedConfig = (resolved: CallConfigLike, route: RouteInfo): CallConfigLike => {
  const { reasoningEffort: _inherited, ...rest } = resolved
  const effort = getWireEffort(route)
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort })
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
 * @param {RouteProbe} [probe] - 根会话回退前的可用性预检；缺省时不预检
 * @param {RouteStateOptionsInfo} [options] - 时钟与断网等待
 * @returns {RouteStateRegistry} 注册表
 */
export const intRouteStateRegistry = (onRootFallback?: (event: FallbackEventInfo) => void, probe?: RouteProbe, options: RouteStateOptionsInfo = {}): RouteStateRegistry => {
  const now = options.now ?? Date.now
  const children = new Map<string, ChildStateInfo>()
  const roots = new Map<string, RootStateInfo>()
  const lastRoutes = new Map<string, RouteInfo>()
  /** 宿主给出的（改写前的）路由，用于判断用户是否换了模型 */
  const lastResolved = new Map<string, RouteInfo>()
  const upgrades = new Map<string, RootUpgradeStateInfo>()
  /** 断网等待次数（按会话） */
  const networkWaits = new Map<string, { count: number; last: number }>()

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

  const getRootFallback = (payload: RequestErrorPayloadLike, presetRole: RoleId, failureClass: FailureClass, action: RequestErrorActionLike, config: SwarmConfigInfo): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const agentId = payload.agent.id
    const failed = lastRoutes.get(agentId) ?? { provider: payload.provider, model: '' }
    const previous = roots.get(agentId)
    const picker = previous?.picker ?? lastResolved.get(agentId) ?? failed
    const tried = new Set([...(previous?.tried ?? []), getRouteLabel(failed)])
    const roleChain = getRoleRoute(config, getRouteKey(presetRole)).chain
    const upgrade = upgrades.get(agentId)
    // 升级期间：先在升级链内回退，再回到常规链
    const chain = upgrade === undefined ? roleChain : getUpgradedChain(upgrade.chain, roleChain)
    const settle = (next: number | undefined): RequestErrorActionLike => {
      if (next === undefined) {
        roots.set(agentId, { ...previous, picker, tried })
        return action
      }
      const to = chain[next] as RouteInfo
      roots.set(agentId, { override: to, at: now(), picker, tried })
      onRootFallback?.({ agentId, from: failed, to, failure: payload.failure, scope: 'root' })
      return { kind: 'retry' }
    }
    if (probe === undefined) return settle(FindNextIndex(chain, 0, tried, failed, failureClass))
    // 与子智能体一致：只回退到当前可解析的路由，不可用的记为已试并继续向后找
    const FindUsableIndex = async (): Promise<number | undefined> => {
      for (let next = FindNextIndex(chain, 0, tried, failed, failureClass); next !== undefined; next = FindNextIndex(chain, next + 1, tried, failed, failureClass)) {
        const route = chain[next] as RouteInfo
        if ((await probe(route)).ok) return next
        tried.add(getRouteLabel(route))
      }
      return undefined
    }
    return FindUsableIndex().then(settle)
  }

  /** 能否再等一次网络：同一会话 30 分钟内最多等 MAX_NETWORK_WAITS 次 */
  const canWaitNetwork = (agentId: string): boolean => {
    const record = networkWaits.get(agentId)
    if (record === undefined || now() - record.last > NETWORK_WAIT_RESET_MS) return true
    return record.count < MAX_NETWORK_WAITS
  }

  const AddNetworkWait = (agentId: string): void => {
    const record = networkWaits.get(agentId)
    const fresh = record === undefined || now() - record.last > NETWORK_WAIT_RESET_MS
    networkWaits.set(agentId, { count: fresh ? 1 : record.count + 1, last: now() })
  }

  /**
   * 断网时先等待网络恢复，恢复后在原路由上重试；网络正常（单个供应商故障）或等待超时时按常规回退
   * @returns 回退动作
   */
  const getNetworkAwareAction = (
    payload: RequestErrorPayloadLike, scope: 'child' | 'root', config: SwarmConfigInfo, fallback: () => RequestErrorActionLike | Promise<RequestErrorActionLike>
  ): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const network = options.network
    const agentId = payload.agent.id
    const waitMs = config.agents?.networkWaitMs ?? 0
    // 不需要探测时保持同步返回
    if (network === undefined || waitMs <= 0 || !isNetworkSuspect(payload.failure) || !canWaitNetwork(agentId)) return fallback()
    return (async () => {
      if (await network.isOnline()) return fallback()
      const route = lastRoutes.get(agentId)
      const started = now()
      AddNetworkWait(agentId)
      options.onNetworkWait?.({ agentId, scope, failure: payload.failure, ...(route === undefined ? {} : { route }) })
      const recovered = await network.waitOnline(payload.signal, waitMs)
      options.onNetworkWait?.({ agentId, scope, failure: payload.failure, recovered, waitedMs: now() - started, ...(route === undefined ? {} : { route }) })
      if (payload.signal?.aborted === true) return undefined
      return recovered ? { kind: 'retry' } : fallback()
    })()
  }

  return {
    AddChild: (agentId, state) => {
      children.set(agentId, {
        chain: state.chain, index: 0, role: state.role, tried: new Set(),
        ...(state.onFallback === undefined ? {} : { onFallback: state.onFallback }),
        ...(state.persistent === true ? { persistent: true } : {})
      })
    },
    getChild: (agentId) => {
      const state = children.get(agentId)
      return state === undefined ? undefined : { route: state.chain[state.index], role: state.role, switches: state.tried.size }
    },
    getChildRole: (agentId) => children.get(agentId)?.role,
    SetRootUpgrade: (agentId, chain) => {
      const root = roots.get(agentId)
      const previous = upgrades.get(agentId)
      if (chain === undefined || chain.length === 0) {
        upgrades.delete(agentId)
        // 撤销时，指向升级链的回退覆盖一并作废，回到对话框所选模型
        if (root?.override !== undefined && previous?.chain.some((route) => isSameRoute(route, root.override as RouteInfo))) roots.set(agentId, { ...root, override: undefined })
        return
      }
      upgrades.set(agentId, { chain: [...chain], ...(previous?.picker === undefined ? {} : { picker: previous.picker }) })
      // 升级优先于之前的回退覆盖；已试记录保留，升级链失败后不会再回到已失败的路由
      if (root?.override !== undefined) roots.set(agentId, { ...root, override: undefined })
    },
    getRootUpgrade: (agentId) => {
      const chain = upgrades.get(agentId)?.chain
      return chain === undefined ? undefined : [...chain]
    },
    DelAgent: (agentId) => {
      children.delete(agentId)
      upgrades.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
      lastResolved.delete(agentId)
      networkWaits.delete(agentId)
    },
    ReleaseAgent: (agentId) => {
      if (children.get(agentId)?.persistent === true) return
      children.delete(agentId)
      upgrades.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
      lastResolved.delete(agentId)
      networkWaits.delete(agentId)
    },
    getRequestOverride: (agent, resolved, _presetRole, config) => {
      const child = children.get(agent.id)
      const root = roots.get(agent.id)
      // 宿主给出的路由与回退时的选择器路由不同：用户换了模型，覆盖与已试记录一并作废
      if (child === undefined && root?.picker !== undefined && !isSameRoute(resolved, root.picker)) roots.delete(agent.id)
      // 回退覆盖到期：故障多半已经恢复（例如断网结束），重新尝试对话框所选模型；再失败会重新回退
      const recoverMs = config?.agents?.rootRecoverMs ?? 0
      const current = roots.get(agent.id)
      if (child === undefined && current?.override !== undefined && current.at !== undefined && recoverMs > 0 && now() - current.at >= recoverMs) roots.delete(agent.id)
      const upgrade = child === undefined ? upgrades.get(agent.id) : undefined
      // 升级生效后用户在对话框里换了模型：以用户的选择为准，撤销升级
      if (upgrade !== undefined && upgrade.picker !== undefined && !isSameRoute(resolved, upgrade.picker)) upgrades.delete(agent.id)
      else if (upgrade !== undefined && upgrade.picker === undefined) upgrade.picker = { provider: resolved.provider, model: resolved.model }
      lastResolved.set(agent.id, { provider: resolved.provider, model: resolved.model })
      const route = child === undefined ? (roots.get(agent.id)?.override ?? upgrades.get(agent.id)?.chain[0]) : child.chain[child.index]
      const next = route === undefined ? resolved : getRoutedConfig(resolved, route)
      lastRoutes.set(agent.id, { provider: next.provider, model: next.model })
      return next
    },
    getErrorAction: (payload, action, presetRole, config) => {
      const failureClass = getFailureClass(payload.failure)
      if (!isSwitchWorthy(failureClass, action === undefined)) return action
      const child = children.get(payload.agent.id)
      if (child !== undefined) {
        return getNetworkAwareAction(payload, 'child', config, () => {
          // 等待期间子智能体可能已被释放或重新登记：以最新状态为准
          const latest = children.get(payload.agent.id)
          return latest === undefined ? action : getChildFallback(payload.agent.id, latest, payload.failure, failureClass, action)
        })
      }
      if (!config.rootFallback || presetRole === undefined) return action
      if (getAgentHeader(payload.agent).parentSession !== undefined) return action
      return getNetworkAwareAction(payload, 'root', config, () => getRootFallback(payload, presetRole, failureClass, action, config))
    }
  }
}
