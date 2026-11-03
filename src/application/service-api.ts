import type { SwarmConfigInfo } from '../config.js'
import type { DelegationRecord } from '../evidence.js'
import type {
  AgentLike, ApprovalServiceLike, AttachmentsLike, CredentialsLike, GoalsLike, JobLifecycleEventLike, JobsLike,
  LlmLike, PreStepDecisionLike, SessionHeaderLike, SessionProjectionsLike, SubagentEndInfoLike, SubagentsLike,
  TokenMeterLike, ToolExecutionLike, ToolsLike, UserQuestionsLike
} from '../host-contract.js'
import type { RouteInfo, RouteProbe } from '../domain/routing/routes.js'
import type { RouteEngine } from './routing/engine.js'
import type { ChildRecoveryEvidence } from '../host-recovery.js'
import type { GitStatusInfo } from '../util/git.js'
import type { NetworkMonitorInfo } from '../network.js'
import type { ChildScopeRequest, DelegateExecInfo } from '../delegate.js'
import type { getStatusResult, getTaskCardResult } from './views.js'
import type { DelegableRoleId, RoleId } from '../role-registry.js'
import type { AgentControl } from '../agent-control.js'
import type { JevHub } from '../jev-hub.js'
import type { ExecutionBudgetSnapshot } from '../execution-budget.js'
import type { AgentControlRpcInput } from '../rpc.js'
import type { ChildPromptInfo } from '../runtime.js'
import type { ToolExecLike } from '../tool-shape.js'
import type { WatchdogAlert } from '../watchdog.js'
import type { AcceptResultInfo } from './validation.js'
import type { LoggerLike, PlanningRunView } from './api.js'
import type { OutboxHandler, OutboxDispatchResult } from '../outbox.js'
import type { SourceAdapter, SourceIngestResult, SourceTriggerStatus } from '../domain/sources/runtime.js'
import type { SourceInstance, SourceSubscription, TriggerInput } from '../domain/sources/model.js'

/** 服务依赖：宿主服务一律用 getter 延迟读取，适配服务晚于插件就绪的情况 */
export interface SwarmServiceDepsInfo {
  getConfig: () => SwarmConfigInfo
  getLlm: () => LlmLike | undefined
  /** Optional DSH token meter; absence keeps older-host routing behavior unchanged. */
  getTokenMeter?: () => TokenMeterLike | undefined
  getSubagents: () => SubagentsLike | undefined
  getTools: () => ToolsLike | undefined
  getAttachments: () => AttachmentsLike | undefined
  getCredentials: () => CredentialsLike | undefined
  getApproval?: () => ApprovalServiceLike | undefined
  getGoals?: () => GoalsLike | undefined
  getUserQuestions?: () => UserQuestionsLike | undefined
  /** 可选：读取会话当前预设（切换过预设的会话，会话头里仍是创建时的预设） */
  getSessionProjections?: () => SessionProjectionsLike | undefined
  /** Actual public AgentRegistry instance; never synthesize an ancestor authority from an ID. */
  getAgent?: (sessionId: string) => (AgentLike & { status?: 'idle' | 'running'; whenIdle?: () => Promise<void> }) | undefined
  getJobs?: () => JobsLike | undefined
  /** 服务器计算的当前宿主goal摘要；缺少接入时receipt不冒称绑定长期goal。 */
  getGoalBinding?: (agent: AgentLike) => string | undefined
  inspectParent?: (sessionId: string) => Promise<SessionHeaderLike | undefined>
  inspectRootPreference?: (sessionId: string) => Promise<RouteInfo | undefined>
  activateParent?: (sessionId: string) => Promise<AgentLike | undefined>
  inspectChild?: (parentSessionId: string, childId: string, notBefore?: number) => Promise<ChildRecoveryEvidence | undefined>
  dshHome: string
  fetch: typeof fetch
  logger?: LoggerLike
  now?: () => number
  readFile?: (path: string) => Promise<Uint8Array>
  gitStatus?: (cwd: string) => Promise<GitStatusInfo | undefined>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  probe?: RouteProbe
  orderQuotaRoutes?: import('./routing/engine.js').RouteEngineOptions['orderQuotaRoutes']
  onQuotaRouteSuccess?: (route: RouteInfo) => void
  quotaDiagnostics?: () => unknown
  /** 联网探测；提供时，断网引起的模型请求失败会等待网络恢复后在原路由重试 */
  network?: NetworkMonitorInfo
}

export interface WatchdogStatusView {
  paused: boolean
  alerts: readonly WatchdogAlert[]
  quarantinedTaskIds: readonly string[]
}

