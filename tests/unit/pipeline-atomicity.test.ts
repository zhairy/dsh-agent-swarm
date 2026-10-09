import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike, SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { VALID_OUTPUTS } from '../../tests/fixtures/valid-outputs.js'
import { createDurableStateStore } from '../../src/state-store.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { digest } from '../../src/task-model.js'
import type { EvidenceConsumptionNotice } from '../../src/evidence-assessment.js'
import type { ExpertMessage } from '../../src/message-bus.js'
import { getValueDigest } from '../../src/workflow.js'
import type { AgentControlRecord } from '../../src/agent-control.js'

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

const tanOutput = { summary: 'stableSum 使用 reduce 求和', unresolved: [], findings: [{ path: 'src/math.ts', symbol: 'stableSum', callChain: ['stableSum'], evidence: '实现调用 values.reduce，初始和为 0' }] }
const score = { type: 'score', score: 3, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } }
const makeRuntime = async (options: { home?: string; jev?: 'known' | 'disabled' | 'network'; pendingRoles?: DelegableRoleId[] } = {}) => {
  const home = options.home ?? await mkdtemp(join(tmpdir(), 'swarm-evidence-service-'))
  if (options.home === undefined) {
    directories.push(home)
    await git('git', ['init', '--quiet'], { cwd: home })
    await mkdir(join(home, 'src'))
    await writeFile(join(home, 'src', 'math.ts'), 'export function stableSum(values: number[]) { return values.reduce((sum, value) => sum + value, 0) }\n')
    await writeFile(join(home, 'package.json'), '{"name":"evidence-service-fixture","version":"2.3.0"}')
  }
  const root: AgentLike = { id: 'evidence-service-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
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
      const agent: AgentLike = { id, session: { header: { parentSession: root.id, cwd: home } } }
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
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'glob', 'grep', 'swarm_context_read', 'swarm_message_send', 'swarm_message_read', 'swarm_message_ack'].map((name) => ({ name })) }),
    getCredentials: () => ({ resolve: async () => ({ value: 'fixture-only-no-live-credential' }) }), getAttachments: () => undefined,
    dshHome: home, fetch, gitStatus: async () => undefined, sleep: async () => undefined,
    probe: async () => ({ ok: true, vision: true }), now: () => ++fixtureTime })
  services.push(service)
  return { service, root, exec, home, fetch, subagents, runs }
}
type Runtime = Awaited<ReturnType<typeof makeRuntime>>
const createTask = (runtime: Runtime) => runtime.service.AddTaskCard({ title: '探索求和实现', goal: '检查 stableSum 当前实现及证据', acceptance: ['判断必须绑定真实源码'], scope: ['src/math.ts'], flags: {} }, runtime.exec())

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
  expect((await work).finalization).toBe('ready')
  const final = await runtime.service.AcceptTask(acceptArgs, runtime.exec())
  expect(final.status).toBe('accepted')
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
