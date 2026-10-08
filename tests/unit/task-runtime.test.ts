import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike, SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'
import { createWorkspaceLeaseManager } from '../../src/util/workspace-lease.js'
import * as AgentBindings from '../../src/agent-binding.js'
import * as FeatureSessions from '../../src/feature-session.js'
import { createDurableStateStore } from '../../src/state-store.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { digest } from '../../src/task-model.js'
import type { ExperienceEntry } from '../../src/experience.js'
import { intTaskStore } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'
import type { RouteHealthEntry } from '../../src/route-health.js'

const directories: string[] = []
const services: SwarmService[] = []
const pendingReleases: Array<() => void> = []
const pendingWork: Promise<unknown>[] = []
const trackWork = <T>(promise: Promise<T>): Promise<T> => { pendingWork.push(promise.catch(() => undefined)); return promise }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
afterEach(async () => {
  for (const release of pendingReleases.splice(0)) release()
  await Promise.allSettled(pendingWork.splice(0))
  await Promise.all(services.splice(0).map((service) => service.dispose().catch(() => undefined)))
  const leases = createWorkspaceLeaseManager()
  for (const directory of directories) {
    const status = await leases.getStatus(directory).catch(() => undefined)
    if (status?.mutationUnknown && status.owner) await leases.reconcile(directory, status.owner, true)
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
  vi.restoreAllMocks()
})

const makeRuntime = async (options: {
  home?: string
  config?: Record<string, unknown>
  pending?: boolean
  output?: (role: DelegableRoleId, request: SubagentStartRequestLike) => unknown
} = {}) => {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'swarm-task-runtime-'))
  if (options.home === undefined) directories.push(home)
  const root: AgentLike = { id: 'task-runtime-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const exec = (agent = root) => ({ agent, signal: new AbortController().signal })
  const config = getSwarmConfig({ jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, agents: { session: 'oneshot', maxRetries: 0 }, ...options.config })
  const runs: Array<{ agent: AgentLike; role: DelegableRoleId; release: () => void }> = []
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => name === 'spawn' ? { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } } : undefined,
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      if (role === undefined) throw new Error('Fixture must receive a declared role')
      const id = 'task-runtime-child-' + (runs.length + 1)
      const agent: AgentLike = { id, session: { header: { parentSession: root.id, cwd: home } } }
      const result = deferred<SubagentResultLike>()
      const structured = options.output?.(role, request) ?? (role === 'suan_heng' ? { ...(VALID_OUTPUTS.suan_heng as object), mode: request.persona?.includes('验算') ? 'verify' : 'research' } : VALID_OUTPUTS[role])
      const release = () => result.resolve({ output: [], structured, stopReason: 'completed' })
      runs.push({ agent, role, release })
      pendingReleases.push(release)
      if (!options.pending) release()
      return { id, result: result.promise, dispose: async () => undefined }
    })
  }
  const fetch = vi.fn(async () => { throw new Error('These fixtures disable Jev; no live network calls are allowed') })
  let time = 1000
  const service = intSwarmService({
    getConfig: () => config,
    getLlm: () => ({ listProviders: () => [{ id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }, { id: 'deepseek-official' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }),
    getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'swarm_calculate', 'swarm_context_read', 'swarm_message_send', 'swarm_message_read', 'swarm_message_ack'].map((name) => ({ name })) }),
    getCredentials: () => undefined, getAttachments: () => undefined,
    dshHome: home, fetch: fetch as unknown as typeof globalThis.fetch,
    gitStatus: async () => undefined, sleep: async () => undefined,
    probe: async () => ({ ok: true, vision: true }), now: () => ++time
  })
  services.push(service)
  return { service, root, exec, home, subagents, runs, fetch, config }
}
const card = (extra: Record<string, unknown> = {}) => ({ title: '运行合同', goal: '分析并给出可检查结论', acceptance: ['结论有证据'], scope: [], flags: {}, ...extra })
const accept = (task_id: string) => ({ task_id, decision: 'accept', summary: '证据已检查', unresolved: [], stopReason: '完成' })
const taskView = (runtime: Awaited<ReturnType<typeof makeRuntime>>, task_id: string) => runtime.service.getStatus({ task_id, verbose: true }, runtime.exec()).tasks[0]!
const contextRefs = (runtime: Awaited<ReturnType<typeof makeRuntime>>, task_id: string, result?: unknown): string[] => {
  const rpc = runtime.service.getTaskViewForRpc(runtime.root.id, task_id) as { contextRefs?: string[] }
  const refs = rpc?.contextRefs ?? (result as { contextRefs?: string[] } | undefined)?.contextRefs
  expect(refs, 'Current task must expose its authorized context references').toBeDefined()
  expect(refs?.length).toBeGreaterThan(0)
  return refs as string[]
}
const reviewCases: Array<{ role: 'yu_shi' | 'suan_heng'; mode?: 'verify'; node: string; gate: 'G_REVIEW' | 'G_MATH_VERIFY'; flags: Record<string, boolean> }> = [
  { role: 'yu_shi', node: 'review', gate: 'G_REVIEW', flags: { securitySensitive: true } },
  { role: 'suan_heng', mode: 'verify', node: 'math_verify', gate: 'G_MATH_VERIFY', flags: { numericPrecision: true } }
]

