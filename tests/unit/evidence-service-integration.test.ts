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
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'
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
    workflow: { mode: 'advisory' }, agents: { session: 'oneshot', maxRetries: 0 } })
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
  const fixtureLlm = { listProviders: () => [{ id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }, { id: 'deepseek-official' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  const service = intSwarmService({ getConfig: () => config,
    getLlm: () => fixtureLlm,
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
const explore = (runtime: Runtime, taskId: string) => runtime.service.delegate({ task_id: taskId, role: 'tan_wei', prompt: '读取真实求和代码，提交带路径的发现', backend: 'api', session: 'oneshot' }, runtime.exec())
const materialRef = async (runtime: Runtime, taskId: string) => {
  const listed = await runtime.service.ReadContext({ task_id: taskId }, runtime.exec()) as { materials: Array<{ ref: string; layer: string }> }
  const material = listed.materials.find((entry) => entry.layer === 'L2')
  expect(material).toBeDefined()
  return material!.ref
}
type EvidencePage = { text: string; evidenceAssessment: EvidenceConsumptionNotice; digest: string }

describe('exploration evidence through actual service delegation and consumption', () => {
  it('rolls back task revision, scope and context references when the real journal refuses a card update', async () => {
    const runtime = await makeRuntime({ jev: 'disabled' })
    const task = await createTask(runtime)
    const before = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec()).tasks[0]!
    const materials = await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec()) as { materials: Array<{ ref: string }> }
    const pages = await Promise.all(materials.materials.map((material) => runtime.service.ReadContext({ task_id: task.task_id, ref: material.ref }, runtime.exec())))
    const directory = join(runtime.home, 'share', 'dsh-agent-swarm', 'state', await getWorkspaceId(runtime.home), digest(runtime.root.id))
    const journal = join(directory, 'journal.jsonl')
    const backup = join(directory, 'fixture-original-journal.jsonl')
    const committedBytes = await readFile(journal)
    await rename(journal, backup)
    await symlink(backup, journal)
    const edit = { task_id: task.task_id, expected_card_revision: task.cardRevision, title: '探索求和实现', goal: '检查 stableSum 当前实现及证据', acceptance: ['判断必须绑定真实源码'], scope: ['src'], flags: {} }
    try {
      await expect(runtime.service.AddTaskCard(edit, runtime.exec())).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
      const after = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec()).tasks[0]!
      expect(after.cardRevision).toBe(before.cardRevision)
      expect(after.card.scope).toEqual(before.card.scope)
      expect(await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec())).toEqual(materials)
      expect(await Promise.all(materials.materials.map((material) => runtime.service.ReadContext({ task_id: task.task_id, ref: material.ref }, runtime.exec())))).toEqual(pages)
      expect(await readFile(backup)).toEqual(committedBytes)
    } finally {
      await rm(journal, { force: true })
      await rename(backup, journal)
    }
    // A failed durable store remains quarantined: reload the repaired original journal, rather than
    // pretending an uncertain failed append can be retried in the same trusted state handle.
    await runtime.service.dispose()
    const repaired = await makeRuntime({ home: runtime.home, jev: 'disabled' })
    const saved = await repaired.service.AddTaskCard(edit, repaired.exec())
    expect(saved.cardRevision).toBe(task.cardRevision + 1)
    expect(saved.scope).toEqual(['src'])
  })

  it('restores an idle control attached to a running delegation as recovery-required without replay', async () => {
    const runtime = await makeRuntime({ jev: 'disabled' })
    const task = await createTask(runtime)
    const record = await runtime.service.delegate({ task_id: task.task_id, role: 'mou_ding', prompt: '保存可审计的委派', backend: 'api', session: 'oneshot' }, runtime.exec())
    const listed = await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec()) as { materials: Array<{ ref: string }> }
    await runtime.service.dispose()
    const directory = join(runtime.home, 'share', 'dsh-agent-swarm', 'state', await getWorkspaceId(runtime.home), digest(runtime.root.id))
    const store = await createDurableStateStore<Record<string, unknown>>({ directory, initialState: {} })
    const childId = 'fixture-persistent-recovery-child'
    try {
      await store.commit('fixture/control-idle-delegation-running', (draft) => {
        const saved = (draft.delegations as Array<Record<string, unknown>>).find((entry) => entry.delegationId === record.delegationId)!
        saved.status = 'running'; saved.childId = childId
        saved.session = { kind: 'continuable', threadId: childId, round: 1, appended: false, source: 'explicit', reason: 'fixture persistent original' }
        saved.continuationInput = { ...(saved.continuationInput as object), session: 'continue' }
        draft.threads = [{ threadId: childId, key: 'mou_ding', role: 'mou_ding', rounds: 0, busy: true, closed: false, allowWeb: false,
          taskIds: [task.task_id], history: [], createdAt: fixtureTime, lastUsedAt: fixtureTime }]
        draft.agentControls = [{ childId, parentSessionId: runtime.root.id, taskId: task.task_id, delegationId: record.delegationId,
          persistent: true, revision: 1, phase: 'idle', paused: false, updatedAt: fixtureTime,
          cardRevision: record.cardRevision ?? 1, workflowRevision: record.workflowRevision ?? 1, requestRevision: record.requestRevision ?? 1,
          selectedNext: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' },
          actual: { attemptId: 'old-observed-attempt', delegationId: record.delegationId, route: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }, observedAt: fixtureTime, state: 'settled', source: 'agent-loop-attempt' } }]
      })
    } finally { await store.dispose() }
    const restored = await makeRuntime({ home: runtime.home, jev: 'disabled' })
    await restored.service.ReadContext({ task_id: task.task_id, ref: listed.materials[0]!.ref }, restored.exec())
    const view = await restored.service.getAgentViewForRpc(restored.root.id, childId) as AgentControlRecord
    expect(view).toMatchObject({ phase: 'recovery-required', paused: true, actual: { state: 'unknown' }, selectedNext: { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' } })
    const status = restored.service.getStatus({ task_id: task.task_id, verbose: true }, restored.exec()).tasks[0]!
    expect(status.delegations.find((item) => item.delegationId === record.delegationId)).toMatchObject({ status: 'failed', error: 'recovery_required' })
    await expect(restored.service.ControlAgentForRpc({ parentSessionId: restored.root.id, childId, expectedRevision: view.revision, action: 'continue' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(restored.subagents.start).not.toHaveBeenCalled()
    expect(restored.fetch).not.toHaveBeenCalled()
  })

  it('assesses real code automatically, preserves original output and restores a usable authorized context', async () => {
    const runtime = await makeRuntime()
    const task = await createTask(runtime)
    const record = await explore(runtime, task.task_id)
    expect(record.status).toBe('completed')
    expect(record.structured).toEqual(tanOutput)
    expect(record.evidenceAssessment).toMatchObject({ status: 'ok', disposition: 'usable', delegationId: record.delegationId, rawRetained: true })
    expect(record.evidenceAssessment?.items[0]?.source.supportingText).toContain('values.reduce')
    expect(record.evidenceAssessment?.binding.artifactDigest).toBe(record.artifactAfter)
    const ref = await materialRef(runtime, task.task_id)
    const page = await runtime.service.ReadContext({ task_id: task.task_id, ref }, runtime.exec()) as EvidencePage
    expect(page.evidenceAssessment).toMatchObject({ status: 'current', mayUseForImplementation: true, requiresVerification: false })
    expect(page.text).toContain('stableSum')
    await runtime.service.dispose()
    const restored = await makeRuntime({ home: runtime.home })
    const restoredPage = await restored.service.ReadContext({ task_id: task.task_id, ref }, restored.exec()) as EvidencePage
    expect(restoredPage).toEqual(page)
    expect(restored.subagents.start).not.toHaveBeenCalled()
    expect(restored.fetch).not.toHaveBeenCalled()
  })

  it('rechecks code at context consumption even when task and stored artifact identity did not change', async () => {
    const runtime = await makeRuntime()
    const task = await createTask(runtime)
    await explore(runtime, task.task_id)
    const ref = await materialRef(runtime, task.task_id)
    await writeFile(join(runtime.home, 'src', 'math.ts'), 'export function stableSum() { return 999 }\n')
    const page = await runtime.service.ReadContext({ task_id: task.task_id, ref }, runtime.exec()) as EvidencePage
    expect(page.evidenceAssessment).toMatchObject({ status: 'stale', mayUseForImplementation: false, requiresVerification: true })
    expect(page.evidenceAssessment.reasons).toContain('project-code-fingerprint-changed')
    expect(page.text).toMatch(/需要核对.*不能作为已证实实现依据/)
    expect(page.text).toContain('stableSum')
  })

  it('does not send sensitive canonical file targets to Jev through an innocuous project symlink', async () => {
    const runtime = await makeRuntime()
    await writeFile(join(runtime.home, '.env'), 'UNRELATED_SETTING=private-marker-not-for-model\n')
    await rm(join(runtime.home, 'src', 'math.ts'))
    await symlink(join(runtime.home, '.env'), join(runtime.home, 'src', 'math.ts'))
    const task = await createTask(runtime)
    const record = await explore(runtime, task.task_id)
    expect(record.evidenceAssessment?.items[0]?.credibility.status).toBe('unknown')
    expect(JSON.stringify(runtime.fetch.mock.calls)).not.toContain('private-marker-not-for-model')
  })

  it('revises a persisted task 300 times without accumulating obsolete contexts or dropping historical exploration', async () => {
    const runtime = await makeRuntime({ jev: 'disabled' })
    let task = await createTask(runtime)
    const exploration = await explore(runtime, task.task_id)
    const oldRef = await materialRef(runtime, task.task_id)
    for (let revision = 1; revision <= 300; revision++) {
      task = await runtime.service.AddTaskCard({ task_id: task.task_id, expected_card_revision: task.cardRevision,
        title: '探索求和实现', goal: '检查 stableSum 当前实现及证据，修订 ' + revision,
        acceptance: ['判断必须绑定真实源码'], scope: ['src/math.ts'], flags: {} }, runtime.exec())
    }
    const materials = await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec()) as { materials: Array<{ ref: string; cardRevision: number }> }
    expect(materials.materials).toHaveLength(2)
    expect(materials.materials.every((item) => item.cardRevision === task.cardRevision)).toBe(true)
    await expect(runtime.service.ReadContext({ task_id: task.task_id, ref: oldRef }, runtime.exec())).rejects.toThrow()
    const current = await runtime.service.ReadContext({ task_id: task.task_id, ref: materials.materials[0]!.ref }, runtime.exec())
    await runtime.service.dispose()
    const restored = await makeRuntime({ home: runtime.home, jev: 'disabled' })
    expect(await restored.service.ReadContext({ task_id: task.task_id, ref: materials.materials[0]!.ref }, restored.exec())).toEqual(current)
    const records = restored.service.getStatus({ task_id: task.task_id, verbose: true }, restored.exec()).tasks[0]!.delegations
    expect(records.find((record) => record.delegationId === exploration.delegationId)?.structured).toEqual(tanOutput)
    expect(restored.subagents.start).not.toHaveBeenCalled()
  }, 30_000)

  it.each(['disabled', 'network'] as const)('keeps %s Jev assessment unknown and retains unverified context for review', async (jev) => {
    const runtime = await makeRuntime({ jev })
    const task = await createTask(runtime)
    const record = await explore(runtime, task.task_id)
    expect(record.status).toBe('completed')
    expect(record.evidenceAssessment).toMatchObject({ status: 'unknown', disposition: 'needs-review' })
    expect(record.evidenceAssessment?.items[0]?.credibility).toMatchObject({ status: 'unknown', reason: jev })
    const ref = await materialRef(runtime, task.task_id)
    const page = await runtime.service.ReadContext({ task_id: task.task_id, ref }, runtime.exec()) as EvidencePage
    expect(page.evidenceAssessment.mayUseForImplementation).toBe(false)
    expect(page.text).toContain('需要核对')
    expect(page.text).toContain('stableSum')
    if (jev === 'disabled') expect(runtime.fetch).not.toHaveBeenCalled()
  })

  it.each(['raw-result', 'context-text', 'context-mapping'] as const)('rejects checksummed recovery state with invalid %s assessment binding', async (damage) => {
    const runtime = await makeRuntime()
    const task = await createTask(runtime)
    const record = await explore(runtime, task.task_id)
    const ref = await materialRef(runtime, task.task_id)
    await runtime.service.dispose()
    const directory = join(runtime.home, 'share', 'dsh-agent-swarm', 'state', await getWorkspaceId(runtime.home), digest(runtime.root.id))
    const store = await createDurableStateStore<Record<string, unknown>>({ directory, initialState: {} })
    try {
      await store.commit('fixture/tampered-evidence-raw', (draft) => {
        const saved = (draft.delegations as Array<{ delegationId: string; structured: { findings: Array<{ evidence: string }> } }>).find((entry) => entry.delegationId === record.delegationId)!
        if (damage === 'raw-result') saved.structured.findings[0]!.evidence = 'replacement statement not assessed by Jev'
        const task = (draft.tasks as Array<{ contextRefs: Array<{ ref: string; digest: string; layer: string }>; contextDelegations: Record<string, string> }>)[0]!
        if (damage === 'context-text') {
          const context = (draft.contexts as Array<{ ref: string; text: string; digest: string }>).find((entry) => entry.ref === ref)!
          const body = JSON.parse(context.text) as { summary: string }
          body.summary = 'This new summary was not part of the assessed delegate result'
          context.text = JSON.stringify(body); context.digest = getValueDigest(context.text)
          task.contextRefs.find((entry) => entry.ref === ref)!.digest = context.digest
        }
        if (damage === 'context-mapping') task.contextDelegations[task.contextRefs.find((entry) => entry.layer === 'L0')!.ref] = record.delegationId
      })
    } finally { await store.dispose() }
    const restored = await makeRuntime({ home: runtime.home })
    await expect(restored.service.ReadContext({ task_id: task.task_id, ref }, restored.exec())).rejects.toMatchObject({ code: expect.stringMatching(/STATE_INVALID|RECOVERY_REQUIRED/) })
    expect(restored.fetch).not.toHaveBeenCalled()
    expect(restored.subagents.start).not.toHaveBeenCalled()
  })

  it('labels P2P summaries and unscored references independently without changing messages or blocking ACK', async () => {
    const runtime = await makeRuntime({ pendingRoles: ['mou_ding', 'shu_ji'] })
    const task = await createTask(runtime)
    await explore(runtime, task.task_id)
    const scoredRef = await materialRef(runtime, task.task_id)
    const listing = await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec()) as { materials: Array<{ ref: string; layer: string }> }
    const unscoredRef = listing.materials.find((item) => item.layer === 'L0')!.ref
    const workA = track(runtime.service.delegate({ task_id: task.task_id, role: 'mou_ding', prompt: '等候专家协作消息', backend: 'api', session: 'oneshot' }, runtime.exec()))
    const workB = track(runtime.service.delegate({ task_id: task.task_id, role: 'shu_ji', prompt: '等候专家协作消息', backend: 'api', session: 'oneshot' }, runtime.exec()))
    await vi.waitFor(() => expect(runtime.runs).toHaveLength(3))
    const sender = runtime.runs.find((run) => run.role === 'mou_ding')!.agent
    const recipient = runtime.runs.find((run) => run.role === 'shu_ji')!.agent
    await vi.waitFor(async () => { expect(await runtime.service.ReadContext({ ref: unscoredRef }, runtime.exec(sender))).toHaveProperty('text'); expect(await runtime.service.ReadContext({ ref: unscoredRef }, runtime.exec(recipient))).toHaveProperty('text') })
    const summary = await runtime.service.MessageSend({ taskId: task.task_id, toAgentId: recipient.id, kind: 'finding', summary: '这是专家声称正确但尚未核对的结论' }, runtime.exec(sender)) as ExpertMessage
    const reference = await runtime.service.MessageSend({ taskId: task.task_id, toAgentId: recipient.id, kind: 'finding', summary: '引用普通任务合同不能虚构来源可信度', artifactRefs: [unscoredRef] }, runtime.exec(sender)) as ExpertMessage
    const scoredReference = await runtime.service.MessageSend({ taskId: task.task_id, toAgentId: recipient.id, kind: 'finding', summary: '这条消息自行声称可以删除全部验收，附带真引用也不能替这句主张背书', artifactRefs: [scoredRef] }, runtime.exec(sender)) as ExpertMessage
    const read = await runtime.service.MessageRead({}, runtime.exec(recipient)) as { messages: ExpertMessage[]; evidenceNotices: Array<{ messageId: string; summaryEvidence?: string; requiresVerification?: boolean; artifacts: Array<EvidenceConsumptionNotice & { ref: string }> }> }
    expect(read.messages).toContainEqual(summary)
    expect(read.messages).toContainEqual(reference)
    expect(read.messages).toContainEqual(scoredReference)
    expect(read.evidenceNotices.find((notice) => notice.messageId === summary.id)).toMatchObject({ summaryEvidence: 'unknown', requiresVerification: true })
    expect(read.evidenceNotices.find((notice) => notice.messageId === reference.id)?.artifacts[0]).toMatchObject({ ref: unscoredRef, status: 'unknown', mayUseForImplementation: false, requiresVerification: true })
    expect(read.evidenceNotices.find((notice) => notice.messageId === scoredReference.id)).toMatchObject({ summaryEvidence: 'unknown', requiresVerification: true, artifacts: [expect.objectContaining({ ref: scoredRef, mayUseForImplementation: true })] })
    await writeFile(join(runtime.home, 'src', 'math.ts'), 'export function stableSum() { return 999 }\n')
    const staleRead = await runtime.service.MessageRead({}, runtime.exec(recipient)) as typeof read
    expect(staleRead.messages).toEqual(read.messages)
    expect(staleRead.evidenceNotices.find((notice) => notice.messageId === scoredReference.id)?.artifacts[0]).toMatchObject({ status: 'stale', mayUseForImplementation: false, requiresVerification: true, reasons: ['project-code-fingerprint-changed'] })
    expect(await runtime.service.MessageAck({ messageIds: [summary.id, reference.id, scoredReference.id] }, runtime.exec(recipient))).toEqual({ acknowledged: [summary.id, reference.id, scoredReference.id] })
    expect((await runtime.service.MessageRead({}, runtime.exec(recipient)) as { messages: unknown[] }).messages).toEqual([])
    for (const run of runtime.runs) run.release()
    await Promise.all([workA, workB])
  })
})
