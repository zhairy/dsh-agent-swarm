import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SwarmConfigInfo } from './config.js'
import { intDelegator, type DelegateExecInfo, type DelegateSessionInfo } from './delegate.js'
import { intLedger, intTaskStore, type AcceptanceRecord, type DelegationRecord, type TaskRecord, type TriageRecord } from './evidence.js'
import {
  SPAWN_PROVIDER,
  WRITE_TOOL_NAMES,
  getAgentHeader,
  type AgentLike,
  type AttachmentsLike,
  type CredentialsLike,
  type LlmLike,
  type SubagentsLike,
  type ToolExecutionLike,
  type ToolsLike
} from './host-contract.js'
import { intJevClient, type JevOutcome } from './jev.js'
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
import { getRouteLabel, intRouteProbe, type RouteProbe } from './routes.js'
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
  dshHome: string
  fetch: typeof fetch
  logger?: LoggerLike
  now?: () => number
  readFile?: (path: string) => Promise<Uint8Array>
  gitStatus?: (cwd: string) => Promise<GitStatusInfo | undefined>
  sleep?: (ms: number) => Promise<void>
  probe?: RouteProbe
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

interface SessionStateInfo extends DelegateSessionInfo {
  counters: { native: number; jev: number }
  /** 天枢根会话最近一次调用 write/edit 的时刻；0 表示没有 */
  rootEditAt: number
}

/** 只有任务创建之后的天枢编辑才会让该任务已有的验证失效 */
const getExternalEditAt = (task: TaskRecord, session: SessionStateInfo): number =>
  session.rootEditAt >= task.createdAt ? session.rootEditAt : 0

/** 天枢工具与运行时行共用的服务 */
export interface SwarmService {
  getConfig: () => SwarmConfigInfo
  routeState: RouteStateRegistry
  AddTaskCard: (raw: unknown, exec: DelegateExecInfo) => Promise<ReturnType<typeof getTaskCardResult>>
  delegate: (raw: unknown, exec: DelegateExecInfo) => Promise<DelegationRecord>
  getStatus: (raw: unknown, exec: DelegateExecInfo) => ReturnType<typeof getStatusResult>
  AcceptTask: (raw: unknown, exec: DelegateExecInfo) => AcceptResultInfo
  getGuardReason: (execution: ToolExecutionLike) => string | undefined
  getRoleForAgent: (agent: AgentLike | undefined) => RoleId | undefined
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

const getTaskCardResult = (task: TaskRecord, card: TaskCard, config: SwarmConfigInfo, ledgerPath: string) => ({
  task_id: task.taskId,
  title: card.title,
  requiredGates: task.gates.map(getGateView),
  suggestedRoles: getSuggestedRoles(card, task.gates).map((item) => ({ ...item, roleName: getRoleInfo(item.role).name })),
  triage: task.triage,
  budgets: config.budgets,
  ledgerPath
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
  ledgerPath: session.ledger.path,
  usage: { nativeCalls: session.counters.native, jevCalls: session.counters.jev },
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
      counters: { native: 0, jev: 0 },
      rootEditAt: 0
    }
    sessions.set(sessionId, created)
    return created
  }

  const routeState = intRouteStateRegistry((event) => {
    deps.logger?.warn(`主会话 ${event.agentId} 路由 ${getRouteLabel(event.from)} 失败（${event.failure.code ?? event.failure.status ?? 'error'}），回退到 ${getRouteLabel(event.to)}`)
    getSession(event.agentId).ledger.AddLedgerEvent({ type: 'route/fallback', data: { scope: 'root', from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
  })

  const delegator = intDelegator({
    getConfig: deps.getConfig,
    getSubagents: deps.getSubagents,
    getTools: deps.getTools,
    getAttachments: deps.getAttachments,
    probe: deps.probe ?? intRouteProbe(deps.getLlm),
    routeState,
    readFile: deps.readFile ?? (async (path) => new Uint8Array(await readFile(path))),
    gitStatus: deps.gitStatus ?? ((cwd) => getGitStatus(cwd)),
    now,
    newId
  })

  const getJevKey = async (env: string): Promise<string | undefined> => {
    try {
      const hit = await deps.getCredentials()?.resolve(env)
      if (hit?.value) return hit.value
    } catch (error) {
      deps.logger?.warn(`读取 Jev 凭据引用 ${env} 失败：${String(error)}`)
    }
    return process.env[env]
  }

  const getTriage = async (card: TaskCard, gates: GateRequirement[], session: SessionStateInfo, signal: AbortSignal) => {
    const config = deps.getConfig()
    const rulesApplied = gates.map((gate) => `${gate.gate}：${gate.reason}`)
    if (!isTriageUseful(card, gates)) return { gates, triage: { source: 'rules', rulesApplied } as TriageRecord }
    if (!config.jev.enabled) return { gates, triage: { source: 'rules', rulesApplied, fallbackReason: 'jev-disabled' } as TriageRecord }
    let outcome: JevOutcome
    if (session.counters.jev >= config.jev.maxCallsPerSession) {
      outcome = { ok: false, reason: 'jev-budget', attempts: 0 }
    } else {
      session.counters.jev += 1
      outcome = await intJevClient(config.jev, { fetch: deps.fetch, getApiKey: () => getJevKey(config.jev.apiKeyEnv), ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) }).triage(card, signal)
    }
    session.ledger.AddLedgerEvent({ type: 'jev/call', data: outcome.ok ? { ok: true, attempts: outcome.attempts, answers: outcome.answers } : { ok: false, reason: outcome.reason, attempts: outcome.attempts } })
    const next = AddTriageGates(gates, card, outcome.ok ? { failed: false, answers: outcome.answers } : { failed: true, reason: outcome.reason }, config.thresholds)
    const triage: TriageRecord = outcome.ok
      ? { source: 'rules+jev', answers: outcome.answers, rulesApplied }
      : { source: 'rules+jev-fallback', fallbackReason: outcome.reason, rulesApplied }
    return { gates: next, triage }
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
    return getTaskCardResult(task, card, deps.getConfig(), session.ledger.path)
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
    const tasks = typeof input.task_id === 'string' ? [getTaskOrThrow(session, input.task_id)] : session.store.getTasks()
    const views = tasks.map((task) =>
      getTaskView(task, session.store.getTaskDelegations(task.taskId), config, input.verbose === true, getExternalEditAt(task, session)))
    return getStatusResult(views, session, getDiagnostics())
  }

  const AcceptTask: SwarmService['AcceptTask'] = (raw, exec) => {
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
    return { task_id: task.taskId, status, missing, roundsUsed: rounds, maxAutoFixRounds: config.budgets.maxAutoFixRounds, gates: check.statuses }
  }

  const getRoleForAgent = (agent: AgentLike | undefined): RoleId | undefined => {
    if (agent === undefined) return undefined
    return routeState.getChildRole(agent.id) ?? FindRoleByPresetId(getAgentHeader(agent).agentPreset)?.id
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
    AddTaskCard,
    delegate: (raw, exec) => delegator.delegate(raw, exec, getSession(exec.agent.id)),
    getStatus,
    AcceptTask,
    getGuardReason,
    getRoleForAgent,
    getDiagnostics
  }
}
