import type { SwarmConfigInfo } from '../config.js'
import type { DelegationRecord, TaskRecord } from '../evidence.js'
import type { GateRequirement, TaskCard } from '../policy.js'
import { GATE_ROLE, getAcceptanceCheck, getEffectiveGates, getSuggestedRoles } from '../policy.js'
import { getRoleInfo } from '../role-registry.js'
import { getRouteLabel } from '../domain/routing/routes.js'
import type { ThreadInfo, ThreadRegistry } from '../threads.js'
import type { RequestRecoveryState } from './routing/engine.js'
import type { WorktreeBindingInfo } from '../worktree-binding.js'
import type { FeatureSession } from '../feature-session.js'
import { getPlanningRecovery } from '../planning-recovery.js'
import { getTaskDiagrams } from '../task-diagrams.js'
import { getBlockedRecovery } from '../blocked-recovery.js'
import { getCurrentDelegations, getTaskBinding, isTaskVersionCurrent } from '../task-model.js'
import { getReadyNodes, getWorkflowMermaid, getTaskCardMarkdown, getPlanningStatusText } from '../workflow.js'
import { projectTicketLifecycle } from '../domain/tickets/lifecycle.js'
import type { RootUpgradeView } from './api.js'
import { suggestRolesByCapabilities } from '../role-registry.js'

export interface StatusSessionInfo {
  rootUpgrade?: RootUpgradeView
  store: { getTasks: () => TaskRecord[] }
  threads: Pick<ThreadRegistry, 'list'>
  ledger: { path: string }
  counters: { native: number; jev: number; review: number; session: number }
  features?: Pick<FeatureSession, 'store' | 'contexts'>
}

export const getGateView = (gate: GateRequirement) => ({
  gate: gate.gate,
  role: gate.role,
  roleName: getRoleInfo(gate.role).name,
  ...(gate.mode === undefined ? {} : { mode: gate.mode }),
  label: GATE_ROLE[gate.gate].label,
  reason: gate.reason,
  source: gate.source
})

