import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'
import type { AgentLike, PluginContextLike } from '../../src/host-contract.js'
import type { SwarmService } from '../../src/service.js'
import { createWorkspaceLeaseManager } from '../../src/util/workspace-lease.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

// Load the installed public SDK, not a production profile or an integration harness.
// An unavailable SDK is a failed prerequisite, never a silently skipped regression.
const modules = [process.env.SWARM_DSH_MODULES, '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules']
  .find((root) => root !== undefined && existsSync(join(root, '@deepseek-ai/dsh-jobs-local/lib/index.js')))
const loadSdk = (name: string) => {
  if (modules === undefined) throw new Error('Lease regressions require DSH JobsLocal (SWARM_DSH_MODULES)')
  return import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')).href)
}
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

const fixture = async () => {
  const [{ Context }, { default: JobsLocal }] = await Promise.all([loadSdk('cordis'), loadSdk('dsh-jobs-local')])
  const ctx = new Context()
  const live = new Map<string, AgentLike>()
  ctx.provide('agents')
  ctx.set('agents', { get: (id: string) => live.get(id) })
  const fork = ctx.plugin(JobsLocal, { maxConcurrentJobsPerOwner: 10, retainBytes: 262144, settledRetainBytes: 16384, pumpPollMs: 150 })
  await fork
  const jobs = ctx.jobs
  const detach = jobs.attachController('lease-unit-test')
  const home = await mkdtemp(join(tmpdir(), 'swarm-lease-jobs-'))
  const root = { id: 'lease-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const provided = new Map<string, unknown>()
  const effects: Array<() => unknown> = []
  const owners: Array<{ dispose: () => Promise<void> }> = []
  const producers: Array<{ resolve: (outcome: { status: string }) => void }> = []
  const work: Promise<unknown>[] = []
  const children: Array<AgentLike & { status: 'running' | 'idle' }> = []
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args as never[])
  const subagents = {
    list: () => ['spawn'], getProvider: () => ({ capabilities: {} }),
    startContinuable: async (spec: { childId: string }) => {
      const owner = ctx.plugin(() => undefined)
      await owner
      owners.push(owner)
      const child = {
        id: spec.childId, status: 'running' as 'running' | 'idle', ctx: owner.ctx,
        session: {
          id: spec.childId, header: { parentSession: root.id, cwd: home },
          append: (type: string, data: unknown) => emit('session/event', { id: spec.childId }, { type, data })
        }
      }
      live.set(child.id, child)
      children.push(child)
      return { childId: child.id, messageId: 'fixture-message' }
    },
    sendMessage: async () => 'fixture-message',
    interrupt: (id: string) => { const child = children.find(child => child.id === id); if (child !== undefined) child.status = 'idle' }
  }
  const host: Record<string, unknown> = {
    profileContext: { home }, jobs, agents: { get: (id: string) => live.get(id) }, subagents,
    llm: { listProviders: () => [{ id: 'fixture' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    tools: { register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'write', 'edit', 'bash'].map(name => ({ name })) }
  }
  const plugin: PluginContextLike = {
    get: (name) => provided.get(name) ?? host[name],
    provide: (name, value) => { provided.set(name, value); return () => { provided.delete(name) } },
    effect: (execute) => { effects.push(execute()) },
    on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name) },
    logger: () => ({ info: () => undefined, warn: () => undefined })
  }
  apply(plugin, {
    jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false },
    workflow: { mode: 'advisory' }, agents: { maxRetries: 0 },
    routes: { ji_feng: { chain: [{ provider: 'fixture', model: 'fixture' }] }, fu_he: { chain: [{ provider: 'fixture', model: 'fixture' }] } }
  })
  const service = provided.get('agentSwarm') as SwarmService
  const exec = { agent: root, signal: new AbortController().signal }
  const leases = createWorkspaceLeaseManager()
  cleanups.push(async () => {
    for (const producer of producers) producer.resolve({ status: 'killed' })
    for (const child of children) { child.status = 'idle'; emit('subagent/end', { id: child.id, stopReason: 'cancelled' }) }
    await Promise.allSettled(work)
    for (const dispose of effects.reverse()) await dispose()
    for (const owner of owners) await owner.dispose()
    detach(); await fork.dispose(); await ctx.fiber.dispose()
    const status = await leases.getStatus(home)
    if (status.owner !== undefined) await leases.reconcile(home, status.owner, true).catch(error => { if (leases.peekStatus(home)?.busy) throw error })
    await rm(home, { recursive: true, force: true })
  })
  const start = async (role: 'ji_feng' | 'fu_he' = 'ji_feng') => {
    const card = await service.AddTaskCard({ title: 'Job lifetime', goal: 'Complete isolated work', acceptance: ['checked'], scope: [], flags: { changesCode: true } }, exec)
    const cancellation = new AbortController()
    let returned = false
    const result = service.delegate({ task_id: card.task_id, role, prompt: 'fixture work', backend: 'api', session: 'new' }, { agent: root, signal: cancellation.signal })
    const handled = result.then(() => { returned = true }, () => { returned = true })
    work.push(handled)
    await vi.waitFor(() => expect(children).toHaveLength(1))
    const child = children[0]!
    const finish = () => { child.status = 'idle'; emit('subagent/end', { id: child.id, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '```json\n' + JSON.stringify(VALID_OUTPUTS[role]) + '\n```' }] }) }
    return { result, handled, cancellation, child, finish, returned: () => returned }
  }
  const startJob = (owner?: string, cancel = () => undefined) => {
    let resolve!: (outcome: { status: string }) => void
    const done = new Promise<{ status: string }>((yes) => { resolve = yes })
    producers.push({ resolve })
    const id = jobs.start({ kind: 'bash', label: 'memory-only writer', ...(owner === undefined ? {} : { owner }), run: () => ({ done, cancel }) })
    return { id, resolve }
  }
  return { service, home, root, jobs, leases, start, startJob, emit, live, owners }
}

