import { join } from 'node:path'
import type { SwarmConfigInfo } from './config.js'
import type { DelegationRecord, TaskRecord, TaskStore } from './evidence.js'
import type { ThreadInfo, ThreadRegistry } from './threads.js'
import { createDurableStateStore, StateStoreError, type DurableStateStore, type StateValidationReport } from './state-store.js'
import { createAgentBindingRegistry, validateBinding, bindingKey, type AgentBindingRegistry } from './agent-binding.js'
import { createMessageBus, type MessageBus, type MessageState } from './message-bus.js'
import { createExperienceRepository, ExperienceError, type ExperienceEntry, type ExperienceReview, type ExperienceState } from './experience.js'
import { createExecutionBudget, ExecutionBudgetError, type ExecutionBudget, type ExecutionBudgetSnapshot } from './execution-budget.js'
import { intContextStore, type ContextArtifactInfo, type ContextStore, type PreparedTaskContextReplacement } from './context-store.js'
import { getArtifactSnapshot, getWorkspaceId } from './artifacts.js'
import { digest, getCurrentDelegations } from './task-model.js'
import { getCanonicalJson, getValueDigest, getWorkflowDigest, ValidateWorkflow } from './workflow.js'
import { GATE_IDS, GATE_ROLE, ValidateTaskCard, getAcceptanceCheck, getEffectiveGates } from './policy.js'
import { ValidateStructuredOutput } from './contracts.js'
import { isDelegableRoleId } from './role-registry.js'
import { createWorkspaceLeaseManager } from './util/workspace-lease.js'
import { validateRouteHealthSnapshot, type RouteHealthEntry, type RouteHealthSnapshot } from './route-health.js'
import { partitionLegacyPlanningBudget } from './planning-recovery.js'
import { validateAgentControlRecords, type AgentControlRecord } from './agent-control.js'
import { validateEvidenceAssessment } from './evidence-assessment.js'
import { ValidateDelegateInput } from './delegate.js'
import { loadMemoryHandoff } from './memory-handoff.js'

export interface FeatureRuntimeSnapshot {
  rootEditAt: number
  taskSequence: number
  counters: { native: number; jev: number; review: number; session: number }
  rootUpgradeExplicit: string[]
}

interface FeatureState extends MessageState, ExperienceState {
  runtime?: FeatureRuntimeSnapshot
  schemaVersion: 1
  tasks: TaskRecord[]
  delegations: DelegationRecord[]
  threads: ThreadInfo[]
  budgets: Record<string, ExecutionBudgetSnapshot>
  planningBudgets?: Record<string, ExecutionBudgetSnapshot>
  agentControls?: AgentControlRecord[]
  contexts: ContextArtifactInfo[]
  routeHealth?: RouteHealthEntry[] | RouteHealthSnapshot
}

