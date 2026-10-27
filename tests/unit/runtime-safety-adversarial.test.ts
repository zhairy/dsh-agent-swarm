import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import { SWARM_SERVICE, type AgentLike, type CallConfigLike, type PluginContextLike } from '../../src/host-contract.js'
import { apply as applyRuntime } from '../../src/runtime.js'
import * as FeatureSessions from '../../src/feature-session.js'
import * as Artifacts from '../../src/artifacts.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'
import { getValueDigest } from '../../src/workflow.js'

const fixtures: Array<{ home: string; service: SwarmService; expectedWriteFailure: boolean }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    try { await fixture.service.dispose() } catch (error) {
      if (!fixture.expectedWriteFailure) throw error
      expect(error).toBeInstanceOf(AggregateError)
    }
    await rm(fixture.home, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const makeFixture = async (durable = false, pendingChild?: Promise<unknown>) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-independent-runtime-guard-'))
  const config = getSwarmConfig({ jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false },
    persistence: { enabled: durable }, agents: { session: 'oneshot', maxRetries: 0 } })
  let features!: FeatureSessions.FeatureSession
  const original = FeatureSessions.createFeatureSession
  vi.spyOn(FeatureSessions, 'createFeatureSession').mockImplementation(async input => { features = await original(input); return features })
  const root: AgentLike = { id: 'independent-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const goal = { id: 'independent-goal', revision: 1, phase: 'active' as const, activation: 'armed' as const, roundsStarted: 0, maxGoalRounds: 1000 }
  let hasGoal = true
  let child = 0
  const service = intSwarmService({ getConfig: () => config, dshHome: home,
    getLlm: () => undefined, getCredentials: () => undefined, getAttachments: () => undefined,
    getGoals: () => ({ get: () => hasGoal ? goal : undefined, disarm: () => hasGoal ? goal : undefined }),
    getGoalBinding: () => hasGoal ? getValueDigest({ root: root.id, goal: goal.id, revision: goal.revision }) : undefined,
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => [{ name: 'read' }] }),
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
      start: async () => ({ id: `independent-child-${++child}`, result: (pendingChild ?? Promise.resolve()).then(() => ({ structured: VALID_OUTPUTS.miao_bi, output: [], stopReason: 'completed' })), dispose: async () => undefined }) }),
    probe: async () => ({ ok: true as const, vision: true }), gitStatus: async () => undefined,
    fetch: async () => { throw new Error('Independent runtime probes forbid network') } })
  const cleanup = { home, service, expectedWriteFailure: false }; fixtures.push(cleanup)
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  const card = (scope: string[], goalText = '核对两个必需产出的完整结果') => ({ title: '独立反方任务', goal: goalText, acceptance: ['需要当前独立交付'], scope, flags: { uiCopy: true } })
  const create = async (scope: string[]) => service.AddTaskCard(card(scope), exec())
  const accepted = async (scope: string[]) => {
    const task = await create(scope)
    const produced = await service.delegate({ task_id: task.task_id, role: 'miao_bi', prompt: '提交独立交付', backend: 'api', session: 'oneshot' }, exec())
    expect(produced.status).toBe('completed')
    const receipt = await service.AcceptTask({ task_id: task.task_id, decision: 'accept', summary: '独立产出已核对', stopReason: '当前任务完成' }, exec())
    expect(receipt.status).toBe('accepted')
    return task
  }
  return { home, config, root, goal, service, exec, card, create, accepted, features: () => features, cleanup, setGoalAvailable: (value: boolean) => { hasGoal = value },
    complete: () => service.BeforeManagedTool({ name: 'update_goal', arguments: { action: 'complete' }, agent: root, signal: new AbortController().signal }) }
}

