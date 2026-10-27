import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { createDurableStateStore } from '../../src/state-store.js'
import { SWARM_LAYOUT_OPTIONS } from '../../src/state-chunks.js'
import { createExperienceRepository, type ExperienceReview, type ExperienceState } from '../../src/experience.js'
import {
  EVOLUTION_POLICY_VERSION, getEvolutionUpper95, runEvolutionEvaluation, ValidateEvolutionGovernance,
  ValidateEvolutionReplayTrace, type EvolutionCanaryScope, type EvolutionDecisionPolicy,
  type EvolutionReplayTrace, recoverEvolutionGovernance
} from '../../src/evolution-governance.js'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const scope = { rootSessionId: 'root-T-1', workspaceId: hash('workspace'), taskId: 'T-1', lineageId: hash('lineage') }
const review = (author = 'author'): ExperienceReview => ({
  author, reviewer: 'independent-reviewer', reviewArtifactDigest: hash('review'),
  sourceArtifactDigest: hash('source'), evidenceComplete: true, unresolvedSevere: 0, applicabilityConfirmed: true
})
const policy: EvolutionDecisionPolicy = { schemaVersion: 1, id: 'wait-aware-repeat-guard', repeatThreshold: 1, respectOpenWait: true, resetOnNewEvidence: true }
const trace = (candidateDigest: string): EvolutionReplayTrace => ({
  schemaVersion: 1, split: 'acceptance', baselineDigest: hash('baseline'), candidateDigest,
  engineVersion: 'test-engine/1', policyVersion: EVOLUTION_POLICY_VERSION, seed: 7,
  groups: Array.from({ length: 3 }, (_, groupIndex) => ({
    id: `G-${groupIndex}`, lineageId: hash(`lineage-${groupIndex}`), evidenceSequenceDigest: hash(`evidence-${groupIndex}`),
    steps: [
      { id: `G${groupIndex}-wait`, projectionDigest: hash(`wait-${groupIndex}`), artifactDigest: hash(`artifact-${groupIndex}`),
        baselineDecision: 'wait', expected: 'wait', severity: 'normal',
        waitHandle: { id: `delegation-${groupIndex}`, kind: 'tool', state: 'open' }, novelEvidence: false,
        operationalTokens: { actual: 10, estimated: 0, unknown: 0 }, evaluationTokens: { actual: 0, estimated: 0, unknown: 1 } },
      { id: `G${groupIndex}-first`, projectionDigest: hash(`repeat-${groupIndex}`), artifactDigest: hash(`artifact-${groupIndex}`),
        baselineDecision: 'continue', expected: 'continue', severity: 'normal', novelEvidence: false,
        operationalTokens: { actual: 10, estimated: 0, unknown: 0 }, evaluationTokens: { actual: 0, estimated: 0, unknown: 1 } },
      { id: `G${groupIndex}-second`, projectionDigest: hash(`repeat-${groupIndex}`), artifactDigest: hash(`artifact-${groupIndex}`),
        baselineDecision: 'continue', expected: 'stop', severity: 'severe', novelEvidence: false,
        operationalTokens: { actual: 10, estimated: 0, unknown: 0 }, evaluationTokens: { actual: 0, estimated: 0, unknown: 1 } }
    ]
  }))
})

describe('deterministic evolution evaluation', () => {
  it('replays only decisions, separates token ledgers, and exposes a conservative interval', () => {
    const result = runEvolutionEvaluation(trace(hash('candidate')), policy)
    expect(result).toMatchObject({ outcome: 'passed', deterministic: true, sideEffects: 0, networkCalls: 0,
      groupCount: 3, stepCount: 9, statisticalClaim: 'insufficient-independent-groups',
      metrics: { candidate: { falseStops: 0, legitimateWaitFalseStops: 0, falsePasses: 0, severeFalsePasses: 0, trueStops: 3, validWaits: 3 },
        baseline: { falseStops: 0, falsePasses: 3, trueStops: 0 } } })
    expect(new Set(result.replayDigests).size).toBe(1)
    expect(result.operationalTokens).toMatchObject({ actual: 90, estimated: 0, unknown: 0 })
    expect(result.evaluationTokens).toMatchObject({ actual: 0, estimated: 0, unknown: 9 })
    expect(getEvolutionUpper95(0, 30)).toBeGreaterThan(0.09)
    expect(getEvolutionUpper95(0, 30)).toBeLessThan(0.1)
    expect(() => getEvolutionUpper95(0, 0)).toThrow()
  })

  it('rejects non-acceptance traces and mutation of frozen labels or bound digests', () => {
    const development = { ...trace(hash('candidate')), split: 'development' as const }
    expect(runEvolutionEvaluation(development, policy).outcome).toBe('unavailable')
    expect(ValidateEvolutionReplayTrace(trace(hash('candidate')))).toBe(true)
    const tampered = structuredClone(trace(hash('candidate')))
    tampered.groups[0]!.steps[2]!.expected = 'continue'
    expect(runEvolutionEvaluation(tampered, { ...policy, respectOpenWait: false }).metrics.candidate.falseStops).toBe(1)
    expect(ValidateEvolutionReplayTrace({ ...tampered, groups: [...tampered.groups, tampered.groups[0]] })).toBe(false)
  })
})