export interface FeatureSession {
  workspaceId: string
  store: DurableStateStore<FeatureState>
  bindings: AgentBindingRegistry
  bus?: MessageBus
  contexts: ContextStore
  experiences: ReturnType<typeof createExperienceRepository<FeatureState>>
  budgetFor: (task: TaskRecord) => ExecutionBudget
  planningBudgetFor: (task: TaskRecord) => ExecutionBudget
  getRestoredAgentControls: () => AgentControlRecord[]
  getRestoredRuntime: () => FeatureRuntimeSnapshot | undefined
  commitRecovery: () => Promise<void>
  /** Existing attempts and exempt Jev observations keep their original accounting handle during hot changes. */
  finishBudgetFor: (task: TaskRecord) => ExecutionBudget
  persist: (type: string, tasks: TaskStore, threads: ThreadRegistry, routeHealth?: RouteHealthEntry[] | RouteHealthSnapshot) => Promise<void>
  addContext: (input: Parameters<ContextStore['Add']>[0]) => ContextArtifactInfo
  prepareTaskContexts: (...args: Parameters<ContextStore['PrepareTaskReplace']>) => PreparedTaskContextReplacement
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
export const validatePersistedRouteHealth = validateRouteHealthSnapshot

/** Verify complete runtime contracts before exposing or replaying any saved state. */
export const inspectFeatureState = (raw: unknown, expected: { rootSessionId: string; workspaceId: string }): StateValidationReport => {
  let path = '$', code = 'STATE_FORMAT'
  const at = (nextPath: string, nextCode: string) => { path = nextPath; code = nextCode }
  const invalid = (): StateValidationReport => ({ ok: false, issues: [{ path, code }] })
  try {
    if (!object(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.delegations) || !Array.isArray(raw.threads) || !Array.isArray(raw.contexts) || !['bindings', 'bindingHistory', 'messages', 'messageAcks', 'experiences', 'budgets'].every((key) => object(raw[key]))) return invalid()
    const state = raw as unknown as FeatureState
    at('$.runtime', 'RUNTIME_FORMAT')
    if (state.runtime !== undefined) {
      const runtime = state.runtime
      if (!object(runtime) || Object.keys(runtime).some((key) => !['rootEditAt', 'taskSequence', 'counters', 'rootUpgradeExplicit'].includes(key))
        || !Number.isFinite(runtime.rootEditAt) || runtime.rootEditAt < 0 || !Number.isSafeInteger(runtime.taskSequence) || runtime.taskSequence < 0
        || !object(runtime.counters) || Object.keys(runtime.counters).length !== 4 || !['native', 'jev', 'review', 'session'].every((key) => Number.isSafeInteger(runtime.counters[key as keyof typeof runtime.counters]) && runtime.counters[key as keyof typeof runtime.counters] >= 0)
        || !strings(runtime.rootUpgradeExplicit) || runtime.rootUpgradeExplicit.some((id) => !identifier(id)) || new Set(runtime.rootUpgradeExplicit).size !== runtime.rootUpgradeExplicit.length) return invalid()
    }
    at('$.agentControls', 'CONTROL_FORMAT')
    if (state.agentControls !== undefined && !validateAgentControlRecords(state.agentControls)) return invalid()
    at('$.routeHealth', 'ROUTE_HEALTH_FORMAT')
    if (state.routeHealth !== undefined && !validatePersistedRouteHealth(state.routeHealth)) return invalid()
    const tasks = new Map<string, TaskRecord>()
    for (const [index, task] of state.tasks.entries()) {
      at(`$.tasks[${index}]`, 'TASK_FORMAT')
      if (!object(task) || !identifier(task.taskId) || tasks.has(task.taskId) || task.sessionId !== expected.rootSessionId || (task.workspaceId !== undefined && task.workspaceId !== expected.workspaceId) || ValidateTaskCard(task.card).card === undefined || !strings(task.delegationIds) || new Set(task.delegationIds).size !== task.delegationIds.length || !Number.isSafeInteger(task.rounds) || task.rounds < 0 || !Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt) || ![task.cardRevision, task.workflowRevision, task.requestRevision].every(optionalRevision) || (task.intentLastDigest !== undefined && !/^[a-f0-9]{64}$/.test(task.intentLastDigest))) return invalid()
      at(`$.tasks[${index}].gates`, 'GATE_FORMAT')
      if (!Array.isArray(task.gates) || task.gates.some((gate) => !object(gate) || !GATE_IDS.includes(gate.gate) || GATE_ROLE[gate.gate].role !== gate.role || GATE_ROLE[gate.gate].mode !== gate.mode || !['rule', 'jev', 'jev-fallback'].includes(gate.source) || typeof gate.reason !== 'string')) return invalid()
      at(`$.tasks[${index}].triage`, 'TRIAGE_FORMAT')
      if (!object(task.triage) || !['rules', 'rules+jev', 'rules+jev-fallback'].includes(task.triage.source) || !strings(task.triage.rulesApplied)) return invalid()
      at(`$.tasks[${index}].acceptance`, 'ACCEPTANCE_FORMAT')
      if (task.acceptance !== undefined) {
        const a = task.acceptance
        if (!object(a) || !['accept', 'reject', 'incomplete'].includes(a.decision) || !['accepted', 'blocked', 'recorded'].includes(a.status) || !strings(a.missing) || !strings(a.unresolved) || typeof a.summary !== 'string' || typeof a.stopReason !== 'string' || !Number.isFinite(a.at) || !Array.isArray(a.resolutions) || a.resolutions.some((r) => !object(r) || !identifier(r.delegationId) || !Number.isSafeInteger(r.index) || r.index < 0 || typeof r.resolution !== 'string')) return invalid()
      }
      at(`$.tasks[${index}].workflowDefinition`, 'WORKFLOW_CONTRACT')
      if (task.workflowDefinition !== undefined) {
        if (ValidateWorkflow(task.workflowDefinition, task.card, task.gates).definition === undefined || task.workflowDigest !== getWorkflowDigest(task.workflowDefinition) || !object(task.workflowState) || !object(task.workflowState.nodes)) return invalid()
        const nodeIds = new Set(task.workflowDefinition.nodes.map((node) => node.id))
        if (Object.keys(task.workflowState.nodes).length !== nodeIds.size || Object.entries(task.workflowState.nodes).some(([id, node]) => !nodeIds.has(id) || !object(node) || !['pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'skipped'].includes(node.status) || (node.attemptId !== undefined && !identifier(node.attemptId)) || (node.evidenceRefs !== undefined && !strings(node.evidenceRefs)))) return invalid()
      } else if (task.workflowState !== undefined || task.workflowDigest !== undefined) return invalid()
      at(`$.tasks[${index}].contextRefs`, 'CONTEXT_REFERENCE_FORMAT')
      if (task.contextRefs !== undefined && (!Array.isArray(task.contextRefs) || task.contextRefs.some((ref) => !object(ref) || !identifier(ref.ref) || !hashPattern.test(ref.digest) || !['L0', 'L1', 'L2'].includes(ref.layer) || !['contract', 'source', 'evidence', 'history', 'experience', 'author-reasoning'].includes(ref.kind)))) return invalid()
      at(`$.tasks[${index}].requestIds`, 'REQUEST_INDEX_FORMAT')
      if (task.requestIds !== undefined && (!object(task.requestIds) || Object.entries(task.requestIds).some(([key, value]) => !identifier(key) || !identifier(value)))) return invalid()
      at(`$.tasks[${index}].artifactSnapshot`, 'ARTIFACT_SNAPSHOT')
      if (task.artifactSnapshot !== undefined) {
        const artifact = task.artifactSnapshot
        if (!object(artifact) || artifact.workspaceId !== expected.workspaceId || !Array.isArray(artifact.entries) || typeof artifact.complete !== 'boolean' || artifact.entries.some((entry) => !object(entry) || typeof entry.path !== 'string' || !['file', 'missing', 'unknown'].includes(entry.state) || (entry.state === 'file' && (!hashPattern.test(entry.digest ?? '') || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0))) || artifact.digest !== getValueDigest({ workspaceId: artifact.workspaceId, entries: artifact.entries }) || (artifact.complete && artifact.entries.some((entry) => entry.state === 'unknown'))) return invalid()
      }
      at(`$.tasks[${index}].planningAutoReviewRuns`, 'PLANNING_COUNTER_FORMAT')
      if ([task.planningFixRounds, task.planningAutoReviewRuns].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) return invalid()
      tasks.set(task.taskId, task)
    }
    const recordIds = new Set<string>()
    const recordsById = new Map<string, DelegationRecord>()
    const recordIdsByTask = new Map<string, Set<string>>()
    for (const [index, record] of state.delegations.entries()) {
      at(`$.delegations[${index}]`, 'DELEGATION_FORMAT')
      if (!object(record) || !identifier(record.delegationId) || recordIds.has(record.delegationId) || !tasks.has(record.taskId) || !isDelegableRoleId(record.role) || !['queued', 'running', 'completed', 'failed', 'blocked'].includes(record.status) || (record.finalization !== undefined && !['processing', 'ready', 'cancelled', 'failed'].includes(record.finalization)) || typeof record.summary !== 'string' || !strings(record.unresolved) || !Array.isArray(record.evidence) || record.evidence.some((e) => !object(e) || !['command', 'step', 'finding', 'source', 'observation', 'claim', 'file-change'].includes(e.kind) || typeof e.ref !== 'string') || ![record.cardRevision, record.workflowRevision, record.requestRevision].every(optionalRevision) || !Number.isFinite(record.startedAt)) return invalid()
      at(`$.delegations[${index}].structured`, 'STRUCTURED_OUTPUT_FORMAT')
      if (record.status === 'completed' && ValidateStructuredOutput(record.role, record.structured, record.mode).length > 0) return invalid()
      at(`$.delegations[${index}].continuationInput`, 'CONTINUATION_BINDING')
      if (record.continuationInput !== undefined) {
        const parsed = ValidateDelegateInput(record.continuationInput).input
        if (parsed === undefined || parsed.task_id !== record.taskId || parsed.role !== record.role
          || (parsed.mode ?? (parsed.role === 'suan_heng' ? 'research' : undefined)) !== record.mode) return invalid()
      }
      at(`$.delegations[${index}].evidenceAssessment`, 'ASSESSMENT_FORMAT')
      if (record.evidenceAssessment !== undefined) {
        const assessment = record.evidenceAssessment
        if (!validateEvidenceAssessment(assessment)) return invalid()
        at(`$.delegations[${index}].evidenceAssessment`, 'ASSESSMENT_IDENTITY_BINDING')
        if (assessment.delegationId !== record.delegationId || assessment.role !== record.role
          || assessment.binding.rootSessionId !== expected.rootSessionId || assessment.binding.workspaceId !== expected.workspaceId
          || assessment.binding.taskId !== record.taskId) return invalid()
        at(`$.delegations[${index}].evidenceAssessment.rawDigest`, 'ASSESSMENT_RAW_DIGEST')
        if (assessment.rawDigest !== getValueDigest(record.structured ?? {})) return invalid()
        for (const key of ['cardRevision', 'workflowRevision', 'requestRevision'] as const) {
          at(`$.delegations[${index}].evidenceAssessment.binding.${key}`, 'ASSESSMENT_REVISION_MISMATCH')
          if ((assessment.binding[key] ?? 1) !== (record[key] ?? 1)) return invalid()
        }
        at(`$.delegations[${index}].evidenceAssessment.binding.artifactDigest`, 'ASSESSMENT_ARTIFACT_MISMATCH')
        if (assessment.binding.artifactDigest !== record.artifactAfter) return invalid()
      }
      recordIds.add(record.delegationId)
      recordsById.set(record.delegationId, record)
      const ids = recordIdsByTask.get(record.taskId) ?? new Set<string>()
      ids.add(record.delegationId)
      recordIdsByTask.set(record.taskId, ids)
    }
    for (const [index, task] of state.tasks.entries()) {
      at(`$.tasks[${index}].delegationIds`, 'DELEGATION_OWNERSHIP_INDEX')
      const owned = recordIdsByTask.get(task.taskId)
      if ((owned?.size ?? 0) !== task.delegationIds.length || task.delegationIds.some((id) => !owned?.has(id))) return invalid()
    }
    for (const [index, control] of (state.agentControls ?? []).entries()) {
      at(`$.agentControls[${index}]`, 'CONTROL_BINDING')
      const task = tasks.get(control.taskId)
      if (!control.persistent || control.parentSessionId !== expected.rootSessionId) return invalid()
      at(`$.agentControls[${index}].taskId`, 'CONTROL_TASK_MISSING')
      if (task === undefined) return invalid()
      at(`$.agentControls[${index}].delegationId`, 'CONTROL_DELEGATION_MISSING')
      if (!recordIds.has(control.delegationId)) return invalid()
      for (const key of ['cardRevision', 'workflowRevision', 'requestRevision'] as const) {
        at(`$.agentControls[${index}].${key}`, 'CONTROL_AHEAD_OF_TASK')
        if (!optionalRevision(control[key]) || (control[key] ?? 1) > (task[key] ?? 1)) return invalid()
      }
      at(`$.agentControls[${index}].delegationId`, 'CONTROL_DELEGATION_BINDING')
      const delegation = recordsById.get(control.delegationId)
      if (delegation?.taskId !== control.taskId) return invalid()
    }
    const threadIds = new Set<string>()
    for (const [index, thread] of state.threads.entries()) {
      at(`$.threads[${index}]`, 'THREAD_FORMAT')
      if (!object(thread) || !identifier(thread.threadId) || threadIds.has(thread.threadId) || !isDelegableRoleId(thread.role) || typeof thread.busy !== 'boolean' || typeof thread.closed !== 'boolean' || typeof thread.allowWeb !== 'boolean' || !strings(thread.taskIds) || thread.taskIds.some((id) => !tasks.has(id)) || !Number.isSafeInteger(thread.rounds) || thread.rounds < 0 || !Array.isArray(thread.history) || thread.history.some((entry) => !object(entry) || !identifier(entry.delegationId) || !tasks.has(entry.taskId) || typeof entry.request !== 'string' || typeof entry.summary !== 'string' || typeof entry.status !== 'string')) return invalid()
      threadIds.add(thread.threadId)
    }
    for (const [index, [key, binding]] of Object.entries(state.bindings).entries()) {
      at(`$.bindings[${index}]`, 'AGENT_BINDING')
      if (!validateBinding(binding) || !isDelegableRoleId(binding.role) || key !== binding.agentId || binding.rootSessionId !== expected.rootSessionId || binding.workspaceId !== expected.workspaceId || !tasks.has(binding.taskId)) return invalid()
    }
    for (const [index, [key, binding]] of Object.entries(state.bindingHistory).entries()) {
      at(`$.bindingHistory[${index}]`, 'AGENT_BINDING_HISTORY')
      if (!validateBinding(binding) || !isDelegableRoleId(binding.role) || key !== bindingKey(binding) || binding.rootSessionId !== expected.rootSessionId || binding.workspaceId !== expected.workspaceId || !tasks.has(binding.taskId)) return invalid()
    }
    const restoredContexts = intContextStore()
    const material = new Map<string, ContextArtifactInfo>()
    for (const [index, context] of state.contexts.entries()) {
      at(`$.contexts[${index}]`, 'CONTEXT_FORMAT')
      const restored = restoredContexts.Restore(context)
      at(`$.contexts[${index}].binding`, 'CONTEXT_OWNER_BINDING')
      if (material.has(restored.ref) || restored.binding.rootSessionId !== expected.rootSessionId || restored.binding.workspaceId !== expected.workspaceId || !tasks.has(restored.binding.taskId)) return invalid()
      const task = tasks.get(restored.binding.taskId)!
      for (const key of ['cardRevision', 'workflowRevision', 'requestRevision'] as const) {
        at(`$.contexts[${index}].binding.${key}`, 'CONTEXT_AHEAD_OF_TASK')
        if ((restored.binding[key] ?? 1) > (task[key] ?? 1)) return invalid()
      }
      material.set(restored.ref, restored)
    }
    for (const [index, task] of state.tasks.entries()) for (const [referenceIndex, reference] of (task.contextRefs ?? []).entries()) {
      at(`$.tasks[${index}].contextRefs[${referenceIndex}]`, 'CONTEXT_REFERENCE_MISSING')
      const context = material.get(reference.ref)
      if (context === undefined) return invalid()
      at(`$.tasks[${index}].contextRefs[${referenceIndex}]`, 'CONTEXT_REFERENCE_BINDING')
      if (context.binding.taskId !== task.taskId || context.digest !== reference.digest || context.layer !== reference.layer || context.kind !== reference.kind) return invalid()
    }
    for (const [index, task] of state.tasks.entries()) {
      at(`$.tasks[${index}].contextDelegations`, 'CONTEXT_MAPPING_FORMAT')
      if (task.contextDelegations !== undefined && !object(task.contextDelegations)) return invalid()
      const exposedRefs = new Set((task.contextRefs ?? []).map((reference) => reference.ref))
      for (const [mappingIndex, [ref, delegationId]] of Object.entries(task.contextDelegations ?? {}).entries()) {
        at(`$.tasks[${index}].contextDelegations[${mappingIndex}]`, 'CONTEXT_MAPPING_TARGET_MISSING')
        const context = material.get(ref), record = recordsById.get(delegationId)
        if (context === undefined || record === undefined || record.evidenceAssessment === undefined) return invalid()
        at(`$.tasks[${index}].contextDelegations[${mappingIndex}]`, 'CONTEXT_MAPPING_BINDING')
        if (context.binding.taskId !== task.taskId || record.taskId !== task.taskId) return invalid()
        if (context.layer !== 'L2' || context.kind !== 'author-reasoning' || !exposedRefs.has(ref)
          || context.binding.cardRevision !== (record.cardRevision ?? 1) || context.binding.workflowRevision !== (record.workflowRevision ?? 1)
          || (context.binding.requestRevision ?? 1) !== (record.requestRevision ?? 1)) return invalid()
        at(`$.tasks[${index}].contextDelegations[${mappingIndex}]`, 'CONTEXT_MAPPING_PAYLOAD')
        if (getCanonicalJson(JSON.parse(context.text)) !== getCanonicalJson({ summary: record.summary, structured: record.structured,
          evidence: record.evidence })) return invalid()
      }
    }
    at('$.planningBudgets', 'BUDGET_COLLECTION_FORMAT')
    if (state.planningBudgets !== undefined && !object(state.planningBudgets)) return invalid()
    for (const [collectionIndex, collection] of [state.budgets, state.planningBudgets ?? {}].entries()) for (const [index, [taskId, budget]] of Object.entries(collection).entries()) {
      at(`$.${collectionIndex === 0 ? 'budgets' : 'planningBudgets'}[${index}]`, 'BUDGET_FORMAT')
      if (!tasks.has(taskId)) return invalid()
      createExecutionBudget(budget.limits, budget)
    }
    for (const [index, [id, message]] of Object.entries(state.messages).entries()) {
      at(`$.messages[${index}]`, 'MESSAGE_FORMAT')
      if (!object(message) || id !== message.id || !uuidPattern.test(id) || message.schemaVersion !== 1 || message.rootSessionId !== expected.rootSessionId || message.workspaceId !== expected.workspaceId || !tasks.has(message.taskId) || !['question', 'answer', 'finding', 'review-response'].includes(message.kind) || typeof message.summary !== 'string' || !strings(message.artifactRefs) || ![message.cardRevision, message.workflowRevision, message.senderGeneration, message.senderLeaseEpoch, message.recipientGeneration, message.recipientLeaseEpoch].every(positive) || !optionalRevision(message.requestRevision) || !Number.isFinite(message.createdAt) || !Number.isFinite(message.expiresAt) || message.expiresAt <= message.createdAt) return invalid()
      at(`$.messages[${index}].payloadDigest`, 'MESSAGE_DIGEST')
      const { payloadDigest, ...payload } = message
      if (payloadDigest !== getValueDigest(payload)) return invalid()
      at(`$.messages[${index}]`, 'MESSAGE_BINDING')
      const sender = state.bindingHistory[message.fromAgentId + ':' + message.senderGeneration + ':' + message.senderLeaseEpoch]
      const recipient = state.bindingHistory[message.toAgentId + ':' + message.recipientGeneration + ':' + message.recipientLeaseEpoch]
      if (sender === undefined || recipient === undefined || sender.taskId !== message.taskId || recipient.taskId !== message.taskId || sender.attemptId !== message.senderAttemptId || sender.threadId !== message.fromThreadId || recipient.threadId !== message.toThreadId || (message.requestRevision ?? 1) !== (sender.requestRevision ?? 1) || (message.requestRevision ?? 1) !== (recipient.requestRevision ?? 1)) return invalid()
    }
    for (const [index, [recipient, acks]] of Object.entries(state.messageAcks).entries()) {
      at(`$.messageAcks[${index}]`, 'MESSAGE_ACK_BINDING')
      if (!object(acks) || state.bindingHistory[recipient] === undefined) return invalid()
      for (const [id, ack] of Object.entries(acks)) if (!object(ack) || ack.messageId !== id || ack.recipientBinding !== recipient || !Number.isFinite(ack.acknowledgedAt) || state.messages[id] === undefined || recipient !== state.messages[id]!.toAgentId + ':' + state.messages[id]!.recipientGeneration + ':' + state.messages[id]!.recipientLeaseEpoch) return invalid()
    }
    for (const [index, [id, entry]] of Object.entries(state.experiences).entries()) {
      at(`$.experiences[${index}]`, 'EXPERIENCE_FORMAT')
      if (!object(entry) || entry.id !== id || !uuidPattern.test(id) || !['candidate', 'validated', 'deprecated'].includes(entry.status) || !object(entry.source) || !tasks.has(entry.source.taskId) || !positive(entry.source.cardRevision) || !positive(entry.source.workflowRevision) || !hashPattern.test(entry.source.artifactDigest) || typeof entry.problemClass !== 'string' || typeof entry.conclusion !== 'string' || !['appliesWhen', 'doesNotApplyWhen', 'verification', 'counterexamples', 'operatorVersions'].every((key) => strings(entry[key as keyof ExperienceEntry])) || !Number.isFinite(entry.createdAt) || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= entry.createdAt || (entry.status === 'validated' && (!identifier(entry.reviewer) || !hashPattern.test(entry.reviewArtifactDigest ?? ''))) || (entry.status === 'deprecated' && typeof entry.deprecationReason !== 'string')) return invalid()
    }
    return { ok: true }
  } catch { return invalid() }
}

/** Compatibility wrapper over the same single-pass validation implementation. */
export const validateFeatureState = (raw: unknown, expected: { rootSessionId: string; workspaceId: string }): boolean =>
  inspectFeatureState(raw, expected).ok

const recover = (state: FeatureState): FeatureState => {
  const copy = structuredClone(state)
  const recordsById = new Map(copy.delegations.map((record) => [record.delegationId, record]))
  const uncertain = new Set(copy.delegations.filter((record) => (['queued', 'running'].includes(record.status) || record.finalization === 'processing')).map((record) => record.delegationId))
  for (const control of copy.agentControls ?? []) if (uncertain.has(control.delegationId)) {
    control.phase = 'recovery-required'; control.paused = true; control.reason = 'restart-requires-host-reconciliation'
    if (control.actual !== undefined) control.actual.state = 'unknown'
    const record = recordsById.get(control.delegationId)
    if (record !== undefined && ['ji_feng', 'zhu_jian', 'xing_zhou', 'fu_he'].includes(record.role)) control.needsSideEffectReview = true
  }
  for (const task of copy.tasks) {
    task.recovered = true
    for (const node of Object.values(task.workflowState?.nodes ?? {})) {
      if (node.status === 'running') { node.status = 'blocked'; node.reason = '重启恢复：运行状态未知，需核对已产生的副作用' }
    }
  }
  for (const record of copy.delegations) if (record.status === 'running' || record.status === 'queued' || record.finalization === 'processing') {
    if (record.finalization !== undefined) record.finalization = 'failed'
    record.status = 'failed'; record.error = 'recovery_required'; record.staleReason = '重启时委派尚未确认结束'
  }
  for (const thread of copy.threads) { thread.busy = false; thread.closed = true }
  for (const binding of Object.values(copy.bindings)) if (binding.state === 'active') binding.state = 'suspended'
  for (const entry of (Array.isArray(copy.routeHealth) ? copy.routeHealth : copy.routeHealth?.entries) ?? []) delete entry.halfOpenAgent
  return copy
}

export const createFeatureSession = async (input: {
  rootSessionId: string; cwd: string; dshHome: string; config: SwarmConfigInfo;
  getConfig?: () => SwarmConfigInfo;
  getAgentControls?: () => AgentControlRecord[];
  getRuntime?: () => FeatureRuntimeSnapshot;
  tasks: TaskStore; threads: ThreadRegistry; now: () => number
}): Promise<FeatureSession> => {
  const workspaceId = await getWorkspaceId(input.cwd)
  const directory = join(input.config.persistence.directory || join(input.dshHome, 'share', 'dsh-agent-swarm', 'state'), workspaceId, digest(input.rootSessionId))
  const initialState: FeatureState = { schemaVersion: 1, tasks: [], delegations: [], threads: [], budgets: {},
    bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {}, contexts: [] }
  const handoff = await loadMemoryHandoff<FeatureState>({ dshHome: input.dshHome, rootSessionId: input.rootSessionId, workspaceId,
    persistenceEnabled: input.config.persistence.enabled,
    validate: (raw) => inspectFeatureState(raw, { rootSessionId: input.rootSessionId, workspaceId }) })
  const store = await createDurableStateStore({ directory, initialState: handoff === undefined ? initialState : recover(handoff.state), enabled: input.config.persistence.enabled,
    validate: (raw) => inspectFeatureState(raw, { rootSessionId: input.rootSessionId, workspaceId }), recover })
  const saved = store.read()
  // Older versions charged planning review reservations against implementation calls.
  // Preserve sent work and observation records, but classify these known reservations correctly.
  saved.planningBudgets ??= {}
  for (const [taskId, snapshot] of Object.entries(saved.budgets)) {
    const partition = partitionLegacyPlanningBudget(snapshot)
    saved.budgets[taskId] = partition.execution
    if (partition.planning !== undefined) {
      const previous = saved.planningBudgets[taskId]
      const ids = new Set(previous?.reservations.map((record) => record.id) ?? [])
      saved.planningBudgets[taskId] = previous === undefined ? partition.planning
        : { ...previous, reservations: [...previous.reservations, ...partition.planning.reservations.filter((record) => !ids.has(record.id))] }
    }
  }
  if (input.tasks.getTasks().length === 0) {
    for (const task of saved.tasks) input.tasks.AddTask({ ...task, delegationIds: [] })
    for (const record of saved.delegations) input.tasks.AddDelegation(record)
    for (const thread of saved.threads) input.threads.Add(thread)
  }
  const contexts = intContextStore()
  const contextArtifacts = new Map(saved.contexts.map((artifact) => [artifact.ref, artifact]))
  for (const artifact of saved.contexts) contexts.Restore(artifact, artifact.binding)
  const bindings = createAgentBindingRegistry(store)
  const bus = !input.config.messageBus.enabled ? undefined : createMessageBus({ store, bindings, now: input.now, maxPendingPerTask: input.config.messageBus.maxPending,
    validateArtifactRef: (ref, binding) => {
      try { contexts.Read(binding, ref, { limit: 1 }); return true } catch { return false }
    } })
  const budgets = new Map<string, ExecutionBudget>()
  const planningBudgets = new Map<string, ExecutionBudget>()
  const planningBudgetFor = (task: TaskRecord): ExecutionBudget => {
    let budget = planningBudgets.get(task.taskId)
    if (budget === undefined) {
      budget = createExecutionBudget({}, saved.planningBudgets?.[task.taskId], ['planning-review-control-plane'])
      planningBudgets.set(task.taskId, budget)
    }
    return budget
  }
  const budgetLimits = new Map<string, string>()
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
    const signature = getCanonicalJson(limits)
    if (existing !== undefined && budgetLimits.get(task.taskId) === signature) return existing
    const snapshot = existing?.getSnapshot() ?? saved.budgets[task.taskId]
    if (existing !== undefined) {
      if (getCanonicalJson(snapshot?.limits) === getCanonicalJson(limits)) return existing
      if (snapshot?.reservations.some((record) => ['delegate', 'model', 'native'].includes(record.source) && ['reserved', 'started'].includes(record.state))) throw new ExecutionBudgetError('BUDGET_TRANSITION', 'Execution limits changed while generation is reserved/running; finish or cancel the existing attempt before applying new limits')
    }
    const budget = createExecutionBudget(limits, snapshot)
    budgets.set(task.taskId, budget)
    budgetLimits.set(task.taskId, signature)
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
    if (all.some((record) => record.status === 'running' || record.status === 'queued' || record.finalization === 'processing')) return undefined
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
    workspaceId, store, bindings, bus, contexts, budgetFor, planningBudgetFor,
    getRestoredAgentControls: () => structuredClone(saved.agentControls ?? []),
    getRestoredRuntime: () => saved.runtime === undefined ? undefined : structuredClone(saved.runtime),
    commitRecovery: async () => { await handoff?.commitConsumption() },
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
      contextArtifacts.set(artifact.ref, artifact)
      return artifact
    },
    prepareTaskContexts: (binding, materials) => {
      const batch = contexts.PrepareTaskReplace(binding, materials)
      const additions = structuredClone(batch.artifacts), removed = structuredClone(batch.replaced)
      let committed = false
      return { artifacts: structuredClone(additions), replaced: structuredClone(removed),
        commit: () => {
          batch.commit()
          for (const artifact of removed) contextArtifacts.delete(artifact.ref)
          for (const artifact of additions) contextArtifacts.set(artifact.ref, artifact)
          committed = true
        },
        finalize: () => batch.finalize(),
        rollback: () => {
          batch.rollback()
          if (committed) {
            for (const artifact of additions) contextArtifacts.delete(artifact.ref)
            for (const artifact of removed) contextArtifacts.set(artifact.ref, artifact)
            committed = false
          }
        }
      }
    },
    persist: async (type, tasks, threads, routeHealth) => {
      // Capture every owned collection synchronously at the call boundary.
      // Sampling only tasks here and contexts/controls later in the queue mixed
      // different versions. Sampling everything later could publish a different
      // operation's uncommitted task revision before its own commit succeeds.
      const detach = <T>(value: T): T => JSON.parse(getCanonicalJson(value)) as T
      const taskSnapshot = tasks.getTasks()
      const stableHealth = routeHealth === undefined ? undefined : Array.isArray(routeHealth)
        ? routeHealth.map(({ halfOpenAgent: _claimant, ...entry }) => entry)
        : { ...routeHealth, entries: routeHealth.entries.map(({ halfOpenAgent: _claimant, ...entry }) => entry) }
      if (stableHealth !== undefined && !validatePersistedRouteHealth(stableHealth)) throw new StateStoreError('STATE_INVALID', 'Invalid durable route health snapshot')
      const snapshot = detach({
        tasks: taskSnapshot,
        delegations: taskSnapshot.flatMap((task) => tasks.getTaskDelegations(task.taskId)),
        threads: threads.list(), contexts: [...contextArtifacts.values()],
        budgets: { ...saved.budgets, ...Object.fromEntries([...budgets].map(([key, value]) => [key, value.getSnapshot()])) },
        planningBudgets: { ...saved.planningBudgets, ...Object.fromEntries([...planningBudgets].map(([key, value]) => [key, value.getSnapshot()])) },
        ...(input.getAgentControls === undefined ? {} : { agentControls: input.getAgentControls() }),
        ...(input.getRuntime === undefined ? {} : { runtime: input.getRuntime() }),
        ...(stableHealth === undefined ? {} : { routeHealth: stableHealth })
      })
      await store.commit(type, (draft) => {
        Object.assign(draft, snapshot)
      })
    },
    dispose: () => store.dispose()
  }
}
