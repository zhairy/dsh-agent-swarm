import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile, rename, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike, SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { getWorktreeOwnerKey, type WorktreeRegistry } from '../../src/worktree-binding.js'
import type { WorktreeHostPort } from '../../src/adapters/dsh-host/worktree.js'
import { getWorkspaceId, getArtifactSnapshot } from '../../src/artifacts.js'
import { getValueDigest } from '../../src/workflow.js'
import { VALID_OUTPUTS } from '../../tests/fixtures/valid-outputs.js'

const git = promisify(execFile)
const directories: string[] = []
const services: SwarmService[] = []
const releases: Array<() => void> = []
const pending: Promise<unknown>[] = []
let fixtureTime = 1000
const track = <T>(work: Promise<T>) => { pending.push(work.catch(() => undefined)); return work }
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  await Promise.all(services.splice(0).map((service) => service.dispose().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

// workingDirectory 是宿主投影，不改 header.cwd；测试端口须能回读真实投影。
const createFixtureWorktreeHost = (observation: import('../../src/worktree-binding.js').WorktreeObservation) => {
  const directories = new Map<string, string>()
  return { cwd: (agent: AgentLike) => directories.get(agent.id) ?? agent.session.header.cwd!,
    setCwd: vi.fn(async (agent: AgentLike, path: string) => { directories.set(agent.id, path); return path }),
    inspect: vi.fn(async () => structuredClone(observation)) } satisfies WorktreeHostPort
}
const tanOutput = { summary: 'stableSum 使用 reduce 求和', unresolved: [], findings: [{ path: 'src/math.ts', symbol: 'stableSum', callChain: ['stableSum'], evidence: '实现调用 values.reduce，初始和为 0' }] }
const score = { type: 'score', score: 3, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } }
const makeRuntime = async (options: { home?: string; jev?: 'known' | 'disabled' | 'network'; pendingRoles?: DelegableRoleId[]; worktreeHost?: WorktreeHostPort; writerBoundary?: import('../../src/application/service-api.js').SwarmServiceDepsInfo['writerBoundary'] } = {}) => {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'swarm-evidence-service-'))
  if (options.home === undefined) {
    directories.push(home)
    await git('git', ['init', '--quiet'], { cwd: home })
    await mkdir(join(home, 'src'))
    await writeFile(join(home, 'src', 'math.ts'), 'export function stableSum(values: number[]) { return values.reduce((sum, value) => sum + value, 0) }\n')
    await writeFile(join(home, 'package.json'), '{"name":"evidence-service-fixture","version":"2.3.0"}')
  }
  const root: AgentLike = { id: 'evidence-service-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const agents = new Map<string, AgentLike>([[root.id, root]])
  const exec = (agent = root) => ({ agent, signal: new AbortController().signal })
  const config = getSwarmConfig({ jev: { enabled: options.jev !== 'disabled', baseUrl: 'https://jev.fixture.invalid', maxRetries: 0, apiKeyEnv: 'SWARM_EVIDENCE_TEST_KEY' },
    review: { enabled: false }, planningReview: { enabled: false }, persistence: { enabled: true }, messageBus: { enabled: true },
    experience: { enabled: true }, workflow: { mode: 'advisory' }, agents: { session: 'oneshot', maxRetries: 0 } })
  const runs: Array<{ agent: AgentLike; role: DelegableRoleId; release: () => void }> = []
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => name === 'spawn' ? { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } } : undefined,
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      if (!role) throw new Error('Expected a real expert role marker')
      const id = 'evidence-child-' + (runs.length + 1)
      const agent: AgentLike & { status: 'idle' } = { id, status: 'idle', session: { header: { parentSession: root.id, cwd: home } } }
      agents.set(id, agent)
      let finish!: (result: SubagentResultLike) => void
      const result = new Promise<SubagentResultLike>((resolve) => { finish = resolve })
      const release = () => finish({ output: [], structured: role === 'tan_wei' ? structuredClone(tanOutput) : structuredClone(VALID_OUTPUTS[role]), stopReason: 'completed' })
      runs.push({ agent, role, release }); releases.push(release)
      if (!options.pendingRoles?.includes(role)) release()
      return { id, result, dispose: async () => undefined }
    })
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (!String(url).startsWith('https://jev.fixture.invalid/')) throw new Error('Unit tests may only call the fake Jev transport')
    if (options.jev === 'network') throw new Error('Fixture network outage')
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    expect(body.questions).toBeTypeOf('object')
    return new Response(JSON.stringify({ model: 'jev-fixture', answers: {
      math_task: { type: 'choice', choice: 'ordinary', confidence: 0.9, probabilities: { ordinary: 1 } },
      need_benchmark: { type: 'noul', noul: 0 }, novelty: { type: 'score', score: 0, confidence: 0.9, probabilities: { '0': 1, '1': 0, '2': 0 } },
      credibility: score, relevance: score, support: { type: 'choice', choice: 'supports', confidence: 0.9 },
      confidence: { type: 'score', score: 3, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } }
    }, usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  })
  const llm = { listProviders: () => [{ id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }, { id: 'deepseek-official' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  const service = intSwarmService({ getConfig: () => config,
    getLlm: () => llm,
    getSubagents: () => subagents,
    getAgent: id => agents.get(id),
    getWorktreeHost: () => options.worktreeHost,
    writerBoundary: options.writerBoundary,
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'glob', 'grep', 'swarm_context_read', 'swarm_message_send', 'swarm_message_read', 'swarm_message_ack'].map((name) => ({ name })) }),
    getCredentials: () => ({ resolve: async () => ({ value: 'fixture-only-no-live-credential' }) }), getAttachments: () => undefined,
    dshHome: home, fetch, gitStatus: async () => undefined, sleep: async () => undefined,
    probe: async () => ({ ok: true, vision: true }), now: () => ++fixtureTime })
  services.push(service)
  return { service, root, exec, home, fetch, subagents, runs, agents }
}
type Runtime = Awaited<ReturnType<typeof makeRuntime>>
const createTask = (runtime: Runtime) => runtime.service.AddTaskCard({ title: '探索求和实现', goal: '检查 stableSum 当前实现及证据', acceptance: ['判断必须绑定真实源码'], scope: ['src/math.ts'], flags: {} }, runtime.exec())

