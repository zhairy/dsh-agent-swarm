import { describe, expect, it } from 'vitest'
import { validateFeatureState } from '../../src/feature-session.js'
import { getInitialEvolutionGovernance } from '../../src/evolution-governance.js'

const fixture = () => {
  const tasks = ['T-1', 'T-2'].map((taskId) => ({ taskId, sessionId: 'root', card: { title: 'audit', goal: 'audit', acceptance: ['verify'], scope: [], flags: {} }, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [] as string[], rounds: 0, createdAt: 0, updatedAt: 0 }))
  const delegations = tasks.map((task, index) => {
    const delegationId = 'D-' + index
    task.delegationIds.push(delegationId)
    return { delegationId, taskId: task.taskId, role: 'mou_ding', status: 'failed', summary: '', unresolved: [], evidence: [], startedAt: 0 }
  })
  return { schemaVersion: 1, tasks, delegations, threads: [], budgets: {}, contexts: [], bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {} }
}
const expected = { rootSessionId: 'root', workspaceId: 'workspace' }

describe('saved task/delegation association validation', () => {
  it('reads legacy v1 without candidates and rejects activated or malformed candidate metadata on recovery', () => {
    const state = fixture()
    const id = '123e4567-e89b-42d3-a456-426614174000'
    const candidate = { id, problemClass: 'tool-candidate', conclusion: 'quarantined only', source: { taskId: 'T-1', cardRevision: 1, workflowRevision: 1, artifactDigest: 'a'.repeat(64) }, appliesWhen: ['finite scope'], doesNotApplyWhen: [], verification: [], counterexamples: [], operatorVersions: ['1'], status: 'candidate', createdAt: 1, expiresAt: 2,
      toolCandidate: { kind: 'tool', version: '1', artifactRefs: ['proposal.md'], permissions: [], testRefs: ['regression'], rollback: 'Discard', evaluation: 'unavailable', executionEnabled: false } }
    Object.assign(state.experiences, { [id]: candidate })
    expect(validateFeatureState(state, expected)).toBe(true)
    candidate.toolCandidate.executionEnabled = true
    expect(validateFeatureState(state, expected)).toBe(false)
    candidate.toolCandidate.executionEnabled = false
    candidate.status = 'validated'
    expect(validateFeatureState(state, expected)).toBe(false)
  })
  it('accepts a complete one-to-one task ownership index, including an empty task', () => {
    const state = fixture()
    expect(validateFeatureState(state, expected)).toBe(true)
    state.delegations.pop(); state.tasks[1]!.delegationIds = []
    expect(validateFeatureState(state, expected)).toBe(true)
  })

  it('validates governance ownership and status coupling without allowing tool candidates to activate', () => {
    const state = fixture()
    const id = '123e4567-e89b-42d3-a456-426614174000'
    const entry = { id, problemClass: 'progress-policy', conclusion: 'bounded', source: { taskId: 'T-1', cardRevision: 1, workflowRevision: 1, artifactDigest: 'a'.repeat(64) },
      appliesWhen: ['frozen'], doesNotApplyWhen: ['override'], verification: ['test'], counterexamples: [], operatorVersions: ['1'],
      status: 'candidate' as const, createdAt: 1, expiresAt: 100, governance: getInitialEvolutionGovernance(1) }
    Object.assign(state.experiences, { [id]: entry })
    expect(validateFeatureState(state, expected)).toBe(true)
    entry.governance.phase = 'active'
    expect(validateFeatureState(state, expected)).toBe(false)
    entry.governance.phase = 'candidate'
    Object.assign(entry, { toolCandidate: { kind: 'tool', version: '1', artifactRefs: ['x'], permissions: [], testRefs: ['t'], rollback: 'r', evaluation: 'unavailable', executionEnabled: false } })
    expect(validateFeatureState(state, expected)).toBe(false)
    delete (entry as { toolCandidate?: unknown }).toolCandidate
    Object.assign(entry, { id: 'different-id' })
    expect(validateFeatureState(state, expected)).toBe(false)
  })

  it.each(['missing-id', 'extra-record', 'cross-task', 'duplicate-id', 'duplicate-record'] as const)('rejects %s without weakening schema or ownership checks', (kind) => {
    const state = fixture()
    if (kind === 'missing-id') state.tasks[0]!.delegationIds = []
    if (kind === 'extra-record') state.delegations.pop()
    if (kind === 'cross-task') state.tasks[0]!.delegationIds = [state.tasks[1]!.delegationIds[0]!]
    if (kind === 'duplicate-id') state.tasks[0]!.delegationIds.push(state.tasks[0]!.delegationIds[0]!)
    if (kind === 'duplicate-record') state.delegations.push({ ...state.delegations[0]! })
    expect(validateFeatureState(state, expected)).toBe(false)
  })
})