describe('governance state machine and bounded persistence', () => {
  it('keeps evaluation, release, shadow, explicit Canary and revocation separate', async () => {
    let now = 1000
    const store = await createDurableStateStore<ExperienceState>({ directory: '/unused', enabled: false,
      initialState: { experiences: {} }, ...SWARM_LAYOUT_OPTIONS })
    const repository = createExperienceRepository(store, {
      now: () => now,
      verifyReview: () => true,
      verifyEvaluation: (_entry, result) => result.outcome === 'passed',
      verifyRelease: (_entry, release) => release.manifestDigest === hash('manifest'),
      verifyCanary: () => true
    })
    const candidate = await repository.addCandidate({
      problemClass: 'progress-policy', appliesWhen: ['frozen replay'], doesNotApplyWhen: ['security gate override'],
      conclusion: 'wait-aware repeat guard', verification: ['three grouped traces'], counterexamples: [], operatorVersions: ['1'],
      source: { taskId: 'T-1', cardRevision: 1, workflowRevision: 1, artifactDigest: hash('source'), authorId: 'author' },
      expiresAt: 10_000
    })
    const candidateDigest = repository.getExperienceDigest(candidate.id)!
    const result = runEvolutionEvaluation(trace(candidateDigest), policy)
    const request = (revision: number, id: string) => ({ expectedRevision: revision, requestId: id })
    expect((await repository.beginEvaluation(candidate.id, { ...request(1, 'begin'), traceDigest: result.traceDigest,
      baselineDigest: result.baselineDigest, candidateDigest })).governance?.phase).toBe('evaluating')
    now = 1001
    expect((await repository.recordEvaluation(candidate.id, result, review(), request(2, 'evaluate'))).governance)
      .toMatchObject({ phase: 'validated', evaluation: { state: 'passed' } })
    const release = { releaseId: 'r-1', version: '3.1.4', gitCommit: hash('commit').slice(0, 40), artifactSha256: candidateDigest,
      manifestDigest: hash('manifest'), policyVersion: EVOLUTION_POLICY_VERSION, previousVersion: '3.1.3', registeredAt: now }
    expect((await repository.registerRelease(candidate.id, release, request(3, 'release'))).governance?.phase).toBe('released')
    expect((await repository.startShadow(candidate.id, request(4, 'shadow'))).governance?.phase).toBe('shadow')
    expect((await repository.recordShadow(candidate.id, 'continue', request(5, 'shadow-sample'))).governance?.shadow.samples).toBe(1)
    const canaryScope: EvolutionCanaryScope = scope
    await expect(repository.requestCanary(candidate.id, { ...canaryScope, taskId: 'T-other' }, hash('stop-policy'), request(6, 'wrong-scope')))
      .rejects.toMatchObject({ code: 'EXPERIENCE_INVALID' })
    expect((await repository.requestCanary(candidate.id, canaryScope, hash('stop-policy'), request(6, 'canary-request'))).governance?.canary.state).toBe('awaiting_user')
    const noCanaryVerifier = createExperienceRepository(store, { now: () => now, verifyReview: () => true,
      verifyEvaluation: () => true, verifyRelease: () => true })
    await expect(noCanaryVerifier.authorizeCanary(candidate.id, canaryScope, 'untrusted-auth', hash('stop-policy'), request(7, 'canary-auth-rejected')))
      .rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
    expect((await repository.authorizeCanary(candidate.id, canaryScope, 'auth-live-1', hash('stop-policy'), request(7, 'canary-auth'))).governance?.canary.state).toBe('authorized')
    const beforeRestart = repository.get(candidate.id)!.governance!
    expect(recoverEvolutionGovernance(beforeRestart, 1100)).toMatchObject({ phase: 'reconcile-required', canary: { state: 'stopped' } })
    expect((await repository.activateCanary(candidate.id, request(8, 'canary-active'))).governance?.canary.state).toBe('active')
    expect((await repository.promoteCanary(candidate.id, 'bounded promotion', request(9, 'promote'))).governance?.phase).toBe('active')
    expect(repository.query({ text: 'wait-aware' }).matches.map(item => item.id)).toEqual([candidate.id])
    const duplicate = await repository.promoteCanary(candidate.id, 'bounded promotion', request(9, 'promote'))
    expect(duplicate.governance?.revision).toBe(10)
    await expect(repository.promoteCanary(candidate.id, 'different', request(9, 'promote'))).rejects.toMatchObject({ code: 'EXPERIENCE_CONFLICT' })
    now = 1002
    expect((await repository.revoke(candidate.id, 'safety violation', 0, request(10, 'revoke'))).status).toBe('deprecated')
    expect(repository.query({ text: 'wait-aware' }).matches).toEqual([])
    await expect(repository.promoteCanary(candidate.id, 'late', request(11, 'late'))).rejects.toMatchObject({ code: 'EXPERIENCE_CONFLICT' })
    expect(ValidateEvolutionGovernance(store.read().experiences[candidate.id]!.governance)).toBe(true)
    const recovered = recoverEvolutionGovernance(store.read().experiences[candidate.id]!.governance!, 2000)
    expect(recovered).toMatchObject({ phase: 'revoked', revoke: { state: 'complete', reason: 'safety violation' } })
    await store.dispose()
  })
})
