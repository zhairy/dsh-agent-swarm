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
import { normalizeRouteFailure, isTerminalRouteFailure, getRouteResourcePolicy, getWireReasoningEffort, type FailureKind, type RouteFailureMetadata } from './provider-policy.js'
import { intRouteHealth, type RouteHealth, type RouteHealthSnapshot } from './route-health.js'
import { SwarmError } from './util/errors.js'
import { getFailureClass, getRouteKey, getRouteLabel, isSameRoute, type FailureClass, type RouteInfo, type RouteProbe } from './routes.js'
import { getUpgradedChain } from './upgrade.js'
import { getCanonicalJson } from './workflow.js'

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
  /** Preflight selected a quota preference, not a failed preferred-route trial. */
  initialQuotaOrder?: RouteInfo[]
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

interface RequestRouteObservation {
  route: RouteInfo
  recovery: RequestRecoveryState
  position?: { turn: number; step: number }
  /** Object identity distinguishes a picker change from an automatic request header. */
  preference?: RouteInfo
}

/** 一次等待：开始等待（recovered 未定义）或等待结束。network 为断网等待；route 为等路由恢复（链尾临时故障退避、隔离到期、他人半开探测） */
export interface NetworkWaitEventInfo {
  agentId: string
  scope: 'child' | 'root'
  reason: 'network' | 'route'
  route?: RouteInfo
  /** 触发等待的失败；准入时等待没有失败 */
  failure?: LlmFailureLike
  /** route 等待开始时：计划等待时长 */
  waitMs?: number
  /** 等待结束时：network 为网络是否已恢复，route 恒为 true */
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
  /** Source-reported quota may change preference only; health and actual failures remain authoritative. */
  orderQuotaRoutes?: (routes: readonly RouteInfo[], signal?: AbortSignal, protectedRoutes?: readonly RouteInfo[]) => Promise<readonly RouteInfo[]>
  onRouteSuccess?: (route: RouteInfo) => void
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
  /** 链上没有可切换路由时的等待（含断网等待、准入等待）：次数与累计时长，上限为 agents.networkWaitMs */
  holdRetries?: number
  holdWaitedMs?: number
  /** 其中准入时的等待：醒来后才发出本次请求，不是额外的模型调用，不从逻辑次数中扣除 */
  admissionHolds?: number
  /** 链耗尽时各路由的状态说明，写进委派结果 */
  terminalDetail?: string
  /** 最近一次真实请求失败；仅供只读诊断，不进入批准或门禁。 */
  lastFailure?: {
    kind: FailureKind
    provider: string
    model: string
    message: string
    at: number
    code?: string
    status?: number
  }
}
export interface RecoveryPolicy {
  maxTransientRetries: number
  maxShortRetryDelayMs: number
  maxTransientWaitMs: number
  maxLogicalAttempts: number
}
export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = { maxTransientRetries: 1, maxShortRetryDelayMs: 2000, maxTransientWaitMs: 5000, maxLogicalAttempts: 8 }

/** 单个逻辑请求的保持重试上限：时长预算之外的保险，防止时钟停滞或网络抖动时无限重试 */
const MAX_HOLD_RETRIES = 32

/** 准入需要先等待：只在 requestOverride 与 AdmitRequest 之间传递 */
class AdmissionWait {
  constructor (readonly waitMs: number, readonly route: RouteInfo) {}
}

/** 同步选路在 claim 与计数之前交给异步准入做适用性预检。 */
class AdmissionProbe {
  constructor (readonly route: RouteInfo) {}
}

/** 路由状态注册表：spawn 子智能体按链回退，swarm 预设的根会话按角色链回退 */
export interface RouteStateRegistry {
  /** 登记子智能体（或连续会话的新一轮）：路由链从头开始，已试记录清空 */
  AddChild: (agentId: string, state: { chain: RouteInfo[]; role: RoleId; onFallback?: (event: FallbackEventInfo) => void; persistent?: boolean; logicalRequestId?: string; initialRoute?: RouteInfo; initialQuotaOrder?: readonly RouteInfo[]; respectStoredOverride?: boolean; requireVision?: boolean }) => void
  BeginLogicalRequest: (agentId: string, logicalRequestId: string) => void
  BeginRequestStep: (agentId: string, turn: number, step: number) => void
  /** The delegation owner calls this after every result/terminal has been consumed, including failure and cancellation. */
  FinishLogicalRequest: (logicalRequestId: string) => void
  getRecovery: (agentId: string) => RequestRecoveryState | undefined
  /** Aggregate lifecycle counts only; no session, request or model identities. */
  getRecoveryDiagnostics: () => { agents: number; logicalRequests: number; logicalStates: number; disposedTerminals: number }
  getTerminal: (agentId: string) => RequestRecoveryState['terminal']
  /** 链耗尽时各路由的状态说明（隔离原因与预计恢复时间） */
  getTerminalDetail: (agentId: string) => string | undefined
  isRouteAvailable: (route: RouteInfo) => boolean
  isRouteAvailableFor: (route: RouteInfo, agentId: string) => boolean
  /** 隔离到期时刻（未隔离为 0），供委派前判断是否值得等待 */
  getRouteDueAt: (route: RouteInfo) => number
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
  PrepareQuotaRouting: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config: SwarmConfigInfo, signal?: AbortSignal) => Promise<void>
  RequestRouteRetry: (route: RouteInfo, agentId: string, options?: { force?: boolean }) => { ok: boolean; keys: string[]; reason?: string; retryAt?: number }
  CancelRouteRetry: (agentId: string) => void
  /** 设置或撤销根会话的容灾升级链（已预检可用的路由） */
  SetRootUpgrade: (agentId: string, chain: RouteInfo[] | undefined, initialUsableRoute?: RouteInfo) => void
  getRootUpgrade: (agentId: string) => RouteInfo[] | undefined
  DelAgent: (agentId: string) => void
  /** 宿主释放 Agent 时调用：连续会话子智能体的路由状态保留，其余清理 */
  ReleaseAgent: (agentId: string) => void
  /** 同步准入：链上没有可立即使用的路由时直接判定链耗尽 */
  getRequestOverride: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config?: SwarmConfigInfo, explicitSelectionAvailable?: boolean) => CallConfigLike
  /** 宿主请求入口的准入：链上暂时没有可用路由时，在等待预算内等最早可能恢复的路由后重新准入 */
  AdmitRequest: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config: SwarmConfigInfo, explicitSelectionAvailable?: boolean, signal?: AbortSignal) => Promise<CallConfigLike>
  getErrorAction: (
    payload: RequestErrorPayloadLike,
    action: RequestErrorActionLike,
    presetRole: RoleId | undefined,
    config: SwarmConfigInfo
  ) => RequestErrorActionLike | Promise<RequestErrorActionLike>
}

