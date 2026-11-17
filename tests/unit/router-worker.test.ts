import { describe, expect, it } from 'vitest'
import { filterEvent, getRouterToolDenial, validateWorkerSubmission, type AssignmentEnvelope } from '../../src/router-worker.js'

const current = { requestRevision: 2, cardRevision: 3, workflowRevision: 4, leaseEpoch: 5 }
const event = {
  eventId: 'evt-1', idempotencyKey: 'key-1', kind: 'message', senderAgentId: 'child', rootAgentId: 'root',
  requestRevision: 2, cardRevision: 3, workflowRevision: 4, leaseEpoch: 5, current
}

describe('v3.2.0 event filter and router/worker boundary', () => {
  it('accepts a current event and rejects duplicates, loops and every stale identity', () => {
    const seen = new Set<string>()
    expect(filterEvent({ ...event, seen })).toEqual({ accepted: true })
    for (const overrides of [
      { eventId: 'evt', seen: new Set(['evt']) }, { senderAgentId: 'root', seen }, { kind: 'ignored', ignoredKinds: ['ignored'] },
      { requestRevision: 1 }, { cardRevision: 1 }, { workflowRevision: 1 }, { leaseEpoch: 1 }
    ]) expect(filterEvent({ ...event, seen, ...overrides }).accepted).toBe(false)
  })

  it('keeps the router read-only and prevents long blocking waits', () => {
    expect(getRouterToolDenial('write')).toContain('router cannot execute')
    expect(getRouterToolDenial('apply_patch')).toContain('router cannot execute')
    expect(getRouterToolDenial('bash', { command: 'sleep 60' })).toContain('long wait')
    expect(getRouterToolDenial('bash', { command: 'rg foo src' })).toBeUndefined()
    expect(getRouterToolDenial('read')).toBeUndefined()
  })

  it('accepts worker results only for the exact ticket, assignment, revisions, lease and input', () => {
    const envelope: AssignmentEnvelope = {
      ticketId: 'T-1', assignmentId: 'D-1', role: 'zhu_jian', workerKind: 'expert', provider: 'codex', model: 'gpt',
      requestRevision: 2, cardRevision: 3, workflowRevision: 4, leaseEpoch: 5, inputDigest: 'sha256:x', permissions: ['read', 'write'], createdAt: 1
    }
    const ok = { ticketId: 'T-1', assignmentId: 'D-1', requestRevision: 2, cardRevision: 3, workflowRevision: 4, leaseEpoch: 5, inputDigest: 'sha256:x' }
    expect(validateWorkerSubmission(envelope, ok)).toEqual({ accepted: true })
    for (const [key, value, reason] of [
      ['ticketId', 'T-2', 'ticket-mismatch'], ['assignmentId', 'D-2', 'assignment-mismatch'],
      ['requestRevision', 1, 'stale-request-revision'], ['cardRevision', 1, 'stale-card-revision'],
      ['workflowRevision', 1, 'stale-workflow-revision'], ['leaseEpoch', 1, 'stale-lease'], ['inputDigest', 'sha256:y', 'input-mismatch']
    ] as const) expect(validateWorkerSubmission(envelope, { ...ok, [key]: value })).toEqual({ accepted: false, reason })
  })
})
