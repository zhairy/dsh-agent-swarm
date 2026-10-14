import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike, SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const homes: string[] = [], services: SwarmService[] = [], releases: Array<() => void> = [], pending: Promise<unknown>[] = []
const deferred = () => { let done!: () => void; return { promise: new Promise<void>((resolve) => { done = resolve }), release: () => done() } }
const track = <T>(work: Promise<T>) => { pending.push(work.catch(() => undefined)); return work }
const snapshots = vi.hoisted(() => ({ afterWait: undefined as undefined | (() => Promise<void>), skip: 0 }))
vi.mock('../../src/artifacts.js', async (original) => {
  const actual = await original<typeof import('../../src/artifacts.js')>()
  return { ...actual, getArtifactSnapshot: async (...args: Parameters<typeof actual.getArtifactSnapshot>) => {
    if (snapshots.skip > 0) snapshots.skip--
    else if (snapshots.afterWait) { const wait = snapshots.afterWait; snapshots.afterWait = undefined; await wait() }
    return actual.getArtifactSnapshot(...args)
  } }
})
afterEach(async () => {
  snapshots.afterWait = undefined; snapshots.skip = 0
  for (const release of releases.splice(0)) release()
  // Queued fixture work must be allowed to finish after earlier work releases.
  await Promise.allSettled(services.map((service) => service.dispose()))
  await Promise.allSettled(pending.splice(0))
  services.length = 0
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const makeRuntime = async (strategy: 'fifo' | 'priority' | 'roundRobin' = 'fifo', maxPending = 8) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-scheduling-service-')); homes.push(home)
  const root: AgentLike = { id: 'scheduler-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const config = getSwarmConfig({ scheduling: { strategy, maxActive: 1, maxPending }, jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, agents: { session: 'oneshot', maxRetries: 0 } })
  const runs: Array<{ role: DelegableRoleId; release: () => void }> = []
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => name === 'spawn' ? { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } } : undefined,
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      const hold = deferred(); releases.push(hold.release); runs.push({ role, release: hold.release })
      return { id: 'scheduled-child-' + runs.length, result: hold.promise.then(() => ({ output: [], structured: VALID_OUTPUTS[role], stopReason: 'completed' } as SubagentResultLike)), dispose: async () => undefined }
    })
  }
  const service = intSwarmService({ getConfig: () => config, getLlm: () => ({ listProviders: () => [{ id: 'deepseek-official' }, { id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
    getSubagents: () => subagents, getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => [{ name: 'read' }, { name: 'glob' }, { name: 'swarm_context_read' }] }),
    getCredentials: () => undefined, getAttachments: () => undefined, dshHome: home,
    fetch: async () => { throw new Error('No live calls are permitted in scheduling fixtures') }, gitStatus: async () => undefined, probe: async () => ({ ok: true, vision: false }), sleep: async () => undefined })
  services.push(service)
  const exec = (signal = new AbortController().signal, agent = root) => ({ agent, signal })
  const card = (title: string, extra = {}, agent = root) => service.AddTaskCard({ title, goal: title, acceptance: ['实测依据'], flags: {}, scope: [], ...extra }, exec(undefined, agent))
  const status = (task: string, agent = root) => service.getTaskViewForRpc(agent.id, task) as { scheduling: { active: number; pending: number }; cardRevision: number }
  const submit = (task: string, role: DelegableRoleId = 'mou_ding', extra = {}, signal?: AbortSignal, agent = root) => track(service.delegate({ task_id: task, role, prompt: '检查当前合同', backend: 'api', session: 'oneshot', ...extra }, exec(signal, agent)))
  return { service, root, config, runs, subagents, card, status, submit, exec }
}

describe('automatic scheduler coupled to original admission pipeline', () => {
  it('rejects queued old contracts before reserving budget or starting another model', async () => {
    const runtime = await makeRuntime(), a = await runtime.card('A'), b = await runtime.card('B')
    const active = runtime.submit(a.task_id); await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const queued = runtime.submit(b.task_id)
    await vi.waitFor(() => expect(runtime.status(b.task_id).scheduling.pending).toBe(1))
    await runtime.card('B changed', { task_id: b.task_id, expected_card_revision: b.cardRevision })
    runtime.runs[0]!.release(); await active
    await expect(queued).rejects.toThrow('等待预约期间任务版本已改变')
    expect(runtime.runs).toHaveLength(1)
    const budget = runtime.service.getStatus({ task_id: b.task_id }, runtime.exec()).executionBudgets.find((item) => item.task_id === b.task_id)
    expect(budget?.reservations ?? []).toEqual([])
  })
  it('queued cancellation and queue overflow have no task state or budget side effects', async () => {
    const runtime = await makeRuntime('fifo', 1), a = await runtime.card('A'), b = await runtime.card('B'), c = await runtime.card('C')
    const active = runtime.submit(a.task_id); await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const controller = new AbortController(), queued = runtime.submit(b.task_id, 'mou_ding', {}, controller.signal)
    await vi.waitFor(() => expect(runtime.status(b.task_id).scheduling.pending).toBe(1))
    await expect(runtime.submit(c.task_id)).rejects.toMatchObject({ code: 'SCHEDULER_FULL' })
    controller.abort(); await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(runtime.service.getStatus({ task_id: b.task_id }, runtime.exec()).tasks[0]?.delegations).toEqual([])
    expect(runtime.service.getStatus({ task_id: c.task_id }, runtime.exec()).tasks[0]?.delegations).toEqual([])
    runtime.runs[0]!.release(); await active
    expect(runtime.runs).toHaveLength(1)
  })
  it('completed request-id replay bypasses a full queue and starts no additional model', async () => {
    const runtime = await makeRuntime('fifo', 1), a = await runtime.card('A'), b = await runtime.card('B'), c = await runtime.card('C')
    const first = runtime.submit(a.task_id, 'mou_ding', { request_id: 'exact-id' }); await vi.waitFor(() => expect(runtime.runs).toHaveLength(1)); runtime.runs[0]!.release()
    const completed = await first
    const active = runtime.submit(b.task_id); await vi.waitFor(() => expect(runtime.runs).toHaveLength(2))
    const queued = runtime.submit(c.task_id); await vi.waitFor(() => expect(runtime.status(c.task_id).scheduling.pending).toBe(1))
    const replay = await runtime.submit(a.task_id, 'mou_ding', { request_id: 'exact-id' })
    expect(replay.delegationId).toBe(completed.delegationId); expect(runtime.runs).toHaveLength(2)
    runtime.runs[1]!.release(); await active; await vi.waitFor(() => expect(runtime.runs).toHaveLength(3)); runtime.runs[2]!.release(); await queued
  })
  it('active capacity includes post-model evidence finalization, and other owners stay independent', async () => {
    const runtime = await makeRuntime(), a = await runtime.card('A'), b = await runtime.card('B')
    const wait = deferred(), entered = deferred(); releases.push(wait.release)
    const active = runtime.submit(a.task_id); await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    snapshots.afterWait = async () => { entered.release(); await wait.promise }
    runtime.runs[0]!.release(); await entered.promise
    const queued = runtime.submit(b.task_id); await vi.waitFor(() => expect(runtime.status(b.task_id).scheduling.pending).toBe(1))
    expect(runtime.runs).toHaveLength(1)
    const other: AgentLike = { id: 'another-root', session: { header: { agentPreset: 'tian-shu', cwd: runtime.root.session!.header!.cwd } } }
    const otherTask = await runtime.card('other owner', {}, other), independent = runtime.submit(otherTask.task_id, 'mou_ding', {}, undefined, other)
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(2)); runtime.runs[1]!.release(); await independent
    wait.release(); await active; await vi.waitFor(() => expect(runtime.runs).toHaveLength(3)); runtime.runs[2]!.release(); await queued
    expect(runtime.status(b.task_id).scheduling).toMatchObject({ active: 0, pending: 0 })
  })
})