/** 天枢工具与运行时行共用的服务 */
export interface SwarmService {
  getConfig: () => SwarmConfigInfo
  routeState: RouteEngine
  agentControl?: AgentControl
  /** Jev 接入点：衡鉴与 jev_* 工具共用的客户端、密钥状态与健康检查 */
  jev: JevHub
  AddTaskCard: (raw: unknown, exec: DelegateExecInfo) => Promise<ReturnType<typeof getTaskCardResult>>
  delegate: (raw: unknown, exec: DelegateExecInfo) => Promise<DelegationRecord>
  getStatus: (raw: unknown, exec: DelegateExecInfo) => ReturnType<typeof getStatusResult> & { executionBudgets: Array<ExecutionBudgetSnapshot & { task_id: string }>; planningRuns?: PlanningRunView[]; watchdog: WatchdogStatusView }
  AcceptTask: (raw: unknown, exec: DelegateExecInfo) => Promise<AcceptResultInfo>
  getGuardReason: (execution: ToolExecutionLike) => string | undefined
  ObserveToolDispatch: (execution: ToolExecutionLike) => void
  getRoleForAgent: (agent: AgentLike | undefined) => RoleId | undefined
  /** 是否由百工管理：百工预设的根会话，或百工委派出的子会话（其他插件的子会话不算） */
  isManagedAgent: (agent: AgentLike | undefined) => boolean
  /** 宿主的 subagent/end：连续会话一轮结束 */
  OnSubagentEnd: (info: SubagentEndInfoLike) => void
  OnAgentDisposed: (childId: string) => void
  OnJobEvent: (sessionId: string, event: JobLifecycleEventLike) => void
  /** 天枢进入下一步前：滤掉已由 swarm_delegate 取走结果的连续会话结束通知，避免同一结果进上下文两次 */
  FilterPreStep: (decision: PreStepDecisionLike) => PreStepDecisionLike
  BeforeManagedStep: (agent: AgentLike | undefined, decision: PreStepDecisionLike) => Promise<PreStepDecisionLike>
  BeforeManagedTool: (execution: ToolExecutionLike) => Promise<void>
  ObserveManagedToolResult: (execution: ToolExecutionLike, result: unknown) => void
  BeforeManagedRequest: (agent: AgentLike) => Promise<void>
  ObserveManagedMessage: (sessionId: string, event: { type: string; data?: unknown }) => void
  /** Feed a Host Session event into the canonical Source/Trigger path; plugin-originated messages are filtered. */
  ObserveSessionEvent: (sessionId: string, event: { type: string; seq?: number; data?: unknown }) => SourceIngestResult | { filtered: string } | undefined
  ConfigureSource: (sessionId: string, source: SourceInstance) => SourceInstance
  IngestSourceTrigger: (sessionId: string, sourceId: string, trigger: TriggerInput, options?: { hasActiveTicket?: boolean }) => SourceIngestResult
  RegisterSourceAdapter: (sessionId: string, adapter: SourceAdapter) => () => void
  IngestSourceEvent: (sessionId: string, sourceId: string, raw: unknown, options?: { hasActiveTicket?: boolean }) => SourceIngestResult
  SubscribeSourceThread: (sessionId: string, input: { sourceId: string; threadId: string; ticketId: string; contextOnly?: boolean }) => SourceSubscription
  UnsubscribeSourceThread: (sessionId: string, subscriptionId: string) => boolean
  GetEventDrivenStatusForRpc: (sessionId: string) => SourceTriggerStatus
  RegisterOutboxHandler: (sessionId: string, kind: string, handler: OutboxHandler) => () => void
  DispatchOutbox: (sessionId: string, limit?: number) => Promise<OutboxDispatchResult>
  getDiagnostics: (agent?: AgentLike) => string[]
  ReviewPlan: (raw: unknown, exec: DelegateExecInfo) => Promise<unknown>
  Calculate: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  ReadContext: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  ProjectFiles: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  MessageSend: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  MessageRead: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  MessageAck: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  Experience: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  getTaskViewForRpc: (sessionId: string, taskId: string) => unknown
  getTaskIndexForRpc: (sessionId: string) => unknown
  getAgentViewForRpc: (parentSessionId: string, childId: string) => Promise<unknown>
  ControlAgentForRpc: (input: AgentControlRpcInput) => Promise<unknown>
  dispose: () => Promise<void>
  WaitAgentReady: (agent: AgentLike) => Promise<void>
  /** 0.2.1-alpha 起：按角色在子智能体作用域限制继承的工具面；旧宿主是空实现（由启动期 toolFilter 承担）。 */
  ApplyChildToolScope: (agent: AgentLike, role: DelegableRoleId, allowWeb?: boolean) => void
  ChildAllowWebFor: (agentId: string) => boolean | undefined
  /** 委派侧在启动子智能体前登记角色与 allow_web，供 agent/created 在首次装配前限制工具面。 */
  NoteChildScope: (request: ChildScopeRequest) => void
  /** 子会话在系统提示里的身份（角色、模式、语言、固定 persona）；不是百工委派的子会话返回 undefined */
  getChildPrompt: (agentId: string) => ChildPromptInfo | undefined
  /** 宿主 agent/created：子智能体入队工作释放前限制其作用域工具面。 */
  OnAgentCreated: (agent: AgentLike) => void
}
