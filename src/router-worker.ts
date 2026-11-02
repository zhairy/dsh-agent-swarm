export const EVENT_FILTER_REASONS = ['duplicate', 'self-echo', 'ignored-kind', 'stale-request-revision', 'stale-card-revision', 'stale-workflow-revision', 'stale-lease'] as const
export type EventFilterReason = typeof EVENT_FILTER_REASONS[number]

export interface EventFilterInput {
  eventId: string
  idempotencyKey?: string
  kind: string
  senderAgentId?: string
  rootAgentId: string
  ignoredKinds?: readonly string[]
  requestRevision: number
  cardRevision: number
  workflowRevision: number
  leaseEpoch: number
  current: { requestRevision: number; cardRevision: number; workflowRevision: number; leaseEpoch: number }
  seen: { has(key: string): boolean }
}

export type EventFilterResult = { accepted: true } | { accepted: false; reason: EventFilterReason }

/** Filter host events before they can mutate a ticket or start a model call. */
export const filterEvent = (input: EventFilterInput): EventFilterResult => {
  const keys = [input.eventId, input.idempotencyKey].filter((key): key is string => key !== undefined && key !== '')
  if (keys.some((key) => input.seen.has(key))) return { accepted: false, reason: 'duplicate' }
  if (input.senderAgentId !== undefined && input.senderAgentId === input.rootAgentId) return { accepted: false, reason: 'self-echo' }
  if (input.ignoredKinds?.includes(input.kind) === true) return { accepted: false, reason: 'ignored-kind' }
  if (input.requestRevision !== input.current.requestRevision) return { accepted: false, reason: 'stale-request-revision' }
  if (input.cardRevision !== input.current.cardRevision) return { accepted: false, reason: 'stale-card-revision' }
  if (input.workflowRevision !== input.current.workflowRevision) return { accepted: false, reason: 'stale-workflow-revision' }
  if (input.leaseEpoch !== input.current.leaseEpoch) return { accepted: false, reason: 'stale-lease' }
  return { accepted: true }
}

export const ROUTER_DENIED_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'shell_write', 'swarm_book_write', 'git_commit', 'deploy', 'publish'
])

/** The router may route and read evidence; host denial and writes stay with workers. */
export const getRouterToolDenial = (toolName: string, argumentsValue?: unknown): string | undefined => {
  if (ROUTER_DENIED_TOOLS.has(toolName)) return `router cannot execute ${toolName}`
  if (toolName === 'bash' && argumentsValue !== null && typeof argumentsValue === 'object') {
    const command = (argumentsValue as { command?: unknown }).command
    if (typeof command === 'string' && /(^|[;&|]\s*)(sleep\s+[1-9]|\S*timeout\s+[3-9][1-9]\d*)/i.test(command)) return 'router cannot block on a long wait'
  }
  return undefined
}

export interface AssignmentEnvelope {
  ticketId: string
  assignmentId: string
  role: string
  workerKind: 'expert' | 'native-codex' | 'native-claude'
  provider: string
  model: string
  reasoningEffort?: string
  requestRevision: number
  cardRevision: number
  workflowRevision: number
  leaseEpoch: number
  inputDigest: string
  permissions: readonly string[]
  createdAt: number
}

export interface WorkerSubmission {
  ticketId: string
  assignmentId: string
  requestRevision: number
  cardRevision: number
  workflowRevision: number
  leaseEpoch: number
  inputDigest: string
}

export type WorkerSubmissionResult = { accepted: true } | { accepted: false; reason: 'ticket-mismatch' | 'assignment-mismatch' | 'stale-request-revision' | 'stale-card-revision' | 'stale-workflow-revision' | 'stale-lease' | 'input-mismatch' }

export const validateWorkerSubmission = (envelope: AssignmentEnvelope, submission: WorkerSubmission): WorkerSubmissionResult => {
  if (submission.ticketId !== envelope.ticketId) return { accepted: false, reason: 'ticket-mismatch' }
  if (submission.assignmentId !== envelope.assignmentId) return { accepted: false, reason: 'assignment-mismatch' }
  if (submission.requestRevision !== envelope.requestRevision) return { accepted: false, reason: 'stale-request-revision' }
  if (submission.cardRevision !== envelope.cardRevision) return { accepted: false, reason: 'stale-card-revision' }
  if (submission.workflowRevision !== envelope.workflowRevision) return { accepted: false, reason: 'stale-workflow-revision' }
  if (submission.leaseEpoch !== envelope.leaseEpoch) return { accepted: false, reason: 'stale-lease' }
  if (submission.inputDigest !== envelope.inputDigest) return { accepted: false, reason: 'input-mismatch' }
  return { accepted: true }
}