/** 换路由时丢弃继承的推理强度，避免把上一模型的强度套到新模型上 */
const getRoutedConfig = (resolved: CallConfigLike, route: RouteInfo): CallConfigLike => {
  const { reasoningEffort: _inherited, policy: _resourcePolicy, ...rest } = resolved
  const effort = getWireReasoningEffort(route)
  return {
    ...rest,
    provider: route.provider,
    model: route.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort })
  }
}

/**
 * 额度源给出的顺序只能重排已声明的路由：增删模型、改写 policy 或形状不符时保留原链
 * @param {readonly RouteInfo[]} declared - 声明的路由链
 * @param {unknown} proposed - 额度源建议的顺序
 * @returns {RouteInfo[]} 重排后的链（元素取自 declared）
 */
export const getValidatedQuotaOrder = (declared: readonly RouteInfo[], proposed: unknown): RouteInfo[] => {
  if (!Array.isArray(proposed) || proposed.length !== declared.length) return [...declared]
  const remaining = [...declared]
  const ordered: RouteInfo[] = []
  for (const route of proposed as unknown[]) {
    const index = route === null || typeof route !== 'object' ? -1
      : remaining.findIndex((candidate) => isSameRoute(candidate, route as RouteInfo) && candidate.reasoningEffort === (route as RouteInfo).reasoningEffort)
    if (index < 0) return [...declared]
    ordered.push(remaining.splice(index, 1)[0]!)
  }
  return ordered
}

/** 能否承担生成请求：判断类 API 或声明不支持生成/工具的路由不参与回退 */
const canServe = (route: RouteInfo): boolean => {
  const policy = getRouteResourcePolicy(route)
  return policy.accessMode !== 'judgment_api' && policy.capabilities?.generation !== false && policy.capabilities?.tools !== false
}

