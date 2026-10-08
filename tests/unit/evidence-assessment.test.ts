import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assessExplorationEvidence, getEvidenceConsumptionNotice, revalidateEvidenceAssessment, validateEvidenceAssessment, type EvidenceAssessmentInput } from '../../src/evidence-assessment.js'
import type { DelegationRecord } from '../../src/evidence.js'
import type { JevAskOutcome, JevClient } from '../../src/jev.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
const score = (value = 3, confidence = 0.9) => ({ type: 'score', score: value, confidence, probabilities: { '0': value === 0 ? 1 : 0, '1': value === 1 ? 1 : 0, '2': value === 2 ? 1 : 0, '3': value === 3 ? 1 : 0 } })
const outcome = (credibility = score(), relevance = score(), relation = 'supports'): JevAskOutcome => ({ ok: true, model: 'jev-test', attempts: 1, usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 1, answers: { credibility, relevance, support: { type: 'choice', choice: relation, confidence: 0.9 } } })
const setup = async (role: 'tan_wei' | 'bo_wen' = 'tan_wei') => {
  const cwd = await mkdtemp(join(tmpdir(), 'swarm-evidence-assessment-')); directories.push(cwd)
  await mkdir(join(cwd, 'src'))
  await writeFile(join(cwd, 'src', 'math.ts'), 'export function stableSum(values: number[]) { return values.reduce((sum, value) => sum + value, 0) }\n')
  await writeFile(join(cwd, 'package.json'), '{"name":"current-project","version":"2.3.0","dependencies":{"math-lib":"2.0.0"}}')
  const record = { delegationId: 'D-1', taskId: 'T-1', role, roleName: role, status: 'completed', summary: '核对求和与当前任务的关系',
    structured: role === 'tan_wei' ? { findings: [{ path: 'src/math.ts', symbol: 'stableSum', callChain: [], evidence: 'stableSum 使用 reduce 求和' }], confidence: 1, relevance: 1 }
      : { sources: [{ url: 'https://docs.math-lib.org/api', title: 'API', date: '2026-10-08', version: '2.0.0', points: ['库提供求和方法'] }], reliability: 1 },
    evidence: [], attempts: [], hardIsolation: true, unresolved: [], startedAt: 1000 } as unknown as DelegationRecord
  const input: EvidenceAssessmentInput = { cwd, binding: { rootSessionId: 'root', workspaceId: 'workspace', taskId: 'T-1', cardRevision: 1, workflowRevision: 1, requestRevision: 1, artifactDigest: 'a'.repeat(64) },
    goal: '为项目验证求和算法', acceptance: ['核对实现和误差'], scope: ['src/math.ts'], record }
  return input
}

