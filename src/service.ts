import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import { intDelegator, getToolFilter, type DelegateExecInfo, type DelegateSessionInfo, type PlanSessionInput } from './delegate.js'
import { intLedger, intTaskStore, type AcceptanceRecord, type AssessmentInfo, type DelegationRecord, type TaskRecord, type TriageRecord } from './evidence.js'
import {
  SPAWN_PROVIDER,
  WRITE_TOOL_NAMES,
  getAgentHeader,
  type AgentLike,
  type ApprovalServiceLike,
  type AttachmentsLike,
  type CredentialsLike,
  type InboxMessageLike,
  type LlmLike,
  type PreStepDecisionLike,
  type SessionProjectionsLike,
  type SubagentEndInfoLike,
  type SubagentsLike,
  type ToolExecutionLike,
  type ToolsLike
} from './host-contract.js'
import { isJevAvailabilityFailure, getJevFailureKind, type JevOutcome } from './jev.js'
import { intJevHub, type JevHub } from './jev-hub.js'
import { SleepWithSignal, type NetworkMonitorInfo } from './network.js'
import {
  AddTriageGates,
  GATE_ROLE,
  ValidateTaskCard,
  getAcceptanceCheck,
  getEffectiveGates,
  getRuleGates,
  getSuggestedRoles,
  isTriageUseful,
  type FindingResolution,
  type GateRequirement,
  type TaskCard
} from './policy.js'
import { intRouteStateRegistry, type RouteStateRegistry } from './route-state.js'
import { FindRoleByPresetId, getPermissionLabel, getRoleInfo, isWriteAllowed, type RoleId } from './role-registry.js'
import { getRouteLabel, intRouteProbe, type RouteInfo, type RouteProbe } from './routes.js'
import { ParseSessionPlan, getRuleSessionPlan, getSessionQuestions, getSessionState, intChildEndHub, intThreadRegistry, type SessionPlan, type ThreadInfo } from './threads.js'
import { getUpgradeReasons } from './upgrade.js'
import { ACCEPTANCE_QUESTIONS, ParseAssessment, VERDICT_LABELS, getAcceptanceState, getReviewQuestions, getReviewState } from './review.js'
import { SwarmError } from './util/errors.js'
import { getGitStatus, type GitStatusInfo } from './util/git.js'
import { intMutex } from './util/mutex.js'
import { getTaskIntent, getSemanticCardDigest, getCurrentDelegations, digest, getTaskBinding, getTaskContextBinding, isTaskVersionCurrent } from './task-model.js'
import { getDefaultWorkflow, ValidateWorkflow, getWorkflowDigest, getWorkflowMermaid, getTaskCardMarkdown, intWorkflowState, ReconcileWorkflow, getReadyNodes, getMatchingNode, UpdateWorkflowNode, getValueDigest } from './workflow.js'
import { RunPlanningReview, getReviewSnapshot, isPlanningReviewCurrent, type PlanningAgentAssessmentInfo, type ReviewSnapshot } from './planning-review.js'
import { getArtifactSnapshot } from './artifacts.js'
import { getToolApprovalDenial, getHostApprovalPolicy, getApprovalPolicyDiagnostics } from './approval-policy.js'
import { getCheckpoint } from './checkpoint.js'
import { createFeatureSession, type FeatureSession } from './feature-session.js'
import { calculate } from './math/operators.js'
import { createWorkspaceLeaseManager, type WorkspaceLease } from './util/workspace-lease.js'
import type { ToolExecLike } from './tool-shape.js'

export interface LoggerLike {
  info: (message: string) => void
  warn: (message: string) => void
}

/** 服务依赖：宿主服务一律用 getter 延迟读取，适配服务晚于插件就绪的情况 */
export interface SwarmServiceDepsInfo {
  getConfig: () => SwarmConfigInfo
  getLlm: () => LlmLike | undefined
  getSubagents: () => SubagentsLike | undefined
  getTools: () => ToolsLike | undefined
  getAttachments: () => AttachmentsLike | undefined
  getCredentials: () => CredentialsLike | undefined
  getApproval?: () => ApprovalServiceLike | undefined
  /** 可选：读取会话当前预设（切换过预设的会话，会话头里仍是创建时的预设） */
  getSessionProjections?: () => SessionProjectionsLike | undefined
  dshHome: string
  fetch: typeof fetch
  logger?: LoggerLike
  now?: () => number
  readFile?: (path: string) => Promise<Uint8Array>
  gitStatus?: (cwd: string) => Promise<GitStatusInfo | undefined>
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  probe?: RouteProbe
  /** 联网探测；提供时，断网引起的模型请求失败会等待网络恢复后在原路由重试 */
  network?: NetworkMonitorInfo
}

/** swarm_accept 的参数 */
export interface AcceptInputInfo {
  task_id: string
  decision: 'accept' | 'reject' | 'incomplete'
  summary: string
  unresolved: string[]
  stopReason: string
  findingResolutions: FindingResolution[]
}

const DECISIONS = ['accept', 'reject', 'incomplete'] as const

const isResolution = (value: unknown): value is FindingResolution => {
  const record = value as Record<string, unknown> | null
  return record !== null && typeof record === 'object' && typeof record.delegationId === 'string'
    && typeof record.index === 'number' && typeof record.resolution === 'string'
}

/**
 * 校验验收参数
 * @param {unknown} raw - 工具参数
 * @returns {{ input?: AcceptInputInfo; errors: string[] }} 规范化参数或错误
 */
export const ValidateAcceptInput = (raw: unknown): { input?: AcceptInputInfo; errors: string[] } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['参数必须是对象'] }
  const value = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof value.task_id !== 'string' || value.task_id === '') errors.push('task_id 必须是非空字符串')
  if (!(DECISIONS as readonly unknown[]).includes(value.decision)) errors.push('decision 必须是 accept / reject / incomplete 之一')
  if (typeof value.summary !== 'string') errors.push('summary 必须是字符串')
  if (typeof value.stopReason !== 'string' || value.stopReason.trim() === '') errors.push('stopReason 必须是非空字符串')
  const unresolved = value.unresolved ?? []
  if (!Array.isArray(unresolved) || unresolved.some((item) => typeof item !== 'string')) errors.push('unresolved 必须是字符串数组')
  const resolutions = value.findingResolutions ?? []
  if (!Array.isArray(resolutions) || !resolutions.every(isResolution)) errors.push('findingResolutions 每项需要 delegationId、index、resolution')
  if (errors.length > 0) return { errors }
  return {
    input: {
      task_id: value.task_id as string,
      decision: value.decision as AcceptInputInfo['decision'],
      summary: value.summary as string,
      unresolved: unresolved as string[],
      stopReason: value.stopReason as string,
      findingResolutions: resolutions as FindingResolution[]
    },
    errors: []
  }
}

/** 天枢根会话的容灾升级状态 */
export interface RootUpgradeView {
  /** 触发升级的任务；这些任务都验收或标记未完成后撤销升级 */
  taskIds: string[]
  reasons: string[]
  /** 已预检可用的升级链；为空表示升级模型当前都不可用，仍用对话框所选模型 */
  chain: string[]
  /** 升级期间用户在对话框里换了模型：以用户选择为准，这批任务不再自动升级 */
  cancelledByUser?: boolean
}

interface SessionStateInfo extends DelegateSessionInfo {
  counters: { native: number; jev: number; review: number; session: number }
  /** 天枢根会话最近一次调用 write/edit 的时刻；0 表示没有 */
  rootEditAt: number
  rootUpgrade?: RootUpgradeView
  features?: FeatureSession
  featuresPromise?: Promise<FeatureSession>
  rootAgent?: AgentLike
  taskLock: ReturnType<typeof intMutex>
  taskSequence: number
}

/** 只有任务创建之后的天枢编辑才会让该任务已有的验证失效 */
const getExternalEditAt = (task: TaskRecord, session: SessionStateInfo): number =>
  session.rootEditAt >= task.createdAt ? session.rootEditAt : 0

/** 天枢工具与运行时行共用的服务 */
export interface SwarmService {
  getConfig: () => SwarmConfigInfo
  routeState: RouteStateRegistry
  /** Jev 接入点：衡鉴与 jev_* 工具共用的客户端、密钥状态与健康检查 */
  jev: JevHub
  AddTaskCard: (raw: unknown, exec: DelegateExecInfo) => Promise<ReturnType<typeof getTaskCardResult>>
  delegate: (raw: unknown, exec: DelegateExecInfo) => Promise<DelegationRecord>
  getStatus: (raw: unknown, exec: DelegateExecInfo) => ReturnType<typeof getStatusResult>
  AcceptTask: (raw: unknown, exec: DelegateExecInfo) => Promise<AcceptResultInfo>
  getGuardReason: (execution: ToolExecutionLike) => string | undefined
  getRoleForAgent: (agent: AgentLike | undefined) => RoleId | undefined
  /** 是否由百工管理：百工预设的根会话，或百工委派出的子会话（其他插件的子会话不算） */
  isManagedAgent: (agent: AgentLike | undefined) => boolean
  /** 宿主的 subagent/end：连续会话一轮结束 */
  OnSubagentEnd: (info: SubagentEndInfoLike) => void
  /** 天枢进入下一步前：滤掉已由 swarm_delegate 取走结果的连续会话结束通知，避免同一结果进上下文两次 */
  FilterPreStep: (decision: PreStepDecisionLike) => PreStepDecisionLike
  getDiagnostics: (agent?: AgentLike) => string[]
  ReviewPlan: (raw: unknown, exec: DelegateExecInfo) => Promise<unknown>
  Calculate: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  ReadContext: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  MessageSend: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  MessageRead: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  MessageAck: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  Experience: (raw: unknown, exec: ToolExecLike) => Promise<unknown>
  getTaskViewForRpc: (sessionId: string, taskId: string) => unknown
  dispose: () => Promise<void>
  WaitAgentReady: (agent: AgentLike) => Promise<void>
}

