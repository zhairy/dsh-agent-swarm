import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import {
  getAgentHeader,
  type AgentLike,
  type CallConfigLike,
  type ContextCompactionLike,
  type LlmFailureLike,
  type RequestErrorActionLike,
  type RequestErrorPayloadLike
} from './host-contract.js'
import type { RoleId } from './role-registry.js'
import { isNetworkSuspect, SleepWithSignal, type NetworkMonitorInfo } from './network.js'
import { normalizeRouteFailure, isTerminalRouteFailure, getRouteResourcePolicy, getWireReasoningEffort, type RouteFailureMetadata } from './provider-policy.js'
import { intRouteHealth, type RouteHealth, type RouteHealthSnapshot } from './route-health.js'
import { SwarmError } from './util/errors.js'
import { getFailureClass, getRouteKey, getRouteLabel, isSameRoute, type FailureClass, type RouteInfo, type RouteProbe } from './routes.js'
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
  baseChain?: RouteInfo[]
  index: number
  role: RoleId
  tried: ReadonlySet<string>
  onFallback?: (event: FallbackEventInfo) => void
  /** 连续会话：每次沉寂都会释放 Agent（触发 agent/disposed），路由状态要跨轮保留 */
  persistent?: boolean
  logicalRequestId?: string
  requireVision?: boolean
}

/** 天枢根会话的容灾升级：升级期间请求改走升级链；picker 记录升级生效时对话框所选的模型 */
interface RootUpgradeStateInfo {
  chain: RouteInfo[]
  picker?: RouteInfo
  index: number
  completeChain?: boolean
  at: number
}

export interface PreferredRecoveryEventInfo {
  agentId: string
  from: RouteInfo
  to: RouteInfo
  scope: 'child' | 'root'
  logicalRequestId: string
  confirmed: boolean
}

interface RootStateInfo {
  override?: RouteInfo
  /** 回退覆盖生效的时刻；超过 rootRecoverMs 后重新尝试对话框所选模型 */
  at?: number
  /** 发生回退时的稳定用户偏好；SDK 自动记录的实际请求头不改变它。 */
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
  onHealthChange?: (snapshot: RouteHealthSnapshot, event: { agentId?: string; reason: 'failure' | 'probe' | 'success' }) => void | Promise<void>
  /** Success is observed on an emit-only Host event; report asynchronous persistence failure explicitly. */
  onHealthPersistenceFailure?: (event: { agentId: string; reason: 'route_health_persist_failed' }) => void
  /** Maximum wait at the next request boundary, not a model or filesystem cancellation timeout. */
  healthCommitWaitMs?: number
  onPreferredRecovery?: (event: PreferredRecoveryEventInfo) => void
}

