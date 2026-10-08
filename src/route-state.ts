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
import { isNetworkSuspect, SleepWithSignal, type NetworkMonitorInfo } from './network.js'
import { normalizeRouteFailure, isTerminalRouteFailure, getRouteResourcePolicy, type RouteFailureMetadata } from './provider-policy.js'
import { intRouteHealth, type RouteHealth, type RouteHealthEntry } from './route-health.js'
import { SwarmError } from './util/errors.js'
import { PROVIDER_CODEX, getFailureClass, getRouteKey, getRouteLabel, isSameRoute, type FailureClass, type RouteInfo, type RouteProbe } from './routes.js'
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
  logicalRequestId?: string
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
  health?: RouteHealth
  recovery?: Partial<RecoveryPolicy>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 持久化启用时，故障域必须提交后才把恢复动作交给宿主；失败不得被吞掉。 */
  onHealthChange?: (entries: RouteHealthEntry[], event: { agentId?: string; reason: 'failure' | 'probe' }) => void | Promise<void>
}

export interface RequestRecoveryState {
  logicalRequestId: string
  attempts: number
  transientRetries: number
  waitedMs: number
  attemptedRoutes: string[]
  terminal?: 'route_chain_exhausted' | 'recovery_attempts_exhausted' | 'route_health_persist_failed'
  suppressedRetryAfterMs?: number
  completed?: boolean
  /** admission 是保守上限，真实 stream/start 观测另外计数；未提供事件的宿主为 unknown。 */
  observedModelAttempts?: number
  observedAttemptIds?: string[]
  observationCoverage?: 'agent-loop-stream-attempts'
}
export interface RecoveryPolicy {
  maxTransientRetries: number
  maxShortRetryDelayMs: number
  maxTransientWaitMs: number
  maxLogicalAttempts: number
}
export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = { maxTransientRetries: 1, maxShortRetryDelayMs: 2000, maxTransientWaitMs: 5000, maxLogicalAttempts: 8 }

/** 同一会话连续断网等待的上限；超过后按常规回退，避免网络时断时续时无限等待 */
const MAX_NETWORK_WAITS = 3
/** 距上次等待超过这段时间，等待次数重新计数 */
const NETWORK_WAIT_RESET_MS = 30 * 60_000

/** 路由状态注册表：spawn 子智能体按链回退，swarm 预设的根会话按角色链回退 */
export interface RouteStateRegistry {
  /** 登记子智能体（或连续会话的新一轮）：路由链从头开始，已试记录清空 */
  AddChild: (agentId: string, state: { chain: RouteInfo[]; role: RoleId; onFallback?: (event: FallbackEventInfo) => void; persistent?: boolean; logicalRequestId?: string }) => void
  BeginLogicalRequest: (agentId: string, logicalRequestId: string) => void
  BeginRequestStep: (agentId: string, turn: number, step: number) => void
  getRecovery: (agentId: string) => RequestRecoveryState | undefined
  getTerminal: (agentId: string) => RequestRecoveryState['terminal']
  isRouteAvailable: (route: RouteInfo) => boolean
  getHealth: () => ReturnType<RouteHealth['list']>
  RestoreHealth: (entries: unknown) => void
  clearHealth: (key?: string) => void
  MarkRequestSucceeded: (agentId: string) => void
  MarkRequestStarted: (agentId: string, attemptId: string) => void
  ObserveRouteFailure: (route: RouteInfo, failure: LlmFailureLike, config?: SwarmConfigInfo) => void | Promise<void>
  /** 管理会话的恢复先于 next，终态和有界瞬时策略不经过宿主的长退避。 */
  recover: (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>, presetRole: RoleId | undefined, config: SwarmConfigInfo) => Promise<RequestErrorActionLike>
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
  const { reasoningEffort: _inherited, policy: _resourcePolicy, ...rest } = resolved
  const effort = getWireEffort(route)
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort })
  }
}

