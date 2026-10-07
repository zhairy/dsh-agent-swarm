import { getValueDigest } from './workflow.js'

export interface CheckpointInputInfo {
  taskId: string
  cardRevision: number
  workflowRevision: number
  roundId: string
  evidenceRefs: string[]
  unresolved: string[]
  resolvedFindingRefs?: string[]
  allowedPaths?: string[]
  changedPaths?: string[]
  pendingMessages?: number
  conflicts?: string[]
  resource?: { delegations?: number; tokens?: number | null; cost?: number | null; elapsedMs?: number; remainingFixRounds?: number; exhausted?: boolean }
  progress?: string
  nextAction?: string
  acceptanceReady?: boolean
}
export interface CheckpointInfo {
  id: string
  taskId: string
  cardRevision: number
  workflowRevision: number
  roundId: string
  evidenceRefs: string[]
  /** 同一语义版本累计已见的证据；旧检查点恢复时可省略。 */
  knownEvidenceRefs?: string[]
  review: { newEvidence: string[]; resolvedFindings: string[] }
  convergence: { unresolvedDelta: number; repeatedWithoutProgress: number; blocked: boolean }
  scope: { outsidePaths: string[] }
  collaboration: { pendingMessages: number; conflicts: string[] }
  resource: NonNullable<CheckpointInputInfo['resource']>
  unresolved: string[]
  nextAction: 'continue' | 'revise-plan' | 'escalate' | 'accept-ready' | 'incomplete'
  progress?: string
}

const normalizePath = (path: string): string => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
const pathAllowed = (path: string, allowed: readonly string[]): boolean => {
  const candidate = normalizePath(path)
  return !candidate.split('/').includes('..') && allowed.some((item) => { const base = normalizePath(item); return base === '.' || candidate === base || candidate.startsWith(`${base}/`) })
}

/** 委派边界的五项短差量，不把底层工具调用变成长反思轮。 */
export const getCheckpoint = (input: CheckpointInputInfo, previous?: CheckpointInfo, noProgressLimit = 2): CheckpointInfo => {
  if (!Number.isSafeInteger(noProgressLimit) || noProgressLimit < 1) throw new Error('无进展阈值必须为正整数')
  const compatible = previous?.taskId === input.taskId && previous.cardRevision === input.cardRevision && previous.workflowRevision === input.workflowRevision ? previous : undefined
  const oldEvidence = new Set([
    ...(compatible?.knownEvidenceRefs ?? []),
    ...(compatible?.evidenceRefs ?? []),
    ...(compatible?.review.newEvidence ?? [])
  ])
  const evidenceRefs = [...new Set(input.evidenceRefs)]
  const newEvidence = evidenceRefs.filter((ref) => !oldEvidence.has(ref))
  const knownEvidenceRefs = [...new Set([...oldEvidence, ...evidenceRefs])]
  const resolvedFindings = [...new Set(input.resolvedFindingRefs ?? [])]
  const unresolved = [...new Set(input.unresolved)]
  const unresolvedDelta = unresolved.length - (compatible?.unresolved.length ?? unresolved.length)
  const sameBlocking = compatible !== undefined && getValueDigest([...compatible.unresolved].sort()) === getValueDigest([...unresolved].sort())
  const repeatedWithoutProgress = sameBlocking && unresolved.length > 0 && newEvidence.length === 0 && resolvedFindings.length === 0 ? compatible.convergence.repeatedWithoutProgress + 1 : 0
  const outsidePaths = (input.changedPaths ?? []).filter((path) => (input.allowedPaths ?? []).length > 0 && !pathAllowed(path, input.allowedPaths!))
  const conflicts = [...new Set(input.conflicts ?? [])]
  const blocked = repeatedWithoutProgress >= noProgressLimit
  const nextAction = input.resource?.exhausted === true || blocked ? 'incomplete'
    : outsidePaths.length > 0 ? 'revise-plan'
      : conflicts.length > 0 ? 'escalate'
        : input.acceptanceReady === true && unresolved.length === 0 ? 'accept-ready' : 'continue'
  return { id: getValueDigest({ taskId: input.taskId, cardRevision: input.cardRevision, workflowRevision: input.workflowRevision, roundId: input.roundId }), taskId: input.taskId, cardRevision: input.cardRevision, workflowRevision: input.workflowRevision, roundId: input.roundId, evidenceRefs, knownEvidenceRefs,
    review: { newEvidence, resolvedFindings }, convergence: { unresolvedDelta, repeatedWithoutProgress, blocked }, scope: { outsidePaths }, collaboration: { pendingMessages: input.pendingMessages ?? 0, conflicts }, resource: { ...input.resource, tokens: input.resource?.tokens ?? null, cost: input.resource?.cost ?? null }, unresolved, nextAction, ...(input.progress === undefined ? {} : { progress: input.progress.slice(0, 400) }) }
}

export const getCheckpointText = (checkpoint: CheckpointInfo): string => `检查点 ${checkpoint.roundId}：新增证据 ${checkpoint.review.newEvidence.length}；未解决项变化 ${checkpoint.convergence.unresolvedDelta}；范围越界 ${checkpoint.scope.outsidePaths.length}；待处理消息 ${checkpoint.collaboration.pendingMessages}；下一步 ${checkpoint.nextAction}`