export interface RequestRecoveryState {
  logicalRequestId: string
  attempts: number
  transientRetries: number
  waitedMs: number
  attemptedRoutes: string[]
  terminal?: 'route_chain_exhausted' | 'recovery_attempts_exhausted' | 'route_health_persist_failed' | 'context_recovery_required'
  contextRecoveryAttempts?: number
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
  AddChild: (agentId: string, state: { chain: RouteInfo[]; role: RoleId; onFallback?: (event: FallbackEventInfo) => void; persistent?: boolean; logicalRequestId?: string; initialRoute?: RouteInfo; respectStoredOverride?: boolean; requireVision?: boolean }) => void
  BeginLogicalRequest: (agentId: string, logicalRequestId: string) => void
  BeginRequestStep: (agentId: string, turn: number, step: number) => void
  /** The delegation owner calls this after every result/terminal has been consumed, including failure and cancellation. */
  FinishLogicalRequest: (logicalRequestId: string) => void
  getRecovery: (agentId: string) => RequestRecoveryState | undefined
  /** Aggregate lifecycle counts only; no session, request or model identities. */
  getRecoveryDiagnostics: () => { agents: number; logicalRequests: number; logicalStates: number; disposedTerminals: number }
  getTerminal: (agentId: string) => RequestRecoveryState['terminal']
  isRouteAvailable: (route: RouteInfo) => boolean
  isRouteAvailableFor: (route: RouteInfo, agentId: string) => boolean
  getHealth: () => ReturnType<RouteHealth['list']>
  getHealthSnapshot: () => RouteHealthSnapshot
  WaitHealthReady: (agentId: string, signal?: AbortSignal) => Promise<void>
  RestoreHealth: (entries: unknown) => void
  clearHealth: (key?: string) => void
  MarkRequestSucceeded: (agentId: string) => void
  MarkRequestStarted: (agentId: string, attemptId: string, actualRoute?: RouteInfo) => void
  ObserveRouteFailure: (route: RouteInfo, failure: LlmFailureLike, config?: SwarmConfigInfo) => void | Promise<void>
  /** 管理会话的恢复先于 next，终态和有界瞬时策略不经过宿主的长退避。 */
  recover: (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>, presetRole: RoleId | undefined, config: SwarmConfigInfo, compaction?: ContextCompactionLike) => Promise<RequestErrorActionLike>
  getChild: (agentId: string) => { route: RouteInfo | undefined; role: RoleId; switches: number } | undefined
  getChildRole: (agentId: string) => RoleId | undefined
  SetChildOverride: (agentId: string, route: RouteInfo | undefined) => void
  getChildOverride: (agentId: string) => RouteInfo | undefined
  SetManualPause: (agentId: string, paused: boolean) => void
  isManualPaused: (agentId: string) => boolean
  getLastRoute: (agentId: string) => RouteInfo | undefined
  /** 初始化持久根会话的真实用户偏好；不会覆盖本进程已观测到的显式选择。 */
  RestoreRootPreference: (agentId: string, route: RouteInfo) => void
  getRootPreference: (agentId: string) => RouteInfo | undefined
  RecordUserSelection: (agentId: string, route: RouteInfo, seq?: number) => void
  PreparePreferredRecovery: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config: SwarmConfigInfo) => Promise<void>
  RequestRouteRetry: (route: RouteInfo, agentId: string, options?: { force?: boolean }) => { ok: boolean; keys: string[]; reason?: string; retryAt?: number }
  CancelRouteRetry: (agentId: string) => void
  /** 设置或撤销根会话的容灾升级链（已预检可用的路由） */
  SetRootUpgrade: (agentId: string, chain: RouteInfo[] | undefined, initialUsableRoute?: RouteInfo) => void
  getRootUpgrade: (agentId: string) => RouteInfo[] | undefined
  DelAgent: (agentId: string) => void
  /** 宿主释放 Agent 时调用：连续会话子智能体的路由状态保留，其余清理 */
  ReleaseAgent: (agentId: string) => void
  getRequestOverride: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config?: SwarmConfigInfo, explicitSelectionAvailable?: boolean) => CallConfigLike
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
  getWireReasoningEffort(route)

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
  // Health is profile-wide, so its durability barrier must survive the child
  // that observed success and apply to every managed agent's next request.
  let pendingHealthCommit: Promise<void> | undefined
  let failedHealthCommit = false
  const healthCommitWaiters = new Set<() => void>()
  const notifyHealthWaiters = () => { for (const waiter of [...healthCommitWaiters]) waiter() }
  const healthCommitWaitMs = typeof options.healthCommitWaitMs === 'number' && Number.isFinite(options.healthCommitWaitMs)
    ? Math.min(60000, Math.max(1, options.healthCommitWaitMs)) : 10000
  // A delegation can restart a one-shot child. Its failed step must keep the
  // same admission counter until that delegation's Promise finally settles.
  // Ordinary root requests have only one current step, rather than a process-
  // lifetime history of every failed/cancelled request.
  const logical = new Map<string, { states: Map<string, RequestRecoveryState>; agents: Set<string>; delegation: boolean }>()
  const agentScopes = new Map<string, string>()
  const disposedTerminals = new Map<string, NonNullable<RequestRecoveryState['terminal']>>()
  const MAX_DISPOSED_TERMINALS = 1024
  const MAX_COMPLETED_STEPS = 1024
  let logicalStates = 0
  const recoveryBoundaries = new Set<string>()
  const preferredRecoveryWaits = new Map<string, { failures: number; nextAt: number }>()
  const preferredTrials = new Map<string, PreferredRecoveryEventInfo>()
  let requestSequence = 0
  const begin = (agentId: string, id: string): void => {
    const changed = recoveries.get(agentId)?.logicalRequestId !== id
    const delegationId = children.get(agentId)?.logicalRequestId
    const scope = delegationId ?? agentId
    const previousScope = agentScopes.get(agentId)
    if (previousScope !== undefined && previousScope !== scope) {
      const previousGroup = logical.get(previousScope)
      previousGroup?.agents.delete(agentId)
      if (previousGroup !== undefined && !previousGroup.delegation && previousGroup.agents.size === 0) {
        logicalStates -= previousGroup.states.size
        logical.delete(previousScope)
      }
    }
    let group = logical.get(scope)
    if (group === undefined) { group = { states: new Map(), agents: new Set(), delegation: delegationId !== undefined }; logical.set(scope, group) }
    if (!group.delegation && changed) { logicalStates -= group.states.size; group.states.clear() }
    let state = group.states.get(id)
    if (state === undefined) {
      // A persistent child's current receipt survives its owner's finally.
      // A late duplicate request event must not reset that receipt's ceiling.
      const current = recoveries.get(agentId)
      state = current?.logicalRequestId === id ? current : { logicalRequestId: id, attempts: 0, transientRetries: 0, waitedMs: 0, attemptedRoutes: [] }
      group.states.set(id, state)
      logicalStates++
    }
    group.agents.add(agentId)
    agentScopes.set(agentId, scope)
    disposedTerminals.delete(agentId)
    recoveries.set(agentId, state)
    if (changed) {
      recoveryBoundaries.add(agentId)
      preferredTrials.delete(agentId)
      const child = children.get(agentId)
      if (child !== undefined) children.set(agentId, { ...child, tried: new Set() })
      const root = roots.get(agentId)
      if (root !== undefined) roots.set(agentId, { ...root, tried: new Set() })
    }
  }
  const forgetRecovery = (agentId: string, preserveTerminal: boolean): void => {
    const scope = agentScopes.get(agentId)
    const group = scope === undefined ? undefined : logical.get(scope)
    // Scoped children remain readable until FinishLogicalRequest: the delegate
    // reads getTerminal only after dispose/end have already been published.
    if (group?.delegation) return
    const terminal = recoveries.get(agentId)?.terminal
    if (preserveTerminal && terminal !== undefined) {
      disposedTerminals.delete(agentId)
      disposedTerminals.set(agentId, terminal)
      if (disposedTerminals.size > MAX_DISPOSED_TERMINALS) disposedTerminals.delete(disposedTerminals.keys().next().value!)
    }
    if (scope !== undefined && group !== undefined) { logicalStates -= group.states.size; logical.delete(scope) }
    agentScopes.delete(agentId)
    recoveries.delete(agentId)
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
  const persistSuccess = (agentId: string): void => {
    if (options.onHealthChange === undefined) return
    let committed: void | Promise<void>
    try { committed = options.onHealthChange(health.getSnapshot(), { agentId, reason: 'success' }) } catch (error) { committed = Promise.reject(error) }
    if (committed === undefined) { failedHealthCommit = false; pendingHealthCommit = undefined; notifyHealthWaiters(); return }
    let pending: Promise<void>
    pending = Promise.resolve(committed).then(() => {
      if (pendingHealthCommit === pending) failedHealthCommit = false
    }, () => {
      // The owner may have consumed and disposed this child while the disk
      // write was pending. Do not recreate a ghost request on late failure.
      if (pendingHealthCommit === pending) {
        failedHealthCommit = true
        const recovery = recoveries.get(agentId)
        if (recovery !== undefined) recovery.terminal = 'route_health_persist_failed'
      }
      try { options.onHealthPersistenceFailure?.({ agentId, reason: 'route_health_persist_failed' }) } catch { /* The recorded failure survives an auxiliary notification error. */ }
    }).finally(() => {
      if (pendingHealthCommit === pending) { pendingHealthCommit = undefined; notifyHealthWaiters() }
    })
    pendingHealthCommit = pending
  }
  const waitHealthReady = async (agentId: string, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted === true) throw new SwarmError('RECOVERY_REQUIRED', '健康状态提交等待已取消；未启动新的模型请求')
    if (failedHealthCommit && pendingHealthCommit === undefined) persistSuccess(agentId)
    if (pendingHealthCommit !== undefined) await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); healthCommitWaiters.delete(check) }
      const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); error === undefined ? resolve() : reject(error) }
      const onAbort = () => finish(new SwarmError('RECOVERY_REQUIRED', '健康状态提交等待已取消；未启动新的模型请求'))
      const check = () => {
        if (pendingHealthCommit === undefined) finish(failedHealthCommit ? new SwarmError('SERVICE_UNAVAILABLE', 'route_health_persist_failed') : undefined)
      }
      // A detached waiter can be removed on timeout/abort; attaching a new then
      // handler to a hung filesystem Promise on every retry would retain it.
      healthCommitWaiters.add(check)
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => finish(new SwarmError('RECOVERY_REQUIRED', '健康状态持久提交仍未完成；暂停新的模型请求，底层写入状态仍待确认')), healthCommitWaitMs)
      if (signal?.aborted === true) { onAbort(); return }
      // One timer covers all newer complete snapshots: frequent successes
      // cannot restart this waiter's deadline indefinitely.
      check()
    })
    if (failedHealthCommit) throw new SwarmError('SERVICE_UNAVAILABLE', 'route_health_persist_failed')
  }
  const children = new Map<string, ChildStateInfo>()
  const childOverrides = new Map<string, RouteInfo>()
  const rootPreferences = new Map<string, RouteInfo>()
  const userSelectionSeqs = new Map<string, number>()
  const manualPauses = new Set<string>()
  const manualRetries = new Map<string, { route: RouteInfo; force: boolean }>()
  const sameSelection = (left: RouteInfo, right: RouteInfo) => isSameRoute(left, right) && left.reasoningEffort === right.reasoningEffort
  const withDeclaredPolicy = (chain: RouteInfo[], selected: RouteInfo) => {
    const declared = chain.find((item) => isSameRoute(item, selected))
    return { ...selected, ...(declared?.policy === undefined ? {} : { policy: declared.policy }) }
  }
  const selectedChain = (chain: RouteInfo[], selected?: RouteInfo) => selected === undefined ? [...chain] : [withDeclaredPolicy(chain, selected), ...chain.filter((item) => !sameSelection(item, selected))]
  const roots = new Map<string, RootStateInfo>()
  const lastRoutes = new Map<string, RouteInfo>()
  /** 兼容旧宿主的改写前路由；必须排除实际自动回退和适配器默认值漂移。 */
  const lastResolved = new Map<string, RouteInfo>()
  const upgrades = new Map<string, RootUpgradeStateInfo>()
  /** 断网等待次数（按会话） */
  const networkWaits = new Map<string, { count: number; last: number }>()
  const delayPreferred = (agentId: string): void => {
    const failures = (preferredRecoveryWaits.get(agentId)?.failures ?? 0) + 1
    preferredRecoveryWaits.set(agentId, { failures, nextAt: now() + Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)) })
    preferredTrials.delete(agentId)
  }

  const getChildFallback = (agentId: string, state: ChildStateInfo, failure: LlmFailureLike, failureClass: FailureClass, _action: RequestErrorActionLike): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const current = state.chain[state.index] as RouteInfo
    if (state.index === 0 || preferredTrials.has(agentId)) delayPreferred(agentId)
    const tried = new Set([...state.tried, getRouteLabel(current)])
    const settle = (next: number | undefined): RequestErrorActionLike => {
      if (manualPauses.has(agentId) || children.get(agentId) !== state) return undefined
      if (next === undefined) {
        children.set(agentId, { ...state, tried })
        return terminal(agentId, 'route_chain_exhausted', failure)
      }
      const to = state.chain[next] as RouteInfo
      children.set(agentId, { ...state, index: next, tried })
      state.onFallback?.({ agentId, from: current, to, failure, scope: 'child' })
      return { kind: 'retry' }
    }
    if (probe === undefined) return settle(FindNextIndex(state.chain, state.index + 1, tried, current, failureClass, health))
    return (async () => {
      for (let next = FindNextIndex(state.chain, state.index + 1, tried, current, failureClass, health); next !== undefined; next = FindNextIndex(state.chain, next + 1, tried, current, failureClass, health)) {
        const candidate = state.chain[next] as RouteInfo
        const checked = await probe(candidate)
        if (manualPauses.has(agentId) || children.get(agentId) !== state) return undefined
        if (checked.ok && (state.requireVision !== true || checked.vision)) return settle(next)
        tried.add(getRouteLabel(candidate))
      }
      return settle(undefined)
    })()
  }

  const getRootFallback = (payload: RequestErrorPayloadLike, presetRole: RoleId, failureClass: FailureClass, _action: RequestErrorActionLike, config: SwarmConfigInfo): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const agentId = payload.agent.id
    const failed = lastRoutes.get(agentId) ?? { provider: payload.provider, model: '' }
    const previous = roots.get(agentId)
    const picker = rootPreferences.get(agentId) ?? previous?.picker ?? lastResolved.get(agentId) ?? failed
    const tried = new Set([...(previous?.tried ?? []), getRouteLabel(failed)])
    const roleChain = getRoleRoute(config, getRouteKey(presetRole)).chain
    const upgrade = upgrades.get(agentId)
    // 升级期间：先在升级链内回退，再回到常规链
    const chain = upgrade === undefined ? roleChain : upgrade.completeChain ? upgrade.chain : getUpgradedChain(upgrade.chain, roleChain)
    if (preferredTrials.has(agentId) || isSameRoute(failed, picker)) delayPreferred(agentId)
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
      if (payload.signal?.aborted === true || manualPauses.has(agentId)) return undefined
      return recovered ? { kind: 'retry' } : fallback()
    })()
  }

  const api: RouteStateRegistry = {
    BeginLogicalRequest: begin,
    BeginRequestStep: (id, turn, step) => { begin(id, `${children.get(id)?.logicalRequestId ?? id}:${turn}:${step}`) },
    FinishLogicalRequest: (id) => {
      const group = logical.get(id)
      if (group === undefined || !group.delegation) return
      for (const agentId of group.agents) {
        if (agentScopes.get(agentId) !== id) continue
        agentScopes.delete(agentId)
        disposedTerminals.delete(agentId)
        if (children.get(agentId)?.persistent !== true) {
          recoveries.delete(agentId)
        }
      }
      logicalStates -= group.states.size
      logical.delete(id)
    },
    getRecovery: (id) => { const state = recoveries.get(id); return state === undefined ? undefined : { ...state, attemptedRoutes: [...state.attemptedRoutes], ...(state.observedAttemptIds === undefined ? {} : { observedAttemptIds: [...state.observedAttemptIds] }) } },
    getRecoveryDiagnostics: () => ({ agents: recoveries.size, logicalRequests: logical.size, logicalStates, disposedTerminals: disposedTerminals.size }),
    getTerminal: (id) => recoveries.get(id)?.terminal ?? disposedTerminals.get(id),
    isRouteAvailable: (route) => health.isAvailable(route),
    isRouteAvailableFor: (route, agentId) => health.isAvailable(route) || (manualRetries.get(agentId) !== undefined && isSameRoute(manualRetries.get(agentId)!.route, route)),
    getHealth: () => health.list(),
    getHealthSnapshot: () => health.getSnapshot(),
    WaitHealthReady: waitHealthReady,
    RestoreHealth: (entries) => health.restore(entries),
    clearHealth: (key) => health.clear(key),
    ObserveRouteFailure: (route, failure, config) => {
      const normalized = normalizeRouteFailure(failure as RouteFailureMetadata, route)
      if (isTerminalRouteFailure(normalized)) {
        health.record(route, normalized)
        return options.onHealthChange?.(health.getSnapshot(), { reason: 'probe' })
      } else if (normalized.providerRetryAfterMs !== undefined && normalized.providerRetryAfterMs > policyOf(config).maxShortRetryDelayMs) {
        health.record(route, normalized, normalized.providerRetryAfterMs)
        return options.onHealthChange?.(health.getSnapshot(), { reason: 'probe' })
      }
    },
    MarkRequestStarted: (id, attemptId, actualRoute) => {
      if (actualRoute !== undefined) {
        const previous = lastRoutes.get(id)
        lastRoutes.set(id, { provider: actualRoute.provider, model: actualRoute.model,
          ...(actualRoute.reasoningEffort === undefined ? {} : { reasoningEffort: actualRoute.reasoningEffort }),
          ...(previous?.policy === undefined || !isSameRoute(previous, actualRoute) ? {} : { policy: previous.policy }) })
      }
      const state = recoveryOf(id)
      if (state.observedAttemptIds?.includes(attemptId)) return
      state.observedAttemptIds = [...(state.observedAttemptIds ?? []), attemptId]
      state.observedModelAttempts = (state.observedModelAttempts ?? 0) + 1
      state.observationCoverage = 'agent-loop-stream-attempts'
    },
    MarkRequestSucceeded: (id) => {
      const route = lastRoutes.get(id)
      const healthChanged = route !== undefined && health.succeeded(route, id)
      const trial = preferredTrials.get(id)
      if (trial !== undefined) {
        if (route !== undefined && isSameRoute(route, trial.to)) { options.onPreferredRecovery?.({ ...trial, to: route, confirmed: true }); preferredRecoveryWaits.delete(id) }
        preferredTrials.delete(id)
      }
      const recovery = recoveries.get(id)
      if (recovery !== undefined) recovery.completed = true
      const scope = agentScopes.get(id)
      const group = scope === undefined ? undefined : logical.get(scope)
      // Long-lived delegates keep recent completed steps for restart accounting;
      // failed steps remain until the delegation owner explicitly finishes.
      if (group !== undefined && group.states.size > MAX_COMPLETED_STEPS) for (const [key, state] of group.states) {
        if (group.states.size <= MAX_COMPLETED_STEPS) break
        if (state.completed && state !== recovery) { group.states.delete(key); logicalStates-- }
      }
      if (healthChanged) persistSuccess(id)
    },
    recover: async (payload, next, role, config, compaction) => {
      if (!managed(payload.agent, role)) return next()
      if (manualPauses.has(payload.agent.id) || payload.signal?.aborted === true) return undefined
      if (normalizeRouteFailure(payload.failure as RouteFailureMetadata, { provider: payload.provider, model: '' }).kind === 'context_exceeded') {
        const recovery = recoveryOf(payload.agent.id)
        const before = payload.agent.session?.surface?.replaceGeneration
        if (compaction === undefined || payload.signal === undefined || before === undefined || (recovery.contextRecoveryAttempts ?? 0) >= 1) return terminal(payload.agent.id, 'context_recovery_required')
        recovery.contextRecoveryAttempts = (recovery.contextRecoveryAttempts ?? 0) + 1
        try { await compaction.compactIfNeeded(payload.agent, 'context-overflow', payload.signal) } catch { /* a durable shrink may have committed before an auxiliary failure */ }
        const after = payload.agent.session?.surface?.replaceGeneration
        if (payload.signal.aborted || manualPauses.has(payload.agent.id)) return undefined
        return after !== undefined && after > before ? { kind: 'retry' } : terminal(payload.agent.id, 'context_recovery_required')
      }
      // 不 await next()：宿主 normal/always recovery 在 next 内会真正 sleep。
      return api.getErrorAction(payload, undefined, role, config)
    },
    AddChild: (agentId, state) => {
      const prepared = state.respectStoredOverride === false ? [...state.chain] : selectedChain(state.chain, childOverrides.get(agentId))
      const initial = state.initialRoute === undefined ? 0 : prepared.findIndex((route) => sameSelection(route, state.initialRoute!))
      children.set(agentId, {
        chain: prepared, baseChain: [...state.chain], index: Math.max(0, initial), role: state.role, tried: new Set(),
        ...(state.onFallback === undefined ? {} : { onFallback: state.onFallback }),
        ...(state.persistent === true ? { persistent: true } : {}),
        ...(state.logicalRequestId === undefined ? {} : { logicalRequestId: state.logicalRequestId }),
        ...(state.requireVision === true ? { requireVision: true } : {})
      })
      if (state.logicalRequestId !== undefined) begin(agentId, state.logicalRequestId)
    },
    getChild: (agentId) => {
      const state = children.get(agentId)
      return state === undefined ? undefined : { route: state.chain[state.index], role: state.role, switches: state.tried.size }
    },
    getChildRole: (agentId) => children.get(agentId)?.role,
    SetChildOverride: (agentId, route) => {
      const previous = childOverrides.get(agentId)
      if (route === undefined) childOverrides.delete(agentId)
      else childOverrides.set(agentId, { ...route })
      if (manualRetries.has(agentId) && (route === undefined || !isSameRoute(manualRetries.get(agentId)!.route, route))) manualRetries.delete(agentId)
      const current = children.get(agentId)
      if (current !== undefined && !(previous !== undefined && route !== undefined && sameSelection(previous, route))) children.set(agentId, { ...current, chain: selectedChain(current.baseChain ?? current.chain, route), index: 0, tried: new Set() })
    },
    getChildOverride: (agentId) => { const value = childOverrides.get(agentId); return value === undefined ? undefined : { ...value } },
    SetManualPause: (agentId, paused) => { if (paused) manualPauses.add(agentId); else manualPauses.delete(agentId) },
    isManualPaused: (agentId) => manualPauses.has(agentId),
    getLastRoute: (agentId) => { const value = lastRoutes.get(agentId); return value === undefined ? undefined : { ...value, ...(getWireEffort(value) === undefined ? {} : { reasoningEffort: getWireEffort(value) }) } },
    RestoreRootPreference: (agentId, route) => { if (!rootPreferences.has(agentId)) rootPreferences.set(agentId, { ...route }) },
    getRootPreference: (agentId) => { const value = rootPreferences.get(agentId); return value === undefined ? undefined : { ...value } },
    RecordUserSelection: (agentId, route, seq) => {
      if (seq !== undefined && (userSelectionSeqs.get(agentId) ?? -1) >= seq) return
      if (seq !== undefined) userSelectionSeqs.set(agentId, seq)
      if (children.has(agentId)) api.SetChildOverride(agentId, route)
      else { rootPreferences.set(agentId, { ...route }); roots.delete(agentId); upgrades.delete(agentId) }
      preferredTrials.delete(agentId); preferredRecoveryWaits.delete(agentId)
    },
    PreparePreferredRecovery: async (agent, resolved, role, config) => {
      if (!managed(agent, role) || manualPauses.has(agent.id) || !recoveryBoundaries.delete(agent.id)) return
      if (rootPreferences.get(agent.id) === undefined && !children.has(agent.id)) rootPreferences.set(agent.id, { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) })
      if ((preferredRecoveryWaits.get(agent.id)?.nextAt ?? 0) > now()) return
      const child = children.get(agent.id)
      const upgrade = upgrades.get(agent.id)
      const root = roots.get(agent.id)
      const rootRecoverMs = config.agents.rootRecoverMs ?? 0
      if (child === undefined && upgrade !== undefined && (rootRecoverMs <= 0 || now() - (root?.at ?? upgrade.at) < rootRecoverMs)) return
      const logicalRequestId = recoveryOf(agent.id).logicalRequestId
      const current = lastRoutes.get(agent.id) ?? child?.chain[child.index] ?? root?.override ?? upgrade?.chain[upgrade.index] ?? resolved
      let candidates: RouteInfo[] = []
      if (child !== undefined) candidates = child.chain.slice(0, child.index)
      else if (upgrade !== undefined) {
        const at = upgrade.chain.findIndex((route) => isSameRoute(route, root?.override ?? upgrade.chain[upgrade.index]!))
        candidates = upgrade.chain.slice(0, Math.max(0, at))
      } else if (root?.override !== undefined && (config.agents.rootRecoverMs ?? 0) > 0 && root.at !== undefined && now() - root.at >= config.agents.rootRecoverMs) candidates = [rootPreferences.get(agent.id) ?? root.picker ?? resolved]
      for (const candidate of candidates) {
        const resource = getRouteResourcePolicy(candidate)
        if (!health.isAvailable(candidate) || resource.accessMode === 'judgment_api' || resource.capabilities?.generation === false || resource.capabilities?.tools === false) continue
        const checked = probe === undefined ? { ok: true as const, vision: true } : await probe(candidate)
        if (manualPauses.has(agent.id) || recoveryOf(agent.id).logicalRequestId !== logicalRequestId || children.get(agent.id) !== child || upgrades.get(agent.id) !== upgrade || roots.get(agent.id) !== root) return
        if (!checked.ok || (child?.requireVision === true && !checked.vision)) continue
        if (child !== undefined) children.set(agent.id, { ...child, index: child.chain.findIndex((route) => sameSelection(route, candidate)) })
        else if (upgrade !== undefined) { roots.delete(agent.id); upgrade.index = upgrade.chain.findIndex((route) => sameSelection(route, candidate)) }
        else roots.delete(agent.id)
        const event: PreferredRecoveryEventInfo = { agentId: agent.id, from: current, to: candidate, scope: child === undefined ? 'root' : 'child', logicalRequestId, confirmed: false }
        preferredTrials.set(agent.id, event); options.onPreferredRecovery?.(event)
        return
      }
      if (candidates.length > 0) preferredRecoveryWaits.set(agent.id, { failures: preferredRecoveryWaits.get(agent.id)?.failures ?? 0, nextAt: now() + 5000 })
    },
    RequestRouteRetry: (route, agentId, retryOptions) => {
      const override = childOverrides.get(agentId)
      const selected = withDeclaredPolicy(children.get(agentId)?.baseChain ?? [], override !== undefined && isSameRoute(override, route) ? { ...override, ...route } : route)
      const related = health.getRelatedEntries(selected)
      const keys = related.map((entry) => entry.key)
      const providerReset = Math.max(0, ...related.map((entry) => entry.resetAt ?? 0))
      const retryAt = Math.max(providerReset, ...related.map((entry) => entry.retryAt ?? entry.resetAt ?? 0))
      if (!agentId || agentId.length > 512) return { ok: false, keys, reason: 'invalid-owner' }
      if (now() < providerReset) return { ok: false, keys, reason: 'provider-reset-pending', retryAt: providerReset }
      if (related.some((entry) => entry.halfOpenAgent !== undefined && entry.halfOpenAgent !== agentId)) return { ok: false, keys, reason: 'retry-in-flight' }
      if (retryOptions?.force !== true && now() < retryAt) return { ok: false, keys, reason: 'cooldown-pending', retryAt }
      manualRetries.set(agentId, { route: selected, force: retryOptions?.force === true })
      const child = children.get(agentId)
      const index = child?.chain.findIndex((candidate) => sameSelection(candidate, selected)) ?? -1
      if (child !== undefined && index >= 0) children.set(agentId, { ...child, index })
      return { ok: true, keys }
    },
    CancelRouteRetry: (agentId) => { manualRetries.delete(agentId) },
    SetRootUpgrade: (agentId, chain, initialUsableRoute) => {
      const root = roots.get(agentId)
      const previous = upgrades.get(agentId)
      if (chain === undefined || chain.length === 0) {
        upgrades.delete(agentId)
        // 撤销本次升级的全部自动回退；稳定人工偏好仍由 rootPreferences 保留。
        roots.delete(agentId)
        preferredTrials.delete(agentId)
        return
      }
      const sameChain = previous !== undefined && previous.chain.length === chain.length
        && previous.chain.every((route, index) => sameSelection(route, chain[index]!))
      const current = root?.override ?? (previous === undefined ? undefined : previous.chain[previous.index])
      const retained = current === undefined ? -1 : chain.findIndex((route) => sameSelection(route, current))
      // Task-card/status refresh is not permission to retry the preferred model.
      // Keep the active fallback and its clock even when metadata says a higher
      // candidate is usable; PreparePreferredRecovery owns safe timed recovery.
      if (previous !== undefined && (sameChain || retained >= 0)) {
        upgrades.set(agentId, { ...previous, chain: [...chain], index: retained >= 0 ? retained : previous.index,
          ...(initialUsableRoute === undefined ? {} : { completeChain: true }) })
        if (root?.override !== undefined && retained >= 0) roots.set(agentId, { ...root, override: chain[retained] })
        return
      }
      const initial = initialUsableRoute === undefined ? 0 : chain.findIndex((route) => sameSelection(route, initialUsableRoute))
      upgrades.set(agentId, { chain: [...chain], index: Math.max(0, initial), at: now(), ...(initialUsableRoute === undefined ? {} : { completeChain: true }), ...(previous?.picker === undefined ? {} : { picker: previous.picker }) })
      // 升级优先于之前的回退覆盖；已试记录保留，升级链失败后不会再回到已失败的路由
      if (root?.override !== undefined) roots.set(agentId, { ...root, override: undefined })
    },
    getRootUpgrade: (agentId) => {
      const chain = upgrades.get(agentId)?.chain
      return chain === undefined ? undefined : [...chain]
    },
    DelAgent: (agentId) => {
      health.release(agentId)
      forgetRecovery(agentId, true)
      children.delete(agentId)
      childOverrides.delete(agentId)
      manualPauses.delete(agentId)
      manualRetries.delete(agentId)
      rootPreferences.delete(agentId); userSelectionSeqs.delete(agentId); recoveryBoundaries.delete(agentId); preferredRecoveryWaits.delete(agentId); preferredTrials.delete(agentId)
      upgrades.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
      lastResolved.delete(agentId)
      networkWaits.delete(agentId)
    },
    ReleaseAgent: (agentId) => {
      health.release(agentId)
      if (children.get(agentId)?.persistent === true) return
      forgetRecovery(agentId, false)
      children.delete(agentId)
      childOverrides.delete(agentId)
      manualPauses.delete(agentId)
      manualRetries.delete(agentId)
      rootPreferences.delete(agentId); userSelectionSeqs.delete(agentId); recoveryBoundaries.delete(agentId); preferredRecoveryWaits.delete(agentId); preferredTrials.delete(agentId)
      upgrades.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
      lastResolved.delete(agentId)
      networkWaits.delete(agentId)
    },
    getRequestOverride: (agent, resolved, _presetRole, config, explicitSelectionAvailable = false) => {
      if (!managed(agent, _presetRole)) return resolved
      if (pendingHealthCommit !== undefined) throw new SwarmError('RECOVERY_REQUIRED', '健康状态持久提交仍未完成；请在请求边界等待，未启动模型请求')
      if (failedHealthCommit) throw new SwarmError('SERVICE_UNAVAILABLE', 'route_health_persist_failed')
      if (manualPauses.has(agent.id)) throw new SwarmError('RECOVERY_REQUIRED', '子会话已人工暂停；取消沉寂后显式继续')
      if (recoveries.get(agent.id)?.completed) begin(agent.id, `${agent.id}:request:${++requestSequence}`)
      const recovery = recoveryOf(agent.id)
      const freshSynchronousBoundary = probe === undefined && recoveryBoundaries.delete(agent.id)
      let child = children.get(agent.id)
      const previousResolved = lastResolved.get(agent.id)
      // Current Hosts provide explicit selection events. Legacy Hosts can only
      // infer a changed provider/model that is not the last actual fallback;
      // adapter default effort changes cannot establish human intent.
      const lastAutomatic = lastRoutes.get(agent.id)
      const legacyUserChange = !explicitSelectionAvailable && previousResolved !== undefined && !sameSelection(resolved, previousResolved) && (lastAutomatic === undefined || !isSameRoute(resolved, lastAutomatic))
      if (child?.persistent === true && legacyUserChange) {
        api.SetChildOverride(agent.id, { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) })
        child = children.get(agent.id)
      }
      const root = roots.get(agent.id)
      // 只在旧宿主的排除自动回退后兼容识别人选；新宿主由 RecordUserSelection 更新。
      if (child === undefined && legacyUserChange) { rootPreferences.set(agent.id, { ...resolved }); roots.delete(agent.id); upgrades.delete(agent.id) }
      if (child === undefined && !rootPreferences.has(agent.id)) rootPreferences.set(agent.id, { ...resolved })
      const preferredRoot = rootPreferences.get(agent.id) ?? resolved
      // 回退覆盖到期：故障多半已经恢复（例如断网结束），重新尝试对话框所选模型；再失败会重新回退
      const recoverMs = config?.agents?.rootRecoverMs ?? 0
      const current = roots.get(agent.id)
      if (freshSynchronousBoundary && child === undefined && current?.override !== undefined && current.at !== undefined && recoverMs > 0 && now() - current.at >= recoverMs && (preferredRecoveryWaits.get(agent.id)?.nextAt ?? 0) <= now() && health.isAvailable(preferredRoot)) roots.delete(agent.id)
      const upgrade = child === undefined ? upgrades.get(agent.id) : undefined
      // 升级生效后用户在对话框里换了模型：以用户的选择为准，撤销升级
      if (upgrade !== undefined && upgrade.picker === undefined) upgrade.picker = { ...preferredRoot }
      lastResolved.set(agent.id, { provider: resolved.provider, model: resolved.model, ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) })
      if (recovery.terminal !== undefined) throw new SwarmError('SERVICE_UNAVAILABLE', recovery.terminal)
      if (recovery.attempts >= policyOf(config).maxLogicalAttempts) { terminal(agent.id, 'recovery_attempts_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'recovery_attempts_exhausted') }
      const declared = config === undefined || _presetRole === undefined ? undefined : getRoleRoute(config, getRouteKey(_presetRole)).chain.find((route) => isSameRoute(route, preferredRoot))
      let route = child === undefined ? (roots.get(agent.id)?.override ?? (upgrades.get(agent.id) === undefined ? undefined : upgrades.get(agent.id)!.chain[upgrades.get(agent.id)!.index]) ?? { ...preferredRoot, ...(declared?.policy === undefined ? {} : { policy: declared.policy }) }) : child.chain[child.index]
      const pendingRetry = manualRetries.get(agent.id)
      if (route !== undefined && pendingRetry !== undefined && isSameRoute(route, pendingRetry.route)) {
        manualRetries.delete(agent.id)
        const permitted = health.claimManualRetry(route, agent.id, { force: pendingRetry.force })
        if (!permitted.ok) throw new SwarmError('RECOVERY_REQUIRED', `受控模型重试暂不可用：${permitted.reason}`)
      }
      const resource = route === undefined ? undefined : getRouteResourcePolicy(route)
      const incompatible = resource?.accessMode === 'judgment_api' || resource?.capabilities?.generation === false || resource?.capabilities?.tools === false
      if (route === undefined || incompatible || !health.claim(route, agent.id)) {
        if (child === undefined && config?.rootFallback === false) { terminal(agent.id, 'route_chain_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'root-fallback-disabled: route_chain_exhausted') }
        const baseChain = config === undefined || _presetRole === undefined ? [] : getRoleRoute(config, getRouteKey(_presetRole)).chain
        const chain = child?.chain ?? (upgrade === undefined ? baseChain : upgrade.completeChain ? upgrade.chain : getUpgradedChain(upgrade.chain, baseChain))
        const index = FindNextIndex(chain, child === undefined ? 0 : child.index + 1, child?.tried ?? roots.get(agent.id)?.tried ?? new Set(), route ?? resolved, 'other', health)
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
      if (manualPauses.has(payload.agent.id)) return undefined
      const recovery = recoveryOf(payload.agent.id)
      if (payload.signal?.aborted === true || recovery.terminal !== undefined) return undefined
      const policy = policyOf(config)
      const failed = lastRoutes.get(payload.agent.id) ?? children.get(payload.agent.id)?.chain[children.get(payload.agent.id)!.index] ?? { provider: payload.provider, model: '' }
      const normalized = normalizeRouteFailure(payload.failure as RouteFailureMetadata, failed)
      if (normalized.kind === 'context_exceeded') return terminal(payload.agent.id, 'context_recovery_required')
      const failedProbe = health.failHalfOpen(failed, payload.agent.id)
      const failureClass = getFailureClass(payload.failure)
      const fatal = isTerminalRouteFailure(normalized)
      const longWait = normalized.providerRetryAfterMs !== undefined && Number.isFinite(normalized.providerRetryAfterMs) && normalized.providerRetryAfterMs > policy.maxShortRetryDelayMs
      if (fatal || longWait) {
        health.record(failed, normalized, fatal ? undefined : normalized.providerRetryAfterMs)
        if (longWait) recovery.suppressedRetryAfterMs = normalized.providerRetryAfterMs
      }
      const afterHealthCommit = (): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
        if (manualPauses.has(payload.agent.id) || payload.signal?.aborted === true) return undefined
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
        try { committed = options.onHealthChange(health.getSnapshot(), { agentId: payload.agent.id, reason: 'failure' }) } catch (error) {
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
