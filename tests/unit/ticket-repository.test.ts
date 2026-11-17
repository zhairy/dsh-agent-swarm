import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../../src/evidence.js'
import { intTaskStore } from '../../src/evidence.js'
import type { TaskCard } from '../../src/policy.js'
import { intTicketRepository } from '../../src/domain/tickets/repository.js'

const card = { title: 'ticket', goal: 'goal', acceptance: ['done'], scope: ['src'] } as TaskCard
const task: TaskRecord = {
  taskId: 'T-1', sessionId: 'root', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0,
  createdAt: 1, updatedAt: 1, cardRevision: 1, workflowRevision: 1, requestRevision: 1,
  acceptance: { decision: 'accept', status: 'accepted', summary: '', missing: [], unresolved: [], stopReason: 'ok', resolutions: [], at: 2 }
}

describe('ticket repository', () => {
  it('rejects an accepted ticket reopening without a contract revision', () => {
    const repository = intTicketRepository(intTaskStore())
    repository.AddTask(task)
    expect(() => repository.UpdateTask('T-1', { acceptance: undefined })).toThrow('不允许从 ended:accepted')
    expect(repository.getTask('T-1')?.acceptance?.status).toBe('accepted')
  })

  it('allows an accepted ticket to reopen only when a revision changes', () => {
    const repository = intTicketRepository(intTaskStore())
    repository.AddTask(task)
    expect(repository.UpdateTask('T-1', { cardRevision: 2, acceptance: undefined })).toMatchObject({ cardRevision: 2 })
    expect(repository.projection('T-1')).toMatchObject({ revisions: { card: 2 }, stage: { stage: 'created' } })
  })
})
