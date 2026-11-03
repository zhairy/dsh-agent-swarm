import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { intTaskStore, type TaskRecord } from '../../src/evidence.js'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import type { TaskCard } from '../../src/policy.js'
import { importFeatureStateToJournal } from '../../src/state-import.js'

const card = { title: '迁移任务', goal: '导入历史状态', acceptance: ['保留事实'], scope: ['src'] } as TaskCard
const task: TaskRecord = {
  taskId: 'T-1', sessionId: 'root', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0,
  createdAt: 1, updatedAt: 2, cardRevision: 2, workflowRevision: 3, requestRevision: 4,
  acceptance: { decision: 'accept', status: 'accepted', summary: '通过', missing: [], unresolved: [], stopReason: 'ok', resolutions: [], at: 3 }
}

describe('legacy committed-state importer', () => {
  it('imports a deterministic ticket projection and writes a private manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-state-import-'))
    try {
      const store = intTaskStore(); store.AddTask(task)
      const journal = createSwarmEventJournal({ directory: join(directory, 'events'), rootSessionId: 'root', now: () => new Date(10) })
      const input = { journal, store, rootSessionId: 'root', workspaceId: 'workspace', sourcePath: join(directory, 'state'), schemaVersion: 2, now: () => new Date(20) }
      const first = importFeatureStateToJournal(input)
      expect(first).toMatchObject({ imported: 1, skipped: 0, unrecoverable: [], projectionMismatches: [] })
      expect(journal.project().tickets['T-1']?.stage).toBe('ended:accepted')
      expect(journal.read().events).toHaveLength(1)
      const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8')) as Record<string, unknown>
      expect(manifest).toMatchObject({ kind: 'legacy-state-import', rootSessionId: 'root', workspaceId: 'workspace', taskCount: 1, imported: 1, projectionMismatches: [] })
      expect(JSON.stringify(manifest)).not.toContain('导入历史状态')
      expect(JSON.stringify(manifest)).not.toContain('保留事实')

      const second = importFeatureStateToJournal(input)
      expect(second).toMatchObject({ imported: 0, skipped: 1, projectionMismatches: [] })
      expect(journal.read().events).toHaveLength(1)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
