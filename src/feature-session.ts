import { join } from 'node:path'
import type { SwarmConfigInfo } from './config.js'
import type { DelegationRecord, TaskRecord, TaskStore } from './evidence.js'
import type { ThreadInfo, ThreadRegistry } from './threads.js'
import { createDurableStateStore, StateStoreError, type DurableStateStore } from './state-store.js'
import { createAgentBindingRegistry, validateBinding, bindingKey, type AgentBindingRegistry } from './agent-binding.js'
import { createMessageBus, type MessageBus, type MessageState } from './message-bus.js'
import { createExperienceRepository, ExperienceError, type ExperienceEntry, type ExperienceReview, type ExperienceState } from './experience.js'
import { createExecutionBudget, ExecutionBudgetError, type ExecutionBudget, type ExecutionBudgetSnapshot } from './execution-budget.js'
import { intContextStore, type ContextArtifactInfo, type ContextStore } from './context-store.js'
import { getArtifactSnapshot, getWorkspaceId } from './artifacts.js'
import { digest, getCurrentDelegations } from './task-model.js'
import { getCanonicalJson, getValueDigest, getWorkflowDigest, ValidateWorkflow } from './workflow.js'
import { GATE_IDS, GATE_ROLE, ValidateTaskCard, getAcceptanceCheck, getEffectiveGates } from './policy.js'
import { ValidateStructuredOutput } from './contracts.js'
import { isDelegableRoleId } from './role-registry.js'
import { createWorkspaceLeaseManager } from './util/workspace-lease.js'
import type { RouteHealthEntry } from './route-health.js'

interface FeatureState extends MessageState, ExperienceState {
  schemaVersion: 1
  tasks: TaskRecord[]
  delegations: DelegationRecord[]
  threads: ThreadInfo[]
  budgets: Record<string, ExecutionBudgetSnapshot>
  contexts: ContextArtifactInfo[]
  routeHealth?: RouteHealthEntry[]
}

export interface FeatureSession {
  workspaceId: string
  store: DurableStateStore<FeatureState>
  bindings: AgentBindingRegistry
  bus?: MessageBus
  contexts: ContextStore
  experiences: ReturnType<typeof createExperienceRepository<FeatureState>>
  budgetFor: (task: TaskRecord) => ExecutionBudget
  /** Existing attempts and exempt Jev observations keep their original accounting handle during hot changes. */
  finishBudgetFor: (task: TaskRecord) => ExecutionBudget
  persist: (type: string, tasks: TaskStore, threads: ThreadRegistry, routeHealth?: RouteHealthEntry[]) => Promise<void>
  addContext: (input: Parameters<ContextStore['Add']>[0]) => ContextArtifactInfo
  /** Trusted lifecycle API: all author/reviewer/verification facts are derived from current runtime evidence. */
  promoteCandidateWithEvidence: (id: string) => Promise<ExperienceEntry>
  dispose: () => Promise<void>
}