/** 从 start 起找第一条未试过的路由；认证失败时跳过同一 provider */
const FindNextIndex = (chain: RouteInfo[], start: number, tried: ReadonlySet<string>, failed: RouteInfo, failureClass: FailureClass, health: RouteHealth): number | undefined => {
  for (let index = start; index < chain.length; index++) {
    const route = chain[index] as RouteInfo
    const policy = getRouteResourcePolicy(route)
    if (tried.has(getRouteLabel(route)) || !health.isAvailable(route) || policy.accessMode === 'judgment_api' || policy.capabilities?.generation === false || policy.capabilities?.tools === false) continue
    if (failureClass === 'auth' && route.provider === failed.provider && route.policy?.quotaDomainId === undefined) continue
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
  const health = options.health ?? intRouteHealth(now)
  const recoveries = new Map<string, RequestRecoveryState>()
  const logical = new Map<string, RequestRecoveryState>()
  let requestSequence = 0
  const begin = (agentId: string, id: string): void => {
    let state = logical.get(id)
    if (state === undefined) { state = { logicalRequestId: id, attempts: 0, transientRetries: 0, waitedMs: 0, attemptedRoutes: [] }; logical.set(id, state) }
    recoveries.set(agentId, state)
  }
  const recoveryOf = (id: string): RequestRecoveryState => { if (!recoveries.has(id)) begin(id, id); return recoveries.get(id) as RequestRecoveryState }
  const policyOf = (config?: SwarmConfigInfo): RecoveryPolicy => ({ ...DEFAULT_RECOVERY_POLICY, ...(config as (SwarmConfigInfo & { recovery?: Partial<RecoveryPolicy> }) | undefined)?.recovery, ...options.recovery })
  const terminal = (id: string, reason: RequestRecoveryState['terminal'], failure?: LlmFailureLike): undefined => {
    const state = recoveryOf(id)
    state.terminal = reason
    state.suppressedRetryAfterMs = (failure as RouteFailureMetadata | undefined)?.providerRetryAfterMs
    return undefined // 真实 DSH agent-loop 中非 retry 即失败，不发明 stop 动作。
  }
  const managed = (agent: AgentLike, role: RoleId | undefined): boolean => children.has(agent.id) || (role !== undefined && getAgentHeader(agent).parentSession === undefined)
  const children = new Map<string, ChildStateInfo>()
  const roots = new Map<string, RootStateInfo>()
  const lastRoutes = new Map<string, RouteInfo>()
  /** 宿主给出的（改写前的）路由，用于判断用户是否换了模型 */
  const lastResolved = new Map<string, RouteInfo>()
  const upgrades = new Map<string, RootUpgradeStateInfo>()
  /** 断网等待次数（按会话） */
  const networkWaits = new Map<string, { count: number; last: number }>()

  const getChildFallback = (agentId: string, state: ChildStateInfo, failure: LlmFailureLike, failureClass: FailureClass, _action: RequestErrorActionLike): RequestErrorActionLike => {
    const current = state.chain[state.index] as RouteInfo
    const tried = new Set([...state.tried, getRouteLabel(current)])
    const next = FindNextIndex(state.chain, state.index + 1, tried, current, failureClass, health)
    if (next === undefined) {
      children.set(agentId, { ...state, tried })
      return terminal(agentId, 'route_chain_exhausted', failure)
    }
    const to = state.chain[next] as RouteInfo
    children.set(agentId, { ...state, index: next, tried })
    state.onFallback?.({ agentId, from: current, to, failure, scope: 'child' })
    return { kind: 'retry' }
  }

  const getRootFallback = (payload: RequestErrorPayloadLike, presetRole: RoleId, failureClass: FailureClass, _action: RequestErrorActionLike, config: SwarmConfigInfo): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
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
        return terminal(agentId, 'route_chain_exhausted', payload.failure)
      }
      const to = chain[next] as RouteInfo
      roots.set(agentId, { override: to, at: now(), picker, tried })
      onRootFallback?.({ agentId, from: failed, to, failure: payload.failure, scope: 'root' })
      return { kind: 'retry' }
    }
    if (probe === undefined) return settle(FindNextIndex(chain, 0, tried, failed, failureClass, health))
    // 与子智能体一致：只回退到当前可解析的路由，不可用的记为已试并继续向后找
    const FindUsableIndex = async (): Promise<number | undefined> => {
      for (let next = FindNextIndex(chain, 0, tried, failed, failureClass, health); next !== undefined; next = FindNextIndex(chain, next + 1, tried, failed, failureClass, health)) {
        if (payload.signal?.aborted === true) return undefined
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

  const api: RouteStateRegistry = {
    BeginLogicalRequest: begin,
    BeginRequestStep: (id, turn, step) => { begin(id, `${children.get(id)?.logicalRequestId ?? id}:${turn}:${step}`) },
    getRecovery: (id) => { const state = recoveries.get(id); return state === undefined ? undefined : { ...state, attemptedRoutes: [...state.attemptedRoutes], ...(state.observedAttemptIds === undefined ? {} : { observedAttemptIds: [...state.observedAttemptIds] }) } },
    getTerminal: (id) => recoveries.get(id)?.terminal,
    isRouteAvailable: (route) => health.isAvailable(route),
    getHealth: () => health.list(),
    RestoreHealth: (entries) => health.restore(entries),
    clearHealth: (key) => health.clear(key),
    ObserveRouteFailure: (route, failure, config) => {
      const normalized = normalizeRouteFailure(failure as RouteFailureMetadata, route)
      if (isTerminalRouteFailure(normalized)) {
        health.record(route, normalized)
        return options.onHealthChange?.(health.list(), { reason: 'probe' })
      } else if (normalized.providerRetryAfterMs !== undefined && normalized.providerRetryAfterMs > policyOf(config).maxShortRetryDelayMs) {
        health.record(route, normalized, normalized.providerRetryAfterMs)
        return options.onHealthChange?.(health.list(), { reason: 'probe' })
      }
    },
    MarkRequestStarted: (id, attemptId) => {
      const state = recoveryOf(id)
      if (state.observedAttemptIds?.includes(attemptId)) return
      state.observedAttemptIds = [...(state.observedAttemptIds ?? []), attemptId]
      state.observedModelAttempts = (state.observedModelAttempts ?? 0) + 1
      state.observationCoverage = 'agent-loop-stream-attempts'
    },
    MarkRequestSucceeded: (id) => {
      const route = lastRoutes.get(id)
      if (route !== undefined) health.succeeded(route, id)
      const recovery = recoveries.get(id)
      if (recovery !== undefined) recovery.completed = true
      // 已完成请求不参与未来恢复，不无限保留旧 step 的恢复记录。
      if (logical.size > 1024) for (const [key, state] of logical) {
        if (logical.size <= 1024) break
        if (state.completed) logical.delete(key)
      }
    },
    recover: async (payload, next, role, config) => {
      if (!managed(payload.agent, role)) return next()
      // 不 await next()：宿主 normal/always recovery 在 next 内会真正 sleep。
      return api.getErrorAction(payload, undefined, role, config)
    },
    AddChild: (agentId, state) => {
      children.set(agentId, {
        chain: state.chain, index: 0, role: state.role, tried: new Set(),
        ...(state.onFallback === undefined ? {} : { onFallback: state.onFallback }),
        ...(state.persistent === true ? { persistent: true } : {}),
        ...(state.logicalRequestId === undefined ? {} : { logicalRequestId: state.logicalRequestId })
      })
      if (state.logicalRequestId !== undefined) begin(agentId, state.logicalRequestId)
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
      if (!managed(agent, _presetRole)) return resolved
      const child = children.get(agent.id)
      const root = roots.get(agent.id)
      // 宿主给出的路由与回退时的选择器路由不同：用户换了模型，覆盖与已试记录一并作废
      if (child === undefined && root?.picker !== undefined && !isSameRoute(resolved, root.picker)) roots.delete(agent.id)
      // 回退覆盖到期：故障多半已经恢复（例如断网结束），重新尝试对话框所选模型；再失败会重新回退
      const recoverMs = config?.agents?.rootRecoverMs ?? 0
      const current = roots.get(agent.id)
      if (child === undefined && current?.override !== undefined && current.at !== undefined && recoverMs > 0 && now() - current.at >= recoverMs && health.isAvailable(resolved)) roots.delete(agent.id)
      const upgrade = child === undefined ? upgrades.get(agent.id) : undefined
      // 升级生效后用户在对话框里换了模型：以用户的选择为准，撤销升级
      if (upgrade !== undefined && upgrade.picker !== undefined && !isSameRoute(resolved, upgrade.picker)) upgrades.delete(agent.id)
      else if (upgrade !== undefined && upgrade.picker === undefined) upgrade.picker = { provider: resolved.provider, model: resolved.model }
      lastResolved.set(agent.id, { provider: resolved.provider, model: resolved.model })
      if (recoveries.get(agent.id)?.completed) begin(agent.id, `${agent.id}:request:${++requestSequence}`)
      const recovery = recoveryOf(agent.id)
      if (recovery.terminal !== undefined) throw new SwarmError('SERVICE_UNAVAILABLE', recovery.terminal)
      if (recovery.attempts >= policyOf(config).maxLogicalAttempts) { terminal(agent.id, 'recovery_attempts_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'recovery_attempts_exhausted') }
      const declared = config === undefined || _presetRole === undefined ? undefined : getRoleRoute(config, getRouteKey(_presetRole)).chain.find((route) => isSameRoute(route, resolved))
      let route = child === undefined ? (roots.get(agent.id)?.override ?? upgrades.get(agent.id)?.chain[0] ?? { ...resolved, ...(declared?.policy === undefined ? {} : { policy: declared.policy }) }) : child.chain[child.index]
      const resource = route === undefined ? undefined : getRouteResourcePolicy(route)
      const incompatible = resource?.accessMode === 'judgment_api' || resource?.capabilities?.generation === false || resource?.capabilities?.tools === false
      if (route === undefined || incompatible || !health.claim(route, agent.id)) {
        if (child === undefined && config?.rootFallback === false) { terminal(agent.id, 'route_chain_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'root-fallback-disabled: route_chain_exhausted') }
        const chain = child?.chain ?? (config === undefined || _presetRole === undefined ? [] : getRoleRoute(config, getRouteKey(_presetRole)).chain)
        const index = FindNextIndex(chain, child === undefined ? 0 : child.index + 1, new Set(), route ?? resolved, 'other', health)
        if (index === undefined) { terminal(agent.id, 'route_chain_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'route_chain_exhausted') }
        route = chain[index] as RouteInfo
        if (!health.claim(route, agent.id)) { terminal(agent.id, 'route_chain_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'route_chain_exhausted') }
        if (child !== undefined) children.set(agent.id, { ...child, index })
        else roots.set(agent.id, { override: route, at: now(), picker: resolved, tried: root?.tried ?? new Set() })
      }
      recovery.attempts += 1
      recovery.attemptedRoutes.push(getRouteLabel(route))
      const next = route === undefined ? resolved : getRoutedConfig(resolved, route)
      lastRoutes.set(agent.id, route)
      return next
    },
    getErrorAction: (payload, action, presetRole, config) => {
      if (!managed(payload.agent, presetRole)) return action
      const recovery = recoveryOf(payload.agent.id)
      if (payload.signal?.aborted === true || recovery.terminal !== undefined) return undefined
      const policy = policyOf(config)
      const failed = lastRoutes.get(payload.agent.id) ?? children.get(payload.agent.id)?.chain[children.get(payload.agent.id)!.index] ?? { provider: payload.provider, model: '' }
      const normalized = normalizeRouteFailure(payload.failure as RouteFailureMetadata, failed)
      const failedProbe = health.failHalfOpen(failed, payload.agent.id)
      const failureClass = getFailureClass(payload.failure)
      const fatal = isTerminalRouteFailure(normalized)
      const longWait = normalized.providerRetryAfterMs !== undefined && Number.isFinite(normalized.providerRetryAfterMs) && normalized.providerRetryAfterMs > policy.maxShortRetryDelayMs
      if (fatal || longWait) {
        health.record(failed, normalized, fatal ? undefined : normalized.providerRetryAfterMs)
        if (longWait) recovery.suppressedRetryAfterMs = normalized.providerRetryAfterMs
      }
      const afterHealthCommit = (): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
        // 第八次的终态故障仍要记录域隔离，随后停止恢复，不再尝试第九个模型。
        if (recovery.attempts >= policy.maxLogicalAttempts) return terminal(payload.agent.id, 'recovery_attempts_exhausted')
        if (!fatal && !longWait && !failedProbe && (!isNetworkSuspect(payload.failure) || options.network === undefined || config.agents.networkWaitMs <= 0)) {
          if (['rate_limited', 'service_transient', 'network_transient'].includes(normalized.kind)) {
            const delay = Math.max(0, normalized.providerRetryAfterMs ?? 500)
            if (recovery.transientRetries < policy.maxTransientRetries && delay <= policy.maxShortRetryDelayMs && recovery.waitedMs + delay <= policy.maxTransientWaitMs) {
              recovery.transientRetries += 1
              recovery.waitedMs += delay
              return (options.sleep ?? SleepWithSignal)(delay, payload.signal).then(() => payload.signal?.aborted === true ? undefined : { kind: 'retry' })
            }
          }
        }
        const child = children.get(payload.agent.id)
        if (child !== undefined) {
          const fallback = () => {
            // 等待期间子智能体可能已被释放或重新登记：以最新状态为准
            const latest = children.get(payload.agent.id)
            return latest === undefined ? action : getChildFallback(payload.agent.id, latest, payload.failure, failureClass, action)
          }
          return fatal || longWait || failedProbe ? fallback() : getNetworkAwareAction(payload, 'child', config, fallback)
        }
        if (!config.rootFallback || presetRole === undefined) return fatal || longWait || failedProbe ? terminal(payload.agent.id, 'route_chain_exhausted', payload.failure) : action
        if (getAgentHeader(payload.agent).parentSession !== undefined) return action
        const fallback = () => getRootFallback(payload, presetRole, failureClass, action, config)
        return fatal || longWait || failedProbe ? fallback() : getNetworkAwareAction(payload, 'root', config, fallback)
      }
      if ((fatal || longWait || failedProbe) && options.onHealthChange !== undefined) {
        let committed: void | Promise<void>
        try { committed = options.onHealthChange(health.list(), { agentId: payload.agent.id, reason: 'failure' }) } catch (error) {
          terminal(payload.agent.id, 'route_health_persist_failed')
          throw error
        }
        return committed === undefined ? afterHealthCommit() : Promise.resolve(committed).catch((error) => {
          terminal(payload.agent.id, 'route_health_persist_failed')
          throw error
        }).then(afterHealthCommit)
      }
      return afterHealthCommit()
    }
  }
  return api
}