const taskStores = vi.hoisted(() => ({ current: undefined as ReturnType<typeof import('../../src/evidence.js').intTaskStore> | undefined }))
vi.mock('../../src/evidence.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/evidence.js')>()
  return { ...actual, intTaskStore: (...args: Parameters<typeof actual.intTaskStore>) => {
    const store = actual.intTaskStore(...args); taskStores.current = store; return store
  } }
})
const registries = vi.hoisted(() => ({ current: undefined as WorktreeRegistry | undefined }))
vi.mock('../../src/worktree-binding.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/worktree-binding.js')>()
  return { ...actual, intWorktreeRegistry: (...args: Parameters<typeof actual.intWorktreeRegistry>) => {
    const registry = actual.intWorktreeRegistry(...args)
    registries.current = registry
    return registry
  } }
})
const gates = vi.hoisted(() => ({ wait: undefined as undefined | (() => Promise<void>), skip: 0 }))
vi.mock('../../src/artifacts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/artifacts.js')>()
  return { ...actual, getArtifactSnapshot: async (...args: Parameters<typeof actual.getArtifactSnapshot>) => {
    const wait = gates.skip-- > 0 ? undefined : gates.wait
    if (wait) gates.wait = undefined
    if (wait) await wait()
    return actual.getArtifactSnapshot(...args)
  } }
})
const pauseSnapshot = (skip = 0) => {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  releases.push(release)
  gates.skip = skip
  gates.wait = async () => { enter(); await blocked }
  return { entered, release }
}
it('refuses changed contracts at actual dispatch, without fallback or publishing a new contract under old admission', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const gate = pauseSnapshot()
  const work = track(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'old contract', backend: 'api', session: 'oneshot' }, runtime.exec()))
  await gate.entered
  await runtime.service.AddTaskCard({ task_id: task.task_id, title: 'changed', goal: 'NEW-UNAPPROVED', acceptance: ['new'], scope: ['src/math.ts'], flags: {} }, runtime.exec())
  gate.release()
  await expect(work).rejects.toThrow('投递前合同')
  expect(runtime.subagents.start).not.toHaveBeenCalled()
  const record = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec()).tasks[0]!.delegations[0]!
  expect(record.finalization).toBe('failed')
  expect(record.cardRevision).toBe(task.cardRevision)
})
it('blocks premature acceptance and avoids the taskLock/workspace-lease cycle with experience enabled', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const gate = pauseSnapshot(1)
  const work = track(runtime.service.delegate({ task_id: task.task_id, role: 'fu_he', prompt: 'verify', backend: 'api', session: 'oneshot' }, runtime.exec()))
  await gate.entered
  const acceptArgs = { task_id: task.task_id, decision: 'accept', summary: 'fixture acceptance', unresolved: [], stopReason: 'done' }
  const early = await runtime.service.AcceptTask(acceptArgs, runtime.exec())
  expect(early.status).toBe('blocked')
  expect(early.missing.join('')).toContain('未结束')
  gate.release()
  const completed = await work
  expect(completed.finalization).toBe('ready')
  runtime.service.agentControl?.Register({ childId: 'settled-persistent-control', parentSessionId: runtime.root.id, taskId: task.task_id,
    delegationId: completed.delegationId, persistent: true, cardRevision: task.cardRevision, workflowRevision: task.workflowRevision, requestRevision: task.requestRevision })
  const final = await runtime.service.AcceptTask(acceptArgs, runtime.exec())
  expect(final.status).toBe('accepted')
  expect(runtime.service.agentControl?.get('settled-persistent-control')).toBeUndefined()
}, 5000)
it('cancellation after model completion never publishes current completion evidence or L2 material', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const controller = new AbortController()
  const gate = pauseSnapshot(1)
  const work = track(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read only', backend: 'api', session: 'oneshot' }, { agent: runtime.root, signal: controller.signal }))
  await gate.entered
  controller.abort(); gate.release()
  await expect(work).rejects.toThrow('已取消')
  const status = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec())
  const record = status.tasks[0]!.delegations[0]!
  expect(record.status).toBe('completed') // preserve raw model result
  expect(record.finalization).toBe('cancelled')
  expect(record.evidenceAssessment).toBeNull()
  expect(status.tasks[0]!.contextRefs).toHaveLength(2)
  expect(runtime.service.agentControl?.get(runtime.runs[0]!.agent.id)?.reason).toBe('one-shot-cancelled')
  await expect(runtime.service.WaitAgentReady(runtime.runs[0]!.agent)).rejects.toThrow('已取消')
})

