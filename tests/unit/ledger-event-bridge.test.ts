import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import { appendLegacyEventToJournal } from '../../src/ledger-event-bridge.js'

describe('legacy ledger to event journal bridge', () => {
  it('mirrors supported facts and ignores unrelated records', () => {
    const journal = createSwarmEventJournal({ directory: join(mkdtempSync(join(tmpdir(), 'swarm-bridge-')), 'events'), rootSessionId: 'session-a' })
    appendLegacyEventToJournal(journal, { ts: '2026-01-01T00:00:00.000Z', sessionId: 'session-a', type: 'route/fallback', taskId: 'T-1', delegationId: 'D-1', data: { from: 'codex/a', to: 'antigravity/b' } })
    appendLegacyEventToJournal(journal, { ts: '2026-01-01T00:00:01.000Z', sessionId: 'session-a', type: 'jev/call', data: { ok: true } })
    expect(journal.read().events).toMatchObject([{ type: 'route/fallback', ticketId: 'T-1', assignmentId: 'D-1', actor: { kind: 'router' } }])
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
})
