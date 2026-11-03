import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import { appendLegacyEventToJournal, importLegacyLedgerEvents, LEGACY_JOURNAL_PAYLOAD_MAX_BYTES } from '../../src/ledger-event-bridge.js'
import { importLegacyLedgerFile } from '../../src/event-import.js'

describe('legacy ledger to event journal bridge', () => {
  it('imports supported facts idempotently and records unsupported records', () => {
    const journal = createSwarmEventJournal({ directory: join(mkdtempSync(join(tmpdir(), 'swarm-bridge-')), 'events'), rootSessionId: 'session-a' })
    const events = [
      { ts: '2026-01-01T00:00:00.000Z', sessionId: 'session-a', type: 'route/fallback' as const, taskId: 'T-1', delegationId: 'D-1', data: { from: 'codex/a', to: 'antigravity/b' } },
      { ts: '2026-01-01T00:00:01.000Z', sessionId: 'session-a', type: 'jev/call' as const, data: { ok: true } }
    ]
    expect(importLegacyLedgerEvents(journal, events)).toEqual({ imported: 2, skipped: 0, unsupported: 0 })
    expect(importLegacyLedgerEvents(journal, events)).toEqual({ imported: 0, skipped: 2, unsupported: 0 })
    expect(journal.read().events).toMatchObject([
      { type: 'route/fallback', ticketId: 'T-1', assignmentId: 'D-1', actor: { kind: 'router' } },
      { type: 'evidence/recorded', actor: { kind: 'worker' } }
    ])
  })

  it('mirrors native worktree creation as a worker-bound event with pinned Git identity', () => {
    const journal = createSwarmEventJournal({ directory: join(mkdtempSync(join(tmpdir(), 'swarm-worktree-bridge-')), 'events'), rootSessionId: 'session-b' })
    appendLegacyEventToJournal(journal, {
      ts: '2026-11-02T00:00:00.000Z', sessionId: 'session-b', type: 'worktree/created', taskId: 'T-2', delegationId: 'D-2',
      data: { path: '/repo/.agents/worktrees/ticket', branch: 'ticket', baseCommit: 'abc123', repositoryRoot: '/repo', agentId: 'child-1' }
    })
    expect(journal.read().events).toMatchObject([{
      type: 'worktree/bound', ticketId: 'T-2', assignmentId: 'D-2', actor: { kind: 'worker', id: 'D-2' }, payload: { legacyType: 'worktree/created' }
    }])
  })

  it('imports a legacy ledger file with a content-free manifest and no payload leakage', () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-import-'))
    const ledgerPath = join(home, 'ledger.jsonl')
    const secretMessage = 'Authorization: Bearer secret-token-value'
    writeFileSync(ledgerPath, [
      JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', sessionId: 'session-c', type: 'task/card', taskId: 'T-1', data: { title: 'x' } }),
      JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', sessionId: 'session-other', type: 'task/card', taskId: 'T-2', data: { title: 'outside' } }),
      JSON.stringify({ ts: '2026-01-01T00:00:02.000Z', sessionId: 'session-c', type: 'route/fallback', data: { message: secretMessage } }),
      '{broken'
    ].join('\n'), 'utf8')
    const journal = createSwarmEventJournal({ directory: join(home, 'events'), rootSessionId: 'session-c' })
    const result = importLegacyLedgerFile({ ledgerPath, journal, rootSessionId: 'session-c', now: () => new Date('2026-01-01T00:00:03Z') })
    expect(result).toMatchObject({ imported: 2, skipped: 0, unsupported: 0, invalidLines: 1, rejectedLines: 1 })
    expect(journal.read().events).toHaveLength(2)
    const manifest = readFileSync(result.manifestPath!, 'utf8')
    expect(manifest).toContain('sourceDigest')
    expect(manifest).not.toContain('secret-token-value')
    expect(manifest).not.toContain('"title"')
  })

  it('replaces an oversized legacy payload with a digest-bound summary instead of failing the session', () => {
    const journal = createSwarmEventJournal({ directory: join(mkdtempSync(join(tmpdir(), 'swarm-bridge-large-')), 'events'), rootSessionId: 'session-large' })
    const large = Array.from({ length: 300 }, (_, index) => `evidence-${index}-${'x'.repeat(160)}`)
    const event = { ts: '2026-01-01T00:00:00.000Z', sessionId: 'session-large', type: 'workflow/checkpoint' as const,
      taskId: 'T-1', delegationId: 'D-1', data: { evidenceRefs: large, nested: { summary: 'kept metadata only' } } }
    expect(Buffer.byteLength(JSON.stringify(event.data))).toBeGreaterThan(LEGACY_JOURNAL_PAYLOAD_MAX_BYTES)
    expect(() => appendLegacyEventToJournal(journal, event)).not.toThrow()
    expect(journal.read()).toMatchObject({ issues: [], events: [{ ticketId: 'T-1', assignmentId: 'D-1', payload: {
      legacyType: 'workflow/checkpoint', legacyDataTruncated: true, legacyDataBytes: expect.any(Number), legacyDataSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      legacyDataKeyCount: 2, legacyDataSample: [{ key: 'evidenceRefs', kind: 'array', size: 300 }, { key: 'nested', kind: 'object' }]
    } }] })
    expect(JSON.stringify(journal.read().events[0]!.payload)).not.toContain('x'.repeat(100))
  })

  it('bounds oversized key names so the recovery summary itself cannot exceed the journal line limit', () => {
    const journal = createSwarmEventJournal({ directory: join(mkdtempSync(join(tmpdir(), 'swarm-bridge-key-')), 'events'), rootSessionId: 'session-key' })
    const hugeKey = `secret-${'k'.repeat(70 * 1024)}`
    const event = { ts: '2026-01-01T00:00:00.000Z', sessionId: 'session-key', type: 'workflow/checkpoint' as const,
      taskId: 'T-1', data: { [hugeKey]: true } }
    expect(() => appendLegacyEventToJournal(journal, event)).not.toThrow()
    const appended = journal.read().events[0]!
    expect(Buffer.byteLength(`${JSON.stringify(appended)}\n`)).toBeLessThan(64 * 1024)
    expect(JSON.stringify(appended.payload)).not.toContain('k'.repeat(200))
  })
})
