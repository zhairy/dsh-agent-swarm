import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import { getChildPromptText, getNativePromptText, getThreadFollowupText } from '../../src/delegate.js'
import { getChildPersona } from '../../src/role-registry.js'
import type { AgentLike, SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { DEFAULT_MATH_CONFIG, MATH_GROUP_OPERATORS, MATH_LIMIT_MAXIMA, MAX_MATH_CALLS_PER_TASK, MAX_MATH_WORK_PER_TASK } from '../../src/math/config.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'
import * as AgentBindings from '../../src/agent-binding.js'
import { createFeatureSession } from '../../src/feature-session.js'
import * as FeatureSessions from '../../src/feature-session.js'
import { loadTaskViewStoreModule } from './client-module-loader.js'
import { intTaskStore } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'

const directories: string[] = [], services: SwarmService[] = [], releases: Array<() => void> = [], work: Promise<unknown>[] = []
const track = <T>(value: Promise<T>): Promise<T> => { work.push(value.catch(() => undefined)); return value }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
afterEach(async () => {
  vi.useRealTimers()
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(work.splice(0))
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

const page = () => {
  const data = { namespace: 'swarm-core', agents: [], triggers: [], math: { defaults: DEFAULT_MATH_CONFIG, groups: MATH_GROUP_OPERATORS, limitMaxima: MATH_LIMIT_MAXIMA, maxWorkPerTask: MAX_MATH_WORK_PER_TASK, maxCallsPerTask: MAX_MATH_CALLS_PER_TASK } }
  const source = readFileSync(join(__dirname, '../../client/settings-page.js'), 'utf8').replace('const DATA = __SWARM_DATA__', `const DATA = ${JSON.stringify(data)}`)
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'react') return { createElement: () => null, useSyncExternalStore: () => undefined, useEffect: () => undefined }
    if (id === '@swarm/settings-navigation') {
      const nested = { exports: {} }
      new Function('module','exports',readFileSync(join(__dirname,'../../client/settings-navigation.js'),'utf8'))(nested,nested.exports)
      return nested.exports
    }
    throw new Error(`Unexpected module: ${id}`)
  }, module, module.exports)
  return module.exports.__test__
}

