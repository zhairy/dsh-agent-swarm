import { describe, expect, it } from 'vitest'
import { createDurableStateStore } from '../../src/state-store.js'
import { createExperienceRepository, type ExperienceReview, type ExperienceState } from '../../src/experience.js'

describe('reviewed reusable experiences', () => {
  it('keeps accepted-derived candidates separate and requires trusted independent evidence before promotion', async () => {
    const store = await createDurableStateStore<ExperienceState>({ directory: '/unused', initialState: { experiences: {} }, enabled: false })
    const repository = createExperienceRepository(store, { now: () => 1000, verifyReview: (_entry, review) => review.reviewArtifactDigest === 'b'.repeat(64) })
    const entry = await repository.addCandidate({ problemClass: 'numerical', appliesWhen: ['finite binary64 vectors'], doesNotApplyWhen: ['exact symbolic theorem'], conclusion: 'Use compensated summation for cancellation', source: { taskId: 'task', cardRevision: 1, workflowRevision: 1, artifactDigest: 'a'.repeat(64), authorId: 'author' }, verification: ['independent cancellation fixture'], counterexamples: [], operatorVersions: ['1'], expiresAt: 2000 })
    expect(repository.list()).toEqual([])
    expect(repository.list(undefined, true)).toHaveLength(1)
    const review: ExperienceReview = { author: 'author', reviewer: 'reviewer', reviewArtifactDigest: 'b'.repeat(64), sourceArtifactDigest: 'a'.repeat(64), evidenceComplete: true, unresolvedSevere: 0, applicabilityConfirmed: true }
    await expect(repository.promote(entry.id, { ...review, reviewer: 'author' })).rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
    await expect(repository.promote(entry.id, { ...review, unresolvedSevere: 1 })).rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
    await expect(repository.promote(entry.id, { ...review, reviewArtifactDigest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
    const untrusted = createExperienceRepository(store, { now: () => 1000 })
    await expect(untrusted.promote(entry.id, review)).rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
    await repository.promote(entry.id, review)
    expect(repository.list('numerical')).toHaveLength(1)
    await repository.deprecate(entry.id, 'Applicability narrowed by counterexample')
    expect(repository.list()).toEqual([])
    expect(store.read().experiences[entry.id]?.status).toBe('deprecated')
    await store.dispose()
  })
})