describe('task execution through the public service', () => {
  it.each([
    { field: 'goal', changed: { goal: '新的数学目标' } },
    { field: 'acceptance', changed: { acceptance: ['新的精确验收要求'] } },
    { field: 'perf', changed: { perf: { p95Ms: 10, dataScale: 'n=32' } } }
  ])('$field changes invalidate the previously accepted task contract', async ({ changed }) => {
    const runtime = await makeRuntime()
    const first = await runtime.service.AddTaskCard(card(), runtime.exec())
    await runtime.service.delegate({ task_id: first.task_id, role: 'mou_ding', node_id: 'analysis', prompt: '提交分析证据', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect((await runtime.service.AcceptTask(accept(first.task_id), runtime.exec())).status).toBe('accepted')
    const revised = await runtime.service.AddTaskCard(card({ task_id: first.task_id, expected_card_revision: first.cardRevision, ...changed }), runtime.exec())
    expect(revised.cardRevision).toBe(first.cardRevision + 1)
    expect(taskView(runtime, first.task_id).acceptance).toBeNull()
    await expect(runtime.service.AddTaskCard(card({ task_id: first.task_id, expected_card_revision: first.cardRevision, goal: 'stale writer' }), runtime.exec())).rejects.toThrow()
    expect(taskView(runtime, first.task_id).cardRevision).toBe(revised.cardRevision)
  })

  it('blocks benchmark acceptance when exitCode=0 but p95=9999 exceeds 10ms', async () => {
    const runtime = await makeRuntime({ output: (role) => role === 'fu_he' ? {
      ...(VALID_OUTPUTS.fu_he as object),
      commands: [{ command: 'fixture benchmark', exitCode: 0, kind: 'benchmark', summary: 'p95 9999 ms' }],
      measurements: [{ metric: 'p95', value: 9999, unit: 'ms', sampleCount: 1000, dataScale: 'n=32', inputDigest: 'a'.repeat(64), environment: 'fixture Node with one worker', commandRef: 'fixture benchmark', rawArtifactRef: 'fixture-raw-result' }]
    } : VALID_OUTPUTS[role] })
    const created = await runtime.service.AddTaskCard(card({ perf: { p95Ms: 10, dataScale: 'n=32' } }), runtime.exec())
    const verification = await runtime.service.delegate({ task_id: created.task_id, role: 'fu_he', node_id: 'verification', prompt: '运行基准并报告实测值', backend: 'api', session: 'oneshot', gate: 'G_BENCH' }, runtime.exec())
    expect(verification.status).toBe('completed')
    const result = await runtime.service.AcceptTask(accept(created.task_id), runtime.exec())
    expect(result.status).toBe('blocked')
    expect(result.gates.find((gate) => gate.gate === 'G_BENCH')?.satisfied).toBe(false)
    expect(result.missing.join(' ')).toMatch(/10|9999|p95|预算/i)
  })

  it('executes six pure math groups through task authorization with cumulative call limits', async () => {
    const runtime = await makeRuntime({ config: { math: { enabled: true, maxCallsPerTask: 6 } } })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const cases = [
      { op: 'add', mode: 'float64', args: { a: 2, b: 3 }, expected: 5 },
      { op: 'gcd', mode: 'bigint', args: { a: '18', b: '12' }, expected: '6' },
      { op: 'add', mode: 'rational', args: { a: { numerator: '1', denominator: '3' }, b: { numerator: '1', denominator: '6' } }, expected: { numerator: '1', denominator: '2' } },
      { op: 'sum', mode: 'float64', args: { values: [1e16, 1, -1e16] }, expected: 1 },
      { op: 'dot', mode: 'float64', args: { a: [1, 2], b: [3, 4] }, expected: 11 },
      { op: 'norm2', mode: 'float64', args: { values: [3, 4] }, expected: 5 }
    ]
    for (const { expected, ...calculation } of cases) expect(await runtime.service.Calculate({ task_id: created.task_id, ...calculation }, runtime.exec())).toMatchObject({ ok: true, value: expected, evidenceKind: 'computed' })
    await expect(runtime.service.Calculate({ task_id: created.task_id, op: 'add', mode: 'float64', args: { a: 1, b: 1 } }, runtime.exec())).rejects.toThrow(/maxMathCalls|预算|上限|额度/i)
    const second = await runtime.service.AddTaskCard(card({ title: '第二任务' }), runtime.exec())
    await expect(runtime.service.Calculate({ op: 'sum', mode: 'float64', args: { values: [1] } }, runtime.exec())).rejects.toThrow(/task_id|任务/)
    expect(await runtime.service.Calculate({ task_id: second.task_id, op: 'sum', mode: 'float64', args: { values: [1] } }, runtime.exec())).toMatchObject({ ok: true, value: 1 })
    const outsider: AgentLike = { id: 'unmanaged-root', session: { header: { agentPreset: 'expert-mode', cwd: runtime.home } } }
    await expect(runtime.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [1] } }, runtime.exec(outsider))).rejects.toThrow()
    expect(runtime.fetch).not.toHaveBeenCalled()
  })

  it('keeps root context private to the requested task and host-bound expert attempt', async () => {
    const runtime = await makeRuntime({ pending: true })
    const first = await runtime.service.AddTaskCard(card({ goal: '任务 A 私有合同' }), runtime.exec())
    const second = await runtime.service.AddTaskCard(card({ goal: '任务 B 私有合同' }), runtime.exec())
    const refsA = contextRefs(runtime, first.task_id, first)
    const refsB = contextRefs(runtime, second.task_id, second)
    const own = await runtime.service.ReadContext({ task_id: first.task_id, ref: refsA[0] }, runtime.exec()) as { text: string }
    expect(own.text).toContain('任务 A 私有合同')
    await expect(runtime.service.ReadContext({ task_id: second.task_id, ref: refsA[0] }, runtime.exec())).rejects.toThrow()
    const delegated = trackWork(runtime.service.delegate({ task_id: first.task_id, role: 'suan_heng', mode: 'research', prompt: '只检查 A 的定义', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const child = runtime.runs[0]!.agent
    await vi.waitFor(async () => expect(await runtime.service.Calculate({ op: 'sum', mode: 'float64', args: { values: [2] } }, runtime.exec(child))).toMatchObject({ ok: true, value: 2 }))
    await expect(runtime.service.Calculate({ task_id: second.task_id, op: 'sum', mode: 'float64', args: { values: [2] } }, runtime.exec(child))).rejects.toThrow()
    await expect(runtime.service.ReadContext({ ref: refsB[0] }, runtime.exec(child))).rejects.toThrow()
    expect(await runtime.service.ReadContext({ ref: refsA[0] }, runtime.exec(child))).toMatchObject({ cardRevision: first.cardRevision })
    runtime.runs[0]!.release(); await delegated
    await expect(runtime.service.ReadContext({ ref: refsA[0] }, runtime.exec(child))).rejects.toThrow()
  })

  it('restores saved tasks, math usage and unchanged private context references in the same session', async () => {
    const runtime = await makeRuntime({ config: { persistence: { enabled: true }, math: { maxCallsPerTask: 2 } } })
    const created = await runtime.service.AddTaskCard(card({ goal: '恢复后仍可读取的完整合同' }), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const before = await runtime.service.ReadContext({ task_id: created.task_id, ref: refs[0] }, runtime.exec())
    await runtime.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [3] } }, runtime.exec())
    await runtime.service.dispose()
    const restored = await makeRuntime({ home: runtime.home, config: { persistence: { enabled: true }, math: { maxCallsPerTask: 2 } } })
    expect(await restored.service.ReadContext({ task_id: created.task_id, ref: refs[0] }, restored.exec())).toEqual(before)
    expect(taskView(restored, created.task_id)).toMatchObject({ goal: '恢复后仍可读取的完整合同', cardRevision: created.cardRevision, recovered: true })
    expect(await restored.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [4] } }, restored.exec())).toMatchObject({ ok: true, value: 4 })
    await expect(restored.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [5] } }, restored.exec())).rejects.toThrow(/maxMathCalls|预算|额度|上限/i)
    const next = await restored.service.AddTaskCard(card({ title: '恢复后的新任务' }), restored.exec())
    expect(next.task_id).not.toBe(created.task_id)
    expect(restored.subagents.start).not.toHaveBeenCalled()
  })

  it('fences old delayed results after a concurrent contract revision', async () => {
    const runtime = await makeRuntime({ pending: true })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const pending = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'mou_ding', node_id: 'analysis', prompt: '延迟交付旧目标分析', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const revised = await runtime.service.AddTaskCard(card({ task_id: created.task_id, expected_card_revision: created.cardRevision, goal: '并发替换的新目标' }), runtime.exec())
    runtime.runs[0]!.release()
    const old = await pending
    expect(old.cardRevision).toBe(created.cardRevision)
    const view = taskView(runtime, created.task_id)
    expect(view.cardRevision).toBe(revised.cardRevision)
    expect(view.goal).toBe('并发替换的新目标')
    expect(view.flow?.state?.nodes.analysis?.status).not.toBe('succeeded')
    expect(view.acceptance?.status).not.toBe('accepted')
  })

  it('marks unknown running work for reconciliation after restart and never replays it automatically', async () => {
    const runtime = await makeRuntime({ pending: true, config: { persistence: { enabled: true } } })
    const created = await runtime.service.AddTaskCard(card({ goal: '未知运行状态必须核对' }), runtime.exec())
    const pending = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'mou_ding', node_id: 'analysis', prompt: '保持挂起直至模拟恢复', backend: 'api', session: 'oneshot' }, runtime.exec()))
    const handled = pending.catch(() => undefined)
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    await vi.waitFor(() => expect(taskView(runtime, created.task_id).delegations.some((record) => record.status === 'running')).toBe(true))
    await runtime.service.dispose()
    const restored = await makeRuntime({ home: runtime.home, config: { persistence: { enabled: true } } })
    await restored.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [1] } }, restored.exec())
    const view = taskView(restored, created.task_id)
    expect(view.recovered).toBe(true)
    expect(view.delegations).toHaveLength(1)
    expect(view.delegations[0]?.status).not.toBe('running')
    expect(view.delegations[0]?.error).toMatch(/recovery|interrupt/i)
    expect(restored.subagents.start).not.toHaveBeenCalled()
    runtime.runs[0]!.release(); await handled
  })

  it.each(['fu_he', 'xing_zhou'] as const)('allows %s to run its shell capability while holding the appropriate execution lease', async (role) => {
    const runtime = await makeRuntime({ pending: true })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const running = trackWork(runtime.service.delegate({ task_id: created.task_id, role, prompt: '在有效执行租约下运行检查', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const child = runtime.runs[0]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(child))).toMatchObject({ cardRevision: created.cardRevision }))
    for (const name of ['bash', 'pwsh']) expect(runtime.service.getGuardReason({ name, arguments: { command: 'fixture-check' }, agent: child })).toBeUndefined()
    expect(runtime.service.getGuardReason({ name: 'write', arguments: { path: 'unsafe-business-write' }, agent: child })).toBeDefined()
    runtime.runs[0]!.release(); await running
  })

  it('revokes delayed writer tools on cancellation and fences advisory root writes while side effects are unknown', async () => {
    const runtime = await makeRuntime({ pending: true, config: { workflow: { mode: 'advisory' } } })
    const created = await runtime.service.AddTaskCard(card({ flags: { changesCode: true } }), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const cancellation = new AbortController()
    const running = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'ji_feng', node_id: 'implementation', prompt: '写入进程仍在运行', backend: 'api', session: 'oneshot' }, { agent: runtime.root, signal: cancellation.signal }))
    const handled = running.catch(() => undefined)
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const child = runtime.runs[0]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(child))).toMatchObject({ cardRevision: created.cardRevision }))
    expect(runtime.service.getGuardReason({ name: 'write', agent: child })).toBeUndefined()
    cancellation.abort()
    expect(runtime.service.getGuardReason({ name: 'write', agent: child })).toBeDefined()
    expect(runtime.service.getGuardReason({ name: 'bash', agent: child })).toBeDefined()
    runtime.runs[0]!.release(); await handled
    const leases = createWorkspaceLeaseManager()
    const status = await leases.getStatus(runtime.home)
    try {
      expect(status.mutationUnknown).toBe(true)
      expect(runtime.service.getGuardReason({ name: 'write', agent: runtime.root })).toBeDefined()
      expect(runtime.service.getGuardReason({ name: 'pwsh', agent: runtime.root })).toBeDefined()
    } finally {
      if (status.mutationUnknown && status.owner) await leases.reconcile(runtime.home, status.owner, true)
    }
  })

  it('replays the same request when JSON object keys are reordered and rejects changed input', async () => {
    const runtime = await makeRuntime()
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const args = { task_id: created.task_id, role: 'mou_ding', node_id: 'analysis', request_id: 'canonical-request', prompt: '一份结果', backend: 'api', session: 'oneshot' }
    const first = await runtime.service.delegate(args, runtime.exec())
    const reordered = Object.fromEntries(Object.entries(args).reverse())
    const replay = await runtime.service.delegate(reordered, runtime.exec())
    expect(replay.delegationId).toBe(first.delegationId)
    expect(runtime.subagents.start).toHaveBeenCalledTimes(1)
    await expect(runtime.service.delegate({ ...reordered, prompt: '不同任务输入' }, runtime.exec())).rejects.toThrow('输入或任务版本已改变')
  })

  it('rejects a contract that changes while delegation waits for its reservation lock', async () => {
    const runtime = await makeRuntime()
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const update = runtime.service.AddTaskCard({ ...card(), task_id: created.task_id, goal: '更新后的任务目标' }, runtime.exec())
    const execution = runtime.service.delegate({ task_id: created.task_id, role: 'mou_ding', prompt: '旧合同请求', backend: 'api', session: 'oneshot' }, runtime.exec())
    const [updated, result] = await Promise.allSettled([update, execution])
    expect(updated.status).toBe('fulfilled')
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'STALE_EVIDENCE' })
    expect(runtime.subagents.start).not.toHaveBeenCalled()
  })

  it('starts at most one expert for concurrent submissions of the same request_id', async () => {
    const runtime = await makeRuntime()
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const request = { task_id: created.task_id, role: 'mou_ding', node_id: 'analysis', request_id: 'same-logical-request', prompt: '只提交一份分析', backend: 'api', session: 'oneshot' }
    const outcomes = await Promise.allSettled([runtime.service.delegate(request, runtime.exec()), runtime.service.delegate(request, runtime.exec())])
    expect(runtime.subagents.start).toHaveBeenCalledTimes(1)
    const completed = outcomes.filter((outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<SwarmService['delegate']>>> => outcome.status === 'fulfilled')
    expect(completed.length).toBeGreaterThan(0)
    expect(new Set(completed.map((outcome) => outcome.value.delegationId)).size).toBe(1)
    expect(taskView(runtime, created.task_id).delegations).toHaveLength(1)
  })

  it('refunds a cancelled unsent delegation waiting for a workspace lease and clears its running marker', async () => {
    const runtime = await makeRuntime({ config: { execution: { profile: 'bounded', maxCalls: 1 } } })
    const created = await runtime.service.AddTaskCard(card({ scope: ['hello.txt'], flags: { changesCode: true } }), runtime.exec())
    const manager = createWorkspaceLeaseManager()
    const external = await manager.acquire(runtime.home, 'external-owner', 'write')
    const cancellation = new AbortController()
    const waiting = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'ji_feng', node_id: 'implementation', request_id: 'not-sent', prompt: '等待锁', backend: 'api', session: 'oneshot' }, { agent: runtime.root, signal: cancellation.signal }))
    const handled = waiting.catch((error: unknown) => error)
    try {
      await vi.waitFor(() => expect(taskView(runtime, created.task_id).flow?.state?.nodes.implementation?.status).toBe('running'))
      expect(runtime.subagents.start).not.toHaveBeenCalled()
      cancellation.abort()
      expect(await handled).toBeInstanceOf(Error)
      expect(taskView(runtime, created.task_id).flow?.state?.nodes.implementation?.status).not.toBe('running')
    } finally { await external.release({ confirmedStopped: true }) }
    const restarted = await runtime.service.delegate({ task_id: created.task_id, role: 'ji_feng', node_id: 'implementation', request_id: 'new-after-cancel', prompt: '执行唯一预算允许的写任务', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(restarted.status).toBe('completed')
    expect(runtime.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('fails closed while a known expert owner is waiting for its durable identity binding', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    const originalFactory = AgentBindings.createAgentBindingRegistry
    const spy = vi.spyOn(AgentBindings, 'createAgentBindingRegistry').mockImplementation((store) => {
      const registry = originalFactory(store)
      return { ...registry, bind: async (input) => { entered.resolve(); await release.promise; return registry.bind(input) } }
    })
    let running: Promise<unknown> | undefined
    let runtime: Awaited<ReturnType<typeof makeRuntime>> | undefined
    try {
      runtime = await makeRuntime({ pending: true })
      const created = await runtime.service.AddTaskCard(card({ scope: ['hello.txt'], flags: { changesCode: true } }), runtime.exec())
      running = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'ji_feng', node_id: 'implementation', prompt: '绑定持久提交尚未完成', backend: 'api', session: 'oneshot' }, runtime.exec()))
      await entered.promise
      const child = runtime.runs[0]!.agent
      expect(runtime.service.getRoleForAgent(child)).toBe('ji_feng')
      expect(runtime.service.getGuardReason({ name: 'write', agent: child })).toBeDefined()
      expect(runtime.service.getGuardReason({ name: 'bash', agent: child })).toBeDefined()
    } finally {
      release.resolve(); runtime?.runs[0]?.release()
      await running?.catch(() => undefined)
      spy.mockRestore()
    }
  })

  it.each(['card', 'foreign-task', 'binding', 'context-digest', 'budget', 'dangling-delegation'])('rejects checksummed but invalid %s recovery state before exposing it', async (damage) => {
    const runtime = await makeRuntime({ config: { persistence: { enabled: true } } })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    await runtime.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [1] } }, runtime.exec())
    await runtime.service.dispose()
    const directory = join(runtime.home, 'share', 'dsh-agent-swarm', 'state', await getWorkspaceId(runtime.home), digest(runtime.root.id))
    // Recompute valid storage checksums through the store to exercise schema validation, not only hash corruption.
    const tampering = await createDurableStateStore<Record<string, unknown>>({ directory, initialState: {} })
    try {
      await tampering.commit('fixture/invalid-schema', (draft) => {
        const tasks = draft.tasks as Array<Record<string, unknown>>
        if (damage === 'card') tasks[0]!.card = { title: 'damaged', goal: 42, acceptance: [], flags: {} }
        if (damage === 'foreign-task') tasks[0]!.sessionId = 'another-root'
        if (damage === 'binding') (draft.bindings as Record<string, unknown>).fake = { agentId: 'fake', permissions: 'unvalidated-shell' }
        if (damage === 'context-digest') (draft.contexts as Array<Record<string, unknown>>)[0]!.text = 'modified without its context digest'
        if (damage === 'budget') (draft.budgets as Record<string, unknown>)[created.task_id] = { schemaVersion: 1, limits: {}, reservations: [], jev: { attempts: -1 } }
        if (damage === 'dangling-delegation') tasks[0]!.delegationIds = ['missing-record']
      })
    } finally { await tampering.dispose() }
    const restored = await makeRuntime({ home: runtime.home, config: { persistence: { enabled: true } } })
    const result = await restored.service.ReadContext({ task_id: created.task_id, ref: refs[0] }, restored.exec()).then(() => undefined, (error: unknown) => error)
    expect(result).toBeInstanceOf(Error)
    expect(result).not.toBeInstanceOf(TypeError)
    expect((result as { code: string }).code).toMatch(/STATE_INVALID|RECOVERY_REQUIRED/)
    expect(restored.subagents.start).not.toHaveBeenCalled()
  })

  it('promotes experience only from current actual author/reviewer/verification evidence and refuses self-reported reviews', async () => {
    let feature!: FeatureSessions.FeatureSession
    const originalFactory = FeatureSessions.createFeatureSession
    const spy = vi.spyOn(FeatureSessions, 'createFeatureSession').mockImplementation(async (input) => { feature = await originalFactory(input); return feature })
    try {
      const runtime = await makeRuntime({ config: { experience: { enabled: true } } })
      const created = await runtime.service.AddTaskCard(card({ scope: ['src/a.ts'], flags: { changesCode: true, crossModuleArchitecture: true } }), runtime.exec())
      for (const role of ['zhu_jian', 'fu_he', 'yu_shi'] as const) {
        const record = await runtime.service.delegate({ task_id: created.task_id, role, prompt: '绑定当前实现并独立检查', backend: 'api', session: 'oneshot' }, runtime.exec())
        expect(record.status).toBe('completed')
      }
      const decision = await runtime.service.AcceptTask({ ...accept(created.task_id), summary: '有当前独立复核证据的增量实现' }, runtime.exec())
      expect(decision.status).toBe('accepted')
      const entries = await runtime.service.Experience({ task_id: created.task_id, includeCandidates: true }, runtime.exec()) as ExperienceEntry[]
      expect(entries).toHaveLength(1)
      const candidate = entries[0]!
      if (candidate.status === 'candidate') {
        await expect(feature.experiences.promote(candidate.id, { author: 'claimed-author', reviewer: 'claimed-reviewer', sourceArtifactDigest: candidate.source.artifactDigest, reviewArtifactDigest: 'b'.repeat(64), evidenceComplete: true, applicabilityConfirmed: true, unresolvedSevere: 0 })).rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
        const promoted = await feature.promoteCandidateWithEvidence(candidate.id)
        expect(promoted.status).toBe('validated')
        expect(runtime.runs.map((run) => run.agent.id)).toContain(promoted.reviewer)
      }
      expect(feature.experiences.list()).toHaveLength(1)
      const staleCandidate = await feature.experiences.addCandidate({ problemClass: candidate.problemClass, conclusion: candidate.conclusion, appliesWhen: candidate.appliesWhen, doesNotApplyWhen: candidate.doesNotApplyWhen, source: candidate.source, verification: candidate.verification, counterexamples: [], operatorVersions: [], expiresAt: candidate.expiresAt })
      await mkdir(join(runtime.home, 'src'), { recursive: true })
      await writeFile(join(runtime.home, 'src', 'a.ts'), 'changed after acceptance')
      await expect(feature.promoteCandidateWithEvidence(staleCandidate.id)).rejects.toMatchObject({ code: 'EXPERIENCE_REVIEW_REQUIRED' })
    } finally { spy.mockRestore() }
  })

  it('blocks blind expert raw filesystem access to private state/ledger including POSIX symlink and parent traversal', async () => {
    const runtime = await makeRuntime({ pending: true, config: { persistence: { enabled: true } } })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const running = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'suan_heng', mode: 'verify', prompt: '只做独立验算', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const child = runtime.runs[0]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(child))).toMatchObject({ cardRevision: created.cardRevision }))
    const state = join(runtime.home, 'share', 'dsh-agent-swarm', 'state')
    const ledger = join(runtime.home, 'share', 'dsh-agent-swarm', 'ledger')
    const requests = [
      { name: 'read', arguments: { file_path: join(state, 'secret.json') } },
      { name: 'read', arguments: { path: join(ledger, 'task-runtime-root.jsonl') } },
      { name: 'glob', arguments: { glob: state + '/**/*.json' } },
      { name: 'grep', arguments: { path: state, pattern: 'private-proof' } }
    ]
    try {
      for (const request of requests) expect(runtime.service.getGuardReason({ ...request, agent: child }), JSON.stringify(request)).toBeDefined()
      expect(runtime.service.getGuardReason({ name: 'read', arguments: { file_path: join(runtime.home, 'public-source.ts') }, agent: child })).toBeUndefined()
      if (process.platform !== 'win32') {
        await mkdir(join(state, 'subdir'), { recursive: true })
        await writeFile(join(state, 'secret.json'), 'private-proof')
        await symlink(join(state, 'subdir'), join(runtime.home, 'link'))
        // Preserve the literal path; path.join/resolve would fold away the attack before the guard sees it.
        expect(runtime.service.getGuardReason({ name: 'read', arguments: { file_path: 'link/../secret.json' }, agent: child })).toBeDefined()
      }
    } finally { runtime.runs[0]!.release(); await running }
  })

  it('persists and restores stable profile route quarantine without resuming an ephemeral half-open agent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'swarm-route-health-state-')); directories.push(home)
    const config = getSwarmConfig({ persistence: { enabled: true }, planningReview: { enabled: false } })
    const tasks = intTaskStore(); const threads = intThreadRegistry()
    const input = { rootSessionId: 'health-root', cwd: home, dshHome: home, config, tasks, threads, now: () => 1000 }
    const feature = await FeatureSessions.createFeatureSession(input)
    let restored: FeatureSessions.FeatureSession | undefined
    try {
      expect(feature.store.read().routeHealth).toBeUndefined()
      const health: RouteHealthEntry[] = [{ key: 'domain:shared-subscription', aliases: ['domain:shared-subscription', 'route:qwen-token-plan-cn/deepseek-test'], kind: 'quota_exhausted', failedAt: 1000, resetAt: 10000, halfOpenAgent: 'dead-half-open-agent', route: { provider: 'qwen-token-plan-cn', model: 'deepseek-test', policy: { accessMode: 'subscription', quotaDomainId: 'shared-subscription', quotaScope: 'plan' } } }]
      await feature.persist('route/isolate', tasks, threads, health)
      const saved = feature.store.read().routeHealth!
      expect(saved).toHaveLength(1)
      expect(saved[0]).not.toHaveProperty('halfOpenAgent')
      expect(saved[0]).toMatchObject({ kind: 'quota_exhausted', failedAt: 1000, resetAt: 10000 })
      await feature.persist('unrelated/checkpoint', tasks, threads)
      expect(feature.store.read().routeHealth).toEqual(saved)
      await feature.dispose()
      restored = await FeatureSessions.createFeatureSession({ ...input, tasks: intTaskStore(), threads: intThreadRegistry() })
      expect(restored.store.read().routeHealth).toEqual(saved)
      for (const change of [{ kind: 'invented' }, { resetAt: NaN }, { failedAt: -1 }, { key: 'unsafe key' }, { aliases: ['not-a-route-key'] }, { aliases: ['domain:duplicate', 'domain:duplicate'] }, { route: { provider: '', model: 'model' } }]) {
        await expect(restored.persist('route/invalid', input.tasks, input.threads, [{ ...saved[0]!, ...change } as RouteHealthEntry])).rejects.toThrow()
        expect(restored.store.read().routeHealth).toEqual(saved)
      }
      await restored.persist('route/confirmed-recovery', input.tasks, input.threads, [])
      expect(restored.store.read().routeHealth).toEqual([])
    } finally { await feature.dispose(); await restored?.dispose() }
  })

  it.each(reviewCases)('rejects $role response before a current frozen blind report exists', async (scenario) => {
    const runtime = await makeRuntime({ config: { persistence: { enabled: true }, messageBus: { enabled: true } } })
    const created = await runtime.service.AddTaskCard(card({ flags: scenario.flags }), runtime.exec())
    const before = structuredClone(taskView(runtime, created.task_id).flow?.state?.nodes[scenario.node])
    await expect(runtime.service.delegate({ task_id: created.task_id, role: scenario.role, ...(scenario.mode ? { mode: scenario.mode } : {}), node_id: scenario.node, review_phase: 'response', prompt: '未有独立初审不得直接回应', backend: 'api', session: 'oneshot' }, runtime.exec())).rejects.toMatchObject({ code: 'PLANNING_REVIEW_REQUIRED' })
    expect(runtime.subagents.start).not.toHaveBeenCalled()
    expect(taskView(runtime, created.task_id).flow?.state?.nodes[scenario.node]).toEqual(before)
  })

  it.each(reviewCases)('allows direct $role peer response after frozen blind review without reopening the completed node', async (scenario) => {
    const runtime = await makeRuntime({ pending: true, config: { persistence: { enabled: true }, messageBus: { enabled: true } } })
    await writeFile(join(runtime.home, 'subject.ts'), 'export const subject = 1')
    const created = await runtime.service.AddTaskCard(card({ scope: ['subject.ts'], flags: scenario.flags }), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const args = { task_id: created.task_id, role: scenario.role, ...(scenario.mode ? { mode: scenario.mode } : {}), node_id: scenario.node, prompt: '先独立冻结当前版本报告', backend: 'api', session: 'oneshot' }
    const blind = trackWork(runtime.service.delegate(args, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const blindAgent = runtime.runs[0]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(blindAgent))).toMatchObject({ cardRevision: created.cardRevision }))
    await expect(runtime.service.MessageRead({}, runtime.exec(blindAgent))).rejects.toThrow()
    runtime.runs[0]!.release()
    const frozen = await blind
    expect(frozen).toMatchObject({ status: 'completed', reviewPhase: 'blind', hardIsolation: true })
    const completedNode = structuredClone(taskView(runtime, created.task_id).flow?.state?.nodes[scenario.node])
    expect(completedNode?.status).toBe('succeeded')
    const author = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'mou_ding', prompt: '作者在当前版本解释冻结报告问题', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(2))
    const authorAgent = runtime.runs[1]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(authorAgent))).toMatchObject({ cardRevision: created.cardRevision }))
    const response = trackWork(runtime.service.delegate({ ...args, review_phase: 'response', prompt: '保留初审冻结证据，开放直接 peer 回应' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(3))
    const responseAgent = runtime.runs[2]!.agent
    await vi.waitFor(async () => expect(await runtime.service.MessageRead({}, runtime.exec(responseAgent))).toMatchObject({ messages: [] }))
    expect(taskView(runtime, created.task_id).flow?.state?.nodes[scenario.node]).toEqual(completedNode)
    const sent = await runtime.service.MessageSend({ taskId: created.task_id, toAgentId: responseAgent.id, kind: 'review-response', summary: '作者对冻结发现给出证据解释' }, runtime.exec(authorAgent)) as { id: string }
    expect(await runtime.service.MessageRead({}, runtime.exec(responseAgent))).toMatchObject({ messages: [{ id: sent.id, fromAgentId: authorAgent.id }] })
    await runtime.service.MessageAck({ messageIds: [sent.id] }, runtime.exec(responseAgent))
    const replied = await runtime.service.MessageSend({ taskId: created.task_id, toAgentId: authorAgent.id, kind: 'review-response', summary: '独立审查者直接回应作者', correlationId: sent.id }, runtime.exec(responseAgent)) as { id: string }
    expect(await runtime.service.MessageRead({}, runtime.exec(authorAgent))).toMatchObject({ messages: [{ id: replied.id, correlationId: sent.id }] })
    runtime.runs[2]!.release()
    const discussed = await response
    runtime.runs[1]!.release(); await author
    expect(discussed.reviewPhase).toBe('response')
    expect(taskView(runtime, created.task_id).flow?.state?.nodes[scenario.node]).toEqual(completedNode)
    expect(taskView(runtime, created.task_id).gates.find((gate) => gate.gate === scenario.gate)?.by).toBe(frozen.delegationId)
  })

  it.each(reviewCases)('requires new $role blind review when the frozen source artifact changes', async (scenario) => {
    const runtime = await makeRuntime()
    await writeFile(join(runtime.home, 'subject.ts'), 'export const subject = 1')
    const created = await runtime.service.AddTaskCard(card({ scope: ['subject.ts'], flags: scenario.flags }), runtime.exec())
    const args = { task_id: created.task_id, role: scenario.role, ...(scenario.mode ? { mode: scenario.mode } : {}), node_id: scenario.node, prompt: '检查当前真实源码', backend: 'api', session: 'oneshot' }
    const first = await runtime.service.delegate(args, runtime.exec())
    expect(first.reviewPhase).toBe('blind')
    await writeFile(join(runtime.home, 'subject.ts'), 'export const subject = 2')
    await expect(runtime.service.delegate({ ...args, review_phase: 'response' }, runtime.exec())).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
    expect(runtime.subagents.start).toHaveBeenCalledTimes(1)
    const fresh = await runtime.service.delegate({ ...args, review_phase: 'blind' }, runtime.exec())
    expect(fresh).toMatchObject({ status: 'completed', reviewPhase: 'blind' })
    expect(fresh.artifactAfter).not.toBe(first.artifactAfter)
    expect((await runtime.service.delegate({ ...args, review_phase: 'response' }, runtime.exec())).reviewPhase).toBe('response')
    expect(taskView(runtime, created.task_id).gates.find((gate) => gate.gate === scenario.gate)?.by).toBe(fresh.delegationId)
  })

  it('applies hot execution limits to an existing task without resetting consumed calls or treating unknown usage as zero', async () => {
    const runtime = await makeRuntime({ config: { execution: { profile: 'bounded', maxCalls: 3 } } })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const args = { task_id: created.task_id, role: 'mou_ding', prompt: '当前任务分析', backend: 'api', session: 'oneshot' }
    await runtime.service.delegate(args, runtime.exec())
    runtime.config.execution.maxCalls = 1
    await expect(runtime.service.delegate(args, runtime.exec())).rejects.toThrow('maxDelegations')
    runtime.config.execution.maxCalls = 2
    expect((await runtime.service.delegate(args, runtime.exec())).status).toBe('completed')
    expect(runtime.subagents.start).toHaveBeenCalledTimes(2)
    runtime.config.execution.maxCalls = 0
    runtime.config.execution.maxTokens = 100
    await expect(runtime.service.delegate(args, runtime.exec())).rejects.toMatchObject({ code: 'BUDGET_UNSUPPORTED' })
    expect(await runtime.service.Calculate({ task_id: created.task_id, op: 'sum', mode: 'float64', args: { values: [2, 3] } }, runtime.exec())).toMatchObject({ ok: true, value: 5 })
    runtime.config.execution.maxTokens = 0
    runtime.config.execution.maxCostUsd = 1
    await expect(runtime.service.delegate(args, runtime.exec())).rejects.toMatchObject({ code: 'BUDGET_UNSUPPORTED' })
    expect(runtime.subagents.start).toHaveBeenCalledTimes(2)
  })

  it('rejects hot reconfiguration for new generation while letting an already-started original budget settle', async () => {
    const runtime = await makeRuntime({ pending: true, config: { execution: { profile: 'bounded', maxCalls: 2 } } })
    const created = await runtime.service.AddTaskCard(card(), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const args = { task_id: created.task_id, role: 'mou_ding', prompt: '保留运行中原预算', backend: 'api', session: 'oneshot' }
    const pending = trackWork(runtime.service.delegate(args, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(runtime.runs[0]!.agent))).toMatchObject({ cardRevision: created.cardRevision }))
    runtime.config.execution.maxCalls = 1
    await expect(runtime.service.delegate(args, runtime.exec())).rejects.toMatchObject({ code: 'BUDGET_TRANSITION' })
    runtime.runs[0]!.release()
    expect((await pending).status).toBe('completed')
    await expect(runtime.service.delegate(args, runtime.exec())).rejects.toThrow('maxDelegations')
    expect(runtime.subagents.start).toHaveBeenCalledTimes(1)
  })

  it('fences writer tools, context and peer messaging after same-id user intent edits while card/flow remain unchanged', async () => {
    const runtime = await makeRuntime({ pending: true, config: { persistence: { enabled: true }, messageBus: { enabled: true } } })
    const user = { id: 'same-user-message', role: 'user', content: [{ type: 'text' as const, text: '修改 subject.ts 并核对结果' }] }
    runtime.root.session!.deriveMessages = () => [user]
    await writeFile(join(runtime.home, 'subject.ts'), 'export const subject = 1')
    const created = await runtime.service.AddTaskCard(card({ scope: ['subject.ts'], flags: { changesCode: true } }), runtime.exec())
    const refs = contextRefs(runtime, created.task_id, created)
    const writer = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'ji_feng', node_id: 'implementation', prompt: '按首个用户要求执行', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(1))
    const writerAgent = runtime.runs[0]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(writerAgent))).toMatchObject({ requestRevision: 1 }))
    const peer = trackWork(runtime.service.delegate({ task_id: created.task_id, role: 'mou_ding', prompt: '等待当前用户要求下的协作消息', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(2))
    const peerAgent = runtime.runs[1]!.agent
    await vi.waitFor(async () => expect(await runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(peerAgent))).toMatchObject({ requestRevision: 1 }))
    const queued = await runtime.service.MessageSend({ taskId: created.task_id, toAgentId: peerAgent.id, kind: 'question', summary: '首个需求下的消息' }, runtime.exec(writerAgent)) as { id: string; requestRevision: number }
    expect(queued.requestRevision).toBe(1)
    const before = taskView(runtime, created.task_id)
    expect(runtime.service.getGuardReason({ name: 'write', arguments: { path: 'subject.ts' }, agent: writerAgent })).toBeUndefined()
    user.content[0]!.text = '同一消息修订：只分析 subject.ts，禁止继续写入'
    // Guard itself must read the current root intent, not depend on a preceding status refresh.
    expect(runtime.service.getGuardReason({ name: 'write', arguments: { path: 'subject.ts' }, agent: writerAgent })).toBeDefined()
    expect(runtime.service.getGuardReason({ name: 'bash', agent: writerAgent })).toBeDefined()
    const after = taskView(runtime, created.task_id)
    expect(after.requestRevision).toBe(before.requestRevision + 1)
    expect(after.cardRevision).toBe(before.cardRevision)
    expect(after.workflowRevision).toBe(before.workflowRevision)
    await expect(runtime.service.ReadContext({ ref: refs[0] }, runtime.exec(writerAgent))).rejects.toThrow()
    await expect(runtime.service.ReadContext({ task_id: created.task_id, ref: refs[0] }, runtime.exec())).rejects.toThrow()
    await expect(runtime.service.MessageSend({ taskId: created.task_id, toAgentId: peerAgent.id, kind: 'answer', summary: '旧身份不能回答新需求' }, runtime.exec(writerAgent))).rejects.toThrow()
    await expect(runtime.service.MessageRead({}, runtime.exec(peerAgent))).rejects.toThrow()
    await expect(runtime.service.MessageAck({ messageIds: [queued.id] }, runtime.exec(peerAgent))).rejects.toThrow()
    runtime.runs[0]!.release(); runtime.runs[1]!.release()
    await Promise.all([writer, peer])
  })
})