it('an explicit incomplete decision fences an admitted child still awaiting fingerprint', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const gate = pauseSnapshot()
  const work = track(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read', backend: 'api', session: 'oneshot' }, runtime.exec()))
  await gate.entered
  await runtime.service.AcceptTask({ task_id: task.task_id, decision: 'incomplete', summary: 'stop task', stopReason: 'user stopped' }, runtime.exec())
  gate.release()
  await expect(work).rejects.toThrow('任务已停止')
  expect(runtime.subagents.start).not.toHaveBeenCalled()
})

it('releases completed one-shot runtime scope while retaining its bounded control record', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const completed = await runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read only', backend: 'api', session: 'oneshot' }, runtime.exec())
  expect(completed.childId).toBeTypeOf('string')
  expect(runtime.service.getChildPrompt(completed.childId!)).toBeUndefined()
  expect(await runtime.service.getAgentViewForRpc(runtime.root.id, completed.childId!)).toMatchObject({ persistent: false, oneShotSettled: true })
})

it('rejects a late managed child request without relying on a bounded history id set', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const late = { id: 'late-managed-child', session: { header: { parentSession: runtime.root.id, agentPreset: 'tan-wei' } } }
  const external = { id: 'external-child', session: { header: { parentSession: runtime.root.id, agentPreset: 'standard' } } }
  await expect(runtime.service.WaitAgentReady(late)).rejects.toThrow('执行授权已结束')
  expect(runtime.service.getGuardReason({ name: 'read', arguments: {}, agent: late })).toContain('执行授权已结束')
  await expect(runtime.service.WaitAgentReady(external)).resolves.toBeUndefined()
})

