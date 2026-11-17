import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectChildRecovery } from '../lib/host-recovery.js'

const fixture = jobs => ({ parentSessionId: 'parent', childId: 'child', notBefore: 10,
  catalog: [{ id: 'child', mode: 'continuable' }],
  inspection: { meta: { id: 'child', parentSession: 'parent' }, inheritedEventCount: 0, events: [
    { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'worker' } },
    { type: 'turn/start', time: 10, data: { turn: 1 } }, ...jobs,
    { type: 'turn/end', time: 30, data: { turn: 1, reason: { kind: 'completed' } } }
  ] } })
const registered = { type: 'job/registered', data: { jobId: 'job', owner: 'child', startedAt: 12, kind: 'bash', label: 'writer' } }
const settled = { type: 'job/settled', data: { ...registered.data, finishedAt: 20, status: 'completed', cause: 'producer', producerReported: true } }

test('cold writer: a completed model turn with an unsettled job is not settled execution', () => {
  const result = inspectChildRecovery(fixture([registered]))
  assert.equal(result.settled, false)
  assert.equal(result.writerQuiescent, false)
  assert.equal(result.reason, 'job-still-unsettled')
})
test('cold writer: producerReported=false is never a stop certificate', () => {
  for (const status of ['completed', 'killed', 'failed']) {
    const result = inspectChildRecovery(fixture([registered, { ...settled, data: { ...settled.data, status, producerReported: false } }]))
    assert.equal(result.settled, false)
    assert.equal(result.writerQuiescent, false)
  }
})
test('cold writer: even a complete job ledger or empty ledger does not certify resource quiescence', () => {
  for (const jobs of [[], [registered, settled]]) {
    const result = inspectChildRecovery(fixture(jobs))
    assert.equal(result.settled, true)
    assert.equal(result.writerQuiescent, false)
  }
})
test('cold writer: missing registrations and mismatched owners fail closed', () => {
  for (const jobs of [[settled], [registered, { ...settled, data: { ...settled.data, owner: 'other' } }]]) assert.equal(inspectChildRecovery(fixture(jobs)).settled, false)
})
