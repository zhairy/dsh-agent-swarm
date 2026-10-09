import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { createFeatureSession, validateFeatureState } from '../../src/feature-session.js'
import { intTaskStore, type TaskRecord } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'
import { createDurableStateStore } from '../../src/state-store.js'
import type { AgentControlRecord } from '../../src/agent-control.js'
import { ValidateTaskCard } from '../../src/policy.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
const fixtureCard = () => ValidateTaskCard({ title: 'epoch fixture', goal: 'persist one consistent state',
  acceptance: ['same snapshot epoch'], scope: [], flags: {} }).card!

describe('whole-state transaction invariants', () => {
  it('does not combine pre-queue task revisions with later context revisions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'swarm-state-epochs-'))
    const tasks = intTaskStore(), threads = intThreadRegistry()
    const features = await createFeatureSession({ rootSessionId: 'epoch-root', cwd: home, dshHome: home,
      config: getSwarmConfig({ persistence: { enabled: false } }), tasks, threads, now: () => 1 })
    cleanup.push(async () => { await features.dispose(); await rm(home, { recursive: true, force: true }) })
    const task: TaskRecord = { taskId: 'T-1', sessionId: 'epoch-root', workspaceId: features.workspaceId,
      card: fixtureCard(),
      gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1,
      cardRevision: 1, workflowRevision: 1, requestRevision: 1 }
    tasks.AddTask(task)
    await features.persist('fixture/initial', tasks, threads)

    const entered = deferred(), release = deferred()
    const blockingCommit = features.store.commit('fixture/queue-blocker', async () => { entered.resolve(); await release.promise })
    await entered.promise
    // The queued persistence call starts with revision 1. A concurrent host
    // status/intent refresh then advances both the task and its material to 2.
    const queued = features.persist('fixture/queued', tasks, threads)
    const queuedResult = queued.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }))
    tasks.UpdateTask(task.taskId, { requestRevision: 2 })
    const artifact = features.addContext({ binding: { rootSessionId: task.sessionId, workspaceId: features.workspaceId,
      taskId: task.taskId, cardRevision: 1, workflowRevision: 1, requestRevision: 2 },
      layer: 'L1', kind: 'source', text: 'new user intent' })
    tasks.UpdateTask(task.taskId, { contextRefs: [{ ref: artifact.ref, digest: artifact.digest, layer: artifact.layer, kind: artifact.kind }] })
    release.resolve()
    await blockingCommit
    expect(await queuedResult).toEqual({ ok: true })
    expect(validateFeatureState(features.store.read(), { rootSessionId: task.sessionId, workspaceId: features.workspaceId })).toBe(true)
    // The first call commits its own detached snapshot rather than accidentally
    // publishing another operation's not-yet-committed contract transaction.
    expect(features.store.read().tasks[0]?.requestRevision).toBe(1)
    expect(features.store.read().contexts).toEqual([])
    // A later full persist must contain the latest intent with its matching
    // context, without a restart.
    await features.persist('fixture/latest', tasks, threads)
    expect(features.store.read().tasks[0]?.requestRevision).toBe(2)
    expect(features.store.read().contexts[0]?.binding.requestRevision).toBe(2)
  })

  it('rejects an invalid draft without poisoning later valid commits', async () => {
    const store = await createDurableStateStore({ directory: '/unused-state-invariant-fixture', enabled: false,
      initialState: { version: 1 }, validate: (raw) => Number.isSafeInteger((raw as { version?: unknown })?.version)
        && Number((raw as { version: number }).version) > 0 })
    cleanup.push(() => store.dispose())
    await expect(store.commit('fixture/invalid', () => ({ version: 0 }))).rejects.toMatchObject({ code: 'STATE_INVALID', message: 'State schema validation failed' })
    expect(store.read()).toEqual({ version: 1 })
    expect(store.getSequence()).toBe(0)
    await expect(store.commit('fixture/valid', (draft) => { draft.version = 2 })).resolves.toEqual({ version: 2 })
    expect(store.getSequence()).toBe(1)
  })

  it('does not combine a pre-queue delegation index with a later child control', async () => {
    const home = await mkdtemp(join(tmpdir(), 'swarm-state-control-epochs-'))
    const tasks = intTaskStore(), threads = intThreadRegistry()
    let controls: AgentControlRecord[] = []
    const features = await createFeatureSession({ rootSessionId: 'control-epoch-root', cwd: home, dshHome: home,
      config: getSwarmConfig({ persistence: { enabled: false } }), tasks, threads, now: () => 1,
      getAgentControls: () => structuredClone(controls) })
    cleanup.push(async () => { await features.dispose(); await rm(home, { recursive: true, force: true }) })
    tasks.AddTask({ taskId: 'T-1', sessionId: 'control-epoch-root', workspaceId: features.workspaceId,
      card: fixtureCard(),
      gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1,
      cardRevision: 1, workflowRevision: 1, requestRevision: 1 })
    await features.persist('fixture/initial', tasks, threads)
    const entered = deferred(), release = deferred()
    const blocker = features.store.commit('fixture/queue-blocker', async () => { entered.resolve(); await release.promise })
    await entered.promise
    const queued = features.persist('fixture/control-queued', tasks, threads)
    const queuedResult = queued.then(() => ({ ok: true }), (error: unknown) => ({ ok: false, error }))
    tasks.AddDelegation({ taskId: 'T-1', delegationId: 'D-1', role: 'tan_wei', roleName: '探微', status: 'failed', summary: '',
      attempts: [], hardIsolation: true, independence: 'n/a',
      unresolved: [], evidence: [], startedAt: 1, cardRevision: 1, workflowRevision: 1, requestRevision: 1 })
    controls = [{ childId: 'control-child', parentSessionId: 'control-epoch-root', taskId: 'T-1', delegationId: 'D-1',
      persistent: true, revision: 1, phase: 'paused', paused: true, updatedAt: 1,
      cardRevision: 1, workflowRevision: 1, requestRevision: 1 }]
    release.resolve()
    await blocker
    expect(await queuedResult).toEqual({ ok: true })
    expect(validateFeatureState(features.store.read(), { rootSessionId: 'control-epoch-root', workspaceId: features.workspaceId })).toBe(true)
    expect(features.store.read().delegations).toEqual([])
    expect(features.store.read().agentControls).toEqual([])
    await features.persist('fixture/control-latest', tasks, threads)
    expect(features.store.read().agentControls?.[0]?.delegationId).toBe('D-1')
    expect(features.store.read().delegations[0]?.delegationId).toBe('D-1')
  })
})
