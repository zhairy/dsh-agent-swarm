import { describe, expect, it } from 'vitest'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import type { TaskCard } from '../../src/policy.js'
import { evaluateProactiveAdmission, projectTicketLifecycle, revalidateMandate, type Mandate } from '../../src/domain/tickets/lifecycle.js'

const card = { title: 'Ticket', goal: 'goal', acceptance: ['done'], scope: ['src'] } as TaskCard
const task = (acceptance?: TaskRecord['acceptance']): TaskRecord => ({
  taskId: 'T-1', sessionId: 's', card, gates: [], triage: { source: 'rules', rulesApplied: [] },
  delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1, ...(acceptance === undefined ? {} : { acceptance })
})
const delegation = (id: string, status: DelegationRecord['status']): DelegationRecord => ({
  delegationId: id, taskId: 'T-1', role: 'zhu_jian', roleName: '铸剑', status, summary: '', evidence: [],
  attempts: [], hardIsolation: true, unresolved: [], startedAt: Number(id.slice(1))
})

describe('v3.2.0 ticket lifecycle', () => {
  it('projects every task phase without inventing a success state', () => {
    expect(projectTicketLifecycle(task(), []).stage).toEqual({ stage: 'created' })
    expect(projectTicketLifecycle(task(), [delegation('D1', 'queued')]).stage).toEqual({ stage: 'working', action: 'queued' })
    expect(projectTicketLifecycle(task(), [delegation('D1', 'running')]).stage).toEqual({ stage: 'working', action: 'running' })
    expect(projectTicketLifecycle(task(), [delegation('D1', 'completed')]).stage).toEqual({ stage: 'person', action: 'review' })
    expect(projectTicketLifecycle(task(), [delegation('D1', 'blocked')])).toMatchObject({ stage: { stage: 'person', action: 'blocked' }, canRetry: true })
    expect(projectTicketLifecycle(task(), [delegation('D1', 'failed')])).toMatchObject({ stage: { stage: 'person', action: 'failed' }, canRetry: true })
    expect(projectTicketLifecycle(task({ decision: 'accept', status: 'accepted', summary: '', missing: [], unresolved: [], stopReason: 'ok', resolutions: [], at: 2 }), [])).toMatchObject({ stage: { stage: 'ended', outcome: 'accepted' }, canRetry: false })
  })

  it('keeps explicit requests separate and defaults inferred work to observe', () => {
    const base = { mode: 'observe' as const, matchedRules: ['rule'], enabledRules: ['rule'], budgetAvailable: true, hostPermitted: true }
    expect(evaluateProactiveAdmission({ ...base, strength: 'explicit' })).toEqual({ kind: 'accept', mandateRequired: true })
    expect(evaluateProactiveAdmission({ ...base, strength: 'inferred' })).toEqual({ kind: 'observe', wouldAccept: true, reason: 'observe-mode' })
    expect(evaluateProactiveAdmission({ ...base, mode: 'off', strength: 'inferred' })).toEqual({ kind: 'ignore', reason: 'off-mode' })
    expect(evaluateProactiveAdmission({ ...base, mode: 'auto', strength: 'inferred' })).toEqual({ kind: 'accept', mandateRequired: true })
    expect(evaluateProactiveAdmission({ ...base, mode: 'auto', strength: 'inferred', hostPermitted: false })).toEqual({ kind: 'ignore', reason: 'host-denied' })
  })

  it('revalidates inferred mandates when policy or matched rules change', () => {
    const mandate: Mandate = { id: 'M-1', strength: 'inferred', policyVersion: 'p1', scope: ['src'], matchedRules: ['rule'], originTriggerId: 'E-1', createdAt: 1 }
    expect(revalidateMandate(mandate, { mode: 'observe', enabledRules: ['rule'] }, 2)).toBe(false)
    expect(revalidateMandate(mandate, { mode: 'auto', enabledRules: ['other'] }, 2)).toBe(false)
    expect(revalidateMandate(mandate, { mode: 'auto', enabledRules: ['rule'] }, 2)).toBe(true)
  })
})
