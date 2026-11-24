import { type SwarmConfigInfo } from '../../config.js';
import { type AgentLike, type CallConfigLike, type ContextCompactionLike, type LlmFailureLike, type RequestErrorActionLike, type RequestErrorPayloadLike } from '../../host-contract.js';
import type { RoleId } from '../../role-registry.js';
import { type NetworkMonitorInfo } from '../../network.js';
import { type FailureKind } from '../../domain/routing/provider-policy.js';
import { type RouteHealth, type RouteHealthSnapshot } from '../../domain/routing/health.js';
import { type RouteInfo, type RouteProbe } from '../../domain/routing/routes.js';
import { type RouteObservationTerminal, type RouteObservabilityOptions, type RouteObservabilitySnapshot } from '../../route-observability.js';
/** 一次路由回退 */
export interface FallbackEventInfo {
    agentId: string;
    from: RouteInfo;
    to: RouteInfo;
    failure: LlmFailureLike;
    scope: 'child' | 'root';
}
export interface PreferredRecoveryEventInfo {
    agentId: string;
    from: RouteInfo;
    to: RouteInfo;
    scope: 'child' | 'root';
    logicalRequestId: string;
    confirmed: boolean;
}
/** 一次等待：开始等待（recovered 未定义）或等待结束。network 为断网等待；route 为等路由恢复（链尾临时故障退避、隔离到期、他人半开探测） */
export interface NetworkWaitEventInfo {
    agentId: string;
    scope: 'child' | 'root';
    reason: 'network' | 'route';
    route?: RouteInfo;
    /** 触发等待的失败；准入时等待没有失败 */
    failure?: LlmFailureLike;
    /** route 等待开始时：计划等待时长 */
    waitMs?: number;
    /** 等待结束时：network 为网络是否已恢复，route 恒为 true */
    recovered?: boolean;
    waitedMs?: number;
}
/** 路由状态注册表的可选依赖 */
export interface RouteEngineOptions {
    now?: () => number;
    /** 进程内有界、脱敏路由 trace 的上限；默认值见 route-observability.ts。 */
    observability?: RouteObservabilityOptions;
    /** 联网探测；缺省时不做断网等待 */
    network?: NetworkMonitorInfo;
    onNetworkWait?: (event: NetworkWaitEventInfo) => void;
    health?: RouteHealth;
    recovery?: Partial<RecoveryPolicy>;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** 持久化启用时，故障域必须提交后才把恢复动作交给宿主；失败不得被吞掉。 */
    onHealthChange?: (snapshot: RouteHealthSnapshot, event: {
        agentId?: string;
        reason: 'failure' | 'probe' | 'success';
    }) => void | Promise<void>;
    /** Success is observed on an emit-only Host event; report asynchronous persistence failure explicitly. */
    onHealthPersistenceFailure?: (event: {
        agentId: string;
        reason: 'route_health_persist_failed';
    }) => void;
    /** Maximum wait at the next request boundary, not a model or filesystem cancellation timeout. */
    healthCommitWaitMs?: number;
    onPreferredRecovery?: (event: PreferredRecoveryEventInfo) => void;
    /** Source-reported quota may change preference only; health and actual failures remain authoritative. */
    orderQuotaRoutes?: (routes: readonly RouteInfo[], signal?: AbortSignal, protectedRoutes?: readonly RouteInfo[]) => Promise<readonly RouteInfo[]>;
    onRouteSuccess?: (route: RouteInfo) => void;
    /** Preflight a candidate against the current session's measured context. */
    admitContext?: (agent: AgentLike, route: RouteInfo, resolved: CallConfigLike, signal?: AbortSignal) => Promise<import('../../context-admission.js').ContextAdmissionInfo>;
    /** Advisory fact for diagnostics; rejection itself still occurs before provider dispatch. */
    onContextRejected?: (event: {
        agentId: string;
        scope: 'child' | 'root';
        route: RouteInfo;
        journal: import('../../context-admission.js').ContextAdmissionInfo;
    }) => void;
}
export interface RequestRecoveryState {
    logicalRequestId: string;
    attempts: number;
    transientRetries: number;
    waitedMs: number;
    attemptedRoutes: string[];
    terminal?: RouteObservationTerminal;
    contextRecoveryAttempts?: number;
    suppressedRetryAfterMs?: number;
    completed?: boolean;
    /** admission 是保守上限，真实 stream/start 观测另外计数；未提供事件的宿主为 unknown。 */
    observedModelAttempts?: number;
    observedAttemptIds?: string[];
    observationCoverage?: 'agent-loop-stream-attempts';
    /** 链上没有可切换路由时的等待（含断网等待、准入等待）：次数与累计时长，上限为 agents.networkWaitMs */
    holdRetries?: number;
    holdWaitedMs?: number;
    /** 其中准入时的等待：醒来后才发出本次请求，不是额外的模型调用，不从逻辑次数中扣除 */
    admissionHolds?: number;
    /** 链耗尽时各路由的状态说明，写进委派结果 */
    terminalDetail?: string;
    /** 最近一次真实请求失败；仅供只读诊断，不进入批准或门禁。 */
    lastFailure?: {
        kind: FailureKind;
        provider: string;
        model: string;
        message: string;
        at: number;
        code?: string;
        status?: number;
    };
}
export interface RecoveryPolicy {
    maxTransientRetries: number;
    maxShortRetryDelayMs: number;
    maxTransientWaitMs: number;
    maxLogicalAttempts: number;
}
export declare const DEFAULT_RECOVERY_POLICY: RecoveryPolicy;
/** 路由状态注册表：spawn 子智能体按链回退，swarm 预设的根会话按角色链回退 */
export interface RouteEngine {
    /** 登记子智能体（或连续会话的新一轮）：路由链从头开始，已试记录清空 */
    AddChild: (agentId: string, state: {
        chain: RouteInfo[];
        role: RoleId;
        onFallback?: (event: FallbackEventInfo) => void;
        persistent?: boolean;
        logicalRequestId?: string;
        initialRoute?: RouteInfo;
        initialQuotaOrder?: readonly RouteInfo[];
        respectStoredOverride?: boolean;
        requireVision?: boolean;
    }) => void;
    BeginLogicalRequest: (agentId: string, logicalRequestId: string) => void;
    BeginRequestStep: (agentId: string, turn: number, step: number) => void;
    /** The delegation owner calls this after every result/terminal has been consumed, including failure and cancellation. */
    FinishLogicalRequest: (logicalRequestId: string) => void;
    getRecovery: (agentId: string) => RequestRecoveryState | undefined;
    getRouteObservability: (agentIds?: readonly string[]) => RouteObservabilitySnapshot;
    /** Aggregate lifecycle counts only; no session, request or model identities. */
    getRecoveryDiagnostics: () => {
        agents: number;
        logicalRequests: number;
        logicalStates: number;
        disposedTerminals: number;
    };
    getTerminal: (agentId: string) => RequestRecoveryState['terminal'];
    /** 链耗尽时各路由的状态说明（隔离原因与预计恢复时间） */
    getTerminalDetail: (agentId: string) => string | undefined;
    isRouteAvailable: (route: RouteInfo) => boolean;
    isRouteAvailableFor: (route: RouteInfo, agentId: string) => boolean;
    /** 隔离到期时刻（未隔离为 0），供委派前判断是否值得等待 */
    getRouteDueAt: (route: RouteInfo) => number;
    getHealth: () => ReturnType<RouteHealth['list']>;
    getHealthSnapshot: () => RouteHealthSnapshot;
    WaitHealthReady: (agentId: string, signal?: AbortSignal) => Promise<void>;
    RestoreHealth: (entries: unknown) => void;
    clearHealth: (key?: string) => void;
    MarkRequestSucceeded: (agentId: string) => void;
    MarkRequestStarted: (agentId: string, attemptId: string, actualRoute?: RouteInfo) => void;
    ObserveRouteFailure: (route: RouteInfo, failure: LlmFailureLike, config?: SwarmConfigInfo) => void | Promise<void>;
    /** 管理会话的恢复先于 next，终态和有界瞬时策略不经过宿主的长退避。 */
    recover: (payload: RequestErrorPayloadLike, next: () => Promise<RequestErrorActionLike>, presetRole: RoleId | undefined, config: SwarmConfigInfo, compaction?: ContextCompactionLike) => Promise<RequestErrorActionLike>;
    getChild: (agentId: string) => {
        route: RouteInfo | undefined;
        role: RoleId;
        switches: number;
    } | undefined;
    getChildRole: (agentId: string) => RoleId | undefined;
    SetChildOverride: (agentId: string, route: RouteInfo | undefined) => void;
    getChildOverride: (agentId: string) => RouteInfo | undefined;
    SetManualPause: (agentId: string, paused: boolean) => void;
    isManualPaused: (agentId: string) => boolean;
    getLastRoute: (agentId: string) => RouteInfo | undefined;
    /** 初始化持久根会话的真实用户偏好；不会覆盖本进程已观测到的显式选择。 */
    RestoreRootPreference: (agentId: string, route: RouteInfo) => void;
    getRootPreference: (agentId: string) => RouteInfo | undefined;
    /** True only for a durable/host-observed picker choice, never for an automatic request header. */
    hasUserSelection: (agentId: string) => boolean;
    RecordUserSelection: (agentId: string, route: RouteInfo, seq?: number) => void;
    PreparePreferredRecovery: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config: SwarmConfigInfo) => Promise<void>;
    PrepareQuotaRouting: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config: SwarmConfigInfo, signal?: AbortSignal) => Promise<void>;
    RequestRouteRetry: (route: RouteInfo, agentId: string, options?: {
        force?: boolean;
    }) => {
        ok: boolean;
        keys: string[];
        reason?: string;
        retryAt?: number;
    };
    CancelRouteRetry: (agentId: string) => void;
    /** 设置或撤销根会话的容灾升级链（已预检可用的路由） */
    SetRootUpgrade: (agentId: string, chain: RouteInfo[] | undefined, initialUsableRoute?: RouteInfo) => void;
    getRootUpgrade: (agentId: string) => RouteInfo[] | undefined;
    DelAgent: (agentId: string) => void;
    /** 宿主释放 Agent 时调用：连续会话子智能体的路由状态保留，其余清理 */
    ReleaseAgent: (agentId: string) => void;
    /** 只释放该会话持有的半开探测，不改变它的路由与恢复状态；用于本地中止等宿主不派发请求错误的结束路径。 */
    ReleaseProbe: (agentId: string) => void;
    /** 同步准入：链上没有可立即使用的路由时直接判定链耗尽 */
    getRequestOverride: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config?: SwarmConfigInfo, explicitSelectionAvailable?: boolean) => CallConfigLike;
    /** 宿主请求入口的准入：链上暂时没有可用路由时，在等待预算内等最早可能恢复的路由后重新准入 */
    AdmitRequest: (agent: AgentLike, resolved: CallConfigLike, presetRole: RoleId | undefined, config: SwarmConfigInfo, explicitSelectionAvailable?: boolean, signal?: AbortSignal) => Promise<CallConfigLike>;
    getErrorAction: (payload: RequestErrorPayloadLike, action: RequestErrorActionLike, presetRole: RoleId | undefined, config: SwarmConfigInfo) => RequestErrorActionLike | Promise<RequestErrorActionLike>;
}
/**
 * 额度源给出的顺序只能重排已声明的路由：增删模型、改写 policy 或形状不符时保留原链
 * @param {readonly RouteInfo[]} declared - 声明的路由链
 * @param {unknown} proposed - 额度源建议的顺序
 * @returns {RouteInfo[]} 重排后的链（元素取自 declared）
 */
export declare const getValidatedQuotaOrder: (declared: readonly RouteInfo[], proposed: unknown) => RouteInfo[];
/**
 * 创建路由状态注册表
 * @param {(event: FallbackEventInfo) => void} [onRootFallback] - 根会话回退时的回调（记日志）
 * @param {RouteProbe} [probe] - 根会话回退前的可用性预检；缺省时不预检
 * @param {RouteEngineOptions} [options] - 时钟与断网等待
 * @returns {RouteEngine} 注册表
 */
export declare const createRouteEngine: (onRootFallback?: (event: FallbackEventInfo) => void, probe?: RouteProbe, options?: RouteEngineOptions) => RouteEngine;
