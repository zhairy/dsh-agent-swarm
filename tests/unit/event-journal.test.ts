import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createSwarmEventJournal, EVENT_JOURNAL_MAX_LINE_BYTES, reduceSwarmEvents } from '../../src/event-journal.js'

const directory = () => join(mkdtempSync(join(tmpdir(), 'swarm-events-')), 'events')
const event = (id: string, type: Parameters<ReturnType<typeof createSwarmEventJournal>['append']>[0]['type'] = 'ticket/state-changed') => ({
  eventId: id, idempotencyKey: `key-${id}`, ticketId: 'T-1', type,
  actor: { kind: 'router' as const, id: 'root' }, payload: { stage: 'running' }
})

describe('v3.2.0 event journal', () => {
  it('appends a monotonic checksum chain and deduplicates ids', () => {
    const journal = createSwarmEventJournal({ directory: directory(), rootSessionId: 'session-a', now: () => new Date('2026-01-01T00:00:00Z') })
    const first = journal.append(event('e1'))!
    const second = journal.append(event('e2'))!
    expect(first.previousDigest).toBe('GENESIS')
    expect(second.previousDigest).toBe(first.digest)
    expect(second.seq).toBe(2)
    expect(journal.append(event('e1'))).toBeUndefined()
  })

  it('redacts secrets, reduces the same view, and truncates an invalid tail', () => {
    const dir = directory()
    const journal = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-a' })
    journal.append({ ...event('e1'), payload: { stage: 'running', apiKey: 'secret-value', measuredTokens: 249_748, safeInputTokens: 139_904 } })
    journal.append({ ...event('e2', 'route/fallback'), payload: { route: 'codex/gpt', reason: 'quota' } })
    expect(readFileSync(journal.path, 'utf8')).not.toContain('secret-value')
    const events = journal.read().events
    expect(events[0]?.payload).toMatchObject({ measuredTokens: 249_748, safeInputTokens: 139_904 })
    expect(reduceSwarmEvents(events)).toMatchObject({ sequence: 2, tickets: { 'T-1': { stage: 'running' } }, routes: { 'codex/gpt': { failures: 1 } } })
    writeFileSync(journal.path, `${readFileSync(journal.path, 'utf8')}{"broken":`, 'utf8')
    const reopened = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-a' })
    expect(reopened.read()).toMatchObject({ issues: [{ reason: 'invalid-json' }] })
    expect(readFileSync(reopened.path, 'utf8').endsWith('\n')).toBe(true)
  })

  it('seals at the byte threshold and reopens a valid cross-segment digest chain', () => {
    const dir = directory()
    const journal = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-sealed', sealAfterBytes: 16_384 })
    const bulk = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`k${index}`, index]))
    for (let index = 1; index <= 6; index++) journal.append({ ...event(`e${index}`), payload: { stage: 'running', ...bulk } })
    expect(journal.segments().length).toBeGreaterThanOrEqual(2)
    const reopened = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-sealed', sealAfterBytes: 16_384 })
    const events = reopened.read().events
    expect(events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events[0]?.previousDigest).toBe('GENESIS')
    expect(events[1]?.previousDigest).toBe(events[0]?.digest)
    expect(events[5]?.previousDigest).toBe(events[4]?.digest)
    expect(reopened.read().issues).toEqual([])
  })

  it('enforces the configured line ceiling without creating a partial event', () => {
    const journal = createSwarmEventJournal({ directory: directory(), rootSessionId: 'session-line', maxLineBytes: 2048 })
    expect(() => journal.append({ ...event('too-large'), payload: { body: 'x'.repeat(EVENT_JOURNAL_MAX_LINE_BYTES) } })).toThrow(/line limit/i)
    expect(journal.read().events).toEqual([])
  })

  it('replays 100,000 events with a contiguous deterministic projection', { timeout: 60_000 }, () => {
    const dir = directory()
    try {
      const journal = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-100k', sealAfterBytes: 8 * 1024 * 1024 })
      for (let index = 1; index <= 100_000; index++) journal.append({ ...event(`bulk-${index}`), payload: { stage: `stage-${index}` } })
      const replay = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-100k', sealAfterBytes: 8 * 1024 * 1024 })
      const result = replay.read()
      expect(result.issues).toEqual([])
      expect(result.events).toHaveLength(100_000)
      expect(result.events.at(-1)?.seq).toBe(100_000)
      expect(result.events.at(-1)?.previousDigest).toMatch(/^[a-f0-9]{64}$/)
      expect(replay.project()).toMatchObject({ sequence: 100_000, tickets: { 'T-1': { stage: 'stage-100000' } } })
    } finally { rmSync(join(dir, '..'), { recursive: true, force: true }) }
  })
})