const runtime = async (maxPending = 3, options: { persistence?: boolean; beforeQuota?: () => Promise<void> } = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-250-adversarial-')); directories.push(home)
  const root: AgentLike = { id: 'adversarial-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const config = getSwarmConfig({ jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, persistence: { enabled: options.persistence === true }, agents: { session: 'oneshot', maxRetries: 0, language: 'en' }, scheduling: { strategy: 'fifo', maxActive: 1, maxPending } })
  const started = deferred<void>(), results: Array<() => void> = []
  const subagents = {
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
    start: vi.fn(async (_provider: string, _request: SubagentStartRequestLike) => {
      const result = deferred<SubagentResultLike>()
      const release = () => result.resolve({ output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' })
      results.push(release); releases.push(release); started.resolve()
      return { id: `child-${results.length}`, result: result.promise, dispose: async () => undefined }
    })
  }
  let clock = 1000
  const service = intSwarmService({ getConfig: () => config, getLlm: () => ({ listProviders: () => [{ id: 'qwen-token-plan-cn' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
    getSubagents: () => subagents, getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'glob', 'grep'].map(name => ({ name })) }),
    getCredentials: () => undefined, getAttachments: () => undefined, dshHome: home,
    fetch: async () => { throw new Error('Live network is forbidden in adversarial unit tests') },
    orderQuotaRoutes: options.beforeQuota === undefined ? undefined : async routes => { await options.beforeQuota!(); return routes },
    gitStatus: async () => undefined, sleep: async () => undefined, probe: async () => ({ ok: true, vision: true }), now: () => ++clock })
  services.push(service)
  const exec = (signal = new AbortController().signal) => ({ agent: root, signal })
  const card = { title: '队列关联审计', goal: '核对旧合同不得被排队改版重新授权', acceptance: ['实际只调用一次'], scope: [], flags: {} }
  const task = await service.AddTaskCard(card, exec())
  const args = (request_id: string) => ({ task_id: task.task_id, role: 'tan_wei', backend: 'api', session: 'oneshot', prompt: 'Check current source', request_id })
  return { service, root, config, home, exec, card, task, args, subagents, started, results }
}

describe('2.5.0 independent adversarial association regressions', () => {
  it.each(['en', 'zh-TW', 'ja', 'ko'])('editing an old policy field preserves saved %s and unknown agent configuration', language => {
    const { getPolicy, toPolicyDraft, buildPolicy } = page()
    const saved = { language, maxRetries: 2, networkProbeUrls: ['https://example.invalid'], futurePolicy: { revision: 7 } }
    const draft = toPolicyDraft(getPolicy(saved))
    expect(draft.language).toBe(language)
    expect(buildPolicy({ ...draft, maxRetries: 1 }, saved)).toEqual({ ...saved, maxRetries: 1 })
  })

  it('every prompt backend and a known-task followup carry the visible language while keeping JSON keys unchanged', async () => {
    const h = await runtime()
    const task = h.service.getStatus({ task_id: h.task.task_id }, h.exec()).tasks[0]!
    const record = { taskId: h.task.task_id, card: task.card } as Parameters<typeof getChildPromptText>[0]
    const input = { task_id: h.task.task_id, role: 'tan_wei' as const, prompt: 'Check the source', language: 'ja' as const }
    for (const style of ['generic', 'gpt', 'claude'] as const) {
      for (const text of [getChildPromptText(record, input, 'D-1', style), getThreadFollowupText(record, input, 'D-2', true, style), getNativePromptText(record, input, 'D-3', undefined, style)]) {
        expect(text).toContain('出力言語：日本語（ja）')
        expect(text).not.toContain('summary 用中文')
      }
      expect(getChildPersona('tan_wei', undefined, style)).not.toContain('summary 用中文')
    }
  })

  it('two same-request calls racing for one active slot start exactly one child and replay the actual finalized record', async () => {
    const h = await runtime()
    const first = track(h.service.delegate(h.args('same-request'), h.exec()))
    const second = track(h.service.delegate(h.args('same-request'), h.exec()))
    await h.started.promise
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
    h.results[0]!()
    const [a, b] = await Promise.all([first, second])
    expect(a.delegationId).toBe(b.delegationId)
    expect(a.finalization).toBe('ready'); expect(b.finalization).toBe('ready')
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('a queued old request cannot adopt a contract edited while another delegation owns the slot', async () => {
    const h = await runtime()
    const active = track(h.service.delegate(h.args('active'), h.exec())); await h.started.promise
    const waiting = track(h.service.delegate(h.args('old-queued'), h.exec()))
    await vi.waitFor(() => expect((h.service.getTaskViewForRpc(h.root.id, h.task.task_id) as any).scheduling.pending).toBe(1))
    await h.service.AddTaskCard({ ...h.card, task_id: h.task.task_id, goal: 'NEW CONTRACT NEEDS FRESH ADMISSION' }, h.exec())
    h.results[0]!(); await active
    await expect(waiting).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('queued cancellation consumes no delegation or mathematical budget and never publishes a child', async () => {
    const h = await runtime(), cancellation = new AbortController()
    const active = track(h.service.delegate(h.args('active'), h.exec())); await h.started.promise
    const waiting = track(h.service.delegate(h.args('cancelled'), h.exec(cancellation.signal)))
    await vi.waitFor(() => expect((h.service.getTaskViewForRpc(h.root.id, h.task.task_id) as any).scheduling.pending).toBe(1))
    cancellation.abort(); await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    h.results[0]!(); await active
    const status = h.service.getStatus({ task_id: h.task.task_id, verbose: true }, h.exec())
    expect(status.tasks[0]!.delegations).toHaveLength(1)
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
    expect((h.service.getTaskViewForRpc(h.root.id, h.task.task_id) as any).scheduling).toMatchObject({ active: 0, pending: 0 })
  })

  it('a completed idempotent result remains readable when the waiting queue is full', async () => {
    const h = await runtime(1)
    const original = track(h.service.delegate(h.args('completed'), h.exec())); await h.started.promise
    h.results[0]!(); const completed = await original
    const active = track(h.service.delegate(h.args('active'), h.exec()))
    await vi.waitFor(() => expect(h.subagents.start).toHaveBeenCalledTimes(2))
    const queued = track(h.service.delegate(h.args('queued'), h.exec()))
    await vi.waitFor(() => expect((h.service.getTaskViewForRpc(h.root.id, h.task.task_id) as any).scheduling.pending).toBe(1))
    const replay = await h.service.delegate(h.args('completed'), h.exec())
    expect(replay.delegationId).toBe(completed.delegationId)
    expect(replay.finalization).toBe('ready')
    expect(h.subagents.start).toHaveBeenCalledTimes(2)
    h.results[1]!(); await active
    await vi.waitFor(() => expect(h.subagents.start).toHaveBeenCalledTimes(3))
    h.results[2]!(); await queued
  })

  it('repeated five-view reads neither mutate task versions nor grant acceptance', async () => {
    const h = await runtime()
    const before = JSON.stringify(h.service.getTaskViewForRpc(h.root.id, h.task.task_id))
    for (let index = 0; index < 3; index++) expect(JSON.stringify(h.service.getTaskViewForRpc(h.root.id, h.task.task_id))).toBe(before)
    const view = h.service.getTaskViewForRpc(h.root.id, h.task.task_id) as any
    expect(view.diagrams.progress.accepted).toBe(false)
    expect(view.diagrams.progress.completed).toBe(0)
    expect(view.planningReview).toBeNull()
    expect(h.subagents.start).not.toHaveBeenCalled()
  })

  it('a slow task-view response remains current and never overlaps automatic polling', async () => {
    vi.useFakeTimers()
    const response = deferred<{ task_id: string }>()
    const request = vi.fn((_method: string, _payload: unknown, _signal: AbortSignal) => response.promise)
    const store = loadTaskViewStoreModule().createTaskViewStore({ request })
    releases.push(() => store.dispose())
    const source = store.task('root', 'T-1'); const stop = source.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(10000)
    expect(request).toHaveBeenCalledTimes(1); expect(source.getSnapshot().value).toBeNull()
    response.resolve({ task_id: 'T-1' }); await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toMatchObject({ value: { task_id: 'T-1' }, error: null })
    await vi.advanceTimersByTimeAsync(4999); expect(request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2)
    stop(); await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('a timed-out task view really aborts and rejects late publication until transport settlement', async () => {
    vi.useFakeTimers()
    const response = deferred<{ task_id: string }>()
    const request = vi.fn((_method: string, _payload: unknown, _signal: AbortSignal) => response.promise)
    const store = loadTaskViewStoreModule().createTaskViewStore({ request })
    releases.push(() => store.dispose())
    const source = store.task('root', 'T-1'); const stop = source.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(15000)
    expect(source.getSnapshot()).toMatchObject({ value: null, status: 'unavailable' })
    expect(request.mock.calls[0]![2].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60000); expect(request).toHaveBeenCalledTimes(1)
    stop(); response.resolve({ task_id: 'T-1' }); await vi.advanceTimersByTimeAsync(60000)
    expect(source.getSnapshot().value).toBeNull(); expect(request).toHaveBeenCalledTimes(1)
  })

  it('manual refreshes share the existing request; a session switch cannot publish an obsolete root', async () => {
    vi.useFakeTimers()
    const response = deferred<{ task_id: string; rootSessionId: string }>()
    const request = vi.fn((_method, payload) => payload.sessionId === 'old-root' ? response.promise : Promise.resolve({ task_id: 'T-1', rootSessionId: 'new-root' }))
    const store = loadTaskViewStoreModule().createTaskViewStore({ request })
    releases.push(() => store.dispose())
    const old = store.task('old-root', 'T-1'); const stopOld = old.subscribe(vi.fn())
    const first = old.refresh(), repeated = old.refresh()
    expect(first).toBe(repeated)
    await vi.advanceTimersByTimeAsync(0); stopOld()
    const current = store.task('new-root', 'T-1'); current.subscribe(vi.fn()); await current.refresh()
    expect(current.getSnapshot().value.rootSessionId).toBe('new-root')
    response.resolve({ task_id: 'T-1', rootSessionId: 'old-root' }); await vi.advanceTimersByTimeAsync(0)
    expect(current.getSnapshot().value.rootSessionId).toBe('new-root')
    expect(old.getSnapshot().value).toBeNull()
    expect(request.mock.calls.filter(([, payload]) => payload.sessionId === 'old-root')).toHaveLength(1)
  })

  it('shutdown checkpoints a published running attempt even when durable child binding has not completed', async () => {
    const bindingEntered = deferred<void>(), allowBinding = deferred<void>()
    releases.push(() => allowBinding.resolve())
    const factory = AgentBindings.createAgentBindingRegistry
    vi.spyOn(AgentBindings, 'createAgentBindingRegistry').mockImplementation(store => {
      const registry = factory(store)
      return { ...registry, bind: async input => { bindingEntered.resolve(); await allowBinding.promise; return registry.bind(input) } }
    })
    const h = await runtime(3, { persistence: true })
    const running = track(h.service.delegate(h.args('shutdown-running'), h.exec()))
    await bindingEntered.promise
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
    await h.service.dispose()
    const tasks = intTaskStore(), threads = intThreadRegistry()
    const restored = await createFeatureSession({ rootSessionId: h.root.id, cwd: h.home, dshHome: h.home, config: h.config, tasks, threads, now: () => 2000 })
    try {
      expect(tasks.getTaskDelegations(h.task.task_id)).toHaveLength(1)
      expect(tasks.getTaskDelegations(h.task.task_id)[0]).toMatchObject({ status: 'failed', error: 'recovery_required' })
      expect(restored.budgetFor(tasks.getTask(h.task.task_id)!).getSnapshot().reservations).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'delegate', state: 'settled', usageUnknown: true })
      ]))
    } finally { await restored.dispose(); allowBinding.resolve(); h.results[0]!(); await running.catch(() => undefined) }
    await expect(h.service.dispose()).resolves.toBeUndefined()
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('shutdown prevents a preflight already outside taskLock from publishing a late child', async () => {
    const entered = deferred<void>(), gate = deferred<void>()
    releases.push(() => gate.resolve())
    const h = await runtime(3, { persistence: true, beforeQuota: async () => { entered.resolve(); await gate.promise } })
    const pending = track(h.service.delegate(h.args('shutdown-preflight'), h.exec()))
    await entered.promise
    await h.service.dispose()
    gate.resolve()
    await expect(pending).rejects.toThrow()
    expect(h.subagents.start).not.toHaveBeenCalled()
  })

  it('shutdown reports a failed owner checkpoint while closing every owner, preserving valid state and keeping failure idempotent', async () => {
    const factory = FeatureSessions.createFeatureSession
    const owners = new Map<string, { feature: Awaited<ReturnType<typeof factory>>; close: ReturnType<typeof vi.fn> }>()
    vi.spyOn(FeatureSessions, 'createFeatureSession').mockImplementation(async input => {
      const feature = await factory(input), close = vi.fn(() => feature.dispose())
      owners.set(input.rootSessionId, { feature, close })
      return { ...feature, dispose: close, persist: async (...args) => {
        if (input.rootSessionId === 'adversarial-root' && args[0] === 'lifecycle/dispose') throw new Error('injected-checkpoint-detail')
        return feature.persist(...args)
      } }
    })
    const h = await runtime(3, { persistence: true })
    const second: AgentLike = { id: 'adversarial-root-second', session: { header: { agentPreset: 'tian-shu', cwd: h.home } } }
    await h.service.AddTaskCard({ ...h.card, title: 'second owner survives first owner failure' }, { agent: second, signal: new AbortController().signal })
    expect(owners.size).toBe(2)
    const shutdown = h.service.dispose()
    await expect(shutdown).rejects.toThrow('Swarm shutdown checkpoint failed')
    expect(h.service.dispose()).toBe(shutdown)
    const failure = await shutdown.catch(error => error as AggregateError)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(String(failure)).not.toContain('injected-checkpoint-detail')
    for (const owner of owners.values()) {
      expect(owner.close).toHaveBeenCalledTimes(1)
      expect(() => owner.feature.store.read()).toThrow('closed')
    }
    // This service's expected cached failure was already checked twice above.
    services.splice(services.indexOf(h.service), 1)
    for (const rootSessionId of [h.root.id, second.id]) {
      const tasks = intTaskStore(), threads = intThreadRegistry()
      const restored = await factory({ rootSessionId, cwd: h.home, dshHome: h.home, config: h.config, tasks, threads, now: () => 2000 })
      try { expect(tasks.getTasks()).toHaveLength(1) } finally { await restored.dispose() }
    }
  })
})
