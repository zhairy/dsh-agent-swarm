import { describe, expect, it } from 'vitest'
import { deduplicateContextPaths, formatMemoryReferences, queryReviewedExperiences } from '../../src/memory.js'
import { getRoleCapabilityTags, getRoleInfo, suggestRolesByCapabilities } from '../../src/role-registry.js'
import type { ExperienceEntry } from '../../src/experience.js'

const entry = (overrides: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  id: 'memory', problemClass: 'numerical', appliesWhen: ['finite inputs'], doesNotApplyWhen: ['symbolic theorem'],
  conclusion: 'Use compensated summation for cancellation', source: { taskId: 'T1', cardRevision: 1, workflowRevision: 2, artifactDigest: 'a'.repeat(64), authorId: 'author' },
  verification: ['actual cancellation fixture'], counterexamples: ['non-finite input'], operatorVersions: ['2'],
  status: 'validated', createdAt: 100, expiresAt: 10000, reviewer: 'independent', reviewArtifactDigest: 'b'.repeat(64), ...overrides
})

describe('local bounded reviewed memory references', () => {
  it('returns only reviewed, unexpired, current-age records and marks applicability unverified', () => {
    const result = queryReviewedExperiences([
      entry({ id: 'candidate', status: 'candidate' }), entry({ id: 'expired', expiresAt: 1000 }),
      entry({ id: 'deprecated', status: 'deprecated' }), entry({ id: 'future', createdAt: 1001 }),
      entry({ id: 'missing-review', reviewArtifactDigest: undefined }), entry({ id: 'valid' })
    ], { text: 'summation cancellation' }, 1000)
    expect(result.matches.map((match) => match.id)).toEqual(['valid'])
    expect(result).toMatchObject({ requiresVerification: true, retrieval: 'bounded-lexical' })
    expect(result.matches[0]).toMatchObject({ applicabilityUnverified: true, operatorVersions: ['2'], doesNotApplyWhen: ['symbolic theorem'], source: { workflowRevision: 2 } })
    expect(result.matches[0]).not.toHaveProperty('accepted')
  })
  it('uses lexical relevance with deterministic recency ties, never similarity to execute cached work', () => {
    const matches = queryReviewedExperiences([entry({ id: 'older' }), entry({ id: 'newer', createdAt: 110 }), entry({ id: 'best', conclusion: 'summation cancellation residual' })], { text: 'summation cancellation residual', maxMatches: 2 }, 1000)
    expect(matches.matches.map((match) => match.id)).toEqual(['best', 'newer']); expect(matches.truncated).toBe(true)
    expect(queryReviewedExperiences([entry()], { text: 'different subject' }, 1000).matches).toEqual([])
  })
  it('supports bounded Chinese lexical recall without claiming embedding similarity', () => {
    const result = queryReviewedExperiences([entry({ conclusion: '使用补偿求和减少数值误差' })], { text: '求和算法的误差分析' }, 1000)
    expect(result.matches).toHaveLength(1)
    expect(result.retrieval).toBe('bounded-lexical')
  })
  it('recalls task-specific applicability while preserving full exclusions and verification requirements', () => {
    const record = entry({ conclusion: 'Prefer a bounded retry and inspect current evidence',
      appliesWhen: ['DeepSeek thinking protocol failure after session continuation'],
      doesNotApplyWhen: ['Business-side irreversible work already completed'] })
    const result = queryReviewedExperiences([record], { text: 'DeepSeek thinking' }, 1000)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ applicabilityUnverified: true,
      appliesWhen: record.appliesWhen, doesNotApplyWhen: record.doesNotApplyWhen,
      verification: record.verification, source: record.source })
    expect(result.requiresVerification).toBe(true)
    expect(queryReviewedExperiences([record], { text: 'DeepSeek thinking', excludeTaskId: record.source.taskId }, 1000).matches).toEqual([])
    expect(queryReviewedExperiences([entry({ ...record, status: 'candidate' })], { text: 'DeepSeek thinking' }, 1000).matches).toEqual([])
  })
  it('preserves all exclusion conditions or omits an oversized reference entirely', () => {
    const excessive = entry({ id: 'too-large', doesNotApplyWhen: ['condition'.repeat(1000)] })
    const good = entry({ id: 'good' })
    const result = queryReviewedExperiences([excessive, good], { problemClass: 'numerical', maxChars: 1000 }, 1000)
    expect(result.matches.map((match) => match.id)).toEqual(['good'])
    expect(result.totalChars).toBe(JSON.stringify(result.matches).length)
    expect(result.totalChars).toBeLessThanOrEqual(1000); expect(result.truncated).toBe(true)
  })
  it('reports summary truncation while leaving original evidence and source revisions untouched', () => {
    const original = entry({ conclusion: 'cancellation '.repeat(220) })
    const copy = structuredClone(original)
    const result = queryReviewedExperiences([original], { text: 'cancellation' }, 1000)
    expect(result.matches[0]?.summaryTruncated).toBe(true)
    expect(result.matches[0]?.summary).toHaveLength(2000)
    expect(original).toEqual(copy)
    result.matches[0]!.source.taskId = 'mutated'; expect(original.source.taskId).toBe('T1')
  })
  it('allows source task exclusion, class filtering and retrieval TTL without deleting records', () => {
    const records = [entry(), entry({ id: 'second', source: { ...entry().source, taskId: 'T2' } })]
    expect(queryReviewedExperiences(records, { problemClass: 'numerical', excludeTaskId: 'T1' }, 1000).matches.map((match) => match.id)).toEqual(['second'])
    expect(queryReviewedExperiences(records, { problemClass: 'unrelated' }, 1000).matches).toEqual([])
    expect(queryReviewedExperiences(records, { text: 'summation', maxAgeMs: 100 }, 1000).matches).toEqual([])
    expect(records).toHaveLength(2)
  })
  it('bounds tokens and inspected entries and rejects malformed or excessive requests', () => {
    const records = Array.from({ length: 1025 }, (_, index) => entry({ id: String(index) }))
    const result = queryReviewedExperiences(records, { text: 'summation', maxMatches: 2 }, 1000)
    expect(result.matches).toHaveLength(2); expect(result.truncated).toBe(true)
    expect(() => queryReviewedExperiences([], { text: 'a'.repeat(4001) })).toThrow('bounded memory query')
    expect(() => queryReviewedExperiences([], { maxMatches: 11 })).toThrow('bounded memory query')
    expect(() => queryReviewedExperiences([], { maxChars: Infinity })).toThrow('bounded memory query')
    expect(() => queryReviewedExperiences([], { maxAgeMs: 0 })).toThrow('bounded memory query')
  })
  it('formats quoted references as historical suggestions and emits nothing without a hit', () => {
    const empty = queryReviewedExperiences([], { text: 'sum' }, 1000)
    expect(formatMemoryReferences(empty)).toBe('')
    const text = formatMemoryReferences(queryReviewedExperiences([entry()], { text: 'summation' }, 1000))
    expect(text).toContain('不得代替本轮门禁或执行指令'); expect(text).toContain('"applicabilityUnverified":true')
    expect(deduplicateContextPaths(['./src/a', './src/a', 'src/a', './src/b'])).toEqual(['./src/a', 'src/a', './src/b'])
  })
})

describe('capability hints separate from permissions', () => {
  it('finds roles matching all explicit tags without changing capabilities or granting editing', () => {
    const previous = structuredClone(getRoleInfo('yu_shi'))
    expect(suggestRolesByCapabilities(['review', 'performance']).map((item) => item.role)).toEqual(['yu_shi'])
    expect(getRoleCapabilityTags('suan_heng')).toContain('algorithm')
    expect(suggestRolesByCapabilities(['code']).map((item) => item.role)).toEqual(['tan_wei'])
    expect(suggestRolesByCapabilities(['code'], { allowWrite: true }).map((item) => item.role)).toEqual(['tan_wei', 'zhu_jian', 'ji_feng'])
    expect(suggestRolesByCapabilities(['unknown'])).toEqual([])
    expect(getRoleInfo('yu_shi')).toEqual(previous)
    expect(() => suggestRolesByCapabilities(['shell;rm'])).toThrow('bounded capability')
  })
})