it('math cancelled while another operation holds taskLock never enters the kernel or publishes evidence', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const gate = pauseSnapshot()
  const holding = track(runtime.service.AcceptTask({ task_id: task.task_id, decision: 'incomplete', summary: 'stop fixture', stopReason: 'fixture' }, runtime.exec()))
  await gate.entered
  const controller = new AbortController()
  const calculation = track(runtime.service.Calculate({ task_id: task.task_id, op: 'add', mode: 'float64', args: { a: 2, b: 3 } }, { agent: runtime.root, signal: controller.signal }))
  await Promise.resolve(); await Promise.resolve()
  controller.abort(); gate.release()
  await holding
  await expect(calculation).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  const status = runtime.service.getStatus({ task_id: task.task_id }, runtime.exec())
  expect(status.executionBudgets[0]!.reservations).toEqual([])
  expect(status.tasks[0]!.contextRefs).toHaveLength(2)
})

it('producer 活动目录未经绑定时在投递前拒绝，不能保存错误目录产物', async () => {
  const runtime = await makeRuntime({ jev: 'disabled' })
  const task = await createTask(runtime)
  const physical = await mkdtemp(join(tmpdir(), 'swarm-producer-physical-'))
  directories.push(physical)
  await mkdir(join(physical, 'src'))
  await writeFile(join(physical, 'src', 'math.ts'), 'export const changedInWorker = true\n')
  runtime.root.session.header.cwd = physical
  await expect(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read physical source', backend: 'api', session: 'oneshot' }, runtime.exec()))
    .rejects.toThrow('活动产物目录未经任务绑定')
  expect(runtime.subagents.start).not.toHaveBeenCalled()
})

// 宿主 inspect 在此为受控端口；真实 Git/宿主边界由集成 fixture 验证。
it.each(['relative', 'root-absolute', 'tree-absolute'])('service 工作树采样映射 %s，根目录变化不能替代工作树变化', async mode => {
  const observation = { repositoryIdentity: 'repo', directoryIdentity: 'dir', gitIdentity: 'git', commonIdentity: 'common',
    gitDirectory: '/fixture/git', commonDirectory: '/fixture/common', head: 'a'.repeat(40) }
  const host = createFixtureWorktreeHost(observation)
  const runtime = await makeRuntime({ jev: 'disabled', worktreeHost: host })
  const tree = join(runtime.home, '.agents', 'worktrees', 'artifact')
  const scope = mode === 'relative' ? 'src/math.ts' : join(mode === 'root-absolute' ? runtime.home : tree, 'src', 'math.ts')
  const task = await runtime.service.AddTaskCard({ title: '工作树产物', goal: '读取真实工作树文件', acceptance: ['真实内容'], scope: [scope], flags: {} }, runtime.exec())
  await mkdir(join(tree, 'src'), { recursive: true })
  await writeFile(join(tree, 'src', 'math.ts'), 'export const workerOnly = 42\n')
  registries.current!.bind({ path: tree, repositoryRoot: runtime.home, branch: 'artifact', baseCommit: 'a'.repeat(40),
    agentId: 'fixture-writer', taskId: task.task_id, delegationId: 'fixture-write', observation: structuredClone(observation),
    execution: { attemptId: 'fixture-attempt', nodeId: 'write', requestRevision: 1, cardRevision: 1, workflowRevision: 1, generation: 1, leaseEpoch: 1 } })
  const start = runtime.subagents.start.getMockImplementation()!
  const logicalFinding = join(runtime.home, 'src', 'math.ts')
  runtime.subagents.start.mockImplementation(async (name, request) => {
    const handle = await start(name, request)
    return { ...handle, result: handle.result.then(result => ({ ...result,
      structured: { ...structuredClone(tanOutput), findings: tanOutput.findings.map(finding => ({ ...finding, path: logicalFinding })) } })) }
  })
  const paths = ['src/math.ts'], workspaceId = await getWorkspaceId(runtime.home)
  const expected = async () => { const physical = await getArtifactSnapshot(tree, paths); return getValueDigest({ workspaceId, entries: physical.entries }) }
  const first = await runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read tree', backend: 'api', session: 'oneshot' }, runtime.exec())
  expect(first.artifactAfter).toBe(await expected())
  expect(first.evidenceAssessment?.items[0]?.source).toMatchObject({ locator: logicalFinding, status: 'observed' })
  expect(first.evidenceAssessment?.items[0]?.source.supportingText).toContain('workerOnly')
  expect(first.evidenceAssessment?.items[0]?.source.supportingText).not.toContain('stableSum')
  expect(first.evidenceAssessment?.rawDigest).toBe(getValueDigest(first.structured))
  await writeFile(join(runtime.home, 'src', 'math.ts'), 'root-only change')
  const second = await runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read tree again', backend: 'api', session: 'oneshot' }, runtime.exec())
  expect(second.artifactAfter).toBe(first.artifactAfter)
  await writeFile(join(tree, 'src', 'math.ts'), 'worker changed')
  const third = await runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'read changed tree', backend: 'api', session: 'oneshot' }, runtime.exec())
  expect(third.artifactAfter).toBe(await expected())
  expect(third.artifactAfter).not.toBe(first.artifactAfter)
  expect(host.inspect).toHaveBeenCalled()
  observation.directoryIdentity = 'replaced'
  await expect(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: '拒绝替换目录', backend: 'api', session: 'oneshot' }, runtime.exec())).rejects.toThrow('目录身份已改变')
  observation.directoryIdentity = 'dir'
  registries.current!.suspend(registries.current!.findByTask(task.task_id)[0]!.worktreeId)
  await expect(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: '拒绝无完成记录的保留树', backend: 'api', session: 'oneshot' }, runtime.exec())).rejects.toThrow('归属或版本未经确认')
})

