import { describe, expect, it } from 'vitest'
import { intTaskStore, type DelegationRecord, type TaskRecord } from '../../src/evidence.js'
import { intTicketRepository } from '../../src/domain/tickets/repository.js'
import type { TaskCard } from '../../src/policy.js'

const task = (): TaskRecord => ({ taskId: 'T-1', sessionId: 'root',
  card: { title: 'ticket', goal: 'goal', acceptance: ['done'], scope: [] } as TaskCard,
  gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: ['D-1', 'D-2'], rounds: 0, createdAt: 1, updatedAt: 7 })
const record = (id: string, status: 'failed' | 'completed', startedAt: number): DelegationRecord => ({
  delegationId: id, taskId: 'T-1', role: 'tan_wei', roleName: '探微', status, summary: '', evidence: [], attempts: [],
  independence: 'n/a', hardIsolation: true, unresolved: [], startedAt
})

describe('durable ticket snapshot restoration', () => {
  it('retains the committed index and timestamps even when records are stored in a different order', () => {
    const repository = intTicketRepository(intTaskStore())
    repository.RestoreSnapshot!([task()], [record('D-2', 'completed', 2), record('D-1', 'failed', 1)])
    expect(repository.getTask('T-1')?.updatedAt).toBe(7)
    expect(repository.getTaskDelegations('T-1').map((item) => item.delegationId)).toEqual(['D-1', 'D-2'])
    expect(repository.projection('T-1')?.stage).toEqual({ stage: 'person', action: 'review' })
  })

  it.each([
    ['missing record', [record('D-1', 'failed', 1)]],
    ['duplicate record', [record('D-1', 'failed', 1), record('D-1', 'failed', 1)]],
    ['wrong owner', [record('D-1', 'failed', 1), { ...record('D-2', 'completed', 2), taskId: 'T-2' }]]
  ])('rejects %s before publishing any part of the snapshot', (_name, records) => {
    const repository = intTicketRepository(intTaskStore())
    expect(() => repository.RestoreSnapshot!([task()], records)).toThrow()
    expect(repository.getTasks()).toEqual([])
    expect(repository.getDelegation('D-1')).toBeUndefined()
  })

  it('does not replace live state and retains ordinary lifecycle checks', () => {
    const repository = intTicketRepository(intTaskStore())
    repository.AddTask({ ...task(), delegationIds: [] })
    repository.AddDelegation(record('D-1', 'failed', 1))
    expect(() => repository.RestoreSnapshot!([task()], [record('D-1', 'failed', 1), record('D-2', 'completed', 2)])).toThrow()
    expect(() => repository.AddDelegation(record('D-2', 'completed', 2))).toThrow('不允许从 person:failed')
    expect(repository.getTaskDelegations('T-1').map((item) => item.delegationId)).toEqual(['D-1'])
  })
})