/** 从 start 起找第一条未试过的路由；认证失败时跳过同一 provider */
const FindNextIndex = (chain: RouteInfo[], start: number, tried: ReadonlySet<string>, failed: RouteInfo, failureClass: FailureClass, health: RouteHealth, accepts?: (route: RouteInfo) => boolean): number | undefined => {
  for (let index = start; index < chain.length; index++) {
    const route = chain[index] as RouteInfo
    if (tried.has(getRouteLabel(route)) || !health.isAvailable(route) || !canServe(route)) continue
    if (failureClass === 'auth' && route.provider === failed.provider && route.policy?.quotaDomainId === undefined) continue
    if (accepts?.(route) === false) continue
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
  // An effective order belongs to one logical step. Keep declared chains intact
  // so preferred recovery still refers to the user's original preference.
  const quotaOrders = new Map<string, { logicalRequestId: string; chain: RouteInfo[] }>()
  const quotaPreparations = new Map<string, object>()
  const quotaManualSelections = new Set<string>()
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
      quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
      recoveryBoundaries.add(agentId)
      preferredTrials.delete(agentId)
      const child = children.get(agentId)
      if (child !== undefined) children.set(agentId, { ...child, tried: new Set() })
      const root = roots.get(agentId)
      if (root !== undefined) roots.set(agentId, { ...root, tried: new Set() })
    }
  }
  const forgetRecovery = (agentId: string, preserveTerminal: boolean): void => {
    quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
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
  const requestObservations = new Map<string, RequestRouteObservation>()
  const requestPositions = new Map<string, { turn: number; step: number }>()
  // The Host retains the same turn signal through request-error. Old turns
  // cannot borrow a later turn's route after a manual continuation.
  const signalObservations = new WeakMap<AbortSignal, Map<string, RequestRouteObservation>>()
  const observedRequest = (payload: RequestErrorPayloadLike): RequestRouteObservation | undefined =>
    (payload.signal === undefined ? undefined : signalObservations.get(payload.signal)?.get(payload.agent.id)) ?? requestObservations.get(payload.agent.id)
  const staleFailure = (payload: RequestErrorPayloadLike): boolean => {
    const exact = payload.signal === undefined ? undefined : signalObservations.get(payload.signal)?.get(payload.agent.id)
    const observation = exact ?? requestObservations.get(payload.agent.id)
    if (observation === undefined) return false
    if (observation.recovery !== recoveries.get(payload.agent.id) || (exact !== undefined && exact.route.provider !== payload.provider)) return true
    return observation.position !== undefined && payload.turn !== undefined && payload.step !== undefined
      && (payload.turn !== observation.position.turn || payload.step !== observation.position.step)
  }
  /** 兼容旧宿主的改写前路由；必须排除实际自动回退和适配器默认值漂移。 */
  const lastResolved = new Map<string, RouteInfo>()
  const upgrades = new Map<string, RootUpgradeStateInfo>()
  const delayPreferred = (agentId: string): void => {
    const failures = (preferredRecoveryWaits.get(agentId)?.failures ?? 0) + 1
    preferredRecoveryWaits.set(agentId, { failures, nextAt: now() + Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6)) })
    preferredTrials.delete(agentId)
  }

  const effectiveChain = (agentId: string, declared: RouteInfo[]): RouteInfo[] => {
    const ordered = quotaOrders.get(agentId)
    return ordered !== undefined && ordered.logicalRequestId === recoveries.get(agentId)?.logicalRequestId ? ordered.chain : declared
  }
  const quotaCancelled = (signal?: AbortSignal): void => {
    if (signal?.aborted === true) throw new SwarmError('RECOVERY_REQUIRED', '额度路由准备已取消；未启动新的模型请求')
  }
  const canUse = (route: RouteInfo): boolean => health.isAvailable(route) && canServe(route)
  const admissionKey = (route: RouteInfo): string => getCanonicalJson([route.provider, route.model, route.reasoningEffort ?? null, route.policy ?? {}])

  /** 计入 maxLogicalAttempts 的次数：错误恢复中的等待会多出一次重试请求，不算新的逻辑尝试 */
  const countedAttempts = (recovery: RequestRecoveryState): number => recovery.attempts - ((recovery.holdRetries ?? 0) - (recovery.admissionHolds ?? 0))
  /** 本逻辑请求还能等待的时长：断网等待与链尾保持共用 agents.networkWaitMs */
  const holdLeft = (recovery: RequestRecoveryState, config: SwarmConfigInfo): number =>
    (recovery.holdRetries ?? 0) >= MAX_HOLD_RETRIES ? 0 : Math.max(0, (config.agents?.networkWaitMs ?? 0) - (recovery.holdWaitedMs ?? 0))

  /** 链耗尽时写进委派结果的说明：每条路由是被隔离（原因与预计恢复）还是本次请求已失败 */
  const getChainDetail = (chain: readonly RouteInfo[], tried: ReadonlySet<string>): string => chain.map((route) => {
    const due = health.getDueAt(route) - now()
    const kind = health.getRelatedEntries(route)[0]?.kind
    if (kind !== undefined && due > 0) return `${getRouteLabel(route)} ${kind}（约 ${Math.ceil(due / 60_000)} 分钟后可再试）`
    return `${getRouteLabel(route)} ${tried.has(getRouteLabel(route)) ? '本次请求已失败' : '不可用'}`
  }).join('；')

  /**
   * 链上已没有可切换的路由：在等待预算内等最早能再试的一条——当前路由只是临时故障、或路由正由其他请求半开探测时
   * 指数退避（5 秒起，封顶 60 秒），被隔离的路由等到隔离到期；预检失败或能力不符的路由不等。超出预算才判定链耗尽。
   * 每次等待都从预算中扣除，单个逻辑请求的总等待不超过 networkWaitMs，保持次数不超过 MAX_HOLD_RETRIES，必然终止。
   */
  const holdOrExhaust = (agentId: string, chain: readonly RouteInfo[], current: RouteInfo, tried: ReadonlySet<string>, failure: LlmFailureLike,
    kind: { transient: boolean; auth: boolean }, config: SwarmConfigInfo, signal: AbortSignal | undefined, retarget: (route: RouteInfo) => RequestErrorActionLike): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const recovery = recoveryOf(agentId)
    const at = now()
    const backoff = Math.min(60_000, 5_000 * 2 ** Math.min(recovery.holdRetries ?? 0, 4))
    let best: { route: RouteInfo; wait: number } | undefined
    for (const route of chain) {
      // 认证失败时同一 provider 的其他模型同样会失败
      if (!canServe(route) || (kind.auth && route.provider === current.provider && route.policy?.quotaDomainId === undefined)) continue
      const due = health.getDueAt(route)
      // 已到期但正由其他请求半开探测的路由，与当前路由的临时故障一样按退避间隔复查
      const wait = due > at ? due - at : (isSameRoute(route, current) && kind.transient) || !health.isAvailable(route) ? backoff : Infinity
      if (wait !== Infinity && (best === undefined || wait < best.wait)) best = { route, wait }
    }
    if (best === undefined || best.wait > holdLeft(recovery, config)) {
      recovery.terminalDetail = getChainDetail(chain, tried)
      return terminal(agentId, 'route_chain_exhausted', failure)
    }
    const target = best
    const scope = children.has(agentId) ? 'child' : 'root'
    recovery.holdRetries = (recovery.holdRetries ?? 0) + 1
    recovery.holdWaitedMs = (recovery.holdWaitedMs ?? 0) + target.wait
    options.onNetworkWait?.({ agentId, scope, reason: 'route', failure, route: target.route, waitMs: target.wait })
    return (options.sleep ?? SleepWithSignal)(target.wait, signal).then(() => {
      options.onNetworkWait?.({ agentId, scope, reason: 'route', failure, route: target.route, recovered: true, waitedMs: target.wait })
      if (signal?.aborted === true || manualPauses.has(agentId) || recoveries.get(agentId) !== recovery) return undefined
      return retarget(target.route)
    })
  }

  /**
   * 准入时链上暂时没有能立即使用的路由（被其他专家的失败隔离，或正由其他请求半开探测）：返回在本请求等待预算内
   * 等到最早可能恢复的一条所需的时长；没有可等的路由或超出预算时判定链耗尽
   */
  const getAdmissionWait = (agentId: string, chain: readonly RouteInfo[], current: RouteInfo, tried: ReadonlySet<string>, config: SwarmConfigInfo | undefined, checks?: ReadonlyMap<string, boolean>): AdmissionWait => {
    const recovery = recoveryOf(agentId)
    const at = now()
    const poll = Math.min(60_000, 5_000 * 2 ** Math.min(recovery.holdRetries ?? 0, 4))
    let best: AdmissionWait | undefined
    for (const route of [current, ...chain]) {
      if (!canServe(route) || checks?.get(admissionKey(route)) === false || (!isSameRoute(route, current) && tried.has(getRouteLabel(route)) && health.getRelatedEntries(route).length === 0)) continue
      const due = health.getDueAt(route)
      // 已试路由只有仍有隔离记录才可等待重探；半开探测由另一请求持有时按退避间隔复查。
      const waitMs = due > at ? due - at : poll
      if (best === undefined || waitMs < best.waitMs) best = new AdmissionWait(waitMs, route)
    }
    if (config !== undefined && best !== undefined && best.waitMs <= holdLeft(recovery, config)) return best
    recovery.terminalDetail = getChainDetail(chain, tried)
    terminal(agentId, 'route_chain_exhausted')
    throw new SwarmError('SERVICE_UNAVAILABLE', 'route_chain_exhausted')
  }

  const getChildFallback = (agentId: string, state: ChildStateInfo, failed: RouteInfo, failure: LlmFailureLike, failureClass: FailureClass, transient: boolean, config: SwarmConfigInfo, signal?: AbortSignal): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const recovery = recoveryOf(agentId)
    const chain = effectiveChain(agentId, state.chain)
    // 链指针代表下一请求的选择，不代表在途 attempt。用户可能在旧请求
    // 返回前换模；失败归属必须沿用 getErrorAction 捕获的实际路由。
    const selected = state.chain[state.index]
    const selectionChanged = selected === undefined || !isSameRoute(selected, failed)
    const start = quotaOrders.has(agentId) || selectionChanged ? 0 : state.index + 1
    if (!selectionChanged && (state.index === 0 || preferredTrials.has(agentId))) delayPreferred(agentId)
    const tried = new Set([...state.tried, getRouteLabel(failed)])
    const changedSelectionAction = (): RequestErrorActionLike => {
      if (signal?.aborted === true || manualPauses.has(agentId) || recoveries.get(agentId) !== recovery) return undefined
      const latest = children.get(agentId)
      // 预检期间只换了下一请求选择：重入既有准入，不丢弃新选择、
      // 不覆盖新链；释放或跨委派重新登记仍然拒绝旧回调。
      return latest !== undefined && latest.logicalRequestId === state.logicalRequestId && latest.baseChain === state.baseChain ? { kind: 'retry' } : undefined
    }
    const moveTo = (base: ChildStateInfo, to: RouteInfo, nextTried: ReadonlySet<string>): RequestErrorActionLike => {
      const index = base.chain.findIndex((route) => sameSelection(route, to))
      if (index < 0) return undefined
      children.set(agentId, { ...base, index, tried: nextTried })
      if (!isSameRoute(to, failed)) state.onFallback?.({ agentId, from: failed, to, failure, scope: 'child' })
      return { kind: 'retry' }
    }
    const settle = (next: number | undefined): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
      if (signal?.aborted === true || manualPauses.has(agentId) || recoveries.get(agentId) !== recovery) return undefined
      if (children.get(agentId) !== state) return changedSelectionAction()
      if (next !== undefined) return moveTo(state, chain[next] as RouteInfo, tried)
      const held = { ...state, tried }
      children.set(agentId, held)
      return holdOrExhaust(agentId, chain, failed, tried, failure, { transient, auth: failureClass === 'auth' }, config, signal, (to) => {
        const latest = children.get(agentId)
        // 等待期间用户换了模型或状态已更新：不改回等待前的目标，交给准入按最新状态选路
        if (latest !== held) return latest === undefined ? undefined : { kind: 'retry' }
        return moveTo(latest, to, new Set([...latest.tried].filter((label) => label !== getRouteLabel(to))))
      })
    }
    // 先向后找，再从链首环形查找：之前被预检跳过、现已恢复的路由也能接手
    const findFrom = (from: number): number | undefined => FindNextIndex(chain, from, tried, failed, failureClass, health)
    if (probe === undefined) return settle(findFrom(start) ?? findFrom(0))
    return (async () => {
      for (const from of [start, 0]) for (let next = findFrom(from); next !== undefined; next = findFrom(next + 1)) {
        if (signal?.aborted === true) return undefined
        const candidate = chain[next] as RouteInfo
        const checked = await (signal === undefined ? probe(candidate) : probe(candidate, signal))
        if (Boolean(signal?.aborted) || manualPauses.has(agentId) || recoveries.get(agentId) !== recovery) return undefined
        if (children.get(agentId) !== state) return changedSelectionAction()
        if (checked.ok && (state.requireVision !== true || checked.vision)) return settle(next)
        tried.add(getRouteLabel(candidate))
      }
      return settle(undefined)
    })()
  }

  const getRootFallback = (payload: RequestErrorPayloadLike, presetRole: RoleId, failureClass: FailureClass, transient: boolean, config: SwarmConfigInfo,
    failed: RouteInfo, observedPreference?: RouteInfo): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const agentId = payload.agent.id
    const previous = roots.get(agentId)
    const preference = rootPreferences.get(agentId)
    const recovery = recoveries.get(agentId)
    const picker = rootPreferences.get(agentId) ?? previous?.picker ?? lastResolved.get(agentId) ?? failed
    const tried = new Set([...(previous?.tried ?? []), getRouteLabel(failed)])
    const roleChain = getRoleRoute(config, getRouteKey(presetRole)).chain
    const upgrade = upgrades.get(agentId)
    // 升级期间：先在升级链内回退，再回到常规链
    const declared = effectiveChain(agentId, upgrade === undefined ? roleChain : upgrade.completeChain ? upgrade.chain : getUpgradedChain(upgrade.chain, roleChain))
    const chain = preference !== undefined && preference !== observedPreference ? selectedChain(declared, preference) : declared
    if (preferredTrials.has(agentId) || isSameRoute(failed, picker)) delayPreferred(agentId)
    const moveTo = (to: RouteInfo, nextTried: ReadonlySet<string>): RequestErrorActionLike => {
      roots.set(agentId, { override: to, at: now(), picker, tried: nextTried })
      if (!isSameRoute(to, failed)) onRootFallback?.({ agentId, from: failed, to, failure: payload.failure, scope: 'root' })
      return { kind: 'retry' }
    }
    const settle = (next: number | undefined): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
      if (payload.signal?.aborted === true || manualPauses.has(agentId) || recoveries.get(agentId) !== recovery) return undefined
      // A new selection during metadata I/O is still the same live request.
      // Re-enter admission instead of ending the turn or installing an old override.
      if (rootPreferences.get(agentId) !== preference) return { kind: 'retry' }
      if (roots.get(agentId) !== previous || upgrades.get(agentId) !== upgrade) return undefined
      if (next !== undefined) return moveTo(chain[next] as RouteInfo, tried)
      const held = { ...previous, picker, tried }
      roots.set(agentId, held)
      return holdOrExhaust(agentId, chain, failed, tried, payload.failure, { transient, auth: failureClass === 'auth' }, config, payload.signal,
        (to) => roots.get(agentId) !== held || rootPreferences.get(agentId) !== preference || upgrades.get(agentId) !== upgrade
          ? { kind: 'retry' } : moveTo(to, new Set([...held.tried].filter((label) => label !== getRouteLabel(to)))))
    }
    if (probe === undefined) return settle(FindNextIndex(chain, 0, tried, failed, failureClass, health))
    // 与子智能体一致：只回退到当前可解析的路由，不可用的记为已试并继续向后找
    const FindUsableIndex = async (): Promise<number | undefined> => {
      for (let next = FindNextIndex(chain, 0, tried, failed, failureClass, health); next !== undefined; next = FindNextIndex(chain, next + 1, tried, failed, failureClass, health)) {
        if (payload.signal?.aborted === true) return undefined
        const route = chain[next] as RouteInfo
        if ((await (payload.signal === undefined ? probe(route) : probe(route, payload.signal))).ok) return next
        tried.add(getRouteLabel(route))
      }
      return undefined
    }
    return FindUsableIndex().then(settle)
  }

  /**
   * 断网时先等待网络恢复（与链尾保持共用本请求的等待预算），恢复后在原路由上重试；
   * 网络正常（单个供应商故障）或预算用尽时按常规回退
   * @returns 回退动作
   */
  const getNetworkAwareAction = (
    payload: RequestErrorPayloadLike, scope: 'child' | 'root', config: SwarmConfigInfo, fallback: () => RequestErrorActionLike | Promise<RequestErrorActionLike>
  ): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
    const network = options.network
    const agentId = payload.agent.id
    const recovery = recoveryOf(agentId)
    // 不需要探测时保持同步返回
    if (network === undefined || holdLeft(recovery, config) <= 0 || !isNetworkSuspect(payload.failure)) return fallback()
    return (async () => {
      if (await network.isOnline()) return fallback()
      const route = lastRoutes.get(agentId)
      const started = now()
      options.onNetworkWait?.({ agentId, scope, reason: 'network', failure: payload.failure, ...(route === undefined ? {} : { route }) })
      const recovered = await network.waitOnline(payload.signal, holdLeft(recovery, config))
      recovery.holdRetries = (recovery.holdRetries ?? 0) + 1
      recovery.holdWaitedMs = (recovery.holdWaitedMs ?? 0) + (now() - started)
      options.onNetworkWait?.({ agentId, scope, reason: 'network', failure: payload.failure, recovered, waitedMs: now() - started, ...(route === undefined ? {} : { route }) })
      if (payload.signal?.aborted === true || manualPauses.has(agentId)) return undefined
      return recovered ? { kind: 'retry' } : fallback()
    })()
  }

  /** 准入；canWait 时链上暂无可用路由但等待预算允许，抛出 AdmissionWait，交给 AdmitRequest 等待后重新准入 */
  const requestOverride = (agent: AgentLike, resolved: CallConfigLike, _presetRole: RoleId | undefined, config: SwarmConfigInfo | undefined, explicitSelectionAvailable: boolean, canWait: boolean, checks?: ReadonlyMap<string, boolean>): CallConfigLike => {
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
    if (child === undefined && legacyUserChange) {
      rootPreferences.set(agent.id, { ...resolved }); roots.delete(agent.id); upgrades.delete(agent.id)
      quotaManualSelections.add(agent.id); quotaOrders.delete(agent.id); quotaPreparations.delete(agent.id)
    }
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
    if (countedAttempts(recovery) >= policyOf(config).maxLogicalAttempts) { terminal(agent.id, 'recovery_attempts_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'recovery_attempts_exhausted') }
    const declared = config === undefined || _presetRole === undefined ? undefined : getRoleRoute(config, getRouteKey(_presetRole)).chain.find((route) => isSameRoute(route, preferredRoot))
    let route = child === undefined ? (roots.get(agent.id)?.override ?? (upgrades.get(agent.id) === undefined ? undefined : upgrades.get(agent.id)!.chain[upgrades.get(agent.id)!.index]) ?? { ...preferredRoot, ...(declared?.policy === undefined ? {} : { policy: declared.policy }) }) : child.chain[child.index]
    const pendingRetry = manualRetries.get(agent.id)
    if (route !== undefined && pendingRetry !== undefined && isSameRoute(route, pendingRetry.route)) {
      manualRetries.delete(agent.id)
      const permitted = health.claimManualRetry(route, agent.id, { force: pendingRetry.force })
      if (!permitted.ok) throw new SwarmError('RECOVERY_REQUIRED', `受控模型重试暂不可用：${permitted.reason}`)
    }
    const accepts = (candidate: RouteInfo): boolean => {
      if (checks === undefined) return true
      const checked = checks.get(admissionKey(candidate))
      if (checked === undefined) throw new AdmissionProbe(candidate)
      return checked
    }
    // 只有从隔离恢复的当前路由才预检；未失败过的健康路由与 2.9.3 一致不依赖元数据。
    // 已由本请求持有的半开/人工许可不能再走全局 probe（它会把自己的 claim 当作隔离）。
    const returning = route !== undefined && health.getRelatedEntries(route).length > 0
    if (route === undefined || !canServe(route) || (returning && health.isAvailable(route) && !accepts(route)) || !health.claim(route, agent.id)) {
      if (child === undefined && config?.rootFallback === false) { terminal(agent.id, 'route_chain_exhausted'); throw new SwarmError('SERVICE_UNAVAILABLE', 'root-fallback-disabled: route_chain_exhausted') }
      const baseChain = config === undefined || _presetRole === undefined ? [] : getRoleRoute(config, getRouteKey(_presetRole)).chain
      const chain = effectiveChain(agent.id, child?.chain ?? (upgrade === undefined ? baseChain : upgrade.completeChain ? upgrade.chain : getUpgradedChain(upgrade.chain, baseChain)))
      const tried = child?.tried ?? roots.get(agent.id)?.tried ?? new Set<string>()
      // 与错误回退一致：先向后找，再环查此前被跳过、现已恢复的路由。
      const index = FindNextIndex(chain, child === undefined || quotaOrders.has(agent.id) ? 0 : child.index + 1, tried, route ?? resolved, 'other', health, accepts)
        ?? FindNextIndex(chain, 0, tried, route ?? resolved, 'other', health, accepts)
      const candidate = index === undefined ? undefined : chain[index] as RouteInfo
      if (candidate === undefined || !health.claim(candidate, agent.id)) {
        if (canWait) throw getAdmissionWait(agent.id, chain, route ?? resolved, tried, config, checks)
        recovery.terminalDetail = getChainDetail(chain, tried)
        terminal(agent.id, 'route_chain_exhausted')
        throw new SwarmError('SERVICE_UNAVAILABLE', 'route_chain_exhausted')
      }
      route = candidate
      if (child !== undefined) children.set(agent.id, { ...child, index: child.chain.findIndex((candidate) => sameSelection(candidate, route!)) })
      else roots.set(agent.id, { override: route, at: now(), picker: resolved, tried: root?.tried ?? new Set() })
    }
    const activeChild = children.get(agent.id)
    if (activeChild?.initialQuotaOrder !== undefined) children.set(agent.id, { ...activeChild, initialQuotaOrder: undefined })
    recovery.attempts += 1
    recovery.attemptedRoutes.push(getRouteLabel(route))
    const next = route === undefined ? resolved : getRoutedConfig(resolved, route)
    lastRoutes.set(agent.id, route)
    requestObservations.set(agent.id, { route: { ...route, ...(route.policy === undefined ? {} : { policy: { ...route.policy,
      ...(route.policy.capabilities === undefined ? {} : { capabilities: { ...route.policy.capabilities } }) } }) }, recovery,
      ...(requestPositions.get(agent.id) === undefined ? {} : { position: { ...requestPositions.get(agent.id)! } }),
      ...(rootPreferences.get(agent.id) === undefined ? {} : { preference: rootPreferences.get(agent.id) }) })
    return next
  }

  const api: RouteStateRegistry = {
    BeginLogicalRequest: begin,
    BeginRequestStep: (id, turn, step) => { requestPositions.set(id, { turn, step }); begin(id, `${children.get(id)?.logicalRequestId ?? id}:${turn}:${step}`) },
    FinishLogicalRequest: (id) => {
      const group = logical.get(id)
      if (group === undefined || !group.delegation) return
      for (const agentId of group.agents) {
        if (agentScopes.get(agentId) !== id) continue
        agentScopes.delete(agentId)
        quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
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
    getTerminalDetail: (id) => recoveries.get(id)?.terminalDetail,
    isRouteAvailable: (route) => health.isAvailable(route),
    getRouteDueAt: (route) => health.getDueAt(route),
    isRouteAvailableFor: (route, agentId) => health.isAvailable(route) || (manualRetries.get(agentId) !== undefined && isSameRoute(manualRetries.get(agentId)!.route, route)),
    getHealth: () => health.list(),
    getHealthSnapshot: () => health.getSnapshot(),
    WaitHealthReady: waitHealthReady,
    RestoreHealth: (entries) => health.restore(entries),
    clearHealth: (key) => health.clear(key),
    ObserveRouteFailure: (route, failure, config) => {
      const normalized = normalizeRouteFailure(failure as RouteFailureMetadata, route)
      // 元数据网络故障也走既有隔离与有界准入等待，不能作为模型不可用的永久否定。
      if (isTerminalRouteFailure(normalized) || normalized.kind === 'network_transient') {
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
      try { if (route !== undefined) options.onRouteSuccess?.(route) } catch { /* Advisory source bookkeeping cannot undo an actual success. */ }
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
      if (manualPauses.has(payload.agent.id) || payload.signal?.aborted === true || staleFailure(payload)) return undefined
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
        ...(state.initialQuotaOrder === undefined ? {} : { initialQuotaOrder: getValidatedQuotaOrder(prepared, state.initialQuotaOrder) }),
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
      quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
      if (current !== undefined && !(previous !== undefined && route !== undefined && sameSelection(previous, route))) children.set(agentId, { ...current, chain: selectedChain(current.baseChain ?? current.chain, route), index: 0, tried: new Set(), initialQuotaOrder: undefined })
    },
    getChildOverride: (agentId) => { const value = childOverrides.get(agentId); return value === undefined ? undefined : { ...value } },
    SetManualPause: (agentId, paused) => { if (paused) manualPauses.add(agentId); else manualPauses.delete(agentId) },
    isManualPaused: (agentId) => manualPauses.has(agentId),
    getLastRoute: (agentId) => { const value = lastRoutes.get(agentId); return value === undefined ? undefined : { ...value, ...(getWireReasoningEffort(value) === undefined ? {} : { reasoningEffort: getWireReasoningEffort(value) }) } },
    RestoreRootPreference: (agentId, route) => { if (!rootPreferences.has(agentId)) rootPreferences.set(agentId, { ...route }) },
    getRootPreference: (agentId) => { const value = rootPreferences.get(agentId); return value === undefined ? undefined : { ...value } },
    RecordUserSelection: (agentId, route, seq) => {
      if (seq !== undefined && (userSelectionSeqs.get(agentId) ?? -1) >= seq) return
      if (seq !== undefined) userSelectionSeqs.set(agentId, seq)
      if (children.has(agentId)) api.SetChildOverride(agentId, route)
      else { rootPreferences.set(agentId, { ...route }); roots.delete(agentId); upgrades.delete(agentId); quotaManualSelections.add(agentId) }
      quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
      preferredTrials.delete(agentId); preferredRecoveryWaits.delete(agentId)
    },
    PreparePreferredRecovery: async (agent, resolved, role, config) => {
      if (managed(agent, role) && recoveries.get(agent.id)?.completed) begin(agent.id, `${agent.id}:request:${++requestSequence}`)
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
      if (child !== undefined && !(child.initialQuotaOrder !== undefined && !lastRoutes.has(agent.id))) candidates = child.chain.slice(0, child.index)
      else if (upgrade !== undefined) {
        const at = upgrade.chain.findIndex((route) => isSameRoute(route, root?.override ?? upgrade.chain[upgrade.index]!))
        candidates = upgrade.chain.slice(0, Math.max(0, at))
      } else if (root?.override !== undefined && (config.agents.rootRecoverMs ?? 0) > 0 && root.at !== undefined && now() - root.at >= config.agents.rootRecoverMs) candidates = [rootPreferences.get(agent.id) ?? root.picker ?? resolved]
      for (const candidate of candidates) {
        if (!canUse(candidate)) continue
        const checked = probe === undefined ? { ok: true as const, vision: true } : await probe(candidate)
        if (manualPauses.has(agent.id) || recoveries.get(agent.id)?.logicalRequestId !== logicalRequestId || children.get(agent.id) !== child || upgrades.get(agent.id) !== upgrade || roots.get(agent.id) !== root) return
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
    PrepareQuotaRouting: async (agent, resolved, role, config, signal) => {
      if (!managed(agent, role)) return
      quotaCancelled(signal)
      if (options.orderQuotaRoutes === undefined || manualPauses.has(agent.id) || childOverrides.has(agent.id) || quotaManualSelections.has(agent.id) || (!children.has(agent.id) && !config.rootFallback)) return
      const recovery = recoveryOf(agent.id)
      if (recovery.terminal !== undefined || quotaOrders.get(agent.id)?.logicalRequestId === recovery.logicalRequestId) return
      const child = children.get(agent.id)
      const root = roots.get(agent.id)
      const upgrade = upgrades.get(agent.id)
      const roleChain = role === undefined ? [] : getRoleRoute(config, getRouteKey(role)).chain
      const preferred = rootPreferences.get(agent.id) ?? resolved
      const declared = child?.chain ?? (upgrade === undefined ? selectedChain(roleChain, preferred) : upgrade.completeChain ? upgrade.chain : getUpgradedChain(upgrade.chain, roleChain))
      if (declared.length === 0) return
      const current = child?.chain[child.index] ?? root?.override ?? upgrade?.chain[upgrade.index] ?? withDeclaredPolicy(roleChain, preferred)
      const trial = preferredTrials.get(agent.id)?.to
      const token = {}
      quotaPreparations.set(agent.id, token)
      try {
        let proposed: readonly RouteInfo[]
        try { proposed = child?.initialQuotaOrder ?? await options.orderQuotaRoutes(declared, signal, trial === undefined ? [] : [trial]) }
        catch (error) { quotaCancelled(signal); proposed = declared }
        quotaCancelled(signal)
        const stillCurrent = () => quotaPreparations.get(agent.id) === token && recoveries.get(agent.id) === recovery && children.get(agent.id) === child && roots.get(agent.id) === root && upgrades.get(agent.id) === upgrade && !manualPauses.has(agent.id) && !childOverrides.has(agent.id) && !quotaManualSelections.has(agent.id)
        if (!stillCurrent()) return
        const chain = getValidatedQuotaOrder(declared, proposed)
        quotaOrders.set(agent.id, { logicalRequestId: recovery.logicalRequestId, chain })
        // Once an attempt was admitted, quota must not replay a route or reset its
        // bounded recovery state. Fallback uses this order and the existing tried set.
        // Established fallback recovery still belongs to its existing timer and
        // probe policy; a newly read quota report cannot rewind that policy.
        const retainedFallback = lastRoutes.has(agent.id) && (child === undefined ? root?.override !== undefined || (upgrade?.index ?? 0) > 0 : child.index > 0)
        if (recovery.attempts > 0 || child?.initialQuotaOrder !== undefined || trial !== undefined || retainedFallback || chain.every((route, index) => sameSelection(route, declared[index]!))) return
        for (const candidate of chain) {
          quotaCancelled(signal)
          if (!canUse(candidate)) continue
          // Preflight already verified the chosen child route. New root choices
          // and other candidates must pass the same capability/metadata gate.
          if (!sameSelection(candidate, current) && probe !== undefined) {
            const checked = await probe(candidate, signal)
            quotaCancelled(signal)
            if (!stillCurrent()) return
            if (!checked.ok || (child?.requireVision === true && !checked.vision)) continue
          }
          if (!stillCurrent()) return
          if (child !== undefined) children.set(agent.id, { ...child, index: child.chain.findIndex((route) => sameSelection(route, candidate)) })
          else if (!sameSelection(candidate, current)) roots.set(agent.id, { override: candidate, at: now(), picker: preferred, tried: root?.tried ?? new Set() })
          return
        }
      } finally {
        // A late cancelled step must not erase a newer step's effective chain.
        if (quotaPreparations.get(agent.id) === token) {
          quotaPreparations.delete(agent.id)
          if (signal?.aborted === true && quotaOrders.get(agent.id)?.logicalRequestId === recovery.logicalRequestId) quotaOrders.delete(agent.id)
        }
      }
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
        quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
        upgrades.delete(agentId)
        // 撤销本次升级的全部自动回退；稳定人工偏好仍由 rootPreferences 保留。
        roots.delete(agentId)
        preferredTrials.delete(agentId)
        return
      }
      const sameChain = previous !== undefined && previous.chain.length === chain.length
        && previous.chain.every((route, index) => sameSelection(route, chain[index]!) && getCanonicalJson(route.policy ?? {}) === getCanonicalJson(chain[index]!.policy ?? {}))
      // Status/card refreshes often repeat the same chain while a metadata probe
      // is in flight. Preserve identity and clocks so that valid recovery can settle.
      const completesChain = initialUsableRoute !== undefined && previous?.completeChain !== true
      if (sameChain && !completesChain) return
      const current = root?.override ?? (previous === undefined ? undefined : previous.chain[previous.index])
      const retained = current === undefined ? -1 : chain.findIndex((route) => sameSelection(route, current))
      // Task-card/status refresh is not permission to retry the preferred model.
      // Keep the active fallback and its clock even when metadata says a higher
      // candidate is usable; PreparePreferredRecovery owns safe timed recovery.
      if (previous !== undefined && (sameChain || retained >= 0)) {
        if (!sameChain || completesChain) { quotaOrders.delete(agentId); quotaPreparations.delete(agentId) }
        upgrades.set(agentId, { ...previous, chain: [...chain], index: retained >= 0 ? retained : previous.index,
          ...(initialUsableRoute === undefined ? {} : { completeChain: true }) })
        if (root?.override !== undefined && retained >= 0) roots.set(agentId, { ...root, override: chain[retained] })
        return
      }
      const initial = initialUsableRoute === undefined ? 0 : chain.findIndex((route) => sameSelection(route, initialUsableRoute))
      quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
      upgrades.set(agentId, { chain: [...chain], index: Math.max(0, initial), at: now(), ...(initialUsableRoute === undefined ? {} : { completeChain: true }), ...(previous?.picker === undefined ? {} : { picker: previous.picker }) })
      // 升级优先于之前的回退覆盖；已试记录保留，升级链失败后不会再回到已失败的路由
      if (root?.override !== undefined) roots.set(agentId, { ...root, override: undefined })
    },
    getRootUpgrade: (agentId) => {
      const chain = upgrades.get(agentId)?.chain
      return chain === undefined ? undefined : [...chain]
    },
    DelAgent: (agentId) => {
      quotaOrders.delete(agentId); quotaPreparations.delete(agentId); quotaManualSelections.delete(agentId)
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
      requestObservations.delete(agentId)
      requestPositions.delete(agentId)
      lastResolved.delete(agentId)
    },
    ReleaseAgent: (agentId) => {
      quotaOrders.delete(agentId); quotaPreparations.delete(agentId)
      health.release(agentId)
      if (children.get(agentId)?.persistent === true) return
      quotaManualSelections.delete(agentId)
      forgetRecovery(agentId, false)
      children.delete(agentId)
      childOverrides.delete(agentId)
      manualPauses.delete(agentId)
      manualRetries.delete(agentId)
      rootPreferences.delete(agentId); userSelectionSeqs.delete(agentId); recoveryBoundaries.delete(agentId); preferredRecoveryWaits.delete(agentId); preferredTrials.delete(agentId)
      upgrades.delete(agentId)
      roots.delete(agentId)
      lastRoutes.delete(agentId)
      requestObservations.delete(agentId)
      requestPositions.delete(agentId)
      lastResolved.delete(agentId)
    },
    getRequestOverride: (agent, resolved, presetRole, config, explicitSelectionAvailable = false) => requestOverride(agent, resolved, presetRole, config, explicitSelectionAvailable, false),
    AdmitRequest: async (agent, resolved, presetRole, config, explicitSelectionAvailable = false, signal) => {
      const checks = probe === undefined ? undefined : new Map<string, boolean>()
      for (;;) {
        if (signal?.aborted === true) throw new SwarmError('RECOVERY_REQUIRED', '路由准入已取消；未启动新的模型请求')
        if (managed(agent, presetRole)) {
          if (manualPauses.has(agent.id)) throw new SwarmError('RECOVERY_REQUIRED', '子会话已人工暂停；取消沉寂后显式继续')
          const recovery = recoveries.get(agent.id)
          const child = children.get(agent.id)
          await waitHealthReady(agent.id, signal)
          if (Boolean(signal?.aborted)) throw new SwarmError('RECOVERY_REQUIRED', '路由准入已取消；未启动新的模型请求')
          if (recoveries.get(agent.id) !== recovery || (child !== undefined && !children.has(agent.id))) throw new SwarmError('RECOVERY_REQUIRED', '路由准入所属请求已结束或变更')
          if (children.get(agent.id) !== child) checks?.clear()
          if (pendingHealthCommit !== undefined) continue
        }
        let wait: AdmissionWait
        try {
          const result = requestOverride(agent, resolved, presetRole, config, explicitSelectionAvailable, true, checks)
          const observation = requestObservations.get(agent.id)
          if (signal !== undefined && observation !== undefined) {
            let observed = signalObservations.get(signal)
            if (observed === undefined) { observed = new Map(); signalObservations.set(signal, observed) }
            observed.set(agent.id, observation)
          }
          return result
        } catch (error) {
          if (error instanceof AdmissionProbe) {
            const recovery = recoveries.get(agent.id)
            const child = children.get(agent.id)
            const root = roots.get(agent.id)
            const preference = rootPreferences.get(agent.id)
            const upgrade = upgrades.get(agent.id)
            const order = quotaOrders.get(agent.id)
            const checked = await (signal === undefined ? probe!(error.route) : probe!(error.route, signal))
            if (Boolean(signal?.aborted)) throw new SwarmError('RECOVERY_REQUIRED', '路由准入已取消；未启动新的模型请求')
            if (recoveries.get(agent.id) !== recovery || (child !== undefined && !children.has(agent.id))) throw new SwarmError('RECOVERY_REQUIRED', '路由准入所属请求已结束或变更')
            if (children.get(agent.id) !== child || roots.get(agent.id) !== root || rootPreferences.get(agent.id) !== preference || upgrades.get(agent.id) !== upgrade || quotaOrders.get(agent.id) !== order) { checks!.clear(); continue }
            // probe 期间被其他请求隔离时重新等待健康状态，不把它当作永久能力不符。
            // 元数据暂时不可知不是否定证据：放行给真实请求判断（失败走常规错误恢复），并记下结果避免立即重探。
            const unknown = !checked.ok && ['metadata-pending-timeout', 'metadata-capacity-busy', 'llm-service-changed'].includes(checked.reason)
            if (checked.ok || checked.reason !== 'route-isolated') checks!.set(admissionKey(error.route), unknown || (checked.ok && (child?.requireVision !== true || checked.vision)))
            continue
          }
          if (!(error instanceof AdmissionWait)) throw error
          wait = error
        }
        const recovery = recoveryOf(agent.id)
        const child = children.get(agent.id)
        const root = roots.get(agent.id)
        recovery.holdRetries = (recovery.holdRetries ?? 0) + 1
        recovery.admissionHolds = (recovery.admissionHolds ?? 0) + 1
        recovery.holdWaitedMs = (recovery.holdWaitedMs ?? 0) + wait.waitMs
        const event = { agentId: agent.id, scope: children.has(agent.id) ? 'child' as const : 'root' as const, reason: 'route' as const, route: wait.route }
        options.onNetworkWait?.({ ...event, waitMs: wait.waitMs })
        await (options.sleep ?? SleepWithSignal)(wait.waitMs, signal)
        for (const [key, accepted] of checks ?? []) if (accepted) checks!.delete(key)
        if (children.get(agent.id) !== child || roots.get(agent.id) !== root) checks?.clear()
        options.onNetworkWait?.({ ...event, recovered: true, waitedMs: wait.waitMs })
        if (Boolean(signal?.aborted)) throw new SwarmError('RECOVERY_REQUIRED', '等待路由恢复时已取消；未启动新的模型请求')
        if (recoveries.get(agent.id) !== recovery || (child !== undefined && !children.has(agent.id))) throw new SwarmError('RECOVERY_REQUIRED', '路由准入所属请求已结束或变更')
        // 只解除本次等待目标的已试标记；手选、换步或重新登记不能被旧等待覆盖。
        if (children.get(agent.id) === child && roots.get(agent.id) === root && health.isAvailable(wait.route)) {
          const label = getRouteLabel(wait.route)
          if (child?.tried.has(label)) children.set(agent.id, { ...child, tried: new Set([...child.tried].filter((item) => item !== label)) })
          if (root?.tried.has(label)) roots.set(agent.id, { ...root, tried: new Set([...root.tried].filter((item) => item !== label)) })
        }
      }
    },
    getErrorAction: (payload, action, presetRole, config) => {
      if (!managed(payload.agent, presetRole)) return action
      if (manualPauses.has(payload.agent.id) || payload.signal?.aborted === true || staleFailure(payload)) return undefined
      const recovery = recoveryOf(payload.agent.id)
      if (recovery.terminal !== undefined) return undefined
      const policy = policyOf(config)
      const observation = observedRequest(payload)
      const failed = observation?.route ?? lastRoutes.get(payload.agent.id) ?? children.get(payload.agent.id)?.chain[children.get(payload.agent.id)!.index] ?? { provider: payload.provider, model: '' }
      const normalized = normalizeRouteFailure(payload.failure as RouteFailureMetadata, failed)
      recovery.lastFailure = {
        kind: normalized.kind,
        provider: normalized.provider,
        model: normalized.model,
        message: normalized.message.slice(0, 500),
        at: now(),
        ...(normalized.code === undefined ? {} : { code: normalized.code }),
        ...(normalized.status === undefined ? {} : { status: normalized.status })
      }
      if (normalized.kind === 'context_exceeded') return terminal(payload.agent.id, 'context_recovery_required')
      const failedProbe = health.failHalfOpen(failed, payload.agent.id)
      const failureClass = getFailureClass(payload.failure)
      const fatal = isTerminalRouteFailure(normalized)
      const longWait = normalized.providerRetryAfterMs !== undefined && Number.isFinite(normalized.providerRetryAfterMs) && normalized.providerRetryAfterMs > policy.maxShortRetryDelayMs
      // 只有网络、服务端与限流类故障值得在原路由上等；4xx、能力不符等等待也不会好转
      const transient = !longWait && ['network_transient', 'service_transient', 'rate_limited'].includes(normalized.kind)
      if (fatal || longWait) {
        health.record(failed, normalized, fatal ? undefined : normalized.providerRetryAfterMs)
        if (longWait) recovery.suppressedRetryAfterMs = normalized.providerRetryAfterMs
      }
      const afterHealthCommit = (): RequestErrorActionLike | Promise<RequestErrorActionLike> => {
        if (recoveries.get(payload.agent.id) !== recovery || manualPauses.has(payload.agent.id) || payload.signal?.aborted === true) return undefined
        // 第八次的终态故障仍要记录域隔离，随后停止恢复，不再尝试第九个模型。
        if (countedAttempts(recovery) >= policy.maxLogicalAttempts) return terminal(payload.agent.id, 'recovery_attempts_exhausted')
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
        const withQuota = (fallback: () => RequestErrorActionLike | Promise<RequestErrorActionLike>) => options.orderQuotaRoutes === undefined ? fallback : async () => {
          try { await api.PrepareQuotaRouting(payload.agent, { ...failed }, presetRole, config, payload.signal) }
          catch (error) { if (payload.signal?.aborted === true) return undefined; throw error }
          if (recoveries.get(payload.agent.id) !== recovery || payload.signal?.aborted === true) return undefined
          return fallback()
        }
        if (child !== undefined) {
          const fallback = withQuota(() => {
            // 等待期间子智能体可能已被释放或重新登记：以最新状态为准
            const latest = children.get(payload.agent.id)
            return latest === undefined ? action : getChildFallback(payload.agent.id, latest, failed, payload.failure, failureClass, transient, config, payload.signal)
          })
          return fatal || longWait || failedProbe ? fallback() : getNetworkAwareAction(payload, 'child', config, fallback)
        }
        if (!config.rootFallback || presetRole === undefined) return fatal || longWait || failedProbe ? terminal(payload.agent.id, 'route_chain_exhausted', payload.failure) : action
        if (getAgentHeader(payload.agent).parentSession !== undefined) return action
        const fallback = withQuota(() => getRootFallback(payload, presetRole, failureClass, transient, config, failed, observation?.preference))
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