it.each([['completed', true, 1], ['failed', true, 1], ['blocked', true, 1], ['failed', false, 1], ['blocked', false, 1], ['completed', true, 2], ['failed', true, 2]] as const)('保留树状态 %s sealed=%s workflow=%s，只读采样不恢复写权', async (status, sealed, workflowRevision) => {
  const observation = { repositoryIdentity: 'repo', directoryIdentity: 'dir', gitIdentity: 'git', commonIdentity: 'common',
    gitDirectory: '/fixture/git', commonDirectory: '/fixture/common', head: 'a'.repeat(40) }
  const host = createFixtureWorktreeHost(observation)
  const boundary = { available: () => true, begin: vi.fn(), seal: vi.fn(() => sealed), quiescent: vi.fn(() => sealed) }
  const runtime = await makeRuntime({ jev: 'disabled', worktreeHost: host, writerBoundary: boundary })
  const writeChecks: Array<string | undefined> = []
  const setDirectory = host.setCwd.getMockImplementation()!
  host.setCwd.mockImplementation(async (agent, path) => {
    const actual = await setDirectory(agent, path)
    writeChecks.push(runtime.service.getGuardReason({ name: 'write', agent, arguments: { path: 'src/math.ts' } }))
    return actual
  })
  const task = await createTask(runtime)
  const completed = await runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: 'produce source evidence', backend: 'api', session: 'oneshot' }, runtime.exec())
  const tree = join(runtime.home, '.agents', 'worktrees', 'retained')
  await mkdir(join(tree, 'src'), { recursive: true })
  await writeFile(join(tree, 'src', 'math.ts'), 'export const retainedOnly = 42\n')
  const registry = registries.current!
  // 用公开存储入口构造终态 producer，避免非法地把 completed 回退为 failed。
  const producerId = status === 'completed' ? completed.delegationId : 'D-retained-terminal'
  if (status !== 'completed') taskStores.current!.AddDelegation({ ...structuredClone(completed), delegationId: producerId, status, finalization: 'cancelled', evidenceAssessment: undefined })
  const bound = registry.bind({ path: tree, repositoryRoot: runtime.home, branch: 'retained', baseCommit: 'a'.repeat(40),
    agentId: completed.childId!, taskId: task.task_id, delegationId: producerId, observation,
    execution: { attemptId: completed.attemptId!, nodeId: completed.nodeId ?? 'legacy', requestRevision: completed.requestRevision ?? 1,
      cardRevision: completed.cardRevision ?? 1, workflowRevision: completed.workflowRevision ?? 1, generation: 1, leaseEpoch: 1 } })
  if (workflowRevision !== 1) taskStores.current!.UpdateTask(task.task_id, { workflowRevision })
  registry.suspend(bound.worktreeId)
  const before = registry.findById(bound.worktreeId)
  if (status !== 'completed' && !sealed) {
    await expect(runtime.service.delegate({ task_id: task.task_id, role: 'fu_he', prompt: 'unknown epoch', backend: 'api', session: 'oneshot' }, runtime.exec())).rejects.toThrow('归属或版本未经确认')
    expect(registry.findById(bound.worktreeId)).toEqual(before)
    return
  }
  const next = await runtime.service.delegate({ task_id: task.task_id, role: 'fu_he', prompt: 'verify retained artifact', backend: 'api', session: 'oneshot' }, runtime.exec())
  const physical = await getArtifactSnapshot(tree, ['src/math.ts']), workspaceId = await getWorkspaceId(runtime.home)
  expect(next.artifactAfter).toBe(getValueDigest({ workspaceId, entries: physical.entries }))
  await expect(runtime.service.AcceptTask({ task_id: task.task_id, decision: 'accept', summary: '核对保留产物', stopReason: 'fixture verification complete' }, runtime.exec())).resolves.toBeDefined()
  expect(registry.findById(bound.worktreeId)).toEqual(before)
  const verifier = runtime.agents.get(next.childId!)!
  expect(host.setCwd).toHaveBeenCalledWith(verifier, tree, expect.any(AbortSignal))
  expect(host.cwd(verifier)).toBe(tree)
  expect(host.setCwd.mock.calls.every(([agent]) => agent.id === next.childId)).toBe(true)
  expect(writeChecks.length).toBeGreaterThan(0)
  expect(writeChecks.every(reason => reason !== undefined)).toBe(true)
  expect(registry.findByAgent(verifier.id)).toBeUndefined()
})

