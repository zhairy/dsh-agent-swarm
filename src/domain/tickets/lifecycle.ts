import type { DelegationRecord, TaskRecord } from '../../evidence.js'

export const ACCEPT_MODES = ['off', 'observe', 'auto'] as const
export type AcceptMode = typeof ACCEPT_MODES[number]
export type MandateStrength = 'explicit' | 'inferred'

export interface Mandate {
  id: string
  strength: MandateStrength
  policyVersion: string
  scope: string[]
  matchedRules: string[]
  originTriggerId: string
  createdAt: number
  expiresAt?: number
}

export interface AdmissionRequest {
  mode: AcceptMode
  strength: MandateStrength
  matchedRules: readonly string[]
  enabledRules: readonly string[]
  budgetAvailable: boolean
  hostPermitted: boolean
}

export type AdmissionDecision =
  | { kind: 'accept'; mandateRequired: true }
  | { kind: 'observe'; wouldAccept: true; reason: 'observe-mode' }
  | { kind: 'ignore'; reason: 'off-mode' | 'no-matched-rule' | 'budget-exhausted' | 'host-denied' }

export type TicketStage =
  | { stage: 'created' }
  | { stage: 'person'; action: 'blocked' | 'failed' | 'review' }
  | { stage: 'working'; action: 'queued' | 'running' }
  | { stage: 'idle' }
  | { stage: 'ended'; outcome: 'accepted' | 'rejected' | 'incomplete' }

export interface TicketProjection {
  ticketId: string
  title: string
  stage: TicketStage
  revisions: { request: number; card: number; workflow: number }
  assignmentIds: string[]
  activeAssignmentId?: string
  canRetry: boolean
  mandate?: Mandate
}

const enabled = (rule: string, rules: readonly string[]): boolean => rules.includes(rule)

/** Stable projection key used by the event journal and migration manifest. */
export const getTicketStageKey = (stage: TicketProjection['stage']): string => stage.stage === 'working' || stage.stage === 'person'
  ? `${stage.stage}:${stage.action}`
  : stage.stage === 'ended' ? `ended:${stage.outcome}` : stage.stage

/** Decide proactive admission without granting any host or workspace permission. */
export const evaluateProactiveAdmission = (request: AdmissionRequest): AdmissionDecision => {
  if (request.strength === 'explicit') return { kind: 'accept', mandateRequired: true }
  if (request.mode === 'off') return { kind: 'ignore', reason: 'off-mode' }
  if (!request.hostPermitted) return { kind: 'ignore', reason: 'host-denied' }
  if (!request.budgetAvailable) return { kind: 'ignore', reason: 'budget-exhausted' }
  if (!request.matchedRules.some((rule) => enabled(rule, request.enabledRules))) return { kind: 'ignore', reason: 'no-matched-rule' }
  if (request.mode === 'observe') return { kind: 'observe', wouldAccept: true, reason: 'observe-mode' }
  return { kind: 'accept', mandateRequired: true }
}

/** A resumed or queued inferred ticket must still satisfy the current policy. */
export const revalidateMandate = (mandate: Mandate, current: Pick<AdmissionRequest, 'mode' | 'enabledRules'>, at: number): boolean => {
  if (mandate.expiresAt !== undefined && mandate.expiresAt <= at) return false
  if (mandate.strength === 'explicit') return true
  return current.mode === 'auto' && mandate.matchedRules.some((rule) => enabled(rule, current.enabledRules))
}

const latest = (delegations: readonly DelegationRecord[]): DelegationRecord | undefined =>
  [...delegations].sort((left, right) => right.startedAt - left.startedAt || right.delegationId.localeCompare(left.delegationId))[0]

const hasRunning = (delegations: readonly DelegationRecord[]): boolean => delegations.some((record) => record.status === 'running')
const hasQueued = (delegations: readonly DelegationRecord[]): boolean => delegations.some((record) => record.status === 'queued')

/** Project the existing task/delegation records into the v3.2.0 ticket lifecycle. */
export const projectTicketLifecycle = (task: TaskRecord, delegations: readonly DelegationRecord[]): TicketProjection => {
  const revisions = { request: task.requestRevision ?? 1, card: task.cardRevision ?? 1, workflow: task.workflowRevision ?? 1 }
  const assignmentIds = delegations.map((record) => record.delegationId)
  const active = [...delegations].reverse().find((record) => record.status === 'running' || record.status === 'queued')
  const last = latest(delegations)
  let stage: TicketStage
  if (task.acceptance !== undefined) {
    const outcome = task.acceptance.decision === 'accept' ? 'accepted' : task.acceptance.decision === 'reject' ? 'rejected' : 'incomplete'
    stage = { stage: 'ended', outcome }
  } else if (last?.finalization === 'failed' || last?.finalization === 'cancelled') stage = { stage: 'person', action: 'failed' }
  else if (last?.status === 'blocked') stage = { stage: 'person', action: 'blocked' }
  else if (last?.status === 'failed') stage = { stage: 'person', action: 'failed' }
  else if (hasRunning(delegations)) stage = { stage: 'working', action: 'running' }
  else if (hasQueued(delegations)) stage = { stage: 'working', action: 'queued' }
  else if (last?.status === 'completed') stage = { stage: 'person', action: 'review' }
  else if (delegations.length > 0) stage = { stage: 'idle' }
  else stage = { stage: 'created' }
  return {
    ticketId: task.taskId,
    title: task.card.title,
    stage,
    revisions,
    assignmentIds,
    ...(active === undefined ? {} : { activeAssignmentId: active.delegationId }),
    canRetry: stage.stage === 'person' && (stage.action === 'blocked' || stage.action === 'failed')
  }
}