describe('workspace leases follow real DSH JobsLocal lifecycle', () => {
  it.each(['ji_feng', 'fu_he'] as const)('normal %s completion waits for owned jobs without killing them or unrelated jobs', async (role) => {
    const f = await fixture()
    const run = await f.start(role)
    let cancelled = false
    const job = f.startJob(run.child.id, () => { cancelled = true })
    const unrelated = f.startJob()
    const waiting = vi.spyOn(f.jobs, 'wait')
    run.finish()
    await vi.waitFor(() => expect(run.returned() || waiting.mock.calls.length > 0).toBe(true))
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true })
    expect(run.returned()).toBe(false)
    expect(cancelled).toBe(false)
    job.resolve({ status: 'completed' })
    await run.result
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false })
    expect(f.jobs.get(unrelated.id).status).toBe('running')
  })

  it.each([false, true])('a timed wait is not stop proof (cancelled=%s); later job settlement recovers without another end event', async (cancelled) => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id)
    const waiting = vi.spyOn(f.jobs, 'wait')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    if (cancelled) run.cancellation.abort(); else run.finish()
    await vi.waitFor(() => expect(run.returned() || waiting.mock.calls.length > 0).toBe(true))
    await vi.advanceTimersByTimeAsync(30_001)
    await run.handled
    expect(f.jobs.get(job.id, run.child.id).status).toBe(cancelled ? 'stopping' : 'running')
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    const previousWaits = waiting.mock.calls.length
    f.emit('subagent/end', { id: run.child.id, stopReason: 'completed' })
    f.emit('agent/disposed', { agent: run.child })
    await vi.waitFor(async () => expect(waiting.mock.calls.length > previousWaits || !(await f.leases.getStatus(f.home)).busy).toBe(true))
    await vi.advanceTimersByTimeAsync(30_001)
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    job.resolve({ status: cancelled ? 'killed' : 'completed' })
    await vi.waitFor(async () => expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false }))
  })

  it('cancellation arriving during normal cleanup requests a kill but still waits for producer completion', async () => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id)
    const waiting = vi.spyOn(f.jobs, 'wait')
    run.finish()
    await vi.waitFor(() => expect(waiting.mock.calls.length).toBeGreaterThan(0))
    run.cancellation.abort()
    await vi.waitFor(() => expect(f.jobs.get(job.id, run.child.id).status).toBe('stopping'))
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true })
    expect(run.returned()).toBe(false)
    job.resolve({ status: 'killed' })
    await run.handled
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false })
  })

  it('agent disappearance does not bypass its still-stopping owned job', async () => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id)
    f.live.delete(run.child.id)
    f.emit('agent/disposed', { agent: run.child })
    const waiting = vi.spyOn(f.jobs, 'wait')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    run.cancellation.abort()
    await vi.waitFor(() => expect(run.returned() || waiting.mock.calls.length > 0).toBe(true))
    await vi.advanceTimersByTimeAsync(30_001)
    await run.handled
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    job.resolve({ status: 'killed' })
    await vi.waitFor(async () => expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false }))
  })

  it('a failed kill stays fenced and agent/disposed retries the same lease', async () => {
    const f = await fixture()
    const run = await f.start()
    let fail = true
    const job = f.startJob(run.child.id, () => { if (fail) throw new Error('cancel fixture failure') })
    run.cancellation.abort()
    await run.handled
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    fail = false
    f.emit('agent/disposed', { agent: run.child })
    await vi.waitFor(() => expect(f.jobs.get(job.id, run.child.id).status).toBe('stopping'))
    job.resolve({ status: 'killed' })
    await vi.waitFor(async () => expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false }))
  })

  it.each(['list', 'wait'] as const)('a transient jobs.%s failure retains the lease for a later end-event retry', async (method) => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id)
    const fault = vi.spyOn(f.jobs, method).mockImplementationOnce(() => { throw new Error('fixture registry unavailable') })
    run.finish()
    await run.handled
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    fault.mockRestore()
    job.resolve({ status: 'completed' })
    f.emit('subagent/end', { id: run.child.id, stopReason: 'completed' })
    await vi.waitFor(async () => expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false }))
  })

  it('a failed owner-file release keeps its recovery entry until agent/disposed retries successfully', async () => {
    const f = await fixture()
    const run = await f.start()
    const before = await f.leases.getStatus(f.home)
    const ownerPath = join(tmpdir(), 'dsh-agent-swarm-workspace-owners', `workspace-${before.workspaceId}.json`)
    const backup = join(f.home, 'owner-backup.json')
    await rename(ownerPath, backup)
    await mkdir(ownerPath)
    try {
      run.finish()
      await run.handled
      expect(await f.leases.getStatus(f.home)).toMatchObject({ owner: before.owner, leaseEpoch: before.leaseEpoch, busy: true, mutationUnknown: true })
    } finally { await rm(ownerPath, { recursive: true }); await rename(backup, ownerPath) }
    f.emit('agent/disposed', { agent: run.child })
    await vi.waitFor(async () => expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false }))
  })

  it('retains forced-failed orphan evidence even after owner teardown removes the job record', async () => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id, () => { throw new Error('orphaned fixture writer') })
    await f.owners[0]!.dispose()
    f.live.delete(run.child.id)
    expect(f.jobs.list(run.child.id)).toEqual([])
    f.emit('agent/disposed', { agent: run.child })
    run.finish()
    await run.handled
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    f.emit('subagent/end', { id: run.child.id, stopReason: 'error' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: true, mutationUnknown: true })
    // JobsLocal ignores a late producer completion after force-failure: no invented proof.
    job.resolve({ status: 'killed' })
  })

  it('does not overwrite newer producer settlement with an earlier timed-wait snapshot after record removal', async () => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id)
    const wait = f.jobs.wait.bind(f.jobs)
    vi.spyOn(f.jobs, 'wait').mockImplementationOnce(async (id, _timeout, caller) => {
      const snapshot = await wait(id, 1, caller)
      expect(snapshot.status).toBe('running')
      job.resolve({ status: 'completed' })
      await f.owners[0]!.dispose()
      f.live.delete(run.child.id)
      f.emit('agent/disposed', { agent: run.child })
      return snapshot
    })
    run.finish()
    await run.result
    expect(f.jobs.list(run.child.id)).toEqual([])
    await vi.waitFor(async () => expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false }))
  })

  it('a producer-reported failed result can finish cleanup without being mistaken for forced teardown', async () => {
    const f = await fixture()
    const run = await f.start()
    const job = f.startJob(run.child.id)
    job.resolve({ status: 'failed' })
    await f.jobs.wait(job.id, 100, run.child.id)
    run.finish()
    await run.result
    expect(await f.leases.getStatus(f.home)).toMatchObject({ busy: false, mutationUnknown: false })
  })
})