describe('independent public runtime guard adversaries', () => {
  it('an accepted task from an older distinct goal is historical rather than a required receipt of the replacement goal', async () => {
    const f = await makeFixture()
    await f.accepted([])
    await expect(f.complete()).resolves.toBeUndefined()
    f.goal.id = 'independent-new-goal'
    f.goal.revision = 1
    await f.accepted([])
    await expect(f.complete()).resolves.toBeUndefined()
  })

  it('a new revision of the same goal still invalidates its existing receipt instead of treating it as different-goal history', async () => {
    const f = await makeFixture()
    await f.accepted([])
    await expect(f.complete()).resolves.toBeUndefined()
    f.goal.revision++
    await expect(f.complete()).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
  })

  it('a legacy task without a server goal identity cannot silently disappear from replacement-goal completion', async () => {
    const f = await makeFixture()
    f.setGoalAvailable(false)
    const legacy = await f.accepted([])
    expect(f.features().store.read().tasks.find(task => task.taskId === legacy.task_id)?.runtimeGoalId).toBeUndefined()
    f.setGoalAvailable(true)
    f.goal.id = 'independent-new-goal'
    await f.accepted([])
    await expect(f.complete()).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
  })
  it('historical phase receipt does not replace or invalidate the later complete-goal receipt', async () => {
    const f = await makeFixture()
    await writeFile(join(f.home, 'phase.txt'), 'phase one')
    const phase = await f.service.AddTaskCard({ ...f.card(['phase.txt']), planningScope: { kind: 'phase', deliverables: ['当前阶段产出'], deferred: ['后续完整交付'], rationale: '分阶段验证后统一验收' } }, f.exec())
    await f.service.delegate({ task_id: phase.task_id, role: 'miao_bi', prompt: '提交当前阶段', backend: 'api', session: 'oneshot' }, f.exec())
    expect(await f.service.AcceptTask({ task_id: phase.task_id, decision: 'accept', summary: '仅本阶段', stopReason: '阶段完成' }, f.exec())).toMatchObject({ status: 'accepted' })
    await expect(f.complete()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await writeFile(join(f.home, 'phase.txt'), 'final integrated artifact')
    await f.accepted(['phase.txt'])
    await expect(f.complete()).resolves.toBeUndefined()
  })
  it('one valid receipt cannot hide another required accepted task whose real artifact changed', async () => {
    const f = await makeFixture()
    await writeFile(join(f.home, 'one.txt'), 'first artifact')
    await writeFile(join(f.home, 'two.txt'), 'second artifact')
    await f.accepted(['one.txt'])
    await f.accepted(['two.txt'])
    await expect(f.complete()).resolves.toBeUndefined()
    await writeFile(join(f.home, 'one.txt'), 'changed after its accepted receipt')
    await expect(f.complete()).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
  })

  it('a task revision committed while goal completion reads artifacts invalidates that completion', async () => {
    const f = await makeFixture()
    await writeFile(join(f.home, 'source.txt'), 'stable artifact')
    const task = await f.accepted(['source.txt'])
    const entered = deferred(), release = deferred()
    const original = Artifacts.getArtifactSnapshot
    let paused = false
    vi.spyOn(Artifacts, 'getArtifactSnapshot').mockImplementation(async (...args) => {
      if (!paused) { paused = true; entered.resolve(); await release.promise }
      return original(...args)
    })
    const pending = f.complete(); void pending.catch(() => undefined)
    await entered.promise
    let edited = false
    const update = f.service.AddTaskCard({ ...f.card(['source.txt'], '变更后的实际任务要求'), task_id: task.task_id }, f.exec()).then(() => { edited = true })
    await Promise.race([update, new Promise(resolve => setTimeout(resolve, 30))])
    const changedDuringGuard = edited
    release.resolve()
    const [completion, revision] = await Promise.allSettled([pending, update])
    expect(revision.status).toBe('fulfilled')
    // Serializing the entire check is also valid; the existing unlocked path
    // must reject a revision that is already committed before its check ends.
    if (changedDuringGuard) expect(completion.status).toBe('rejected')
  })

  it('new domain IDs in real observed JSON are evidence, not transport identifiers to erase', async () => {
    const f = await makeFixture()
    const task = await f.create(['data.json'])
    for (const id of ['record-A', 'record-B', 'record-C']) {
      const body = JSON.stringify({ customer: { id, amount: 7 } })
      await writeFile(join(f.home, 'data.json'), body)
      f.service.ObserveManagedToolResult({ name: 'read', agent: f.root, arguments: { file_path: 'data.json' } }, { isError: false, content: [{ type: 'text', text: body }] })
      const next = await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
      expect(next.kind, `real data changed to ${id}`).toBe('enter')
    }
    expect(f.features().progress.forTask(task.task_id)?.status).toBe('active')
  })

  it('new real read evidence after the array preview limit must still change the observed digest', async () => {
    const f = await makeFixture()
    const task = await f.create(['data.json'])
    for (const tail of ['tail-A', 'tail-B', 'tail-C']) {
      const body = JSON.stringify([...Array.from({ length: 128 }, (_, id) => ({ id, value: 'stable' })), { id: 128, value: tail }])
      await writeFile(join(f.home, 'data.json'), body)
      f.service.ObserveManagedToolResult({ name: 'read', agent: f.root, arguments: { file_path: 'data.json' } }, { isError: false, content: [{ type: 'text', text: body }] })
      expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind, `real suffix changed to ${tail}`).toBe('enter')
    }
    expect(f.features().progress.forTask(task.task_id)?.status).toBe('active')
  })

  it('durable progress write failure keeps the existing swarm_status diagnostic tool available', async () => {
    const f = await makeFixture(true)
    const task = await f.create([])
    await f.service.BeforeManagedTool({ name: 'read', arguments: { file_path: 'README.md' }, agent: f.root })
    const journal = join(f.features().store.directory, 'journal.jsonl')
    const trap = join(f.home, 'trap-log')
    await writeFile(trap, 'unchanged')
    await unlink(journal)
    await symlink(trap, journal)
    f.cleanup.expectedWriteFailure = true
    f.service.ObserveManagedToolResult({ name: 'read', arguments: { file_path: 'README.md' }, agent: f.root }, { isError: false, content: [{ type: 'text', text: 'new observed evidence' }] })
    await expect(f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: task.task_id }, agent: f.root })).resolves.toBeUndefined()
    expect(f.service.getStatus({ task_id: task.task_id }, f.exec()).tasks).toHaveLength(1)
    expect(await readFile(trap, 'utf8')).toBe('unchanged')
  })

  it('repeated pure status reads do not allocate progress activations or signatures', async () => {
    const f = await makeFixture()
    const task = await f.create([])
    await f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: task.task_id }, agent: f.root })
    const initial = f.features().progress.forTask(task.task_id)
    for (let i = 0; i < 12; i++) {
      await f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: task.task_id }, agent: f.root })
      f.service.getStatus({ task_id: task.task_id }, f.exec())
    }
    const final = f.features().progress.forTask(task.task_id)
    expect(final?.activations).toBe(initial?.activations)
    expect(final?.historyCount).toBe(initial?.historyCount)
  })

  it('a ready parallel node cannot make unrelated root model rounds exempt from progress admission', async () => {
    const childDone = deferred(), f = await makeFixture(false, childDone.promise)
    const running = await f.create([])
    const pending = f.service.delegate({ task_id: running.task_id, role: 'miao_bi', prompt: '等待本次真实交付', backend: 'api', session: 'oneshot' }, f.exec())
    void pending.catch(() => undefined)
    try {
      await vi.waitFor(() => expect(f.service.getStatus({}, f.exec()).tasks.some(task => task.delegations.some(record => record.status === 'running'))).toBe(true))
      const ready = await f.create([])
      await f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: ready.task_id }, agent: f.root })
      const before = f.features().progress.forTask(ready.task_id)?.activations ?? 0
      let admitted = 0
      for (let index = 0; index < 8; index++) {
        const next = await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
        if (next.kind !== 'enter') break
        await f.service.BeforeManagedRequest(f.root)
        admitted++
      }
      const after = f.features().progress.forTask(ready.task_id)?.activations ?? 0
      expect(admitted === 0 || after > before, `admitted=${admitted}, charged=${after - before}`).toBe(true)
    } finally { childDone.resolve(); await pending }
  })

  it('different calls to the same tool remain distinct root progress', async () => {
    const f = await makeFixture()
    const task = await f.create([])
    await f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: task.task_id }, agent: f.root })
    for (const filePath of ['a.ts', 'b.ts', 'c.ts']) {
      f.service.ObserveToolDispatch({ name: 'edit', arguments: { file_path: filePath }, agent: f.root })
      expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('enter')
    }
    expect(f.features().progress.forTask(task.task_id)?.status).toBe('active')
  })

  it('a direct goal resume reopens one bounded recovery window', async () => {
    const f = await makeFixture()
    const task = await f.create([])
    await f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: task.task_id }, agent: f.root })
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('enter')
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('enter')
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('reject')
    f.service.ObserveManagedMessage(f.root.id, {
      type: 'goal/change',
      data: { kind: 'goal/change', operation: 'resume', goal: { id: f.goal.id, revision: 2, phase: 'active' } }
    })
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('enter')
  })

  it('the actual registered runtime request hook stops before downstream model preparation after a structural loop', async () => {
    const f = await makeFixture()
    const task = await f.create([])
    await f.service.BeforeManagedTool({ name: 'swarm_status', arguments: { task_id: task.task_id }, agent: f.root })
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('enter')
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('enter')
    expect((await f.service.BeforeManagedStep(f.root, { kind: 'enter', messages: [] })).kind).toBe('reject')
    const hooks = new Map<string, (...args: never[]) => unknown>()
    const ctx: PluginContextLike = { get: name => name === SWARM_SERVICE ? f.service : undefined,
      provide: () => () => undefined, effect: () => undefined, on: (name, listener) => { hooks.set(name, listener) } }
    applyRuntime(ctx, { role: 'tian_shu' })
    const hook = hooks.get('agent/request') as unknown as (payload: { agent: AgentLike }, next: () => Promise<CallConfigLike>) => Promise<CallConfigLike>
    expect(hook).toBeTypeOf('function')
    const downstream = vi.fn(async () => ({ provider: 'must-not-enter', model: 'no-network' }))
    await expect(hook({ agent: f.root }, downstream)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(downstream).not.toHaveBeenCalled()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'stalled', activations: 3 })
  })
})
