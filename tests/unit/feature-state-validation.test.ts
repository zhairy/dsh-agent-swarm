import { describe, expect, it } from 'vitest'
import { validateFeatureState } from '../../src/feature-session.js'

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
  it('accepts a complete one-to-one task ownership index, including an empty task', () => {
    const state = fixture()
    expect(validateFeatureState(state, expected)).toBe(true)
    state.delegations.pop(); state.tasks[1]!.delegationIds = []
    expect(validateFeatureState(state, expected)).toBe(true)
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