/** 验收结果 */
export interface AcceptResultInfo {
  task_id: string
  status: AcceptanceRecord['status']
  missing: string[]
  roundsUsed: number
  maxAutoFixRounds: number
  gates: ReturnType<typeof getAcceptanceCheck>['statuses']
  /** 衡鉴对天枢验收结论的复评（只在 decision=accept 时执行） */
  assessment?: AssessmentInfo
}

const getGateView = (gate: GateRequirement) => ({
  gate: gate.gate,
  role: gate.role,
  roleName: getRoleInfo(gate.role).name,
  ...(gate.mode === undefined ? {} : { mode: gate.mode }),
  label: GATE_ROLE[gate.gate].label,
  reason: gate.reason,
  source: gate.source
})

const getTaskCardResult = (task: TaskRecord, card: TaskCard, config: SwarmConfigInfo, ledgerPath: string, rootUpgrade: RootUpgradeView | undefined) => ({
  task_id: task.taskId,
  rootUpgrade: rootUpgrade ?? null,
  title: card.title,
  goal: card.goal, acceptance: card.acceptance, scope: card.scope, perf: card.perf ?? null,
  cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1, requestRevision: task.requestRevision ?? 1,
  contextRefs: (task.contextRefs ?? []).map((material) => material.ref),
  contextArtifacts: task.contextRefs ?? [],
  planningReview: task.planningReview ?? null,
  flow: task.workflowDefinition === undefined ? null : {
    definition: task.workflowDefinition, state: task.workflowState,
    digest: task.workflowDigest, mermaid: getWorkflowMermaid(task.workflowDefinition),
    nextReadyNodes: task.workflowState === undefined ? [] : getReadyNodes(task.workflowDefinition, task.workflowState).map((node) => node.id)
  },
  requiredGates: task.gates.map(getGateView),
  suggestedRoles: getSuggestedRoles(card, task.gates).map((item) => ({ ...item, roleName: getRoleInfo(item.role).name })),
  triage: task.triage,
  budgets: config.budgets,
  ledgerPath
})

const getThreadView = (thread: ThreadInfo) => ({
  threadId: thread.threadId,
  role: thread.role,
  roleName: getRoleInfo(thread.role).name,
  ...(thread.mode === undefined ? {} : { mode: thread.mode }),
  rounds: thread.rounds,
  busy: thread.busy,
  closed: thread.closed,
  taskIds: thread.taskIds,
  lastSummary: thread.history.at(-1)?.summary.slice(0, 200) ?? null
})

const getDelegationView = (d: DelegationRecord, verbose: boolean) => ({
  delegationId: d.delegationId,
  role: d.role,
  roleName: d.roleName,
  ...(d.mode === undefined ? {} : { mode: d.mode }),
  status: d.status,
  summary: d.summary.slice(0, 300),
  route: d.route === undefined ? null : getRouteLabel(d.route),
  backend: d.backend ?? null,
  independence: d.independence,
  hardIsolation: d.hardIsolation,
  durationMs: d.durationMs ?? null,
  error: d.error ?? null,
  assessment: d.assessment ?? null,
  session: d.session ?? null,
  retries: d.retries ?? [],
  unresolved: d.unresolved,
  changedFiles: d.changedFiles ?? [],
  ...(verbose ? { structured: d.structured, evidence: d.evidence, attempts: d.attempts } : {})
})

const getTaskView = (task: TaskRecord, delegations: DelegationRecord[], config: SwarmConfigInfo, verbose: boolean, externalEditAt: number) => {
  const current = getCurrentDelegations(task, delegations, task.artifactSnapshot?.digest)
  const gates = getEffectiveGates(task.gates, current, externalEditAt)
  const check = getAcceptanceCheck(gates, current, task.acceptance?.resolutions ?? [], externalEditAt, task.card.perf)
  return {
    task_id: task.taskId,
    title: task.card.title,
    goal: task.card.goal,
    card: task.card,
    cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1,
    requestRevision: task.requestRevision ?? 1, intentSource: task.intentSource ?? 'declared',
    planningReview: task.planningReview ?? null, checkpoint: task.checkpoint ?? null,
    recovered: task.recovered ?? false,
    contextRefs: (task.contextRefs ?? []).map((material) => material.ref),
    contextArtifacts: task.contextRefs ?? [],
    flow: task.workflowDefinition === undefined ? null : {
      definition: task.workflowDefinition, state: task.workflowState, digest: task.workflowDigest,
      mermaid: getWorkflowMermaid(task.workflowDefinition)
    },
    markdown: task.workflowDefinition === undefined ? '' : getTaskCardMarkdown(task.card, task.workflowDefinition, {
      taskId: task.taskId, cardRevision: task.cardRevision, workflowRevision: task.workflowRevision,
      state: task.workflowState, planningStatus: task.planningReview?.status ?? 'pending',
      delegationLimit: config.budgets.maxDelegationsPerTask
    }),
    rounds: task.rounds,
    triage: task.triage,
    acceptance: task.acceptance ?? null,
    gates: check.statuses.map((status) => ({ ...status, label: GATE_ROLE[status.gate].label })),
    delegations: delegations.map((d) => getDelegationView(d, verbose)),
    budget: { used: delegations.filter((d) => d.status !== 'blocked').length, max: config.budgets.maxDelegationsPerTask }
  }
}

const getStatusResult = (tasks: ReturnType<typeof getTaskView>[], session: SessionStateInfo, diagnostics: string[]) => ({
  tasks,
  rootUpgrade: session.rootUpgrade ?? null,
  threads: session.threads.list().map(getThreadView),
  ledgerPath: session.ledger.path,
  usage: { nativeCalls: session.counters.native, jevCalls: session.counters.jev, reviewCalls: session.counters.review, sessionCalls: session.counters.session },
  diagnostics
})

/**
 * 创建 SwarmService
 * @param {SwarmServiceDepsInfo} deps - 依赖
 * @returns {SwarmService} 服务
 */
