import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import { intDelegator, type DelegateExecInfo, type DelegateSessionInfo, type PlanSessionInput } from './delegate.js'
import { intLedger, intTaskStore, type AcceptanceRecord, type AssessmentInfo, type DelegationRecord, type TaskRecord, type TriageRecord } from './evidence.js'
import {
  SPAWN_PROVIDER,
  WRITE_TOOL_NAMES,
  getAgentHeader,
  type AgentLike,
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
import type { JevOutcome } from './jev.js'
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
  getDiagnostics: () => string[]
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
  const gates = getEffectiveGates(task.gates, delegations, externalEditAt)
  const check = getAcceptanceCheck(gates, delegations, task.acceptance?.resolutions ?? [], externalEditAt)
  return {
    task_id: task.taskId,
    title: task.card.title,
    goal: task.card.goal,
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
      rootEditAt: 0
    }
    sessions.set(sessionId, created)
    return created
  }

  const sleep = deps.sleep ?? SleepWithSignal
  const probe = deps.probe ?? intRouteProbe(deps.getLlm, { now })
  const routeState = intRouteStateRegistry((event) => {
    deps.logger?.warn(`主会话 ${event.agentId} 路由 ${getRouteLabel(event.from)} 失败（${event.failure.code ?? event.failure.status ?? 'error'}），回退到 ${getRouteLabel(event.to)}`)
    getSession(event.agentId).ledger.AddLedgerEvent({ type: 'route/fallback', data: { scope: 'root', from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
  }, probe, {
    now,
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
    return outcome.ok ? ParseAssessment(outcome.answers, config.review, outcome.model) : { status: 'unavailable', reason: outcome.reason }
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
    const requestedId = (raw as { task_id?: unknown }).task_id
    const existing = typeof requestedId === 'string' ? session.store.getTask(requestedId) : undefined
    if (typeof requestedId === 'string' && existing === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${requestedId}`)
    const ruleGates = getRuleGates(card)
    const merged = existing === undefined ? ruleGates : [...existing.gates, ...ruleGates.filter((gate) => !existing.gates.some((old) => old.gate === gate.gate))]
    const { gates, triage } = await getTriage(card, merged, session, exec.signal)
    const task: TaskRecord = existing === undefined
      ? { taskId: `T-${session.store.getTasks().length + 1}`, sessionId: session.sessionId, card, gates, triage, delegationIds: [], rounds: 0, createdAt: now(), updatedAt: now() }
      : session.store.UpdateTask(existing.taskId, { card, gates, triage })
    if (existing === undefined) session.store.AddTask(task)
    session.ledger.AddLedgerEvent({ type: 'task/card', taskId: task.taskId, data: { card, gates: gates.map((gate) => gate.gate), triage: triage.source } })
    const explicit = (raw as { upgrade?: unknown }).upgrade
    const rootUpgrade = await UpdateRootUpgrade(exec.agent, session, task, typeof explicit === 'boolean' ? explicit : undefined)
    return getTaskCardResult(task, card, deps.getConfig(), session.ledger.path, rootUpgrade)
  }

  const getTaskOrThrow = (session: SessionStateInfo, taskId: string): TaskRecord => {
    const task = session.store.getTask(taskId)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${taskId}`)
    return task
  }

  const getDiagnostics = (): string[] => {
    const out: string[] = []
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
    const tasks = typeof input.task_id === 'string' ? [getTaskOrThrow(session, input.task_id)] : session.store.getTasks()
    const views = tasks.map((task) =>
      getTaskView(task, session.store.getTaskDelegations(task.taskId), config, input.verbose === true, getExternalEditAt(task, session)))
    return getStatusResult(views, session, getDiagnostics())
  }

  const AcceptTask: SwarmService['AcceptTask'] = async (raw, exec) => {
    const { input, errors } = ValidateAcceptInput(raw)
    if (input === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const session = getSession(exec.agent.id)
    const task = getTaskOrThrow(session, input.task_id)
    const config = deps.getConfig()
    const delegations = session.store.getTaskDelegations(task.taskId)
    const resolutions = [...(task.acceptance?.resolutions ?? []), ...input.findingResolutions]
    const externalEditAt = getExternalEditAt(task, session)
    const check = getAcceptanceCheck(getEffectiveGates(task.gates, delegations, externalEditAt), delegations, resolutions, externalEditAt)
    let rounds = task.rounds
    let status: AcceptanceRecord['status'] = 'recorded'
    let missing: string[] = []
    if (input.decision === 'accept') {
      const pending = delegations.filter((d) => d.status === 'queued' || d.status === 'running').map((d) => d.delegationId)
      missing = [...check.missing, ...(pending.length > 0 ? [`仍有未结束的委派：${pending.join(', ')}`] : [])]
      status = missing.length === 0 ? 'accepted' : 'blocked'
    } else if (input.decision === 'reject') {
      rounds += 1
      if (rounds > config.budgets.maxAutoFixRounds) {
        status = 'blocked'
        missing = [`自动修复轮次已用尽（上限 ${config.budgets.maxAutoFixRounds}），请向用户报告阻塞原因`]
      }
    }
    const acceptance: AcceptanceRecord = {
      decision: input.decision, status, summary: input.summary, missing, unresolved: input.unresolved,
      stopReason: input.stopReason, resolutions, at: now()
    }
    session.store.UpdateTask(task.taskId, { rounds, acceptance })
    session.ledger.AddLedgerEvent({ type: 'accept/decision', taskId: task.taskId, data: { ...acceptance } })
    if (status === 'accepted' || input.decision === 'incomplete') ClearRootUpgrade(exec.agent, session, task.taskId)
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
    if (!WRITE_TOOL_NAMES.includes(execution.name)) return undefined
    const role = getRoleForAgent(execution.agent)
    AddRootEdit(execution.agent, role)
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
      const delegated = await delegator.delegate(raw, exec, session)
      const prompt = (raw as { prompt?: unknown } | null)?.prompt
      const record = await ReviewDelegation(session, delegated, typeof prompt === 'string' ? prompt : undefined, exec.signal)
      // 委派结果可能带来结论冲突或复评存疑：按天枢的升级配置重新判定
      const task = session.store.getTask(record.taskId)
      if (task !== undefined) await UpdateRootUpgrade(exec.agent, session, task)
      return record
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
  }
}