it.each([true, false])('当前 attempt 的 processing 结算只允许真实可 seal epoch=%s，不提前成功或授予写权', async sealable => {
  const observation = { repositoryIdentity: 'repo', directoryIdentity: 'dir', gitIdentity: 'git', commonIdentity: 'common',
    gitDirectory: '/fixture/git', commonDirectory: '/fixture/common', head: 'a'.repeat(40) }
  const host = createFixtureWorktreeHost(observation)
  let known = false, sealed = false
  const boundary = { available: () => true, begin: vi.fn(() => { known = true }),
    seal: vi.fn(() => { if (!known || !sealable) return false; sealed = true; return true }), quiescent: vi.fn(() => known && sealed) }
  const runtime = await makeRuntime({ jev: 'disabled', worktreeHost: host, writerBoundary: boundary })
  const task = await createTask(runtime), registry = registries.current!
  const tree = join(runtime.home, '.agents', 'worktrees', 'settling')
  await mkdir(join(tree, 'src'), { recursive: true })
  await writeFile(join(tree, 'src', 'math.ts'), 'export const settlingArtifact = 42\n')
  const start = runtime.subagents.start.getMockImplementation()!
  let treeId = ''
  runtime.subagents.start.mockImplementation(async (name, request) => {
    const handle = await start(name, request)
    const producer = taskStores.current!.getTaskDelegations(task.task_id).at(-1)!
    treeId = registry.bind({ path: tree, repositoryRoot: runtime.home, branch: 'settling', baseCommit: 'a'.repeat(40),
      agentId: handle.id, taskId: task.task_id, delegationId: producer.delegationId, observation,
      execution: { attemptId: producer.attemptId!, nodeId: producer.nodeId ?? 'legacy', cardRevision: 1, workflowRevision: 1, requestRevision: 1, generation: 1, leaseEpoch: 1 } }).worktreeId
    registry.suspend(treeId)
    return handle
  })
  const work = runtime.service.delegate({ task_id: task.task_id, role: 'zhu_jian', prompt: 'settle own artifact', backend: 'api', session: 'oneshot' }, runtime.exec())
  if (sealable) {
    const result = await work
    expect(result.finalization).toBe('ready')
    const physical = await getArtifactSnapshot(tree, ['src/math.ts', ...(result.changedFiles ?? [])]), workspaceId = await getWorkspaceId(runtime.home)
    expect(result.artifactAfter).toBe(getValueDigest({ workspaceId, entries: physical.entries }))
  } else await expect(work).rejects.toThrow('当前产物结算缺少可信 Host 停净证明')
  expect(registry.findById(treeId)?.state).toBe('recovery-required')
  expect(boundary.seal).toHaveBeenCalled()
  expect(host.setCwd).not.toHaveBeenCalled()
})


