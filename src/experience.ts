import { randomUUID } from 'node:crypto'
import type { DurableStateStore } from './state-store.js'
import { queryReviewedExperiences, type MemoryQuery } from './memory.js'
import { getValueDigest } from './workflow.js'

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
  constructor (readonly code: 'EXPERIENCE_INVALID' | 'EXPERIENCE_REVIEW_REQUIRED', message: string) { super(message); this.name = 'ExperienceError' }
}
export const createExperienceRepository = <T extends ExperienceState>(store: DurableStateStore<T>, options: { now?: () => number; maxEntries?: number; verifyReview?: (entry: ExperienceEntry, review: ExperienceReview) => boolean | Promise<boolean> } = {}) => {
  const now = options.now ?? Date.now
  const digest = /^[a-f0-9]{64}$/i
  const readEntries = (): Record<string, ExperienceEntry> => store.readFields?.(['experiences']).experiences ?? store.read().experiences
  const identity = (entry: Omit<ExperienceEntry, 'id' | 'status' | 'createdAt' | 'expiresAt' | 'reviewer' | 'reviewArtifactDigest' | 'deprecationReason'>) => getValueDigest({
    problemClass: entry.problemClass, appliesWhen: entry.appliesWhen, doesNotApplyWhen: entry.doesNotApplyWhen,
    conclusion: entry.conclusion, source: entry.source, verification: entry.verification,
    counterexamples: entry.counterexamples, operatorVersions: entry.operatorVersions
  })
  return {
    addCandidate: async (input: Omit<ExperienceEntry, 'id' | 'status' | 'createdAt' | 'reviewer' | 'reviewArtifactDigest' | 'deprecationReason'>): Promise<ExperienceEntry> => {
      if (typeof input.conclusion !== 'string' || input.conclusion.length < 1 || input.conclusion.length > 4000 || typeof input.problemClass !== 'string' || input.problemClass.length < 1 || input.problemClass.length > 128 || !digest.test(input.source?.artifactDigest ?? '') || !Number.isSafeInteger(input.source.cardRevision) || input.source.cardRevision < 1 || !Number.isSafeInteger(input.source.workflowRevision) || input.source.workflowRevision < 1 || !Number.isFinite(input.expiresAt) || input.expiresAt <= now()) throw new ExperienceError('EXPERIENCE_INVALID', 'Candidate needs a bounded conclusion, source revisions/digest and future expiry')
      for (const key of ['appliesWhen', 'doesNotApplyWhen', 'verification', 'counterexamples', 'operatorVersions'] as const) if (!Array.isArray(input[key]) || input[key].length > 32 || input[key].some((s) => typeof s !== 'string' || s.length > 2000)) throw new ExperienceError('EXPERIENCE_INVALID', 'Invalid bounded experience fields')
      const createdAt = now(), inputIdentity = identity(input)
      let entry: ExperienceEntry = { ...structuredClone(input), id: randomUUID(), status: 'candidate', createdAt }
      await store.commit('experience/candidate', (draft) => {
        // Only exact, still-live candidates reuse storage; reviewed/deprecated/expired records remain distinct audit facts.
        const existing = Object.values(draft.experiences).find((candidate) => candidate.status === 'candidate'
          && candidate.expiresAt > createdAt && identity(candidate) === inputIdentity)
        if (existing !== undefined) { entry = structuredClone(existing); return }
        if (Object.keys(draft.experiences).length >= (options.maxEntries ?? 1024)) throw new ExperienceError('EXPERIENCE_INVALID', 'Experience capacity reached; archive first')
        draft.experiences[entry.id] = entry
      })
      return entry
    },
    promote: async (id: string, review: ExperienceReview): Promise<ExperienceEntry> => {
      let result!: ExperienceEntry
      await store.commit('experience/promote', async (draft) => {
        const entry = draft.experiences[id]
        if (entry === undefined || entry.status !== 'candidate' || entry.expiresAt <= now() || !review.evidenceComplete || review.unresolvedSevere !== 0 || !review.applicabilityConfirmed || !review.reviewer || review.reviewer === review.author || (entry.source.authorId !== undefined && entry.source.authorId !== review.author) || !digest.test(review.reviewArtifactDigest) || review.sourceArtifactDigest !== entry.source.artifactDigest || entry.verification.length === 0 || options.verifyReview === undefined || !await options.verifyReview(entry, review)) throw new ExperienceError('EXPERIENCE_REVIEW_REQUIRED', 'Promotion needs independently verified current source evidence, an independent reviewer and no unresolved severe findings')
        result = { ...entry, status: 'validated', reviewer: review.reviewer, reviewArtifactDigest: review.reviewArtifactDigest }
        draft.experiences[id] = result
      })
      return result
    },
    deprecate: async (id: string, reason: string): Promise<void> => {
      if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 2000) throw new ExperienceError('EXPERIENCE_INVALID', 'Deprecation reason is required')
      await store.commit('experience/deprecate', (draft) => {
        const entry = draft.experiences[id]
        if (entry === undefined) throw new ExperienceError('EXPERIENCE_INVALID', 'Unknown experience')
        draft.experiences[id] = { ...entry, status: 'deprecated', deprecationReason: reason }
      })
    },
    query: (query: MemoryQuery) => queryReviewedExperiences(Object.values(readEntries()), query, now()),
    list: (problemClass?: string, includeCandidates = false): ExperienceEntry[] => Object.values(readEntries()).filter((entry) => entry.expiresAt > now() && entry.status !== 'deprecated' && (includeCandidates || entry.status === 'validated') && (problemClass === undefined || entry.problemClass === problemClass))
  }
}
