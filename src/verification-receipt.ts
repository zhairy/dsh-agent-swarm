import { randomUUID } from 'node:crypto'
import { getValueDigest } from './workflow.js'
import type { DelegationRecord, TaskRecord } from './evidence.js'
import { ValidateStructuredOutput } from './contracts.js'
import { getSemanticCardDigest, getTaskBinding } from './task-model.js'
import type { FindingResolution } from './policy.js'
import { ACCEPTANCE_QUESTIONS } from './review.js'

export const RUNTIME_POLICY_VERSION = 'swarm-runtime/3.1.3-v1'
export const VERIFICATION_QUESTION_VERSION = getValueDigest(ACCEPTANCE_QUESTIONS)
export interface VerificationBinding {
  rootSessionId: string
  workspaceId: string
  taskId: string
  cardRevision: number
  workflowRevision: number
  requestRevision: number
  questionVersion: string
  policyVersion: string
  artifactDigest: string
  evidenceDigest: string
  decisionDigest: string
  goalBinding?: string
}
export interface VerificationReceipt {
  id: string
  policyVersion: typeof RUNTIME_POLICY_VERSION
  status: 'consumed'
  binding: VerificationBinding
  issuer: 'independent-evidence-verifier'
  producerIds: string[]
  issuedAt: number
  consumedAt: number
}
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const id = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)

/** 类型不防伪：只由服务的当前证据校验路径签发，调用方JSON不会进入此路径。 */
export const IssueVerificationReceipt = (binding: VerificationBinding, producerIds: readonly string[], at: number): VerificationReceipt => {
  if (!id(binding.rootSessionId) || !id(binding.taskId) || !hash(binding.workspaceId) || !['artifactDigest', 'evidenceDigest', 'decisionDigest'].every(key => hash(binding[key as keyof VerificationBinding]))
    || ![binding.cardRevision, binding.workflowRevision, binding.requestRevision].every(value => Number.isSafeInteger(value) && value >= 1)
    || binding.policyVersion !== RUNTIME_POLICY_VERSION || !id(binding.questionVersion) || (binding.goalBinding !== undefined && !hash(binding.goalBinding)) || producerIds.length === 0 || producerIds.length > 128 || producerIds.some(value => !id(value) || value === binding.rootSessionId) || !Number.isFinite(at) || at < 0) throw new Error('Invalid trusted verification binding')
  return { id: 'vr-' + randomUUID(), policyVersion: RUNTIME_POLICY_VERSION, status: 'consumed', binding: structuredClone(binding), issuer: 'independent-evidence-verifier', producerIds: [...new Set(producerIds)], issuedAt: at, consumedAt: at }
}

export const ValidateVerificationReceipt = (raw: unknown): raw is VerificationReceipt => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const r = raw as VerificationReceipt
  const b = r.binding
  return /^vr-[a-f0-9-]{36}$/.test(r.id ?? '') && r.policyVersion === RUNTIME_POLICY_VERSION && r.status === 'consumed' && r.issuer === 'independent-evidence-verifier'
    && b !== null && typeof b === 'object' && id(b.rootSessionId) && hash(b.workspaceId) && id(b.taskId) && b.policyVersion === RUNTIME_POLICY_VERSION && id(b.questionVersion)
    && [b.cardRevision, b.workflowRevision, b.requestRevision].every(value => Number.isSafeInteger(value) && value >= 1)
    && hash(b.artifactDigest) && hash(b.evidenceDigest) && hash(b.decisionDigest) && (b.goalBinding === undefined || hash(b.goalBinding))
    && Array.isArray(r.producerIds) && r.producerIds.length > 0 && r.producerIds.length <= 128 && r.producerIds.every(value => id(value) && value !== b.rootSessionId)
    && Number.isFinite(r.issuedAt) && r.issuedAt >= 0 && r.consumedAt === r.issuedAt
}

export const IsVerificationReceiptCurrent = (raw: unknown, expected: VerificationBinding): boolean => ValidateVerificationReceipt(raw) && getValueDigest(raw.binding) === getValueDigest(expected)

/** 验收与goal完成守卫共用的绑定投影；所有事实须由宿主重取，不能从caller JSON传入。 */
export const getTaskVerificationBinding = (input: {
  task: TaskRecord; workspaceId: string; artifactDigest: string; records: readonly DelegationRecord[]
  resolutions: readonly FindingResolution[]; externalEditAt: number; policyDigest: string; decisionDigest: string; goalBinding?: string
}): VerificationBinding => ({
  rootSessionId: input.task.sessionId, workspaceId: input.workspaceId, ...getTaskBinding(input.task),
  questionVersion: VERIFICATION_QUESTION_VERSION, policyVersion: RUNTIME_POLICY_VERSION,
  artifactDigest: input.artifactDigest, decisionDigest: input.decisionDigest,
  ...(input.goalBinding === undefined ? {} : { goalBinding: input.goalBinding }),
  evidenceDigest: getValueDigest({ goalId: input.task.runtimeGoalId ?? null, card: getSemanticCardDigest(input.task.card), workflow: input.task.workflowDefinition ?? null,
    nodes: input.task.workflowDefinition?.nodes.filter(node => node.operation === 'delegate').map(node => input.task.workflowState?.nodes[node.id] ?? null) ?? [],
    planningReview: input.task.planningReview ?? null, checkpoint: input.task.checkpoint ?? null,
    records: input.records, resolutions: input.resolutions, externalEditAt: input.externalEditAt, policy: input.policyDigest })
})

/** 授权答案是服务器事实；稳定排序使存储顺序不改变当前授权绑定。 */
export const getVerificationDecisionDigest = (raw: unknown, taskId: string): string => getValueDigest(Object.values(
  raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
).filter(value => value !== null && typeof value === 'object' && [taskId, '@root'].includes((value as { questionBinding?: { taskId?: string } }).questionBinding?.taskId ?? ''))
  .sort((left, right) => String((left as { id?: string }).id).localeCompare(String((right as { id?: string }).id))))

/** 证明来自已登记、已提交的独立子委派；不声称输出里的测试语义一定正确。 */
export const getVerificationProducers = (task: TaskRecord, records: readonly DelegationRecord[], saved: readonly DelegationRecord[]): string[] => {
  const committed = new Map(saved.filter(record => record.taskId === task.taskId).map(record => [record.delegationId, getValueDigest(record)]))
  return [...new Set(records.filter(record => record.status === 'completed' && record.finalization !== 'processing'
    && record.finalization !== 'cancelled' && record.finalization !== 'failed' && record.hardIsolation === true
    && typeof record.childId === 'string' && record.childId !== task.sessionId
    && committed.get(record.delegationId) === getValueDigest(record)
    && ValidateStructuredOutput(record.role, record.structured, record.mode).length === 0).map(record => record.childId!))].slice(0, 128)
}
