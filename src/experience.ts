import { randomUUID } from 'node:crypto'
import type { DurableStateStore } from './state-store.js'
import { queryReviewedExperiences, type MemoryQuery } from './memory.js'
import { getValueDigest } from './workflow.js'
import { ValidateToolCandidate, type ToolCandidateMetadata } from './tool-candidate.js'
import {
  EVOLUTION_MAX_REQUEST_HISTORY, getInitialEvolutionGovernance, transitionEvolutionGovernance,
  ValidateEvolutionEvaluationResult, ValidateEvolutionGovernance, recoverEvolutionGovernance,
  type EvolutionCanaryScope, type EvolutionEvaluationResult, type EvolutionGovernance, type EvolutionReleaseRef
} from './evolution-governance.js'

export interface ExperienceSource {
  taskId: string
  cardRevision: number
  workflowRevision: number
  artifactDigest: string
  authorId?: string
}
export interface ExperienceEntry {
  id: string
  problemClass: string
  appliesWhen: string[]
  doesNotApplyWhen: string[]
  conclusion: string
  source: ExperienceSource
  verification: string[]
  counterexamples: string[]
  operatorVersions: string[]
  status: 'candidate' | 'validated' | 'deprecated'
  createdAt: number
  expiresAt: number
  reviewer?: string
  reviewArtifactDigest?: string
  deprecationReason?: string
  toolCandidate?: ToolCandidateMetadata
  governance?: EvolutionGovernance
}
export interface ExperienceState { experiences: Record<string, ExperienceEntry> }
export interface ExperienceReview {
  reviewer: string
  author: string
  reviewArtifactDigest: string
  sourceArtifactDigest: string
  evidenceComplete: boolean
  unresolvedSevere: number
  applicabilityConfirmed: boolean
}
export class ExperienceError extends Error {
  constructor (readonly code: 'EXPERIENCE_INVALID' | 'EXPERIENCE_REVIEW_REQUIRED' | 'EXPERIENCE_CONFLICT', message: string) { super(message); this.name = 'ExperienceError' }
}
export interface EvolutionTransitionRequest { expectedRevision: number; requestId: string }
export const createExperienceRepository = <T extends ExperienceState>(store: DurableStateStore<T>, options: {
  now?: () => number
  maxEntries?: number
  verifyReview?: (entry: ExperienceEntry, review: ExperienceReview) => boolean | Promise<boolean>
  verifyEvaluation?: (entry: ExperienceEntry, result: EvolutionEvaluationResult) => boolean | Promise<boolean>
  verifyRelease?: (entry: ExperienceEntry, release: EvolutionReleaseRef) => boolean | Promise<boolean>
  verifyCanary?: (entry: ExperienceEntry, scope: EvolutionCanaryScope, authorizationRef: string, stopPolicyDigest: string) => boolean | Promise<boolean>
} = {}) => {
  const now = options.now ?? Date.now
  const digest = /^[a-f0-9]{64}$/i
  const readEntries = (): Record<string, ExperienceEntry> => store.readFields?.(['experiences']).experiences ?? store.read().experiences
  const identity = (entry: Omit<ExperienceEntry, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'reviewer' | 'reviewArtifactDigest' | 'deprecationReason' | 'governance'>) => getValueDigest({
    problemClass: entry.problemClass, appliesWhen: entry.appliesWhen, doesNotApplyWhen: entry.doesNotApplyWhen,
    conclusion: entry.conclusion, source: entry.source, verification: entry.verification,
    counterexamples: entry.counterexamples, operatorVersions: entry.operatorVersions, ...(entry.toolCandidate === undefined ? {} : { toolCandidate: entry.toolCandidate })
  })
  const contentDigest = (entry: ExperienceEntry): string => getValueDigest({
    problemClass: entry.problemClass, appliesWhen: entry.appliesWhen, doesNotApplyWhen: entry.doesNotApplyWhen,
    conclusion: entry.conclusion, source: entry.source, verification: entry.verification,
    counterexamples: entry.counterexamples, operatorVersions: entry.operatorVersions,
    ...(entry.toolCandidate === undefined ? {} : { toolCandidate: entry.toolCandidate })
  })
  const validTransitionRequest = (input: EvolutionTransitionRequest): boolean =>
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 1 && typeof input.requestId === 'string'
    && input.requestId.trim().length > 0 && input.requestId.length <= 512
  const validReview = (entry: ExperienceEntry, review: ExperienceReview): boolean =>
    review.evidenceComplete && review.unresolvedSevere === 0 && review.applicabilityConfirmed
    && typeof review.author === 'string' && review.author.length > 0
    && typeof review.reviewer === 'string' && review.reviewer.length > 0 && review.reviewer !== review.author
    && (entry.source.authorId === undefined || entry.source.authorId === review.author)
    && digest.test(review.reviewArtifactDigest) && review.sourceArtifactDigest === entry.source.artifactDigest
  const transition = async (
    id: string,
    event: Parameters<typeof transitionEvolutionGovernance>[1],
    input: EvolutionTransitionRequest,
    review?: ExperienceReview
  ): Promise<ExperienceEntry> => {
    if (!validTransitionRequest(input)) throw new ExperienceError('EXPERIENCE_INVALID', 'Governance transition needs an expected revision and request id')
    let result!: ExperienceEntry
    await store.update(`experience/governance/${event.type}`, { build: async state => {
      const entry = state.experiences[id]
      if (entry === undefined || entry.toolCandidate !== undefined) throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown or quarantined experience')
      const governance = entry.governance ?? (event.type === 'begin-evaluation' ? getInitialEvolutionGovernance(now()) : undefined)
      if (governance === undefined) throw new ExperienceError('EXPERIENCE_CONFLICT', 'Evaluation must be started before governance actions')
      if (!ValidateEvolutionGovernance(governance)) throw new ExperienceError('EXPERIENCE_INVALID', 'Persisted governance state is invalid')
      if (event.type === 'begin-evaluation' && (entry.status !== 'candidate' || entry.expiresAt <= now() || event.candidateDigest !== contentDigest(entry))) {
        throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Evaluation candidate digest does not match the frozen experience')
      }
      if (event.type === 'record-evaluation') {
        if (!ValidateEvolutionEvaluationResult(event.result) || event.result.candidateDigest !== contentDigest(entry) || entry.verification.length === 0
          || review === undefined || !validReview(entry, review)
          || options.verifyReview === undefined || !await options.verifyReview(entry, review)
          || options.verifyEvaluation === undefined || !await options.verifyEvaluation(entry, event.result)) {
          throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Evaluation needs independently verified review and trusted frozen-trace evidence')
        }
      }
      if (event.type === 'register-release' && (options.verifyRelease === undefined || !await options.verifyRelease(entry, event.release))) {
        throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Release registration needs trusted manifest and artifact verification')
      }
      if (event.type === 'authorize-canary' && (options.verifyCanary === undefined
        || !await options.verifyCanary(entry, event.scope, event.authorizationRef, event.stopPolicyDigest))) {
        throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Canary authorization must come from the live host authorization record')
      }
      if ((event.type === 'request-canary' || event.type === 'authorize-canary') && event.scope.taskId !== entry.source.taskId) {
        throw new ExperienceError('EXPERIENCE_INVALID', 'Canary scope must stay on the candidate source task')
      }
      let next: EvolutionGovernance
      try { next = transitionEvolutionGovernance(governance, event, { expectedRevision: input.expectedRevision, requestId: input.requestId, at: now() }) }
      catch (error) { throw new ExperienceError('EXPERIENCE_CONFLICT', error instanceof Error ? error.message : 'Governance transition failed') }
      if (next.requestIndex !== undefined && Object.keys(next.requestIndex).length > EVOLUTION_MAX_REQUEST_HISTORY) {
        throw new ExperienceError('EXPERIENCE_INVALID', 'Governance request history capacity reached')
      }
      const status: ExperienceEntry['status'] = next.phase === 'revoked' ? 'deprecated'
        : ['validated', 'released', 'shadow', 'canary', 'active', 'stopped'].includes(next.phase) ? 'validated' : 'candidate'
      result = { ...entry, status, governance: next,
        ...(event.type === 'record-evaluation' && event.result.outcome === 'passed' && review !== undefined
          ? { reviewer: review.reviewer, reviewArtifactDigest: review.reviewArtifactDigest }
          : {}),
        ...(event.type === 'revoke' ? { deprecationReason: event.reason } : {}) }
      return { set: { experiences: { [id]: result } } }
    } })
    return structuredClone(result)
  }
  return {
    getExperienceDigest: (id: string): string | undefined => {
      const entry = readEntries()[id]
      return entry === undefined ? undefined : contentDigest(entry)
    },
    get: (id: string): ExperienceEntry | undefined => {
      const entry = readEntries()[id]
      return entry === undefined ? undefined : structuredClone(entry)
    },
    addCandidate: async (input: Omit<ExperienceEntry, 'id' | 'status' | 'createdAt' | 'reviewer' | 'reviewArtifactDigest' | 'deprecationReason' | 'governance'>): Promise<ExperienceEntry> => {
      if (typeof input.conclusion !== 'string' || input.conclusion.length < 1 || input.conclusion.length > 4000 || typeof input.problemClass !== 'string' || input.problemClass.length < 1 || input.problemClass.length > 128 || !digest.test(input.source?.artifactDigest ?? '') || !Number.isSafeInteger(input.source.cardRevision) || input.source.cardRevision < 1 || !Number.isSafeInteger(input.source.workflowRevision) || input.source.workflowRevision < 1 || !Number.isFinite(input.expiresAt) || input.expiresAt <= now()) throw new ExperienceError('EXPERIENCE_INVALID', 'Candidate needs a bounded conclusion, source revisions/digest and future expiry')
      for (const key of ['appliesWhen', 'doesNotApplyWhen', 'verification', 'counterexamples', 'operatorVersions'] as const) if (!Array.isArray(input[key]) || input[key].length > 32 || input[key].some((s) => typeof s !== 'string' || s.length > 2000)) throw new ExperienceError('EXPERIENCE_INVALID', 'Invalid bounded experience fields')
      if (input.toolCandidate !== undefined && !ValidateToolCandidate(input.toolCandidate)) throw new ExperienceError('EXPERIENCE_INVALID', 'Tool candidates require bounded references and disabled execution')
      const createdAt = now(), inputIdentity = identity(input)
      let entry: ExperienceEntry = { ...structuredClone(input), id: randomUUID(), status: 'candidate', createdAt }
      // 补丁在 store 的互斥区内按冻结基线求值：去重与容量检查对最新的已提交候选成立。
      await store.update('experience/candidate', { build: (state) => {
        // Only exact, still-live candidates reuse storage; reviewed/deprecated/expired records remain distinct audit facts.
        const existing = Object.values(state.experiences).find((candidate) => candidate.status === 'candidate'
          && candidate.expiresAt > createdAt && identity(candidate) === inputIdentity)
        if (existing !== undefined) { entry = structuredClone(existing); return {} }
        if (Object.keys(state.experiences).length >= (options.maxEntries ?? 1024)) throw new ExperienceError('EXPERIENCE_INVALID', 'Experience capacity reached; archive first')
        return { set: { experiences: { [entry.id]: entry } } }
      } })
      return entry
    },
    promote: async (id: string, review: ExperienceReview): Promise<ExperienceEntry> => {
      let result!: ExperienceEntry
      await store.update('experience/promote', { build: async (state) => {
        const entry = state.experiences[id]
        // 经验复评不等于代码沙箱评测；不能沿用文本经验晋升路径装载工具。
        if (entry?.toolCandidate !== undefined) throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Tool evaluation unavailable; candidate remains quarantined and cannot be activated')
        if (entry === undefined || entry.governance !== undefined || entry.status !== 'candidate' || entry.expiresAt <= now() || entry.verification.length === 0 || !validReview(entry, review)
          || options.verifyReview === undefined || !await options.verifyReview(entry, review)) throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Promotion needs independently verified current source evidence, an independent reviewer and no unresolved severe findings')
        result = { ...entry, status: 'validated', reviewer: review.reviewer, reviewArtifactDigest: review.reviewArtifactDigest }
        return { set: { experiences: { [id]: result } } }
      } })
      return result
    },
    deprecate: async (id: string, reason: string): Promise<void> => {
      if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 2000) throw new ExperienceError('EXPERIENCE_INVALID', 'Deprecation reason is required')
      await store.update('experience/deprecate', { build: (state) => {
        const entry = state.experiences[id]
        if (entry === undefined || entry.governance !== undefined) throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown experience or governance-managed entry; use revoke for the latter')
        return { set: { experiences: { [id]: { ...entry, status: 'deprecated', deprecationReason: reason } } } }
      } })
    },
    beginEvaluation: (id: string, input: EvolutionTransitionRequest & { traceDigest: string; baselineDigest: string; candidateDigest: string }) =>
      transition(id, { type: 'begin-evaluation', traceDigest: input.traceDigest, baselineDigest: input.baselineDigest, candidateDigest: input.candidateDigest }, input),
    recordEvaluation: (id: string, result: EvolutionEvaluationResult, review: ExperienceReview, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'record-evaluation', result }, input, review),
    registerRelease: (id: string, release: EvolutionReleaseRef, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'register-release', release }, input),
    startShadow: (id: string, input: EvolutionTransitionRequest) => transition(id, { type: 'start-shadow', at: now() }, input),
    recordShadow: (id: string, recommendation: 'continue' | 'stop', input: EvolutionTransitionRequest) =>
      transition(id, { type: 'record-shadow', at: now(), recommendation }, input),
    requestCanary: (id: string, scope: EvolutionCanaryScope, stopPolicyDigest: string, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'request-canary', scope, stopPolicyDigest, at: now() }, input),
    authorizeCanary: (id: string, scope: EvolutionCanaryScope, authorizationRef: string, stopPolicyDigest: string, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'authorize-canary', scope, authorizationRef, stopPolicyDigest, at: now() }, input),
    activateCanary: (id: string, input: EvolutionTransitionRequest) => transition(id, { type: 'activate-canary', at: now() }, input),
    stopCanary: (id: string, reason: string, safetyViolation: boolean, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'stop-canary', at: now(), reason, safetyViolation }, input),
    promoteCanary: (id: string, reason: string | undefined, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'promote', at: now(), ...(reason === undefined ? {} : { reason }) }, input),
    revoke: (id: string, reason: string, unresolvedHandles: number, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'revoke', at: now(), reason, unresolvedHandles }, input),
    reconcile: (id: string, reason: string, input: EvolutionTransitionRequest) =>
      transition(id, { type: 'reconcile', at: now(), reason }, input),
    /** Restart recovery is deliberately separate from an operator transition. */
    recover: async (id: string): Promise<ExperienceEntry | undefined> => {
      const current = readEntries()[id]
      if (current?.governance === undefined) return current === undefined ? undefined : structuredClone(current)
      const next = recoverEvolutionGovernance(current.governance, now())
      if (getValueDigest(next) === getValueDigest(current.governance)) return structuredClone(current)
      let result!: ExperienceEntry
      await store.update('experience/governance/recover', { build: state => {
        const entry = state.experiences[id]
        if (entry?.governance === undefined) throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown experience governance')
        result = { ...entry, governance: next, status: next.phase === 'revoked' ? 'deprecated' : entry.status }
        return { set: { experiences: { [id]: result } } }
      } })
      return structuredClone(result)
    },
    listForTask: (taskId: string): ExperienceEntry[] => Object.values(readEntries())
      .filter(entry => entry.source.taskId === taskId && entry.governance !== undefined)
      .sort((left, right) => right.governance!.revision - left.governance!.revision || right.createdAt - left.createdAt)
      .map(entry => structuredClone(entry)),
    query: (query: MemoryQuery) => queryReviewedExperiences(Object.values(readEntries()).filter(entry => entry.governance === undefined || entry.governance.phase === 'active'), query, now()),
    list: (problemClass?: string, includeCandidates = false): ExperienceEntry[] => Object.values(readEntries()).filter((entry) => entry.expiresAt > now() && entry.status !== 'deprecated' && (includeCandidates || entry.status === 'validated') && (problemClass === undefined || entry.problemClass === problemClass))
  }
}
