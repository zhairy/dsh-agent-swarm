import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createSwarmEventJournal, reduceSwarmEvents } from '../../src/event-journal.js'

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

  it.each(['null', 'false', '0', '"not an event"', '[]', '{}'])('recovers a non-event JSON tail: %s', (tail) => {
    const dir = directory()
    const journal = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-a' })
    const first = journal.append(event('e1'))!
    const prefix = readFileSync(journal.path, 'utf8')
    writeFileSync(journal.path, `${prefix}${tail}\n`, 'utf8')

    const reopened = createSwarmEventJournal({ directory: dir, rootSessionId: 'session-a' })
    expect(reopened.read()).toEqual({ events: [first], issues: [{ line: 2, reason: 'invalid-shape' }] })
    expect(readFileSync(journal.path, 'utf8')).toBe(prefix)
    expect(reopened.project().sequence).toBe(1)
    const second = reopened.append(event('e2'))!
    expect(second.seq).toBe(2)
    expect(second.previousDigest).toBe(first.digest)
    expect(createSwarmEventJournal({ directory: dir, rootSessionId: 'session-a' }).read()).toEqual({ events: [first, second], issues: [] })
  })

})