// 在真实源码已捕获、语义判断 await 尚未结束时制造变化，不靠延时碰运气。
it.each(['content', 'directory', 'owner'] as const)('探索取证期间 %s 改变必须拒绝旧摘要结算，且不重放专家', async change => {
  const observation = { repositoryIdentity: 'repo', directoryIdentity: 'dir', gitIdentity: 'git', commonIdentity: 'common',
    gitDirectory: '/fixture/git', commonDirectory: '/fixture/common', head: 'a'.repeat(40) }
  const host = createFixtureWorktreeHost(observation)
  const runtime = await makeRuntime({ jev: 'known', worktreeHost: host })
  const logical = join(runtime.home, 'src', 'math.ts'), tree = join(runtime.home, '.agents', 'worktrees', 'assessment-race')
  await writeFile(logical, 'export const source = "ROOT"\n')
  const task = await runtime.service.AddTaskCard({ title: '取证复核', goal: '核对 TREE 的真实源码', acceptance: ['来源绑定真实产物'], scope: [logical], flags: {} }, runtime.exec())
  await mkdir(join(tree, 'src'), { recursive: true })
  await writeFile(join(tree, 'src', 'math.ts'), 'export const source = "TREE"\n')
  observation.directoryIdentity = String((await lstat(tree)).ino)
  const registry = registries.current!
  const bound = registry.bind({ path: tree, repositoryRoot: runtime.home, branch: 'assessment-race', baseCommit: 'a'.repeat(40),
    agentId: 'original-writer', taskId: task.task_id, delegationId: 'D-original-writer', observation: structuredClone(observation),
    execution: { attemptId: 'original-attempt', nodeId: 'write', cardRevision: 1, workflowRevision: 1, requestRevision: 1, generation: 1, leaseEpoch: 1 } })
  const start = runtime.subagents.start.getMockImplementation()!
  const structured = { ...structuredClone(tanOutput), findings: [{ path: logical, symbol: 'source', callChain: [], evidence: 'source is TREE' }] }
  runtime.subagents.start.mockImplementation(async (name, request) => {
    const handle = await start(name, request)
    return { ...handle, result: handle.result.then(result => ({ ...result, structured })) }
  })
  const fetch = runtime.fetch.getMockImplementation()!
  let mutated = false, observedSource: { locator: string; supportingText: string } | undefined
  runtime.fetch.mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown>; state: { source: { locator: string; supportingText: string } } }
    if (body.questions.support && body.questions.credibility && !mutated) {
      observedSource = body.state.source
      mutated = true
      if (change === 'content') await writeFile(join(tree, 'src', 'math.ts'), 'export const source = "CHANGED"\n')
      else if (change === 'directory') {
        await rename(tree, tree + '-original')
        await mkdir(join(tree, 'src'), { recursive: true })
        await writeFile(join(tree, 'src', 'math.ts'), 'export const source = "TREE"\n')
        observation.directoryIdentity = String((await lstat(tree)).ino)
      } else {
        const next = registry.prepareRestore(bound.worktreeId, bound, { agentId: 'new-owner', taskId: task.task_id, delegationId: 'D-new-owner',
          execution: { ...bound.execution!, attemptId: 'new-attempt' } }, observation)
        registry.publishRestore(bound, next)
        registry.activate(bound.worktreeId, getWorktreeOwnerKey(next), observation)
      }
    }
    return fetch(url, init)
  })
  await expect(runtime.service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: '捕获真实 TREE 后复核', backend: 'api', session: 'oneshot' }, runtime.exec()))
    .rejects.toThrow(/产物.*(?:改变|变化)|取证.*(?:改变|变化)/)
  expect(mutated).toBe(true)
  expect(observedSource?.locator).toBe(logical)
  expect(observedSource?.supportingText).toContain('TREE')
  expect(observedSource?.supportingText).not.toContain('ROOT')
  expect(runtime.subagents.start).toHaveBeenCalledTimes(1)
  const record = taskStores.current!.getTaskDelegations(task.task_id)[0]!
  expect(record.finalization).toBe('failed')
  expect(record.evidenceAssessment).toBeUndefined()
  expect(record.structured).toEqual(structured)
})
