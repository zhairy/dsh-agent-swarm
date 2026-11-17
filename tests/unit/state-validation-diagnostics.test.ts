import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectFeatureState, validateFeatureState } from '../../src/feature-session.js'
import { createDurableStateStore, type StateValidationResult } from '../../src/state-store.js'
import { intContextStore, type ContextArtifactInfo } from '../../src/context-store.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { assessExplorationEvidence } from '../../src/evidence-assessment.js'
import { createExecutionBudget, type ExecutionBudgetSnapshot } from '../../src/execution-budget.js'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import type { AgentControlRecord } from '../../src/agent-control.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const close: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of close.splice(0)) await action() })
const privateMarker = 'PRIVATE_STATE_VALUE_DO_NOT_EXPOSE'
const expected = { rootSessionId: 'private-root-' + privateMarker, workspaceId: 'private-workspace-' + privateMarker }
const fixture = async () => {
  const task: TaskRecord = { taskId: 'private-task-' + privateMarker, sessionId: expected.rootSessionId,
    workspaceId: expected.workspaceId, card: ValidateTaskCard({ title: privateMarker, goal: 'check current source',
      acceptance: ['validate binding'], scope: [], flags: {} }).card!, gates: [], triage: { source: 'rules', rulesApplied: [] },
    delegationIds: ['private-delegation-' + privateMarker], rounds: 0, createdAt: 1, updatedAt: 1,
    cardRevision: 1, workflowRevision: 1, requestRevision: 1 }
  const record: DelegationRecord = { delegationId: task.delegationIds[0]!, taskId: task.taskId, role: 'tan_wei', roleName: '探微',
    status: 'completed', summary: privateMarker, unresolved: [], evidence: [], structured: structuredClone(VALID_OUTPUTS.tan_wei),
    attempts: [], hardIsolation: true, independence: 'n/a', startedAt: 1,
    cardRevision: 1, workflowRevision: 1, requestRevision: 1, artifactAfter: 'a'.repeat(64) }
  record.evidenceAssessment = await assessExplorationEvidence({ cwd: '/unused-state-diagnostic-fixture',
    binding: { ...expected, taskId: task.taskId, cardRevision: 1, workflowRevision: 1, requestRevision: 1, artifactDigest: record.artifactAfter! },
    goal: task.card.goal, acceptance: task.card.acceptance, scope: [], record },
  { ask: async () => ({ ok: false, reason: 'disabled', attempts: 0 }), now: () => 1 })
  const state = { schemaVersion: 1, tasks: [task], delegations: [record], threads: [],
    contexts: [] as ContextArtifactInfo[], budgets: {} as Record<string, ExecutionBudgetSnapshot>, planningBudgets: {},
    agentControls: [] as AgentControlRecord[], bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {} }
  expect(inspectFeatureState(state, expected)).toEqual({ ok: true })
  return state
}

describe('safe whole-state validation diagnostics', () => {
  it.each(['cardRevision', 'workflowRevision', 'requestRevision'] as const)('locates assessment %s mismatch without exposing saved values', async (key) => {
    const state = await fixture()
    state.delegations[0]!.evidenceAssessment!.binding[key] = 2
    const result = inspectFeatureState(state, expected)
    expect(result).toEqual({ ok: false, issues: [{ path: `$.delegations[0].evidenceAssessment.binding.${key}`, code: 'ASSESSMENT_REVISION_MISMATCH' }] })
    expect(validateFeatureState(state, expected)).toBe(false)
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })

  it('locates a context revision ahead of its task', async () => {
    const state = await fixture()
    state.contexts.push(intContextStore().Add({ binding: { ...expected, taskId: state.tasks[0]!.taskId,
      cardRevision: 1, workflowRevision: 1, requestRevision: 2 }, layer: 'L1', kind: 'source', text: privateMarker }))
    expect(inspectFeatureState(state, expected)).toEqual({ ok: false, issues: [{ path: '$.contexts[0].binding.requestRevision', code: 'CONTEXT_AHEAD_OF_TASK' }] })
  })

  it('locates a missing context mapping target without logging its private map key', async () => {
    const state = await fixture()
    state.tasks[0]!.contextDelegations = { [privateMarker]: state.delegations[0]!.delegationId }
    const result = inspectFeatureState(state, expected)
    expect(result).toEqual({ ok: false, issues: [{ path: '$.tasks[0].contextDelegations[0]', code: 'CONTEXT_MAPPING_TARGET_MISSING' }] })
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })

  it('locates an orphaned persistent child control', async () => {
    const state = await fixture()
    state.agentControls.push({ childId: privateMarker, parentSessionId: expected.rootSessionId,
      taskId: state.tasks[0]!.taskId, delegationId: 'missing-' + privateMarker, persistent: true,
      revision: 1, phase: 'paused', paused: true, updatedAt: 1, cardRevision: 1, workflowRevision: 1, requestRevision: 1 })
    expect(inspectFeatureState(state, expected)).toEqual({ ok: false, issues: [{ path: '$.agentControls[0].delegationId', code: 'CONTROL_DELEGATION_MISSING' }] })
  })

  it('locates invalid budget usage without copying the task key or underlying error text', async () => {
    const state = await fixture()
    const budget = createExecutionBudget().getSnapshot()
    budget.jev.attempts = -1
    state.budgets[state.tasks[0]!.taskId] = budget
    const result = inspectFeatureState(state, expected)
    expect(result).toEqual({ ok: false, issues: [{ path: '$.budgets[0]', code: 'BUDGET_FORMAT' }] })
    expect(JSON.stringify(result)).not.toContain(privateMarker)
  })

  it('locates malformed completed structured output', async () => {
    const state = await fixture()
    state.delegations[0]!.structured = { malformed: privateMarker }
    expect(inspectFeatureState(state, expected)).toEqual({ ok: false, issues: [{ path: '$.delegations[0].structured', code: 'STRUCTURED_OUTPUT_FORMAT' }] })
  })

  it('uses one validator pass per store commit and remains writable after a rejected draft', async () => {
    const validate = vi.fn((raw: unknown): StateValidationResult => (raw as { version: number }).version > 0
      ? { ok: true } : { ok: false, issues: [{ path: '$.version', code: 'VERSION_INVALID' }] })
    const store = await createDurableStateStore({ directory: '/unused-state-diagnostic-store', enabled: false,
      initialState: { version: 1 }, validate })
    close.push(() => store.dispose())
    expect(validate).toHaveBeenCalledTimes(1)
    await expect(store.commit('fixture/invalid', () => ({ version: 0 }))).rejects.toMatchObject({
      code: 'STATE_INVALID', message: 'State schema validation failed ($.version: VERSION_INVALID)' })
    expect(validate).toHaveBeenCalledTimes(2)
    expect(store.getSequence()).toBe(0)
    await expect(store.commit('fixture/valid', () => ({ version: 2 }))).resolves.toEqual({ version: 2 })
    expect(validate).toHaveBeenCalledTimes(3)
  })

  it('drops unsafe diagnostic locations and rule text instead of echoing them', async () => {
    const store = await createDurableStateStore({ directory: '/unused-state-diagnostic-sanitize', enabled: false,
      initialState: { version: 1 }, validate: (raw) => (raw as { version: number }).version > 0
        ? true : { ok: false, issues: [{ path: `$.tasks["${privateMarker}"]`, code: 'INVALID: ' + privateMarker }] } })
    close.push(() => store.dispose())
    await expect(store.commit('fixture/invalid', () => ({ version: 0 }))).rejects.toMatchObject({
      code: 'STATE_INVALID', message: 'State schema validation failed' })
  })
})