const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
const identifier = (raw: unknown): raw is string => typeof raw === 'string' && raw.length > 0 && raw.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(raw)
const strings = (raw: unknown): raw is string[] => Array.isArray(raw) && raw.every((value) => typeof value === 'string')
const positive = (raw: unknown) => Number.isSafeInteger(raw) && Number(raw) >= 1
const optionalRevision = (raw: unknown) => raw === undefined || positive(raw)
const hashPattern = /^[a-f0-9]{64}$/i
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only stable quarantine facts are durable. A process-local half-open claimant is never resumed. */
export const validatePersistedRouteHealth = (raw: unknown): raw is RouteHealthEntry[] => {
  if (!Array.isArray(raw) || raw.length > 4096) return false
  const keys = new Set<string>()
  const healthKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && /^(?:route|domain|pool):.+$/.test(value) && !/[\u0000-\u001f]/.test(value)
  for (const entry of raw) {
    if (!object(entry) || Object.keys(entry).some((key) => !['key', 'aliases', 'kind', 'failedAt', 'resetAt', 'route'].includes(key)) || !healthKey(entry.key) || keys.has(entry.key) || (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.length > 4096 || entry.aliases.some((alias) => !healthKey(alias)) || new Set(entry.aliases).size !== entry.aliases.length)) || !['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'unknown'].includes(String(entry.kind)) || typeof entry.failedAt !== 'number' || !Number.isFinite(entry.failedAt) || entry.failedAt < 0 || (entry.resetAt !== undefined && (typeof entry.resetAt !== 'number' || !Number.isFinite(entry.resetAt) || entry.resetAt < 0)) || !object(entry.route) || !identifier(entry.route.provider) || !identifier(entry.route.model) || (entry.route.reasoningEffort !== undefined && !identifier(entry.route.reasoningEffort))) return false
    const policy = entry.route.policy
    if (policy !== undefined) {
      if (!object(policy) || (policy.accessMode !== undefined && !['subscription', 'metered_api', 'judgment_api', 'unknown'].includes(String(policy.accessMode))) || (policy.quotaScope !== undefined && !['account', 'plan', 'model', 'pool', 'unknown'].includes(String(policy.quotaScope))) || (policy.quotaDomainId !== undefined && !identifier(policy.quotaDomainId)) || (policy.poolId !== undefined && !identifier(policy.poolId)) || (policy.capabilities !== undefined && (!object(policy.capabilities) || Object.values(policy.capabilities).some((value) => typeof value !== 'boolean')))) return false
    }
    keys.add(entry.key)
  }
  return true
}

/** Verify complete runtime contracts before exposing or replaying any saved state. */
export const validateFeatureState = (raw: unknown, expected: { rootSessionId: string; workspaceId: string }): boolean => {
  try {
    if (!object(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.delegations) || !Array.isArray(raw.threads) || !Array.isArray(raw.contexts) || !['bindings', 'bindingHistory', 'messages', 'messageAcks', 'experiences', 'budgets'].every((key) => object(raw[key]))) return false
    const state = raw as unknown as FeatureState
    if (state.routeHealth !== undefined && !validatePersistedRouteHealth(state.routeHealth)) return false
    const tasks = new Map<string, TaskRecord>()
    for (const task of state.tasks) {
      if (!object(task) || !identifier(task.taskId) || tasks.has(task.taskId) || task.sessionId !== expected.rootSessionId || (task.workspaceId !== undefined && task.workspaceId !== expected.workspaceId) || ValidateTaskCard(task.card).card === undefined || !strings(task.delegationIds) || new Set(task.delegationIds).size !== task.delegationIds.length || !Number.isSafeInteger(task.rounds) || task.rounds < 0 || !Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt) || ![task.cardRevision, task.workflowRevision, task.requestRevision].every(optionalRevision) || (task.intentLastDigest !== undefined && !/^[a-f0-9]{64}$/.test(task.intentLastDigest))) return false
      if (!Array.isArray(task.gates) || task.gates.some((gate) => !object(gate) || !GATE_IDS.includes(gate.gate) || GATE_ROLE[gate.gate].role !== gate.role || GATE_ROLE[gate.gate].mode !== gate.mode || !['rule', 'jev', 'jev-fallback'].includes(gate.source) || typeof gate.reason !== 'string')) return false
      if (!object(task.triage) || !['rules', 'rules+jev', 'rules+jev-fallback'].includes(task.triage.source) || !strings(task.triage.rulesApplied)) return false
      if (task.acceptance !== undefined) {
        const a = task.acceptance
        if (!object(a) || !['accept', 'reject', 'incomplete'].includes(a.decision) || !['accepted', 'blocked', 'recorded'].includes(a.status) || !strings(a.missing) || !strings(a.unresolved) || typeof a.summary !== 'string' || typeof a.stopReason !== 'string' || !Number.isFinite(a.at) || !Array.isArray(a.resolutions) || a.resolutions.some((r) => !object(r) || !identifier(r.delegationId) || !Number.isSafeInteger(r.index) || r.index < 0 || typeof r.resolution !== 'string')) return false
      }
      if (task.workflowDefinition !== undefined) {
        if (ValidateWorkflow(task.workflowDefinition, task.card, task.gates).definition === undefined || task.workflowDigest !== getWorkflowDigest(task.workflowDefinition) || !object(task.workflowState) || !object(task.workflowState.nodes)) return false
        const nodeIds = new Set(task.workflowDefinition.nodes.map((node) => node.id))
        if (Object.keys(task.workflowState.nodes).length !== nodeIds.size || Object.entries(task.workflowState.nodes).some(([id, node]) => !nodeIds.has(id) || !object(node) || !['pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'skipped'].includes(node.status) || (node.attemptId !== undefined && !identifier(node.attemptId)) || (node.evidenceRefs !== undefined && !strings(node.evidenceRefs)))) return false
      } else if (task.workflowState !== undefined || task.workflowDigest !== undefined) return false
      if (task.contextRefs !== undefined && (!Array.isArray(task.contextRefs) || task.contextRefs.some((ref) => !object(ref) || !identifier(ref.ref) || !hashPattern.test(ref.digest) || !['L0', 'L1', 'L2'].includes(ref.layer) || !['contract', 'source', 'evidence', 'history', 'experience', 'author-reasoning'].includes(ref.kind)))) return false
      if (task.requestIds !== undefined && (!object(task.requestIds) || Object.entries(task.requestIds).some(([key, value]) => !identifier(key) || !identifier(value)))) return false
      if (task.artifactSnapshot !== undefined) {
        const artifact = task.artifactSnapshot
        if (!object(artifact) || artifact.workspaceId !== expected.workspaceId || !Array.isArray(artifact.entries) || typeof artifact.complete !== 'boolean' || artifact.entries.some((entry) => !object(entry) || typeof entry.path !== 'string' || !['file', 'missing', 'unknown'].includes(entry.state) || (entry.state === 'file' && (!hashPattern.test(entry.digest ?? '') || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0))) || artifact.digest !== getValueDigest({ workspaceId: artifact.workspaceId, entries: artifact.entries }) || (artifact.complete && artifact.entries.some((entry) => entry.state === 'unknown'))) return false
      }
      tasks.set(task.taskId, task)
    }
    const records = new Map<string, DelegationRecord>()
    for (const record of state.delegations) {
      if (!object(record) || !identifier(record.delegationId) || records.has(record.delegationId) || !tasks.has(record.taskId) || !isDelegableRoleId(record.role) || !['queued', 'running', 'completed', 'failed', 'blocked'].includes(record.status) || typeof record.summary !== 'string' || !strings(record.unresolved) || !Array.isArray(record.evidence) || record.evidence.some((e) => !object(e) || !['command', 'step', 'finding', 'source', 'observation', 'claim', 'file-change'].includes(e.kind) || typeof e.ref !== 'string') || ![record.cardRevision, record.workflowRevision, record.requestRevision].every(optionalRevision) || !Number.isFinite(record.startedAt)) return false
      if (record.status === 'completed' && ValidateStructuredOutput(record.role, record.structured, record.mode).length > 0) return false
      records.set(record.delegationId, record)
    }
    for (const task of state.tasks) if (task.delegationIds.some((id) => records.get(id)?.taskId !== task.taskId) || [...records.values()].some((record) => record.taskId === task.taskId && !task.delegationIds.includes(record.delegationId))) return false
    const threadIds = new Set<string>()
    for (const thread of state.threads) {
      if (!object(thread) || !identifier(thread.threadId) || threadIds.has(thread.threadId) || !isDelegableRoleId(thread.role) || typeof thread.busy !== 'boolean' || typeof thread.closed !== 'boolean' || typeof thread.allowWeb !== 'boolean' || !strings(thread.taskIds) || thread.taskIds.some((id) => !tasks.has(id)) || !Number.isSafeInteger(thread.rounds) || thread.rounds < 0 || !Array.isArray(thread.history) || thread.history.some((entry) => !object(entry) || !identifier(entry.delegationId) || !tasks.has(entry.taskId) || typeof entry.request !== 'string' || typeof entry.summary !== 'string' || typeof entry.status !== 'string')) return false
      threadIds.add(thread.threadId)
    }
    for (const [key, binding] of Object.entries(state.bindings)) if (!validateBinding(binding) || !isDelegableRoleId(binding.role) || key !== binding.agentId || binding.rootSessionId !== expected.rootSessionId || binding.workspaceId !== expected.workspaceId || !tasks.has(binding.taskId)) return false
    for (const [key, binding] of Object.entries(state.bindingHistory)) if (!validateBinding(binding) || !isDelegableRoleId(binding.role) || key !== bindingKey(binding) || binding.rootSessionId !== expected.rootSessionId || binding.workspaceId !== expected.workspaceId || !tasks.has(binding.taskId)) return false
    const restoredContexts = intContextStore()
    const material = new Map<string, ContextArtifactInfo>()
    for (const context of state.contexts) {
      const restored = restoredContexts.Restore(context)
      if (material.has(restored.ref) || restored.binding.rootSessionId !== expected.rootSessionId || restored.binding.workspaceId !== expected.workspaceId || !tasks.has(restored.binding.taskId)) return false
      const task = tasks.get(restored.binding.taskId)!
      if (restored.binding.cardRevision > (task.cardRevision ?? 1) || restored.binding.workflowRevision > (task.workflowRevision ?? 1) || (restored.binding.requestRevision ?? 1) > (task.requestRevision ?? 1)) return false
      material.set(restored.ref, restored)
    }
    for (const task of state.tasks) for (const reference of task.contextRefs ?? []) {
      const context = material.get(reference.ref)
      if (context === undefined || context.binding.taskId !== task.taskId || context.digest !== reference.digest || context.layer !== reference.layer || context.kind !== reference.kind) return false
    }
    for (const [taskId, budget] of Object.entries(state.budgets)) { if (!tasks.has(taskId)) return false; createExecutionBudget(budget.limits, budget) }
    for (const [id, message] of Object.entries(state.messages)) {
      if (!object(message) || id !== message.id || !uuidPattern.test(id) || message.schemaVersion !== 1 || message.rootSessionId !== expected.rootSessionId || message.workspaceId !== expected.workspaceId || !tasks.has(message.taskId) || !['question', 'answer', 'finding', 'review-response'].includes(message.kind) || typeof message.summary !== 'string' || !strings(message.artifactRefs) || ![message.cardRevision, message.workflowRevision, message.senderGeneration, message.senderLeaseEpoch, message.recipientGeneration, message.recipientLeaseEpoch].every(positive) || !optionalRevision(message.requestRevision) || !Number.isFinite(message.createdAt) || !Number.isFinite(message.expiresAt) || message.expiresAt <= message.createdAt) return false
      const { payloadDigest, ...payload } = message
      if (payloadDigest !== getValueDigest(payload)) return false
      const sender = state.bindingHistory[message.fromAgentId + ':' + message.senderGeneration + ':' + message.senderLeaseEpoch]
      const recipient = state.bindingHistory[message.toAgentId + ':' + message.recipientGeneration + ':' + message.recipientLeaseEpoch]
      if (sender === undefined || recipient === undefined || sender.taskId !== message.taskId || recipient.taskId !== message.taskId || sender.attemptId !== message.senderAttemptId || sender.threadId !== message.fromThreadId || recipient.threadId !== message.toThreadId || (message.requestRevision ?? 1) !== (sender.requestRevision ?? 1) || (message.requestRevision ?? 1) !== (recipient.requestRevision ?? 1)) return false
    }
    for (const [recipient, acks] of Object.entries(state.messageAcks)) {
      if (!object(acks) || state.bindingHistory[recipient] === undefined) return false
      for (const [id, ack] of Object.entries(acks)) if (!object(ack) || ack.messageId !== id || ack.recipientBinding !== recipient || !Number.isFinite(ack.acknowledgedAt) || state.messages[id] === undefined || recipient !== state.messages[id]!.toAgentId + ':' + state.messages[id]!.recipientGeneration + ':' + state.messages[id]!.recipientLeaseEpoch) return false
    }
    for (const [id, entry] of Object.entries(state.experiences)) {
      if (!object(entry) || entry.id !== id || !uuidPattern.test(id) || !['candidate', 'validated', 'deprecated'].includes(entry.status) || !object(entry.source) || !tasks.has(entry.source.taskId) || !positive(entry.source.cardRevision) || !positive(entry.source.workflowRevision) || !hashPattern.test(entry.source.artifactDigest) || typeof entry.problemClass !== 'string' || typeof entry.conclusion !== 'string' || !['appliesWhen', 'doesNotApplyWhen', 'verification', 'counterexamples', 'operatorVersions'].every((key) => strings(entry[key as keyof ExperienceEntry])) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= entry.createdAt || (entry.status === 'validated' && (!identifier(entry.reviewer) || !hashPattern.test(entry.reviewArtifactDigest ?? ''))) || (entry.status === 'deprecated' && typeof entry.deprecationReason !== 'string')) return false
    }
    return true
  } catch { return false }
}

const recover = (state: FeatureState): FeatureState => {
  const copy = structuredClone(state)
  for (const task of copy.tasks) {
    task.recovered = true
    for (const node of Object.values(task.workflowState?.nodes ?? {})) {
      if (node.status === 'running') { node.status = 'blocked'; node.reason = '重启恢复：运行状态未知，需核对已产生的副作用' }
    }
  }
  for (const record of copy.delegations) if (record.status === 'running' || record.status === 'queued') {
    record.status = 'failed'; record.error = 'recovery_required'; record.staleReason = '重启时委派尚未确认结束'
  }
  for (const thread of copy.threads) { thread.busy = false; thread.closed = true }
  for (const binding of Object.values(copy.bindings)) if (binding.state === 'active') binding.state = 'suspended'
  for (const entry of copy.routeHealth ?? []) delete entry.halfOpenAgent
  return copy
}

export const createFeatureSession = async (input: {
  rootSessionId: string; cwd: string; dshHome: string; config: SwarmConfigInfo;
  getConfig?: () => SwarmConfigInfo;
  tasks: TaskStore; threads: ThreadRegistry; now: () => number
}): Promise<FeatureSession> => {
  const workspaceId = await getWorkspaceId(input.cwd)
  const directory = join(input.config.persistence.directory || join(input.dshHome, 'share', 'dsh-agent-swarm', 'state'), workspaceId, digest(input.rootSessionId))
  const initialState: FeatureState = { schemaVersion: 1, tasks: [], delegations: [], threads: [], budgets: {},
    bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {}, contexts: [] }
  const store = await createDurableStateStore({ directory, initialState, enabled: input.config.persistence.enabled,
    validate: (raw) => validateFeatureState(raw, { rootSessionId: input.rootSessionId, workspaceId }), recover })
  const saved = store.read()
  if (input.tasks.getTasks().length === 0) {
    for (const task of saved.tasks) input.tasks.AddTask({ ...task, delegationIds: [] })
    for (const record of saved.delegations) input.tasks.AddDelegation(record)
    for (const thread of saved.threads) input.threads.Add(thread)
  }
  const contexts = intContextStore()
  const contextArtifacts = [...saved.contexts]
  for (const artifact of saved.contexts) contexts.Restore(artifact, artifact.binding)
  const bindings = createAgentBindingRegistry(store)
  const bus = !input.config.messageBus.enabled ? undefined : createMessageBus({ store, bindings, now: input.now, maxPendingPerTask: input.config.messageBus.maxPending,
    validateArtifactRef: (ref, binding) => {
      try { contexts.Read(binding, ref, { limit: 1 }); return true } catch { return false }
    } })
  const budgets = new Map<string, ExecutionBudget>()
  const budgetFor = (task: TaskRecord): ExecutionBudget => {
    const existing = budgets.get(task.taskId)
    const config = input.getConfig?.() ?? input.config
    const bounded = config.execution.profile === 'bounded'
    const mode = task.workflowDefinition?.mode ?? 'standard'
    const limits = {
      maxDelegations: config.execution.maxCalls || (bounded ? ({ quick: 6, standard: 16, algorithm: 20 })[mode] : 0),
      maxMathCalls: config.math.maxCallsPerTask, maxMathWorkUnits: 1_000_000,
      maxTokens: config.execution.maxTokens, maxCostUsd: config.execution.maxCostUsd
    }
    const snapshot = existing?.getSnapshot() ?? saved.budgets[task.taskId]
    if (existing !== undefined) {
      if (getCanonicalJson(snapshot?.limits) === getCanonicalJson(limits)) return existing
      if (snapshot?.reservations.some((record) => ['delegate', 'model', 'native'].includes(record.source) && ['reserved', 'started'].includes(record.state))) throw new ExecutionBudgetError('BUDGET_TRANSITION', 'Execution limits changed while generation is reserved/running; finish or cancel the existing attempt before applying new limits')
    }
    const budget = createExecutionBudget(limits, snapshot)
    budgets.set(task.taskId, budget)
    return budget
  }
  const deriveExperienceReview = async (entry: ExperienceEntry): Promise<ExperienceReview | undefined> => {
    const task = input.tasks.getTask(entry.source.taskId)
    if (task === undefined || task.sessionId !== input.rootSessionId || task.acceptance?.status !== 'accepted' || task.acceptance.decision !== 'accept' || task.acceptance.unresolved.length > 0 || (task.cardRevision ?? 1) !== entry.source.cardRevision || (task.workflowRevision ?? 1) !== entry.source.workflowRevision) return undefined
    const committed = store.read().tasks.find((savedTask) => savedTask.taskId === task.taskId)
    if (committed?.acceptance?.status !== 'accepted' || committed.acceptance.at !== task.acceptance.at || (committed.cardRevision ?? 1) !== (task.cardRevision ?? 1) || (committed.workflowRevision ?? 1) !== (task.workflowRevision ?? 1) || (committed.requestRevision ?? 1) !== (task.requestRevision ?? 1)) return undefined
    // Source review validates this recorded result in its original contract, never an arbitrary new generalization.
    if (entry.conclusion !== task.acceptance.summary || getCanonicalJson(entry.appliesWhen) !== getCanonicalJson(task.card.acceptance) || getCanonicalJson(entry.doesNotApplyWhen) !== getCanonicalJson(task.acceptance.unresolved)) return undefined
    const all = input.tasks.getTaskDelegations(task.taskId)
    if (all.some((record) => record.status === 'running' || record.status === 'queued')) return undefined
    const artifact = await getArtifactSnapshot(input.cwd, [...new Set([...task.card.scope, ...all.flatMap((record) => record.changedFiles ?? [])])])
    if (!artifact.complete || artifact.digest !== entry.source.artifactDigest) return undefined
    const current = getCurrentDelegations(task, all, artifact.digest).filter((record) => record.status === 'completed')
    if (!getAcceptanceCheck(getEffectiveGates(task.gates, current), current, task.acceptance.resolutions, 0, task.card.perf).ok) return undefined
    const verification = current.filter((record) => record.role === 'fu_he' && record.hardIsolation && record.artifactAfter === artifact.digest && ValidateStructuredOutput('fu_he', record.structured).length === 0 && (record.structured as { verdict?: string }).verdict === 'pass' && record.unresolved.length === 0).at(-1)
    const reviewer = current.filter((record) => record.role === 'yu_shi' && record.hardIsolation && record.independence !== 'not-achieved' && record.artifactAfter === artifact.digest && identifier(record.childId) && ValidateStructuredOutput('yu_shi', record.structured).length === 0 && record.unresolved.length === 0).at(-1)
    if (verification === undefined || reviewer === undefined) return undefined
    const findings = (reviewer.structured as { findings: Array<{ severity: string }> }).findings
    const unresolvedSevere = findings.filter((finding) => ['critical', 'high'].includes(finding.severity)).length
    if (unresolvedSevere > 0) return undefined
    const authors = current.filter((record) => record.role !== 'yu_shi' && record.role !== 'fu_he' && !(record.role === 'suan_heng' && record.mode === 'verify'))
    const selectedAuthor = authors.filter((record) => ['ji_feng', 'zhu_jian', 'xing_zhou'].includes(record.role) || (record.role === 'suan_heng' && record.mode === 'research')).at(-1) ?? authors.at(-1)
    const author = selectedAuthor?.childId ?? selectedAuthor?.delegationId ?? task.sessionId
    if (entry.source.authorId !== undefined && entry.source.authorId !== author) return undefined
    if (reviewer.childId === author || reviewer.childId === verification.childId || reviewer.delegationId === selectedAuthor?.delegationId) return undefined
    const latest = input.tasks.getTask(task.taskId)
    if (latest?.acceptance?.status !== 'accepted' || latest.acceptance.at !== task.acceptance.at || (latest.cardRevision ?? 1) !== (task.cardRevision ?? 1) || (latest.workflowRevision ?? 1) !== (task.workflowRevision ?? 1) || (latest.requestRevision ?? 1) !== (task.requestRevision ?? 1)) return undefined
    const reviewArtifactDigest = getValueDigest({
      taskId: task.taskId, cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1, requestRevision: task.requestRevision ?? 1,
      sourceArtifactDigest: artifact.digest, author,
      reviewer: { id: reviewer.delegationId, childId: reviewer.childId, structured: reviewer.structured, artifactDigest: reviewer.artifactAfter },
      verification: { id: verification.delegationId, childId: verification.childId, structured: verification.structured, artifactDigest: verification.artifactAfter }
    })
    return { author, reviewer: reviewer.childId!, reviewArtifactDigest, sourceArtifactDigest: artifact.digest, evidenceComplete: true, unresolvedSevere, applicabilityConfirmed: true }
  }
  const promotionLeases = createWorkspaceLeaseManager()
  const activePromotions = new Set<string>()
  const experiences = createExperienceRepository(store, {
    now: input.now,
    verifyReview: async (entry, supplied) => {
      if (!activePromotions.has(entry.id)) return false
      const actual = await deriveExperienceReview(entry)
      return actual !== undefined && getCanonicalJson(actual) === getCanonicalJson(supplied)
    }
  })
  return {
    workspaceId, store, bindings, bus, contexts, budgetFor,
    finishBudgetFor: (task) => budgets.get(task.taskId) ?? budgetFor(task),
    experiences,
    promoteCandidateWithEvidence: async (id) => {
      const lease = await promotionLeases.acquire(input.cwd, 'experience:' + input.rootSessionId + ':' + id, 'verify')
      try {
        const entry = store.read().experiences[id]
        if (entry === undefined) throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown experience candidate')
        const review = await deriveExperienceReview(entry)
        if (review === undefined) throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Candidate needs current accepted source, actual independent reviewer and passing verification evidence')
        activePromotions.add(id)
        return await experiences.promote(id, review)
      } finally { activePromotions.delete(id); await lease.release({ confirmedStopped: true }) }
    },
    addContext: (material) => {
      const task = input.tasks.getTask(material.binding.taskId)
      const artifact = contexts.Add({ ...material, binding: { ...material.binding, requestRevision: material.binding.requestRevision ?? task?.requestRevision ?? 1 } })
      if (!contextArtifacts.some((entry) => entry.ref === artifact.ref)) contextArtifacts.push(artifact)
      return artifact
    },
    persist: async (type, tasks, threads, routeHealth) => {
      const taskSnapshot = tasks.getTasks()
      const delegationSnapshot = taskSnapshot.flatMap((task) => tasks.getTaskDelegations(task.taskId))
      const stableHealth = routeHealth?.map(({ halfOpenAgent: _claimant, ...entry }) => entry)
      if (stableHealth !== undefined && !validatePersistedRouteHealth(stableHealth)) throw new StateStoreError('STATE_INVALID', 'Invalid durable route health snapshot')
      const healthSnapshot = stableHealth === undefined ? undefined : JSON.parse(getCanonicalJson(stableHealth)) as RouteHealthEntry[]
      await store.commit(type, (draft) => {
        draft.tasks = JSON.parse(getCanonicalJson(taskSnapshot)) as TaskRecord[]
        draft.delegations = JSON.parse(getCanonicalJson(delegationSnapshot)) as DelegationRecord[]
        draft.threads = JSON.parse(getCanonicalJson(threads.list())) as ThreadInfo[]
        draft.contexts = JSON.parse(getCanonicalJson(contextArtifacts)) as ContextArtifactInfo[]
        draft.budgets = Object.fromEntries([...budgets].map(([key, value]) => [key, value.getSnapshot()]))
        if (healthSnapshot !== undefined) draft.routeHealth = healthSnapshot
      })
    },
    dispose: () => store.dispose()
  }
}