describe('independent source credibility and project applicability assessment', () => {
  it('uses actual project code, manifest versions and independent Jev axes instead of explorer self ratings', async () => {
    const input = await setup()
    const ask = vi.fn<JevClient['ask']>(async () => outcome())
    const assessment = await assessExplorationEvidence(input, { ask, now: () => 1000 })
    expect(assessment).toMatchObject({ status: 'ok', disposition: 'usable', confidenceMeaning: 'distribution-concentration-not-correctness', rawRetained: true })
    expect(validateEvidenceAssessment(assessment)).toBe(true)
    expect(assessment?.items[0]?.credibility).toMatchObject({ status: 'known', score: 1, confidence: 0.9 })
    expect(assessment?.items[0]?.relevance).toMatchObject({ status: 'known', score: 1, confidence: 0.9 })
    const state = ask.mock.calls[0]?.[0] as unknown as { project: { codeReferences: Array<{ excerpt: string }>; manifest: { excerpt: string } } }
    expect(state.project.codeReferences[0]?.excerpt).toContain('values.reduce')
    expect(state.project.manifest.excerpt).toContain('2.3.0')
    expect(JSON.stringify(state)).not.toContain('"confidence":1')
    expect(getEvidenceConsumptionNotice(assessment, input.binding, 1000).mayUseForImplementation).toBe(true)
  })

  it('quarantines a credible but unrelated source without converting confidence into correctness', async () => {
    const input = await setup()
    const assessment = await assessExplorationEvidence(input, { ask: async () => outcome(score(3), score(0)), now: () => 1000 })
    expect(assessment?.items[0]).toMatchObject({ credibility: { score: 1 }, relevance: { score: 0 }, disposition: 'quarantined', reasons: ['low-project-relevance'] })
    expect(getEvidenceConsumptionNotice(assessment, input.binding, 1000).mayUseForImplementation).toBe(false)
  })

  it('retains strongly evidenced dissent and source counterexamples instead of filtering by majority agreement', async () => {
    const input = await setup()
    const supported = await assessExplorationEvidence(input, { ask: async () => outcome(), now: () => 1000 })
    expect(supported?.disposition).toBe('usable')
    const contradiction = await assessExplorationEvidence(input, { ask: async () => outcome(score(), score(), 'contradicts'), now: () => 1000 })
    expect(contradiction?.items[0]).toMatchObject({ disposition: 'quarantined', contraryEvidenceRetained: true, support: { relation: 'contradicts' }, source: { status: 'observed' } })
    expect(contradiction?.items[0]?.source.supportingText).toContain('values.reduce')
    expect(contradiction?.rawRetained).toBe(true)
  })

  it('keeps missing configuration, network failure and malformed judgments explicitly unknown', async () => {
    const input = await setup()
    for (const reason of ['missing-api-key', 'network', 'timeout', 'disabled']) {
      const assessment = await assessExplorationEvidence(input, { ask: async () => ({ ok: false, reason, attempts: 0 }), now: () => 1000 })
      expect(assessment).toMatchObject({ status: 'unknown', disposition: 'needs-review' })
      expect(assessment?.items[0]?.credibility).toEqual({ status: 'unknown', reason })
    }
    const malformed = await assessExplorationEvidence(input, { ask: async () => outcome({ ...score(), score: NaN }, score()), now: () => 1000 })
    expect(malformed?.items[0]?.credibility.status).toBe('unknown')
    expect(malformed?.disposition).toBe('needs-review')
  })

  it('does not fabricate provenance when an agent invents a path or a URL without fetched original text', async () => {
    const local = await setup()
    ;(local.record.structured as { findings: Array<{ path: string }> }).findings[0]!.path = '../outside.ts'
    const bad = await assessExplorationEvidence(local, { ask: async () => outcome(), now: () => 1000 })
    expect(bad?.items[0]?.credibility).toMatchObject({ status: 'unknown', reason: 'unsafe-or-sensitive-code-reference' })
    const external = await setup('bo_wen')
    const missing = await assessExplorationEvidence(external, { ask: async () => outcome(), now: () => 1000 })
    expect(missing?.items[0]?.credibility).toMatchObject({ status: 'unknown', reason: 'source-original-not-observed' })
    expect(missing?.items[0]?.relevance.status).toBe('known')
    expect(missing?.items[0]?.judgments.credibility.status).toBe('known')
  })

  it('assesses host-captured external original text with freshness and real code fingerprints', async () => {
    const input = await setup('bo_wen')
    const resolveSource = vi.fn(async () => ({ text: 'math-lib 2.0.0 provides sum(values).', retrievedAt: 1000, version: '2.0.0' }))
    const assessment = await assessExplorationEvidence(input, { ask: async () => outcome(), resolveSource, now: () => 1000 })
    expect(assessment?.items[0]).toMatchObject({ source: { status: 'observed', observedVersion: '2.0.0' }, disposition: 'usable' })
    const old = await assessExplorationEvidence(input, { ask: async () => outcome(), resolveSource: async () => ({ text: 'original source', retrievedAt: 1 }), now: () => 5000, policy: { maxAgeMs: 1000 } })
    expect(old?.items[0]?.credibility.reason).toBe('source-capture-too-old')
  })

  it('marks persisted scores stale when code, manifest, request identity or age changes', async () => {
    const input = await setup()
    const assessment = await assessExplorationEvidence(input, { ask: async () => outcome(), now: () => 1000 })
    expect((await revalidateEvidenceAssessment(assessment, input, { now: () => 1000 })).status).toBe('current')
    expect(getEvidenceConsumptionNotice(assessment, { ...input.binding, requestRevision: 2 }, 1000).status).toBe('stale')
    expect(getEvidenceConsumptionNotice(assessment, input.binding, 10000, { maxAgeMs: 1000 }).status).toBe('stale')
    await writeFile(join(input.cwd, 'src', 'math.ts'), 'export function stableSum() { return 999 }')
    const changed = await revalidateEvidenceAssessment(assessment, input, { now: () => 1000 })
    expect(changed).toMatchObject({ status: 'stale', requiresVerification: true, mayUseForImplementation: false, reasons: ['project-code-fingerprint-changed'] })
  })

  it('focuses source support near real symbols, keeps all claim results and leaves Jev requests uncapped', async () => {
    const input = await setup()
    await writeFile(join(input.cwd, 'src', 'math.ts'), '// prefix\n'.repeat(2000) + 'export function stableSum(values: number[]) { return values.reduce((a,b)=>a+b,0) }')
    ;(input.record.structured as { findings: unknown[] }).findings = Array.from({ length: 20 }, () => ({ path: 'src/math.ts', symbol: 'stableSum', callChain: [], evidence: 'stableSum uses reduce' }))
    const ask = vi.fn<JevClient['ask']>(async () => outcome())
    const assessed = await assessExplorationEvidence(input, { ask, now: () => 1000 })
    expect(assessed?.items).toHaveLength(20)
    expect(assessed?.codeReferences).toHaveLength(2)
    expect(ask).toHaveBeenCalledTimes(20)
    expect(assessed?.items[19]?.source.supportingText).toContain('function stableSum')
  })

  it('rejects malformed restored assessments and never trusts favorable stored flags alone', async () => {
    const input = await setup()
    const assessment = (await assessExplorationEvidence(input, { ask: async () => outcome(), now: () => 1000 }))!
    for (const mutate of [
      (value: typeof assessment) => { value.items[0]!.credibility.probabilities = { '0': 1, '1': 1, '2': 1, '3': 1 } },
      (value: typeof assessment) => { value.items[0]!.source.status = 'unknown' },
      (value: typeof assessment) => { value.items.push(structuredClone(value.items[0]!)) },
      (value: typeof assessment) => { value.codeReferences[0]!.excerpt += 'tampered' },
      (value: typeof assessment) => { value.projectDigest = 'b'.repeat(64) },
      (value: typeof assessment) => { value.items[0]!.judgments.credibility = { status: 'unknown', score: 1, reason: 'missing' } }
    ]) {
      const corrupted = structuredClone(assessment); mutate(corrupted)
      expect(validateEvidenceAssessment(corrupted)).toBe(false)
      expect(getEvidenceConsumptionNotice(corrupted, input.binding, 1000).mayUseForImplementation).toBe(false)
    }
    const low = (await assessExplorationEvidence(input, { ask: async () => outcome(score(1), score(1)), now: () => 1000, policy: { minimumCredibility: 0, minimumRelevance: 0, quarantineBelow: 0 } }))!
    expect(low.disposition).toBe('usable')
    expect(getEvidenceConsumptionNotice(low, input.binding, 1000)).toMatchObject({ status: 'current', disposition: 'quarantined', mayUseForImplementation: false })
  })

  it('keeps private runtime files, symlink escapes and source URL credentials out of Jev state', async () => {
    const input = await setup()
    await mkdir(join(input.cwd, '.state'))
    await writeFile(join(input.cwd, '.state', 'secret.json'), '{"private":"private runtime material"}')
    await symlink(join(input.cwd, '.state', 'secret.json'), join(input.cwd, 'src', 'alias.ts'))
    ;(input.record.structured as { findings: Array<{ path: string }> }).findings[0]!.path = 'src/alias.ts'
    const ask = vi.fn<JevClient['ask']>(async () => outcome())
    const assessment = await assessExplorationEvidence(input, { ask, now: () => 1000, privatePaths: ['.state'] })
    expect(assessment?.items[0]?.credibility).toMatchObject({ status: 'unknown', reason: 'private-runtime-reference' })
    expect(JSON.stringify(ask.mock.calls)).not.toContain('private runtime material')
    const web = await setup('bo_wen')
    ;(web.record.structured as { sources: Array<{ url: string }> }).sources[0]!.url = 'https://alice:private-password@docs.example.org/'
    const webAsk = vi.fn<JevClient['ask']>(async () => outcome())
    await assessExplorationEvidence(web, { ask: webAsk, now: () => 1000 })
    expect(JSON.stringify(webAsk.mock.calls)).not.toContain('private-password')
  })

  it('rejects a score that disagrees with its own probability distribution', async () => {
    const input = await setup()
    const assessment = await assessExplorationEvidence(input, { ask: async () => outcome({ ...score(0), score: 3 }, score()), now: () => 1000 })
    expect(assessment?.items[0]?.credibility).toEqual({ status: 'unknown', reason: 'malformed-jev-distribution' })
  })

  it.each(['.env', '.env.production', '.aws/config', '.git/config', '.codex/settings'])('rejects a sensitive canonical %s target behind an ordinary source alias', async (target) => {
    const input = await setup()
    const path = join(input.cwd, target)
    const segments = target.split('/')
    if (segments.length > 1) await mkdir(join(input.cwd, ...segments.slice(0, -1)), { recursive: true })
    await writeFile(path, 'UNRELATED_SETTING=private-marker-not-for-model\n')
    await symlink(path, join(input.cwd, 'src', 'alias.ts'))
    ;(input.record.structured as { findings: Array<{ path: string }> }).findings[0]!.path = 'src/alias.ts'
    const ask = vi.fn<JevClient['ask']>(async () => outcome())
    const assessment = await assessExplorationEvidence(input, { ask, now: () => 1000 })
    expect(assessment?.items[0]?.credibility).toMatchObject({ status: 'unknown', reason: 'unsafe-or-sensitive-code-reference' })
    expect(JSON.stringify(ask.mock.calls)).not.toContain('private-marker-not-for-model')
  })

  it('records rejected or unavailable original-source retrieval as unknown without trusting optimistic Jev scores', async () => {
    const input = await setup('bo_wen')
    const assessment = await assessExplorationEvidence(input, { ask: async () => outcome(), now: () => 1000, resolveSource: async () => { throw Object.assign(new Error('private target'), { code: 'SOURCE_ADDRESS_REJECTED' }) } })
    expect(assessment?.items[0]).toMatchObject({ credibility: { status: 'unknown', reason: 'SOURCE_ADDRESS_REJECTED' }, source: { status: 'unknown', reason: 'SOURCE_ADDRESS_REJECTED' }, disposition: 'needs-review' })
  })
})