export const getTaskCardResult = (task: TaskRecord, card: TaskCard, config: SwarmConfigInfo, ledgerPath: string, rootUpgrade: RootUpgradeView | undefined) => ({
  task_id: task.taskId,
  rootUpgrade: rootUpgrade ?? null,
  title: card.title,
  goal: card.goal, acceptance: card.acceptance, scope: card.scope, perf: card.perf ?? null,
  planningScope: card.planningScope ?? null,
  cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1, requestRevision: task.requestRevision ?? 1,
  contextRefs: (task.contextRefs ?? []).map((material) => material.ref),
  contextArtifacts: task.contextRefs ?? [],
  planningReview: task.planningReview ?? null,
  workflowMode: config.workflow.mode,
  planningRecovery: getPlanningRecovery(task, config.planningReview.maxFixRounds),
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

export const getThreadView = (thread: ThreadInfo) => ({
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

export const getDelegationView = (d: DelegationRecord, verbose: boolean) => ({
  delegationId: d.delegationId,
  cardRevision: d.cardRevision ?? 1, workflowRevision: d.workflowRevision ?? 1, requestRevision: d.requestRevision ?? 1,
  role: d.role,
  roleName: d.roleName,
  ...(d.mode === undefined ? {} : { mode: d.mode }),
  status: d.status,
  finalization: d.finalization ?? null,
  staleReason: d.staleReason ?? null,
  summary: d.summary.slice(0, 300),
  route: d.route === undefined ? null : getRouteLabel(d.route),
  backend: d.backend ?? null,
  independence: d.independence,
  hardIsolation: d.hardIsolation,
  durationMs: d.durationMs ?? null,
  error: d.error ?? null,
  assessment: d.assessment ?? null,
  evidenceAssessment: d.evidenceAssessment === undefined ? null : {
    status: d.evidenceAssessment.status, disposition: d.evidenceAssessment.disposition,
    confidenceMeaning: d.evidenceAssessment.confidenceMeaning,
    items: d.evidenceAssessment.items.map((item) => ({ id: item.id, credibility: item.credibility, relevance: item.relevance,
      support: item.support, disposition: item.disposition, reasons: item.reasons, model: item.model }))
  },
  session: d.session ?? null,
  retries: d.retries ?? [],
  unresolved: d.unresolved,
  changedFiles: d.changedFiles ?? [],
  ...(verbose ? { structured: d.structured, evidence: d.evidence, attempts: d.attempts, evidenceAssessmentDetails: d.evidenceAssessment } : {})
})

  export const getTaskView = (task: TaskRecord, delegations: DelegationRecord[], config: SwarmConfigInfo, verbose: boolean, externalEditAt: number, recovery?: RequestRecoveryState | null, delegationBindingTask: TaskRecord = task, includeDiagrams = true, worktrees: WorktreeBindingInfo[] = []) => {
  const current = getCurrentDelegations(task, delegations, task.artifactSnapshot?.digest)
  const gates = getEffectiveGates(task.gates, current, externalEditAt)
  const check = getAcceptanceCheck(gates, current, task.acceptance?.resolutions ?? [], externalEditAt, task.card.perf)
  return {
    task_id: task.taskId,
    ticket: projectTicketLifecycle(task, delegations),
    worktrees,
    title: task.card.title,
    goal: task.card.goal,
    card: task.card,
    cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1,
    stateRefreshRequired: false, publishedRevisions: getTaskBinding(task),
    requestRevision: task.requestRevision ?? 1, intentSource: task.intentSource ?? 'declared',
    intentHistoryNote: task.intentHistoryNote ?? null,
    planningReview: task.planningReview ?? null, checkpoint: task.checkpoint ?? null, workflowMode: config.workflow.mode,
    planningRecovery: getPlanningRecovery(task, config.planningReview.maxFixRounds),
    blockedRecovery: getBlockedRecovery({
      task: { acceptance: task.acceptance, checkpoint: task.checkpoint, planningReview: task.planningReview },
      gates: check.statuses,
      recovery
    }),
    recovered: task.recovered ?? false,
    contextRefs: (task.contextRefs ?? []).map((material) => material.ref),
    contextArtifacts: task.contextRefs ?? [],
    diagrams: includeDiagrams ? getTaskDiagrams(task, delegations, delegationBindingTask) : null,
    // 编排方案随任务视图一起下发：状态文本与图表都从这里取，避免各自推算。
    orchestration: task.orchestration ?? null,
    flow: task.workflowDefinition === undefined ? null : {
      definition: task.workflowDefinition, state: task.workflowState, digest: task.workflowDigest,
      mermaid: getWorkflowMermaid(task.workflowDefinition)
    },
    markdown: task.workflowDefinition === undefined ? '' : getTaskCardMarkdown(task.card, task.workflowDefinition, {
      taskId: task.taskId, cardRevision: task.cardRevision, workflowRevision: task.workflowRevision,
      state: task.workflowState, planningStatus: getPlanningStatusText(task.planningReview?.status, config.workflow.mode),
      delegationLimit: config.budgets.maxDelegationsPerTask
    }),
    rounds: task.rounds,
    triage: task.triage,
    acceptance: task.acceptance ?? null,
    gates: check.statuses.map((status) => ({ ...status, label: GATE_ROLE[status.gate].label })),
    delegations: delegations.map((d) => ({ ...getDelegationView(d, verbose), isCurrent: (d.finalization === undefined || d.finalization === 'ready') && isTaskVersionCurrent(task, d) && !d.staleReason })),
    budget: { used: delegations.filter((d) => d.status !== 'blocked').length, max: config.budgets.maxDelegationsPerTask }
  }
}

export const getStatusResult = (tasks: ReturnType<typeof getTaskView>[], session: StatusSessionInfo, diagnostics: string[]) => ({
  tasks,
  roleSuggestions: [] as ReturnType<typeof suggestRolesByCapabilities>,
  rootUpgrade: session.rootUpgrade ?? null,
  threads: session.threads.list().map(getThreadView),
  ledgerPath: session.ledger.path,
  usage: { nativeCalls: session.counters.native, jevCalls: session.counters.jev, reviewCalls: session.counters.review, sessionCalls: session.counters.session },
  diagnostics,
  persistence: { durable: session.features?.store.recoveryDurable ?? false,
    ...(session.features === undefined ? {} : { stateBytes: session.features.store.getStateBytes(), stateLimitBytes: session.features.store.maxStateBytes,
      contextBytes: session.features.contexts.getTotalEncodedBytes() }),
    recovery: '已审计状态可恢复；不自动恢复旧 live thread' }
})

/**
 * 未知任务的统一诊断。
 * 只给「未知任务：T-1」时，无法判断是 ID 拼错、DSH 重启后内存态任务丢失，还是切了会话；
 * 这里补上当前会话已知任务与任务卡的隔离语义，让调用方一步定位而不是继续猜。
 */
export const describeUnknownTask = (session: StatusSessionInfo, taskId: string): string => {
  const known = session.store.getTasks().map((task) => task.taskId)
  const shown = known.slice(0, 5)
  const listing = known.length === 0
    ? '当前会话还没有任务卡'
    : `当前会话的任务：${shown.join('、')}${known.length > shown.length ? `…（共 ${known.length} 个）` : ''}`
  return `未知任务：${taskId}。${listing}。任务卡按根会话与工作区隔离：DSH 重启或切换会话后需要用 swarm_task_card 重新创建；swarm_status 可以列出当前会话的全部任务。`
}