export const intSwarmService = (deps: SwarmServiceDepsInfo): SwarmService => {
  const sessions = new Map<string, SessionStateInfo>()
  const now = deps.now ?? Date.now
  let sequence = 0
  const newId = (prefix: string): string => `${prefix}-${++sequence}`

  const getLedgerDir = (): string => deps.getConfig().ledgerDir || join(deps.dshHome, 'share', 'dsh-agent-swarm', 'ledger')

  const getSession = (sessionId: string): SessionStateInfo => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionStateInfo = {
      sessionId,
      store: intTaskStore(),
      ledger: intLedger(getLedgerDir(), sessionId, (error) => deps.logger?.warn(`账本写入失败：${String(error)}`)),
      editLock: intMutex(),
      counters: { native: 0, jev: 0, review: 0, session: 0 },
      threads: intThreadRegistry(),
      rootEditAt: 0, taskLock: intMutex(), taskSequence: 0
    }
    sessions.set(sessionId, created)
    return created
  }

  const childOwners = new Map<string, string>()
  const childSignals = new Map<string, AbortSignal>()
  const childReady = new Map<string, Promise<void>>()
  const leases = createWorkspaceLeaseManager()
  const ensureFeatures = async (session: SessionStateInfo, agent: AgentLike): Promise<FeatureSession> => {
    session.rootAgent ??= agent
    if (session.features !== undefined) return session.features
    session.featuresPromise ??= createFeatureSession({
      rootSessionId: session.sessionId, cwd: getAgentHeader(session.rootAgent).cwd ?? process.cwd(),
      dshHome: deps.dshHome, config: deps.getConfig(), getConfig: deps.getConfig,
      tasks: session.store, threads: session.threads, now
    }).then((features) => {
      routeState.RestoreHealth(features.store.read().routeHealth ?? [])
      session.features = features
      session.taskSequence = Math.max(session.taskSequence, ...session.store.getTasks().map((task) => Number(/^T-(\d+)$/.exec(task.taskId)?.[1] ?? 0)))
      for (const task of session.store.getTasks()) for (const record of session.store.getTaskDelegations(task.taskId)) {
        sequence = Math.max(sequence, Number(/^D-(\d+)$/.exec(record.delegationId)?.[1] ?? 0))
      }
      return features
    })
    return session.featuresPromise
  }
  const getToolTask = async (raw: unknown, exec: ToolExecLike) => {
    if (exec.agent === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '工具缺少真实会话身份')
    const owner = childOwners.get(exec.agent.id)
    const session = getSession(owner ?? exec.agent.id)
    const features = await ensureFeatures(session, session.rootAgent ?? exec.agent)
    const requested = (raw as { task_id?: string; taskId?: string } | null)?.task_id ?? (raw as { taskId?: string } | null)?.taskId
    const binding = owner === undefined ? undefined : features.bindings.requireActive(exec.agent.id)
    if (binding !== undefined && requested !== undefined && binding.taskId !== requested) throw new SwarmError('INVALID_ARGS', '专家不能访问其他任务')
    const active = session.store.getTasks().filter((task) => task.acceptance?.status !== 'accepted' && task.acceptance?.decision !== 'incomplete')
    const id = requested ?? binding?.taskId ?? (active.length === 1 ? active[0]?.taskId : undefined)
    let task = id === undefined ? undefined : session.store.getTask(id)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', '必须指定当前任务 task_id；多任务不能默认选取')
    if (owner === undefined && !isRootTianShu(exec.agent)) throw new SwarmError('INVALID_ARGS', '工具只服务百工管理的根会话或已绑定专家')
    task = refreshIntent(session, task, session.rootAgent ?? exec.agent)
    if (binding !== undefined && !isTaskVersionCurrent(task, binding)) throw new SwarmError('STALE_EVIDENCE', '专家绑定的是旧任务需求或合同版本')
    return { session, features, task, binding, agent: exec.agent }
  }
  const reviewSnapshot = (task: TaskRecord): ReviewSnapshot => getReviewSnapshot({
    rootSessionId: task.sessionId, workspaceId: task.workspaceId ?? '',
    ...getTaskBinding(task),
    requestText: task.intentText ?? task.card.goal, requestSource: task.intentSource ?? 'declared',
    requestRefs: [{ source: task.intentSourceRef ?? 'declared', text: task.intentText ?? task.card.goal }],
    card: task.card, workflow: task.workflowDefinition ?? getDefaultWorkflow(task.card, task.gates), gates: task.gates,
    parserVersion: '11.12.0',
    reviewPolicy: { requireJev: deps.getConfig().planningReview.requireJev, reviewAbove: deps.getConfig().planningReview.reviewAbove }
    ,executionPolicy: { maxAutoFixRounds: deps.getConfig().budgets.maxAutoFixRounds,
      maxPlanningReviewFixRounds: deps.getConfig().planningReview.maxFixRounds,
      ...deps.getConfig().execution, delegationLimit: deps.getConfig().budgets.maxDelegationsPerTask }
  })
  const refreshContractContexts = (session: SessionStateInfo, task: TaskRecord): TaskRecord => {
    const features = session.features
    if (features === undefined) return task
    const binding = getTaskContextBinding(task, features.workspaceId)
    const contract = features.addContext({ binding, layer: 'L0', kind: 'contract', text: JSON.stringify({
      goal: task.card.goal, acceptance: task.card.acceptance, scope: task.card.scope, flags: task.card.flags,
      perf: task.card.perf, gates: task.gates, workflowRevision: task.workflowRevision
    }) })
    const source = features.addContext({ binding, layer: 'L1', kind: 'source', text: task.intentText ?? task.card.goal })
    return session.store.UpdateTask(task.taskId, { contextRefs: [contract, source].map(({ ref, digest, layer, kind }) => ({ ref, digest, layer, kind })) })
  }
  const reconcileTask = (session: SessionStateInfo, task: TaskRecord): TaskRecord => {
    const all = session.store.getTaskDelegations(task.taskId)
    const gates = getEffectiveGates(task.gates, getCurrentDelegations(task, all), getExternalEditAt(task, session))
    const current = task.workflowDefinition ?? getDefaultWorkflow(task.card, gates)
    const reconciled = ReconcileWorkflow(current, task.card, gates)
    if (reconciled.errors.length > 0) throw new SwarmError('INVALID_ARGS', reconciled.errors.join('；'))
    if (!reconciled.changed && gates.length === task.gates.length) return task
    const old = task.workflowState ?? intWorkflowState(current, task.rounds)
    const state = intWorkflowState(reconciled.definition, task.rounds)
    for (const node of reconciled.definition.nodes) {
      const previous = current.nodes.find((item) => item.id === node.id)
      if (node.operation === 'delegate' && previous !== undefined && digest(previous) === digest(node) && old.nodes[node.id] !== undefined) state.nodes[node.id] = old.nodes[node.id]!
    }
    const revision = (task.workflowRevision ?? 1) + 1
    for (const record of all) {
      const before = current.nodes.find((node) => node.id === record.nodeId)
      const after = reconciled.definition.nodes.find((node) => node.id === record.nodeId)
      if (before && after && digest(before) === digest(after)) session.store.UpdateDelegation(record.delegationId, { workflowRevision: revision })
    }
    return refreshContractContexts(session, session.store.UpdateTask(task.taskId, {
      gates, workflowDefinition: reconciled.definition, workflowDigest: getWorkflowDigest(reconciled.definition),
      workflowState: state, workflowRevision: revision, planningReview: undefined, acceptance: undefined
    }))
  }
  const refreshIntent = (session: SessionStateInfo, task: TaskRecord, agent: AgentLike): TaskRecord => {
    const latest = getTaskIntent(agent, task.card)
    if (latest.source !== 'host' || (latest.sourceRef === task.intentSourceRef && latest.digest === task.intentLastDigest)) return task
    return refreshContractContexts(session, session.store.UpdateTask(task.taskId, {
      intentText: `${task.intentText ?? task.card.goal}\n\n用户后续要求（${latest.sourceRef}）：\n${latest.text}`,
      intentSourceRef: latest.sourceRef, intentSource: 'host', intentLastDigest: latest.digest,
      requestRevision: (task.requestRevision ?? 1) + 1, planningReview: undefined, acceptance: undefined,
      workflowState: task.workflowDefinition === undefined ? undefined : intWorkflowState(task.workflowDefinition, task.rounds)
    }))
  }

  const sleep = deps.sleep ?? SleepWithSignal
  const probe = deps.probe ?? intRouteProbe(deps.getLlm, {
    now, isRouteAvailable: (route) => routeState.isRouteAvailable(route),
    onFailure: (route, failure) => routeState.ObserveRouteFailure(route, failure, deps.getConfig())
  })
  const routeState = intRouteStateRegistry((event) => {
    deps.logger?.warn(`主会话 ${event.agentId} 路由 ${getRouteLabel(event.from)} 失败（${event.failure.code ?? event.failure.status ?? 'error'}），回退到 ${getRouteLabel(event.to)}`)
    getSession(event.agentId).ledger.AddLedgerEvent({ type: 'route/fallback', data: { scope: 'root', from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
  }, probe, {
    now,
    onHealthChange: (entries) => {
      if (!deps.getConfig().persistence.enabled) return
      // The failure domain is shared by roots. Commit it before publishing a recovery action.
      return Promise.all([...sessions.values()].flatMap((session) => session.features === undefined ? [] : [
        session.features.persist('route/health', session.store, session.threads, entries)
      ])).then(() => undefined)
    },
    ...(deps.network === undefined ? {} : { network: deps.network }),
    onNetworkWait: (event) => {
      const where = `${event.scope === 'root' ? '主会话' : '子智能体'} ${event.agentId}${event.route === undefined ? '' : `（${getRouteLabel(event.route)}）`}`
      if (event.recovered === undefined) deps.logger?.warn(`${where} 请求失败且网络不可达（${event.failure.code ?? event.failure.message ?? 'error'}），等待网络恢复后重试`)
      else deps.logger?.info(`${where} ${event.recovered ? '网络已恢复，在原路由重试' : '等待网络超时，按路由链回退'}（等待 ${Math.round((event.waitedMs ?? 0) / 1000)} 秒）`)
    }
  })

  const hub = intChildEndHub()
  const jev = intJevHub({
    getConfig: () => deps.getConfig().jev,
    getCredentials: deps.getCredentials,
    fetch: deps.fetch,
    sleep,
    now,
    ...(deps.logger === undefined ? {} : { logger: deps.logger })
  })

  /** 衡鉴判断会话方式：一次性，新建连续会话，或追加到已有会话；Jev 不可用时按规则 */
  const planSession = async (input: PlanSessionInput): Promise<SessionPlan> => {
    const config = deps.getConfig()
    const rule = (reason: string): SessionPlan =>
      getRuleSessionPlan({ role: input.input.role, taskId: input.task.taskId, reason, ...(input.thread === undefined ? {} : { thread: input.thread }) })
    if (!config.jev.enabled) return rule('Jev 已关闭')
    const session = input.session as SessionStateInfo
    session.counters.session += 1
    const state = getSessionState({
      roleName: getRoleInfo(input.input.role).name,
      goal: input.task.card.goal,
      request: input.input.prompt,
      ...(input.input.mode === undefined ? {} : { mode: input.input.mode }),
      ...(input.thread === undefined ? {} : { thread: input.thread })
    })
    const outcome = await jev.getClient().ask(state, getSessionQuestions(input.thread !== undefined), input.signal)
    const plan = outcome.ok
      ? ParseSessionPlan(outcome.answers, { repeatAbove: config.agents.repeatAbove, sameCategoryAbove: config.agents.sameCategoryAbove, ...(input.thread === undefined ? {} : { thread: input.thread }) })
      : undefined
    return plan ?? rule(outcome.ok ? 'Jev 答案不完整' : outcome.reason)
  }

  const delegator = intDelegator({
    getConfig: deps.getConfig,
    getSubagents: deps.getSubagents,
    getTools: deps.getTools,
    getAttachments: deps.getAttachments,
    probe,
    routeState,
    readFile: deps.readFile ?? (async (path) => new Uint8Array(await readFile(path))),
    gitStatus: deps.gitStatus ?? ((cwd) => getGitStatus(cwd)),
    now,
    newId,
    newChildId: () => randomUUID(),
    hub,
    planSession,
    sleep,
    onChildStart: async ({ agentId, task, record, role, signal }) => {
      const session = getSession(task.sessionId)
      childOwners.set(agentId, task.sessionId)
      childSignals.set(agentId, signal)
      const features = await ensureFeatures(session, session.rootAgent ?? { id: task.sessionId })
      const ready = features.bindings.bind({
        agentId, ...getTaskContextBinding(task, features.workspaceId),
        nodeId: record.nodeId ?? 'legacy', attemptId: record.attemptId ?? record.delegationId, threadId: agentId, role,
        permissions: [
          ...(getRoleInfo(role).capabilities.includes('calculate') ? ['pure-calc'] : []),
          ...(getRoleInfo(role).capabilities.includes('context') ? ['context-read'] : []),
          ...(getRoleInfo(role).capabilities.includes('message') ? ['message-send', 'message-read'] : [])
        ],
        blindReview: record.reviewPhase !== 'response' && (role === 'yu_shi' || (role === 'suan_heng' && record.mode === 'verify'))
      }).then(async () => { await features.persist('delegation/started', session.store, session.threads, routeState.getHealth()) })
      childReady.set(agentId, ready)
      await ready
    },
    onChildEnd: async (agentId) => {
      const owner = childOwners.get(agentId)
      if (owner === undefined) return
      const session = getSession(owner)
      const features = session.features
      if (features !== undefined) await features.bindings.revoke(agentId, childSignals.get(agentId)?.aborted ? 'cancelled' : 'completed')
    },
    ...(deps.network === undefined ? {} : { network: deps.network })
  })

  const getTriage = async (card: TaskCard, gates: GateRequirement[], session: SessionStateInfo, signal: AbortSignal) => {
    const config = deps.getConfig()
    const rulesApplied = gates.map((gate) => `${gate.gate}：${gate.reason}`)
    if (!isTriageUseful(card, gates)) return { gates, triage: { source: 'rules', rulesApplied } as TriageRecord }
    if (!config.jev.enabled) return { gates, triage: { source: 'rules', rulesApplied, fallbackReason: 'jev-disabled' } as TriageRecord }
    session.counters.jev += 1
    const outcome: JevOutcome = await jev.getClient().triage(card, signal)
    session.ledger.AddLedgerEvent({ type: 'jev/call', data: outcome.ok ? { ok: true, attempts: outcome.attempts, answers: outcome.answers } : { ok: false, reason: outcome.reason, attempts: outcome.attempts } })
    const next = AddTriageGates(gates, card, outcome.ok ? { failed: false, answers: outcome.answers } : { failed: true, reason: outcome.reason }, config.thresholds)
    const triage: TriageRecord = outcome.ok
      ? { source: 'rules+jev', answers: outcome.answers, rulesApplied }
      : { source: 'rules+jev-fallback', fallbackReason: outcome.reason, rulesApplied }
    return { gates: next, triage }
  }

  /**
   * 衡鉴复评：调用 Jev 给交付打分（不设调用额度）；关闭或调用失败时返回 unavailable，不影响流程
   * @returns 复评结果；复评关闭时为 undefined
   */
  const getAssessment = async (session: SessionStateInfo, state: unknown, questions: Record<string, unknown>, signal: AbortSignal): Promise<AssessmentInfo | undefined> => {
    const config = deps.getConfig()
    if (!config.review.enabled || !config.jev.enabled) return undefined
    session.counters.review += 1
    const outcome = await jev.getClient().ask(state, questions, signal)
    return outcome.ok ? ParseAssessment(outcome.answers, config.review, outcome.model) : { status: 'unavailable', reason: outcome.reason, failureKind: getJevFailureKind(outcome) }
  }

  /** 专家交付完成后复评；存疑时写入未解决事项，提醒天枢核实或重新委派 */
  const ReviewDelegation = async (session: SessionStateInfo, record: DelegationRecord, request: string | undefined, signal: AbortSignal): Promise<DelegationRecord> => {
    if (record.status !== 'completed') return record
    const task = session.store.getTask(record.taskId)
    if (task === undefined) return record
    const assessment = await getAssessment(session, getReviewState(task, record, request), getReviewQuestions(record.role, record.mode), signal)
    if (assessment === undefined) return record
    const doubtful = assessment.verdict === 'doubtful'
      ? [`衡鉴复评存疑（可信度 ${(assessment.reliability ?? 0).toFixed(2)}）：请核实该交付的依据，必要时重新委派`]
      : []
    const next = session.store.UpdateDelegation(record.delegationId, { assessment, unresolved: [...record.unresolved, ...doubtful] })
    session.ledger.AddLedgerEvent({ type: 'review/assessment', taskId: record.taskId, delegationId: record.delegationId, data: { ...assessment } })
    return next
  }

  /** 会话当前的预设：优先读 agentPreset 投影，读不到再用会话头 */
  const getPresetId = (agent: AgentLike): string | undefined => {
    try {
      const current = deps.getSessionProjections?.()?.stateOf(agent.session, 'agentPreset')
      if (typeof current === 'string' && current !== '') return current
    } catch {
      // 投影服务不认识该会话（例如测试替身）：退回会话头
    }
    return getAgentHeader(agent).agentPreset
  }

  const isRootTianShu = (agent: AgentLike): boolean =>
    getAgentHeader(agent).parentSession === undefined && FindRoleByPresetId(getPresetId(agent))?.id === 'tian_shu'

  /** 路由层在用户换模型时会撤销升级；这里同步服务层的状态 */
  const SyncRootUpgrade = (agent: AgentLike, session: SessionStateInfo): void => {
    const current = session.rootUpgrade
    if (current === undefined || current.chain.length === 0 || routeState.getRootUpgrade(agent.id) !== undefined) return
    session.rootUpgrade = { ...current, chain: [], cancelledByUser: true }
  }

  const ClearRootUpgrade = (agent: AgentLike, session: SessionStateInfo, taskId: string): void => {
    const current = session.rootUpgrade
    if (current === undefined || !current.taskIds.includes(taskId)) return
    const taskIds = current.taskIds.filter((id) => id !== taskId)
    if (taskIds.length > 0) {
      session.rootUpgrade = { ...current, taskIds }
      return
    }
    session.rootUpgrade = undefined
    routeState.SetRootUpgrade(agent.id, undefined)
    session.ledger.AddLedgerEvent({ type: 'route/upgrade', taskId, data: { scope: 'root', active: false } })
  }

  /**
   * 按天枢的容灾升级配置判定：命中触发条件（或天枢显式要求）时，把根会话后续请求切到升级模型，直到相关任务验收。
   * explicit=false 表示天枢主动取消本任务的升级。
   */
  const UpdateRootUpgrade = async (agent: AgentLike, session: SessionStateInfo, task: TaskRecord, explicit?: boolean): Promise<RootUpgradeView | undefined> => {
    if (!isRootTianShu(agent)) return undefined
    if (explicit === false) {
      ClearRootUpgrade(agent, session, task.taskId)
      return session.rootUpgrade
    }
    SyncRootUpgrade(agent, session)
    const upgrade = getRoleRoute(deps.getConfig(), 'tian_shu').upgrade
    const reasons = getUpgradeReasons(upgrade, { task, delegations: session.store.getTaskDelegations(task.taskId), explicit: explicit === true })
    if (upgrade === undefined || reasons.length === 0) return session.rootUpgrade
    const current = session.rootUpgrade
    const labeled = reasons.map((reason) => `${task.taskId}：${reason}`)
    // 用户手动换过模型：只记录原因，不再覆盖用户的选择（天枢显式要求除外）
    if (current !== undefined && (current.chain.length > 0 || (current.cancelledByUser === true && explicit !== true))) {
      session.rootUpgrade = {
        taskIds: current.taskIds.includes(task.taskId) ? current.taskIds : [...current.taskIds, task.taskId],
        reasons: [...new Set([...current.reasons, ...labeled])],
        chain: current.chain,
        ...(current.cancelledByUser === true ? { cancelledByUser: true } : {})
      }
      return session.rootUpgrade
    }
    const usable: RouteInfo[] = []
    for (const route of upgrade.chain) if ((await probe(route)).ok) usable.push(route)
    session.rootUpgrade = { taskIds: [task.taskId], reasons: labeled, chain: usable.map(getRouteLabel) }
    if (usable.length > 0) routeState.SetRootUpgrade(agent.id, usable)
    session.ledger.AddLedgerEvent({ type: 'route/upgrade', taskId: task.taskId, data: { scope: 'root', active: usable.length > 0, reasons, chain: usable.map(getRouteLabel) } })
    return session.rootUpgrade
  }

  const AddTaskCard: SwarmService['AddTaskCard'] = async (raw, exec) => {
    const { card, errors } = ValidateTaskCard(raw)
    if (card === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const session = getSession(exec.agent.id)
    const features = await ensureFeatures(session, exec.agent)
    const task = await session.taskLock.run(async () => {
      const requestedId = (raw as { task_id?: unknown }).task_id
      const existing = typeof requestedId === 'string' ? session.store.getTask(requestedId) : undefined
      if (typeof requestedId === 'string' && existing === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${requestedId}`)
      const expected = (raw as { expected_card_revision?: unknown }).expected_card_revision
      if (expected !== undefined && expected !== (existing?.cardRevision ?? 1)) throw new SwarmError('INVALID_ARGS', '任务合同版本已改变，请读取最新任务卡')
      const ruleGates = getRuleGates(card)
      const merged = existing === undefined ? ruleGates : [...existing.gates, ...ruleGates.filter((gate) => !existing.gates.some((old) => old.gate === gate.gate))]
      const { gates, triage } = await getTriage(card, merged, session, exec.signal)
      const check = ValidateWorkflow(card.workflow ?? getDefaultWorkflow(card, gates), card, gates)
      if (check.definition === undefined) throw new SwarmError('INVALID_ARGS', check.errors.join('；'))
      if (check.definition.nodes.length > deps.getConfig().workflow.maxNodes
        || check.definition.nodes.reduce((total, node) => total + node.dependsOn.length, 0) > deps.getConfig().workflow.maxEdges) throw new SwarmError('INVALID_ARGS', '流程超过配置的节点或依赖边上限')
      const workflowDigest = getWorkflowDigest(check.definition)
      const semanticChanged = existing !== undefined && getSemanticCardDigest(existing.card) !== getSemanticCardDigest(card)
      const workflowChanged = existing !== undefined && existing.workflowDigest !== workflowDigest
      const intent = getTaskIntent(exec.agent, card)
      const intentChanged = existing !== undefined && (existing.intentLastDigest !== intent.digest || existing.intentSourceRef !== intent.sourceRef)
      if (existing?.planningReview && !['pass', 'pass_with_degradation'].includes(existing.planningReview.status) && (semanticChanged || workflowChanged)) {
        if ((existing.planningFixRounds ?? 0) >= deps.getConfig().planningReview.maxFixRounds) throw new SwarmError('BUDGET_EXHAUSTED', '规划修正轮次用尽')
      }
      const changed = semanticChanged || workflowChanged || intentChanged
      const record: TaskRecord = {
        ...(existing ?? { taskId: `T-${++session.taskSequence}`, sessionId: session.sessionId, delegationIds: [], rounds: 0, createdAt: now() }),
        card, gates, triage, updatedAt: now(), workspaceId: features.workspaceId,
        cardRevision: (existing?.cardRevision ?? 1) + (semanticChanged ? 1 : 0),
        workflowRevision: (existing?.workflowRevision ?? 1) + (workflowChanged ? 1 : 0),
        requestRevision: (existing?.requestRevision ?? 1) + (intentChanged ? 1 : 0),
        intentText: existing !== undefined && !intentChanged ? existing.intentText ?? intent.text
          : intentChanged && existing?.intentSource === 'host' && intent.source === 'host'
            ? `${existing.intentText ?? existing.card.goal}\n\n用户后续要求（${intent.sourceRef}）：\n${intent.text}` : intent.text,
        intentSource: intent.source, intentSourceRef: intent.sourceRef, intentLastDigest: intent.digest,
        workflowDefinition: check.definition, workflowDigest,
        workflowState: changed || existing?.workflowState === undefined ? intWorkflowState(check.definition, existing?.rounds ?? 0) : existing.workflowState,
        ...(changed ? { acceptance: undefined, planningReview: undefined,
          planningFixRounds: (existing?.planningFixRounds ?? 0) + (existing?.planningReview && !['pass', 'pass_with_degradation'].includes(existing.planningReview.status) ? 1 : 0)
        } : {})
      }
      if (existing === undefined) session.store.AddTask(record)
      else session.store.UpdateTask(record.taskId, record)
      if (changed || existing === undefined) {
        refreshContractContexts(session, record)
      }
      await features.persist('task/card', session.store, session.threads, routeState.getHealth())
      session.ledger.AddLedgerEvent({ type: 'task/card', taskId: record.taskId, data: { card, gates: gates.map((gate) => gate.gate), triage: triage.source, cardRevision: record.cardRevision, workflowRevision: record.workflowRevision } })
      return session.store.getTask(record.taskId)!
    })
    if (deps.getConfig().planningReview.enabled && deps.getConfig().workflow.mode !== 'off') await ReviewPlan({ task_id: task.taskId }, exec)
    const explicit = (raw as { upgrade?: unknown }).upgrade
    const latest = session.store.getTask(task.taskId)!
    const rootUpgrade = await UpdateRootUpgrade(exec.agent, session, latest, typeof explicit === 'boolean' ? explicit : undefined)
    return getTaskCardResult(latest, latest.card, deps.getConfig(), session.ledger.path, rootUpgrade)
  }

  const getTaskOrThrow = (session: SessionStateInfo, taskId: string): TaskRecord => {
    const task = session.store.getTask(taskId)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${taskId}`)
    return task
  }

  const reviewRuns = new Map<string, Promise<unknown>>()
  const ReviewPlan: SwarmService['ReviewPlan'] = async (raw, exec) => {
    const session = getSession(exec.agent.id)
    const features = await ensureFeatures(session, exec.agent)
    const requested = (raw as { task_id?: unknown })?.task_id
    if (typeof requested !== 'string') throw new SwarmError('INVALID_ARGS', '规划审核必须指定 task_id')
    let task = reconcileTask(session, refreshIntent(session, getTaskOrThrow(session, requested), exec.agent))
    const snapshot = reviewSnapshot(task)
    if ((raw as { bypass_cache?: boolean })?.bypass_cache !== true && isPlanningReviewCurrent(task.planningReview, snapshot)) return task.planningReview
    if (reviewRuns.has(snapshot.snapshotDigest)) return reviewRuns.get(snapshot.snapshotDigest)!
    const operation = (async () => {
      const config = deps.getConfig()
      const record = await RunPlanningReview(snapshot, {
        now, policy: config.planningReview,
        reviewAgent: async (_snapshot, schema, prompt): Promise<PlanningAgentAssessmentInfo> => {
          const subagents = deps.getSubagents()
          const visible = deps.getTools()?.schemas(exec.agent).map((tool) => tool.name) ?? []
          const capabilities = subagents?.getProvider(SPAWN_PROVIDER)?.capabilities
          if (!subagents || !capabilities || !['agentOptions', 'outputSchema', 'toolFilter', 'persona', 'depthLimit'].every((key) => capabilities[key as keyof typeof capabilities] === true) || visible.length === 0) return { reason: '独立只读审核后端或工具过滤能力不可用' }
          const budget = features.budgetFor(task)
          const reservationId = `plan-${randomUUID()}`
          budget.reserve({ id: reservationId, source: 'delegate' })
          const chain = getRoleRoute(config, 'yu_shi').chain
          const candidates: RouteInfo[] = []
          for (const route of chain) if (routeState.isRouteAvailable(route) && (await probe(route)).ok) candidates.push(route)
          if (candidates.length === 0) { budget.cancel(reservationId); return { reason: '没有当前可用的独立审核模型' } }
          budget.start(reservationId)
          const route = candidates[0]!
          const allowed = getToolFilter('yu_shi', visible, false)?.allow?.filter((name) => !name.startsWith('jev_') && !name.startsWith('swarm_message_')) ?? []
          let run: Awaited<ReturnType<SubagentsLike['start']>> | undefined
          try {
            run = await subagents.start(SPAWN_PROVIDER, {
              label: `规划审核·${task.taskId}`, parent: exec.agent, signal: exec.signal,
              prompt: [{ type: 'text', text: prompt }], outputSchema: schema, maxDepth: 1,
              toolFilter: { allow: allowed }, agentOptions: { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) },
              persona: '你是独立只读的规划审查者。审核原始用户需求、目标、流程和源码，严禁写入、shell或自行委派。[[swarm:role=yu_shi]]'
            })
            childOwners.set(run.id, session.sessionId)
            childSignals.set(run.id, exec.signal)
            routeState.AddChild(run.id, { chain: candidates, role: 'yu_shi', logicalRequestId: reservationId })
            const ready = features.bindings.bind({ agentId: run.id, ...getTaskContextBinding(task, features.workspaceId),
              nodeId: 'planning-review', attemptId: reservationId, threadId: run.id,
              role: 'yu_shi',
              permissions: ['pure-calc', 'context-read'], blindReview: true })
              .then(async () => { await features.persist('workflow/review-start', session.store, session.threads, routeState.getHealth()) })
            childReady.set(run.id, ready)
            await ready
            const result = await run.result
            return { result: result.structured, reviewer: { agentId: run.id, role: 'yu_shi', model: routeState.getChild(run.id)?.route?.model ?? route.model,
              fresh: true, readOnly: true, authorAgentIds: [exec.agent.id, ...session.store.getTaskDelegations(task.taskId).filter((d) => ['ji_feng', 'zhu_jian'].includes(d.role)).flatMap((d) => d.childId ? [d.childId] : [])] } }
          } catch (error) { return { reason: String(error) } }
          finally {
            budget.settle(reservationId)
            if (run !== undefined) {
              await run.dispose().catch(() => undefined)
              await features.bindings.revoke(run.id, exec.signal.aborted ? 'cancelled' : 'completed')
              routeState.DelAgent(run.id)
            }
          }
        },
        reviewJev: async (state, questions) => {
          if (!config.jev.enabled) return { status: 'unavailable', reason: 'Jev 已关闭' }
          session.counters.review += 1
          const outcome = await jev.getClient().ask(state, questions, exec.signal)
          features.finishBudgetFor(task).observeJev(outcome.ok ? outcome.usage : undefined, outcome.attempts)
          return outcome.ok ? { status: 'ok', answers: outcome.answers, model: outcome.model }
            : { status: isJevAvailabilityFailure(outcome) ? 'unavailable' : 'unknown', reason: outcome.reason }
        }
      })
      return session.taskLock.run(async () => {
        const current = refreshIntent(session, getTaskOrThrow(session, task.taskId), exec.agent)
        if (reviewSnapshot(current).snapshotDigest !== snapshot.snapshotDigest) return { status: 'stale', reason: '审核期间需求、合同、流程或策略已经改变' }
        task = session.store.UpdateTask(task.taskId, { planningReview: record })
        session.ledger.AddLedgerEvent({ type: 'workflow/review', taskId: task.taskId, data: { status: record.status, snapshotDigest: record.snapshotDigest, errors: record.errors } })
        await features.persist('workflow/review', session.store, session.threads, routeState.getHealth())
        return record
      })
    })()
    reviewRuns.set(snapshot.snapshotDigest, operation)
    try { return await operation } finally { reviewRuns.delete(snapshot.snapshotDigest) }
  }

  const Calculate: SwarmService['Calculate'] = async (raw, exec) => {
    if (!deps.getConfig().math.enabled) throw new SwarmError('SERVICE_UNAVAILABLE', '数学算子已关闭')
    const { session, features, task, binding } = await getToolTask(raw, exec)
    if (binding !== undefined) features.bindings.requireActive(binding.agentId, 'pure-calc')
    const budget = features.budgetFor(task)
    const id = exec.callId ?? `calc-${randomUUID()}`
    const snapshot = budget.getSnapshot().reservations.find((item) => item.id === id)
    if (snapshot !== undefined) throw new SwarmError('INVALID_ARGS', '计算请求ID已使用，读取原有计算证据后再决定')
    budget.reserve({ id, source: 'math' }); budget.start(id)
    const { task_id: _task, ...request } = (raw ?? {}) as Record<string, unknown>
    const remaining = budget.remainingMathWork()
    const result = calculate(request, { enableExtended: deps.getConfig().math.enableExtended,
      ...(remaining === undefined ? {} : { limits: { maxWorkUnits: Math.max(0, remaining) } }) })
    budget.settle(id, { workUnits: result.workUnits })
    const artifact = features.addContext({
      binding: getTaskContextBinding(task, features.workspaceId),
      layer: 'L2', kind: 'evidence', text: JSON.stringify({ input: request, result })
    })
    session.store.UpdateTask(task.taskId, { contextRefs: [...(task.contextRefs ?? []), { ref: artifact.ref, digest: artifact.digest, layer: artifact.layer, kind: artifact.kind }] })
    session.ledger.AddLedgerEvent({ type: 'math/computed', taskId: task.taskId, data: { evidenceKind: 'computed', ref: artifact.ref, ok: result.ok, workUnits: result.workUnits } })
    await features.persist('math/computed', session.store, session.threads, routeState.getHealth())
    return { ...result, artifactRef: artifact.ref, task_id: task.taskId }
  }

  const ReadContext: SwarmService['ReadContext'] = async (raw, exec) => {
    const { features, task, binding } = await getToolTask(raw, exec)
    const args = raw as { ref?: string; cursor?: string; limit?: number; expectedDigest?: string }
    if (typeof args.ref !== 'string') throw new SwarmError('INVALID_ARGS', '需要上下文 ref')
    if (binding !== undefined) features.bindings.requireActive(binding.agentId, 'context-read')
    return features.contexts.Read(binding ?? getTaskContextBinding(task, features.workspaceId), args.ref, args)
  }

  const requireMailbox = async (raw: unknown, exec: ToolExecLike) => {
    const context = await getToolTask(raw, exec)
    if (!deps.getConfig().messageBus.enabled || !context.features.store.durable || context.features.bus === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '专家邮箱需要启用持久化与 messageBus')
    if (context.binding === undefined) throw new SwarmError('PERMISSION_DENIED', '文件邮箱仅服务已绑定的专家，天枢不转述消息正文')
    return { ...context, bus: context.features.bus }
  }
  const MessageSend: SwarmService['MessageSend'] = async (raw, exec) => {
    const { bus, agent } = await requireMailbox(raw, exec)
    return bus.send(agent.id, raw as Parameters<typeof bus.send>[1])
  }
  const MessageRead: SwarmService['MessageRead'] = async (raw, exec) => {
    const { bus, agent } = await requireMailbox(raw, exec)
    return bus.pull(agent.id, raw as Parameters<typeof bus.pull>[1])
  }
  const MessageAck: SwarmService['MessageAck'] = async (raw, exec) => {
    const { bus, agent } = await requireMailbox(raw, exec)
    return bus.ack(agent.id, raw as Parameters<typeof bus.ack>[1])
  }
  const Experience: SwarmService['Experience'] = async (raw, exec) => {
    const { features, binding } = await getToolTask(raw, exec)
    if (!deps.getConfig().experience.enabled || binding?.blindReview) throw new SwarmError('PERMISSION_DENIED', '经验检索已关闭或当前为独立盲审')
    const args = raw as { problemClass?: string; includeCandidates?: boolean }
    return features.experiences.list(args.problemClass, args.includeCandidates === true).slice(0, 3)
  }

  const getDiagnostics = (agent?: AgentLike): string[] => {
    const out: string[] = getApprovalPolicyDiagnostics(deps.getConfig().approvals, getHostApprovalPolicy(deps.getApproval?.(), agent))
    if (deps.getLlm() === undefined) out.push('ctx.llm 不可用：无法做路由预检')
    if (deps.getTools() === undefined) out.push('ctx.tools 不可用：无法计算子智能体工具白名单')
    const spawn = deps.getSubagents()?.getProvider(SPAWN_PROVIDER)
    const capabilities = spawn?.capabilities ?? {}
    const required = ['agentOptions', 'outputSchema', 'toolFilter', 'persona', 'depthLimit']
    if (spawn === undefined) out.push('spawn 子智能体后端不可用：无法委派')
    else if (required.some((cap) => capabilities[cap] !== true)) out.push(`spawn 后端缺少能力：${required.filter((cap) => capabilities[cap] !== true).join(', ')}`)
    if (deps.getAttachments() === undefined) out.push('附件服务不可用：观象无法接收工作区图片')
    return out
  }

  const getStatus: SwarmService['getStatus'] = (raw, exec) => {
    const input = (raw ?? {}) as { task_id?: unknown; verbose?: unknown }
    const session = getSession(exec.agent.id)
    const config = deps.getConfig()
    SyncRootUpgrade(exec.agent, session)
    const tasks = (typeof input.task_id === 'string' ? [getTaskOrThrow(session, input.task_id)] : session.store.getTasks())
      .map((task) => reconcileTask(session, refreshIntent(session, task, exec.agent)))
    const views = tasks.map((task) =>
      getTaskView(task, session.store.getTaskDelegations(task.taskId), config, input.verbose === true, getExternalEditAt(task, session)))
    return { ...getStatusResult(views, session, getDiagnostics(exec.agent)),
      persistence: { durable: session.features?.store.durable ?? false, recovery: '已审计状态可恢复；不自动恢复旧 live thread' },
      recovery: { isolatedRoutes: routeState.getHealth(), current: routeState.getRecovery(exec.agent.id) ?? null, nativeInternalRetryCoverage: 'unverified' },
      executionBudgets: session.features === undefined ? [] : tasks.map((task) => ({ task_id: task.taskId, ...session.features!.budgetFor(task).getSnapshot() }))
    }
  }

  const AcceptTask: SwarmService['AcceptTask'] = async (raw, exec) => {
    const { input, errors } = ValidateAcceptInput(raw)
    if (input === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const session = getSession(exec.agent.id)
    const features = await ensureFeatures(session, exec.agent)
    let task = reconcileTask(session, refreshIntent(session, getTaskOrThrow(session, input.task_id), exec.agent))
    const config = deps.getConfig()
    const delegations = session.store.getTaskDelegations(task.taskId)
    const cwd = getAgentHeader(exec.agent).cwd ?? process.cwd()
    const paths = [...new Set([...task.card.scope, ...delegations.flatMap((record) => record.changedFiles ?? [])])]
    const artifact = await getArtifactSnapshot(cwd, paths)
    const currentDelegations = getCurrentDelegations(task, delegations, artifact.digest)
    const resolutions = [...(task.acceptance?.resolutions ?? []), ...input.findingResolutions]
    const externalEditAt = getExternalEditAt(task, session)
    const check = getAcceptanceCheck(getEffectiveGates(task.gates, currentDelegations, externalEditAt), currentDelegations, resolutions, externalEditAt, task.card.perf)
    let rounds = task.rounds
    let status: AcceptanceRecord['status'] = 'recorded'
    let missing: string[] = []
    if (input.decision === 'accept') {
      const pending = delegations.filter((d) => d.status === 'queued' || d.status === 'running').map((d) => d.delegationId)
      missing = [...check.missing, ...(pending.length > 0 ? [`仍有未结束的委派：${pending.join(', ')}`] : [])]
      if (!artifact.complete) missing.push('产物摘要不完整，不能确认当前验证适用')
      if (config.workflow.mode === 'enforced') {
        if (!isPlanningReviewCurrent(task.planningReview, reviewSnapshot(task))) missing.push('缺少当前版本目标、流程与源码的规划审核')
        const remaining = task.workflowDefinition?.nodes.filter((node) => node.operation === 'delegate'
          && !['succeeded', 'skipped'].includes(task.workflowState?.nodes[node.id]?.status ?? 'pending')) ?? []
        if (remaining.length > 0) missing.push(`仍有必需流程节点未完成：${remaining.map((node) => node.id).join(', ')}`)
        if (task.checkpoint?.scope.outsidePaths.length) missing.push('任务改动越过允许范围')
        if (task.checkpoint?.convergence.blocked) missing.push('连续检查点没有进展，需要修正规划')
      }
      status = missing.length === 0 ? 'accepted' : 'blocked'
    } else if (input.decision === 'reject') {
      rounds += 1
      if (rounds > config.budgets.maxAutoFixRounds) {
        status = 'blocked'
        missing = [`自动修复轮次已用尽（上限 ${config.budgets.maxAutoFixRounds}），请向用户报告阻塞原因`]
      }
      if (rounds <= config.budgets.maxAutoFixRounds && task.workflowDefinition !== undefined) {
        task = session.store.UpdateTask(task.taskId, { workflowState: intWorkflowState(task.workflowDefinition, rounds) })
      }
    }
    const acceptance: AcceptanceRecord = {
      decision: input.decision, status, summary: input.summary, missing, unresolved: input.unresolved,
      stopReason: input.stopReason, resolutions, at: now()
    }
    let state = task.workflowState
    if (status === 'accepted' && state && task.workflowDefinition) {
      for (const node of task.workflowDefinition.nodes.filter((node) => node.operation !== 'delegate')) {
        const original = state.nodes[node.id]
        if (original?.status === 'pending') state = UpdateWorkflowNode(state, node.id, 'ready')
        if (state.nodes[node.id]?.status === 'ready') state = UpdateWorkflowNode(state, node.id, 'succeeded', { evidenceRefs: currentDelegations.map((record) => record.delegationId) })
      }
    }
    session.store.UpdateTask(task.taskId, { rounds, acceptance, workflowState: state, artifactSnapshot: artifact })
    session.ledger.AddLedgerEvent({ type: 'accept/decision', taskId: task.taskId, data: { ...acceptance } })
    if (status === 'accepted' || input.decision === 'incomplete') ClearRootUpgrade(exec.agent, session, task.taskId)
    let experienceCandidateId: string | undefined
    if (status === 'accepted' && config.experience.enabled) {
      const current = session.store.getTask(task.taskId)!
      try {
        const candidate = await features.experiences.addCandidate({
        problemClass: current.workflowDefinition?.mode ?? 'standard', conclusion: input.summary,
        appliesWhen: current.card.acceptance, doesNotApplyWhen: input.unresolved,
        source: { taskId: current.taskId, cardRevision: current.cardRevision ?? 1, workflowRevision: current.workflowRevision ?? 1, artifactDigest: artifact.digest },
        verification: currentDelegations.flatMap((record) => record.evidence.map((item) => item.ref)),
        counterexamples: [], operatorVersions: [], expiresAt: now() + 30 * 24 * 60 * 60_000
        })
        experienceCandidateId = candidate.id
      } catch (error) { deps.logger?.info(`本次经验未入库：${String(error)}`) }
    }
    await features.persist('accept/decision', session.store, session.threads, routeState.getHealth())
    if (experienceCandidateId !== undefined) {
      // Promotion derives proof from persisted current source, independent review and verification.
      try { await features.promoteCandidateWithEvidence(experienceCandidateId) }
      catch (error) { deps.logger?.info(`经验保留为候选，未获独立复核晋升：${String(error)}`) }
    }
    // 天枢申请验收时，也由衡鉴复评验收结论是否与证据一致（只提示，不改变验收结果）
    const assessment = input.decision === 'accept'
      ? await getAssessment(session, getAcceptanceState(task, delegations, { summary: input.summary, unresolved: input.unresolved, gates: check.statuses }), ACCEPTANCE_QUESTIONS, exec.signal)
      : undefined
    if (assessment !== undefined) {
      session.ledger.AddLedgerEvent({ type: 'review/assessment', taskId: task.taskId, data: { scope: 'acceptance', ...assessment } })
      if (assessment.verdict !== undefined) deps.logger?.info(`任务 ${task.taskId} 验收复评：${VERDICT_LABELS[assessment.verdict]}`)
    }
    return {
      task_id: task.taskId, status, missing, roundsUsed: rounds, maxAutoFixRounds: config.budgets.maxAutoFixRounds, gates: check.statuses,
      ...(assessment === undefined ? {} : { assessment })
    }
  }

  const getRoleForAgent = (agent: AgentLike | undefined): RoleId | undefined => {
    if (agent === undefined) return undefined
    return routeState.getChildRole(agent.id) ?? FindRoleByPresetId(getPresetId(agent))?.id
  }

  const isManagedAgent = (agent: AgentLike | undefined): boolean => {
    if (agent === undefined) return false
    if (routeState.getChildRole(agent.id) !== undefined) return true
    return getAgentHeader(agent).parentSession === undefined && FindRoleByPresetId(getPresetId(agent)) !== undefined
  }

  /** 天枢根会话自己的写操作：记下时刻，使之前的验证与审查失效（shell 写文件无法识别，属已知限制） */
  const AddRootEdit = (agent: AgentLike | undefined, role: RoleId | undefined): void => {
    if (agent === undefined || role !== 'tian_shu' || getAgentHeader(agent).parentSession !== undefined) return
    getSession(agent.id).rootEditAt = now()
  }

  const getGuardReason = (execution: ToolExecutionLike): string | undefined => {
    const writer = WRITE_TOOL_NAMES.includes(execution.name) || ['bash', 'pwsh'].includes(execution.name)
    const role = getRoleForAgent(execution.agent)
    if (isManagedAgent(execution.agent)) {
      const denied = getToolApprovalDenial(execution, deps.getConfig().approvals)
      if (denied !== undefined) return denied
    }
    const owner = execution.agent === undefined ? undefined : childOwners.get(execution.agent.id)
    if (owner !== undefined && execution.agent !== undefined) {
      const session = getSession(owner)
      const binding = session.features?.bindings.get(execution.agent.id)
      if (binding === undefined) return '当前专家的身份绑定尚未就绪，不能执行工具'
      if (childSignals.get(execution.agent.id)?.aborted) return '专家已经取消，延迟工具调用被拒绝'
      {
        if (binding.state !== 'active') return '专家执行身份已经撤销，请重新委派'
        const currentTask = session.store.getTask(binding.taskId)
        const task = currentTask === undefined ? undefined : refreshIntent(session, currentTask, session.rootAgent ?? execution.agent)
        if (task === undefined || !isTaskVersionCurrent(task, binding)) return '专家绑定的是旧任务版本，不能继续执行工具'
      }
      if (['read', 'read_image', 'glob', 'grep', 'write', 'edit'].includes(execution.name)) {
        const canonical = (path: string): string => {
          const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`
          try { return realpathSync.native(absolute) } catch {
            let parent = dirname(absolute)
            for (let n = 0; n < 64; n++) {
              try {
                const suffix = absolute.slice(parent.length).replace(/^[\\/]+/, '')
                return resolve(realpathSync.native(parent), suffix)
              } catch {
                const next = dirname(parent); if (next === parent) break; parent = next
              }
            }
            return absolute
          }
        }
        const within = (base: string, target: string): boolean => {
          const rel = relative(base, target)
          return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
        }
        const config = deps.getConfig()
        const privateRoots = [
          config.persistence.directory || join(deps.dshHome, 'share', 'dsh-agent-swarm', 'state'),
          config.ledgerDir || join(deps.dshHome, 'share', 'dsh-agent-swarm', 'ledger')
        ].map(canonical)
        const cwd = getAgentHeader(execution.agent).cwd ?? getAgentHeader(session.rootAgent ?? execution.agent).cwd ?? process.cwd()
        const args = execution.arguments as Record<string, unknown> | undefined
        const targets = Object.entries(args ?? {}).filter(([key, value]) => /path|file|directory|root|cwd/i.test(key) && typeof value === 'string')
          .map(([, value]) => canonical(isAbsolute(value as string) ? value as string : `${cwd}${sep}${value as string}`))
        if (['glob', 'grep'].includes(execution.name) && targets.length === 0) targets.push(canonical(cwd))
        if (targets.some((target) => privateRoots.some((root) => within(root, target) || (['glob', 'grep'].includes(execution.name) && within(target, root))))) {
          return '私有状态与账本不能通过通用文件工具读取；请使用当前任务授权的 swarm_context_read'
        }
        if (WRITE_TOOL_NAMES.includes(execution.name) && targets.length > 0) {
          const task = session.store.getTask(binding.taskId)!
          if (task.card.scope.length > 0) {
            const allowed = task.card.scope.map((path) => canonical(isAbsolute(path) ? path : `${cwd}${sep}${path}`))
            if (targets.some((target) => !allowed.some((path) => within(path, target)))) return '写入路径超出当前任务允许的 scope'
          } else if (config.workflow.mode === 'enforced') return '写任务必须先明确允许修改的 scope'
        }
      }
    }
    if (!writer) return undefined
    if (execution.agent !== undefined && leases.peekStatus(getAgentHeader(execution.agent).cwd ?? process.cwd())?.mutationUnknown) return '工作区存在未确认副作用，必须完成恢复核对后才能再次写入或运行命令'
    if (role === 'tian_shu' && execution.agent !== undefined && deps.getConfig().workflow.mode === 'enforced'
      && getSession(execution.agent.id).store.getTasks().some((task) => task.acceptance?.status !== 'accepted' && task.acceptance?.decision !== 'incomplete')) {
      return '强制任务流程中，写入与通用命令需通过受工作区租约管理的专家执行'
    }
    if (WRITE_TOOL_NAMES.includes(execution.name)) AddRootEdit(execution.agent, role)
    if (['bash', 'pwsh'].includes(execution.name) && role !== undefined && getRoleInfo(role).capabilities.includes('shell')) return undefined
    if (role === undefined || isWriteAllowed(role)) return undefined
    return `dsh-agent-swarm 守卫：「${getRoleInfo(role).name}」是${getPermissionLabel(role)}角色，不能调用 ${execution.name} 修改文件。请在结果中写明需要的改动，由天枢交给铸剑或疾风处理。`
  }

  return {
    getConfig: deps.getConfig,
    routeState,
    jev,
    AddTaskCard,
    delegate: async (raw, exec) => {
      const session = getSession(exec.agent.id)
      const features = await ensureFeatures(session, exec.agent)
      const args = { ...(raw as { task_id: string; role: import('./role-registry.js').DelegableRoleId; mode?: import('./role-registry.js').SuanHengMode; gate?: import('./policy.js').GateId; node_id?: string; request_id?: string; expected_workflow_revision?: number; prompt?: string; session?: string; review_phase?: 'blind' | 'response' }) }
      args.request_id ??= exec.callId
      const responsePhase = args.review_phase === 'response'
      if (responsePhase && args.role !== 'yu_shi' && !(args.role === 'suan_heng' && args.mode === 'verify')) throw new SwarmError('PERMISSION_DENIED', '只有已冻结独立初审的角色可进入回应阶段')
      let prepared: TaskRecord
      let nodeId: string | undefined
      let executionBudget: ReturnType<FeatureSession['budgetFor']>
      const attemptId = randomUUID()
      const reservationId = `delegation-${attemptId}`
      const requestTask = reconcileTask(session, refreshIntent(session, getTaskOrThrow(session, args.task_id), exec.agent))
      const requestInput = { ...args, cardRevision: requestTask.cardRevision ?? 1,
        workflowRevision: requestTask.workflowRevision ?? 1, requestRevision: requestTask.requestRevision ?? 1 }
      const requestDigest = getValueDigest(requestInput)
      const legacyRequestDigest = digest(requestInput)
      const matchesRequest = (saved: string | undefined): boolean => saved === requestDigest || saved === legacyRequestDigest
      const previousRequest = args.request_id === undefined ? undefined : getTaskOrThrow(session, args.task_id).requestIds?.[args.request_id]
      if (previousRequest !== undefined) {
        if (!matchesRequest(requestTask.requestInputs?.[args.request_id!])) throw new SwarmError('INVALID_ARGS', '相同 request_id 的输入或任务版本已改变')
        const previous = session.store.getDelegation(previousRequest)
        if (previous !== undefined) return previous
        throw new SwarmError('RECOVERY_REQUIRED', '此请求正在执行或需要恢复核对，不能重复启动')
      }
      let replay: DelegationRecord | undefined
      await session.taskLock.run(async () => {
        prepared = reconcileTask(session, refreshIntent(session, getTaskOrThrow(session, args.task_id), exec.agent))
        if (!isTaskVersionCurrent(prepared, requestTask)) throw new SwarmError('STALE_EVIDENCE', '等待预约期间任务版本已改变，请读取新合同')
        if (args.request_id !== undefined) {
          if (typeof args.request_id !== 'string' || !args.request_id || args.request_id.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(args.request_id)) throw new SwarmError('INVALID_ARGS', 'request_id 必须是有界合法标识')
          const existing = prepared.requestIds?.[args.request_id]
          if (existing !== undefined) {
            if (!matchesRequest(prepared.requestInputs?.[args.request_id])) throw new SwarmError('INVALID_ARGS', '相同 request_id 的输入或任务版本已改变')
            replay = session.store.getDelegation(existing)
            if (replay !== undefined) return
            throw new SwarmError('RECOVERY_REQUIRED', '同一请求已有正在执行的 attempt，拒绝重复启动')
          }
        }
        if (args.expected_workflow_revision !== undefined && args.expected_workflow_revision !== (prepared.workflowRevision ?? 1)) throw new SwarmError('INVALID_ARGS', '流程版本已改变')
        if (prepared.recovered && ['ji_feng', 'zhu_jian', 'xing_zhou'].includes(args.role)
          && Object.values(prepared.workflowState?.nodes ?? {}).some((node) => node.status === 'blocked')) throw new SwarmError('RECOVERY_REQUIRED', '恢复时存在未确认副作用，不能直接重复写任务')
        if (deps.getConfig().workflow.mode === 'enforced' && !isPlanningReviewCurrent(prepared.planningReview, reviewSnapshot(prepared))) throw new SwarmError('PLANNING_REVIEW_REQUIRED', '执行前需要当前版本的目标、流程设计和 Mermaid 审核')
        if (responsePhase) {
          const frozen = getCurrentDelegations(prepared, session.store.getTaskDelegations(prepared.taskId), prepared.artifactSnapshot?.digest)
            .find((record) => record.role === args.role && record.mode === args.mode && record.status === 'completed'
              && record.reviewPhase !== 'response' && record.artifactAfter === prepared.artifactSnapshot?.digest)
          if (frozen === undefined) throw new SwarmError('PLANNING_REVIEW_REQUIRED', '当前版本及产物尚无冻结的独立初审，不能开放 peer 回应')
        } else if (prepared.workflowDefinition && prepared.workflowState) {
          const match = getMatchingNode(prepared.workflowDefinition, prepared.workflowState, {
            role: args.role, mode: args.mode, gate: args.gate, nodeId: args.node_id
          })
          if (match.node === undefined && deps.getConfig().workflow.mode === 'enforced') throw new SwarmError('INVALID_ARGS', match.reason ?? '节点不允许执行')
          nodeId = match.node?.id
        }
        executionBudget = features.budgetFor(prepared)
        executionBudget.reserve({ id: reservationId, source: 'delegate' })
        if (nodeId !== undefined && prepared.workflowState) {
          let state = prepared.workflowState
          if (state.nodes[nodeId]?.status === 'pending') state = UpdateWorkflowNode(state, nodeId, 'ready')
          state = UpdateWorkflowNode(state, nodeId, 'running', { attemptId })
          prepared = session.store.UpdateTask(prepared.taskId, { workflowState: state })
        }
        if (args.request_id !== undefined) prepared = session.store.UpdateTask(prepared.taskId, {
          requestIds: { ...prepared.requestIds, [args.request_id]: `pending:${attemptId}` },
          requestInputs: { ...prepared.requestInputs, [args.request_id]: requestDigest }
        })
        await features.persist('workflow/attempt-reserved', session.store, session.threads, routeState.getHealth())
      })
      if (replay !== undefined) return replay
      const captured = prepared!
      const cwd = getAgentHeader(exec.agent).cwd ?? process.cwd()
      const kind = ['ji_feng', 'zhu_jian', 'xing_zhou'].includes(args.role) ? 'write' : args.role === 'fu_he' ? 'verify' : undefined
      let lease: WorkspaceLease | undefined
      let started = false
      try {
        lease = kind === undefined ? undefined : await leases.acquire(cwd, `${exec.agent.id}:${attemptId}`, kind, exec.signal)
        const current = refreshIntent(session, getTaskOrThrow(session, args.task_id), exec.agent)
        if (!isTaskVersionCurrent(current, captured)) {
          executionBudget!.cancel(reservationId)
          throw new SwarmError('STALE_EVIDENCE', '等待执行期间任务版本已改变')
        }
        const paths = [...new Set([...captured.card.scope, ...session.store.getTaskDelegations(captured.taskId).flatMap((record) => record.changedFiles ?? [])])]
        const before = await getArtifactSnapshot(cwd, paths)
        if (responsePhase && before.digest !== captured.artifactSnapshot?.digest) throw new SwarmError('STALE_EVIDENCE', '产物改变后必须重新进行独立盲审')
        executionBudget!.start(reservationId)
        started = true
        const input = { ...args, ...(nodeId === undefined ? {} : { node_id: nodeId }), attempt_id: attemptId,
          ...((!responsePhase && (args.role === 'yu_shi' || (args.role === 'suan_heng' && args.mode === 'verify'))) ? { session: 'new', review_phase: 'blind' } : {}) }
        const delegated = await delegator.delegate(input, exec, session)
        const record = await ReviewDelegation(session, delegated, args.prompt, exec.signal)
        const after = await getArtifactSnapshot(cwd, [...new Set([...paths, ...(record.changedFiles ?? [])])])
        executionBudget!.settle(reservationId)
        return await session.taskLock.run(async () => {
          let task = refreshIntent(session, getTaskOrThrow(session, captured.taskId), exec.agent)
          const stale = (task.cardRevision ?? 1) !== (captured.cardRevision ?? 1)
            || (task.requestRevision ?? 1) !== (captured.requestRevision ?? 1)
          const verifier = ['fu_he', 'yu_shi'].includes(args.role) || (args.role === 'suan_heng' && args.mode === 'verify')
          const changedDuringVerification = verifier && (before.digest !== after.digest || !before.complete || !after.complete)
          const updated = session.store.UpdateDelegation(record.delegationId, {
            cardRevision: captured.cardRevision ?? 1, workflowRevision: captured.workflowRevision ?? 1, requestRevision: captured.requestRevision ?? 1,
            attemptId, ...(nodeId === undefined ? {} : { nodeId }), artifactBefore: before.digest, artifactAfter: after.digest,
            artifactDigest: after.digest,
            ...(stale ? { staleReason: '执行期间合同或原始需求改版' } : changedDuringVerification ? { staleReason: '验证期间产物发生变化或摘要不完整' } : {})
          })
          if (!stale) {
            task = reconcileTask(session, task)
            if (nodeId && task.workflowState?.nodes[nodeId]?.attemptId === attemptId) {
              task = session.store.UpdateTask(task.taskId, { workflowState: UpdateWorkflowNode(task.workflowState, nodeId,
                updated.status === 'completed' && !updated.staleReason ? 'succeeded' : updated.status === 'blocked' ? 'blocked' : 'failed',
                { attemptId, reason: updated.staleReason ?? updated.error, evidenceRefs: updated.evidence.map((item) => item.ref) }) })
            }
            const checkpoint = getCheckpoint({
              taskId: task.taskId, cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1,
              roundId: `${task.rounds}:${attemptId}`, evidenceRefs: updated.evidence.map((item) => digest({ evidence: item, artifactDigest: after.digest })),
              unresolved: updated.unresolved, allowedPaths: task.card.scope, changedPaths: updated.changedFiles ?? [],
              resource: { delegations: session.store.getTaskDelegations(task.taskId).length, tokens: null, cost: null, remainingFixRounds: deps.getConfig().budgets.maxAutoFixRounds - task.rounds }
            }, task.checkpoint)
            task = session.store.UpdateTask(task.taskId, { checkpoint, artifactSnapshot: after })
            session.ledger.AddLedgerEvent({ type: 'workflow/checkpoint', taskId: task.taskId, delegationId: updated.delegationId, data: { ...checkpoint } })
            const material = features.addContext({
              binding: getTaskContextBinding(task, features.workspaceId),
              layer: 'L2', kind: verifier ? 'evidence' : 'author-reasoning', text: JSON.stringify({ summary: updated.summary, structured: updated.structured, evidence: updated.evidence })
            })
            session.store.UpdateTask(task.taskId, { contextRefs: [...(task.contextRefs ?? []), { ref: material.ref, digest: material.digest, layer: material.layer, kind: material.kind }] })
          }
          if (args.request_id !== undefined) session.store.UpdateTask(task.taskId, { requestIds: { ...task.requestIds, [args.request_id]: updated.delegationId } })
          await features.persist('delegation/completed', session.store, session.threads, routeState.getHealth())
          if (!stale) await UpdateRootUpgrade(exec.agent, session, task)
          return session.store.getDelegation(updated.delegationId)!
        })
      } catch (error) {
        const budget = executionBudget!
        const reservation = budget.getSnapshot().reservations.find((item) => item.id === reservationId)
        if (reservation?.state === 'reserved') budget.cancel(reservationId)
        else if (reservation?.state === 'started') budget.settle(reservationId)
        await session.taskLock.run(async () => {
          const task = getTaskOrThrow(session, captured.taskId)
          let state = task.workflowState
          if (nodeId && state?.nodes[nodeId]?.attemptId === attemptId && state.nodes[nodeId]?.status === 'running') {
            state = started ? UpdateWorkflowNode(state, nodeId, 'failed', { attemptId, reason: String(error) })
              : { ...state, nodes: { ...state.nodes, [nodeId]: { status: 'ready', reason: '未启动的预约已取消，可以重新提交' } } }
          }
          const requestIds = { ...task.requestIds }, requestInputs = { ...task.requestInputs }
          if (!started && args.request_id && requestIds[args.request_id] === `pending:${attemptId}`) {
            delete requestIds[args.request_id]; delete requestInputs[args.request_id]
          }
          session.store.UpdateTask(task.taskId, { workflowState: state, requestIds, requestInputs })
          await features.persist('workflow/attempt-failed', session.store, session.threads, routeState.getHealth())
        })
        throw error
      } finally {
        if (lease !== undefined) await lease.release({ confirmedStopped: !exec.signal.aborted })
      }
    },
    getStatus,
    AcceptTask,
    getGuardReason,
    getRoleForAgent,
    isManagedAgent,
    OnSubagentEnd: (info) => hub.Emit(info),
    FilterPreStep: (decision) => {
      if (decision.kind !== 'enter' || decision.messages.length === 0) return decision
      const isConsumedNotice = (message: InboxMessageLike): boolean =>
        message.source?.kind === 'subagent-settled' && typeof message.source.senderSessionId === 'string' && hub.TakeConsumed(message.source.senderSessionId)
      const messages = decision.messages.filter((message) => !isConsumedNotice(message))
      return messages.length === decision.messages.length ? decision : { ...decision, messages }
    },
    getDiagnostics
    ,ReviewPlan, Calculate, ReadContext, MessageSend, MessageRead, MessageAck, Experience
    ,getTaskViewForRpc: (sessionId, taskId) => {
      const session = sessions.get(sessionId)
      if (session === undefined || session.rootAgent === undefined || !isRootTianShu(session.rootAgent)) throw new SwarmError('PERMISSION_DENIED', '该会话不是已登记的百工根会话')
      const task = getTaskOrThrow(session, taskId)
      return getTaskView(task, session.store.getTaskDelegations(taskId), deps.getConfig(), false, getExternalEditAt(task, session))
    }
    ,dispose: async () => { for (const session of sessions.values()) if (session.featuresPromise) await (await session.featuresPromise).dispose() }
    ,WaitAgentReady: async (agent) => {
      const pending = childReady.get(agent.id)
      if (pending !== undefined) await pending
      else if (deps.getConfig().persistence.enabled && isRootTianShu(agent)) await ensureFeatures(getSession(agent.id), agent)
    }
  }
}
