import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import * as FeatureSessions from '../../src/feature-session.js'
import { NOTEBOOK_RUNTIME_KEY, type AgentLike, type ContentBlockLike, type GoalViewLike, type GoalsLike, type SubagentResultLike, type SubagentStartRequestLike } from '../../src/host-contract.js'
import type { ReviewSnapshot } from '../../src/planning-review.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

interface Message {
  id: string
  role: string
  source: { kind: string; callId?: string; outcome?: string }
  toolCallId?: string
  content: ContentBlockLike[]
  [key: string]: unknown
}

interface StartInfo {
  id: string
  role: DelegableRoleId
  gate: ReturnType<typeof deferred>
}

interface TaskViewInfo {
  scheduling: { active: number; pending: number }
}

const homes: string[] = []
const services: SwarmService[] = []
const releases: Array<() => void> = []
const operations: Promise<unknown>[] = []
const runtimeMarkerRestores: Array<() => void> = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(operations.splice(0))
  await Promise.allSettled(services.splice(0).map(service => service.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  for (const restore of runtimeMarkerRestores.splice(0)) restore()
  vi.restoreAllMocks()
})

const deferred = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

const getSubagentRole = (request: SubagentStartRequestLike): DelegableRoleId => {
  const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1]
  if (role === undefined) throw new Error('fixture request omitted a delegable role persona')
  return role as DelegableRoleId
}

const installNotebookRuntime = (shutdownSession: (agentId: string) => Promise<void>): void => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, NOTEBOOK_RUNTIME_KEY)
  Object.defineProperty(globalThis, NOTEBOOK_RUNTIME_KEY, {
    configurable: true,
    writable: true,
    value: Object.freeze({ version: 1, shutdownSession })
  })
  runtimeMarkerRestores.push(() => {
    if (previous === undefined) delete (globalThis as unknown as Record<symbol, unknown>)[NOTEBOOK_RUNTIME_KEY]
    else Object.defineProperty(globalThis, NOTEBOOK_RUNTIME_KEY, previous)
  })
}

const makeFixture = async (options: { durable?: boolean; maxActive?: number; failedStart?: boolean; failureDiagnostic?: string; disposeFailure?: boolean; role?: DelegableRoleId
  planningVerdict?: 'pass' | 'changes_requested' } = {}) => {
  vi.restoreAllMocks()
  const home = await mkdtemp(join(tmpdir(), 'swarm-service-runtime-wait-'))
  homes.push(home)
  await mkdir(join(home, 'src'), { recursive: true })
  await mkdir(join(home, 'docs'), { recursive: true })
  await writeFile(join(home, 'README.md'), 'service runtime wait fixture\n')

  const messages: Message[] = [{ id: 'initial-human-goal', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '先核对只读材料；等待真实答复后再继续。' }] }]
  const root: AgentLike = { id: 'runtime-wait-root', session: { header: { agentPreset: 'tian-shu', cwd: home }, deriveMessages: () => messages } }
  let goal: GoalViewLike = { id: 'runtime-wait-goal', revision: 1, phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 100 }
  const goals: GoalsLike = {
    get: () => ({ ...goal }),
    disarm: vi.fn(() => { goal = { ...goal, activation: 'disarmed' }; return { ...goal } }),
    resume: vi.fn((_agent, ref) => {
      if (goal.id !== ref.id || goal.revision !== ref.revision || goal.phase !== 'active' || goal.activation !== 'disarmed') throw new Error('fixture goal CAS refused')
      goal = { ...goal, revision: goal.revision + 1, activation: 'armed' }
      return { ...goal }
    })
  }

  let features!: FeatureSessions.FeatureSession
  const createFeatureSession = FeatureSessions.createFeatureSession
  vi.spyOn(FeatureSessions, 'createFeatureSession').mockImplementation(async input => {
    features = await createFeatureSession(input)
    return features
  })

  const starts: StartInfo[] = []
  const startWaiters = new Map<number, (start: StartInfo) => void>()
  const defaultRole = options.role ?? 'mou_ding'
  const start = vi.fn(async (_provider: string, request: SubagentStartRequestLike) => {
    const role = getSubagentRole(request)
    const gate = deferred()
    releases.push(gate.release)
    const index = starts.length
    const id = `runtime-wait-child-${index + 1}`
    const info: StartInfo = { id, role, gate }
    starts.push(info)
    const notifyStart = startWaiters.get(index)
    if (notifyStart !== undefined) {
      startWaiters.delete(index)
      notifyStart(info)
    }
    let structured: unknown = VALID_OUTPUTS[role]
    if (request.label?.startsWith('规划审核') === true) {
      const prompt = request.prompt[0]?.text ?? ''
      const matched = /快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(prompt)
      if (matched === null) throw new Error('planning fixture omitted its frozen review snapshot')
      const snapshot = JSON.parse(matched[1]!) as ReviewSnapshot
      const verdict = options.planningVerdict ?? 'pass'
      const dimension = { verdict, summary: '逐条对照原始需求与当前流程', evidenceRefs: ['R1', 'A1', 'read-only'] }
      structured = {
        snapshotDigest: snapshot.snapshotDigest,
        verdict,
        goalReview: dimension,
        designReview: dimension,
        mermaidReview: dimension,
        requirementCoverage: snapshot.requirements.map(requirement => ({ requirementId: requirement.id, covered: true, evidence: 'read-only 节点产生可核对结论' })),
        findings: [],
        assumptions: [],
        unresolved: []
      }
    }
    return {
      id,
      result: gate.promise.then(() => (options.failedStart === true
        ? { output: [], stopReason: 'error', ...(options.failureDiagnostic === undefined ? {} : { diagnostic: options.failureDiagnostic }) } as SubagentResultLike
        : { output: [], structured, stopReason: 'completed' } as SubagentResultLike)),
      dispose: async () => {
        if (options.disposeFailure === true) throw new Error('CLEANUP_DISPOSE_FAILURE')
      }
    }
  })
  const config = getSwarmConfig({
    persistence: { enabled: options.durable === true },
    scheduling: { maxActive: options.maxActive ?? 8 },
    workflow: { mode: 'advisory' },
    planningReview: { enabled: false },
    jev: { enabled: false },
    review: { enabled: false },
    agents: { session: 'oneshot', maxRetries: 0 }
  })
  const build = () => intSwarmService({
    getConfig: () => config,
    getAgent: id => id === root.id ? root : undefined,
    getLlm: () => ({ listProviders: () => [{ id: 'runtime-wait-fixture' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
    getGoals: () => goals,
    getSubagents: () => ({
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
      start
    }),
    getTools: () => ({
      register: () => () => undefined,
      guard: () => () => undefined,
      schemas: () => ['read', 'glob', 'grep', 'swarm_context_read', 'ask_user_question'].map(name => ({ name }))
    }),
    getAttachments: () => undefined,
    getCredentials: () => undefined,
    dshHome: home,
    probe: async () => ({ ok: true, vision: false }),
    gitStatus: async () => undefined,
    fetch: async () => { throw new Error('service runtime wait fixture forbids external network') }
  })

  let service = build()
  services.push(service)
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  const addTask = async (scope: string[], extra: Record<string, unknown> = {}) => service.AddTaskCard({
    title: `任务 ${scope.join(',') || 'root'}`,
    goal: '验证可靠等待结算与投递前授权复核',
    acceptance: ['只执行当前真实授权范围内的动作'],
    scope,
    flags: {},
    workflow: {
      schemaVersion: 1,
      mode: 'quick',
      nodes: [
        { id: 'read-only', label: '任务执行', operation: 'delegate', role: defaultRole, dependsOn: [], gates: [], outputContractVersion: '1' },
        { id: 'checkpoint', label: '检查点', operation: 'checkpoint', dependsOn: ['read-only'], gates: [], outputContractVersion: '1' },
        { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
      ]
    },
    ...extra
  }, exec())
  const submit = (taskId: string, role: DelegableRoleId = defaultRole, extra: Record<string, unknown> = {}) => {
    const pending = service.delegate({
      task_id: taskId,
      role,
      prompt: '只读取当前任务允许的材料并提交结构化结果',
      backend: 'api',
      session: 'oneshot',
      ...extra
    }, exec())
    operations.push(pending.catch(() => undefined))
    return pending
  }
  const restart = async () => {
    await service.dispose()
    service = build()
    services.push(service)
    await service.WaitAgentReady(root)
  }
  const scheduling = (taskId: string): TaskViewInfo['scheduling'] =>
    (service.getTaskViewForRpc(root.id, taskId) as TaskViewInfo).scheduling
    /** 在真实 start 调用点结算，避免 full-run CPU 竞争把固定轮询窗口误判为空启动。 */
    const nextStart = (index = 0): Promise<StartInfo> => {
      const existing = starts[index]
      if (existing !== undefined) return Promise.resolve(existing)
      return new Promise(resolve => startWaiters.set(index, resolve))
    }
  const taskRecord = (taskId: string) => {
    const task = features.store.read().tasks.find(value => value.taskId === taskId)
    if (task === undefined) throw new Error(`fixture task not found: ${taskId}`)
    return task
  }
  const prepareWaitingAuthorization = async (taskId: string, callId: string) => {
    const task = taskRecord(taskId)
    const prepared = await features.authorizations.prepare({
      binding: {
        rootSessionId: root.id,
        workspaceId: features.workspaceId,
        taskId,
        lineageId: features.progress.lineageFor(task, features.workspaceId),
        requestRevision: task.requestRevision ?? 1,
        cardRevision: task.cardRevision ?? 1,
        workflowRevision: task.workflowRevision ?? 1
      },
      operationDigest: 'b'.repeat(64),
      scopeDigest: 'c'.repeat(64),
      questions: [{ id: 'scope', question: '是否扩大当前任务范围？', options: [{ label: '保持当前范围' }, { label: '拒绝' }] }],
      requiresUserDecision: true
    })
    await features.authorizations.dispatchKnown(prepared.decision.id, { callId, questionDigest: prepared.decision.questionDigest })
    return prepared.decision
  }
  const questions = [{ id: 'next-scope', question: '后续只读核查范围如何选择？', options: [{ label: '仍只读README' }, { label: '拒绝后续动作' }] }]
  const ask = { name: 'ask_user_question', callId: 'runtime-wait-question', agent: root, arguments: { questions, timeout: 1 } }
  const decision = (taskId: string) => features.authorizations.forTask(taskId, root.id)[0]!
  const pendingAsk = async () => {
    messages.push({ id: 'assistant-question', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: ask.callId, name: ask.name, arguments: JSON.stringify(ask.arguments) }] })
    await service.BeforeManagedTool(ask)
    const result = { content: [{ type: 'text', text: JSON.stringify({ pending: true, callId: ask.callId }) }] }
    service.ObserveManagedToolResult(ask, result)
    const logged: Message = { id: 'pending-tool-result', role: 'tool', source: { kind: 'tool', callId: ask.callId }, toolCallId: ask.callId, content: result.content }
    messages.push(logged)
    service.ObserveManagedMessage(root.id, { type: 'tool/result', data: { message: logged } })
    expect(await service.BeforeManagedStep(root, { kind: 'enter', messages: [] })).toEqual({ kind: 'reject' })
  }
  const answer = async (taskId: string, label = '仍只读README') => {
    const reply: Message = {
      id: `actual-late-answer-${taskId}`,
      role: 'user',
      source: { kind: 'user-question-reply', callId: ask.callId, outcome: 'answered' },
      content: [{
        type: 'text',
        text: JSON.stringify({
          kind: 'answer_to_pending_question',
          tool: 'ask_user_question',
          callId: ask.callId,
          questions,
          answers: [{ id: 'next-scope', selected: [label] }]
        })
      }]
    }
    expect((await service.BeforeManagedStep(root, { kind: 'enter', messages: [reply] })).kind).toBe('enter')
    messages.push(reply)
    service.ObserveManagedMessage(root.id, { type: 'user/message', data: reply })
    await service.BeforeManagedRequest(root)
    return reply
  }

  return {
    root,
    config,
    service: () => service,
    addTask,
    submit,
    restart,
    scheduling,
    features: () => features,
    starts,
    nextStart,
    pendingAsk,
    prepareWaitingAuthorization,
    answer,
    decision,
    goal: () => goal,
    changeGoal: (patch: Partial<GoalViewLike>) => { goal = { ...goal, ...patch } }
  }
}

describe('真实服务等待句柄结算与投递前授权复核', () => {
  it('委派可靠完成后结算原 wait 句柄，重启不把旧 open 升级为 unknown', async () => {
    const f = await makeFixture({ durable: true })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    f.starts[0]!.gate.release()
    expect((await running).status).toBe('completed')
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([])
    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'active', waitHandles: {} })
  })

  it('干净模型失败且有Host终态确认时结算wait但保持failed，重启后可重新规划', async () => {
    const f = await makeFixture({ durable: true, failedStart: true })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    f.starts[0]!.gate.release()
    const failed = await running
    expect(failed.status).toBe('failed')
    expect(failed.finalization).toBe('ready')
    expect(failed.staleReason).toBeUndefined()
    expect(failed.error).not.toMatch(/recovery_required|CLEANUP_DISPOSE_FAILURE|清理未确认/i)
    expect(failed.unresolved.some(value => /未确认|recovery_required|CLEANUP/i.test(value))).toBe(false)
    const hostView = await f.service().getAgentViewForRpc(f.root.id, f.starts[0]!.id) as { oneShotSettled?: boolean }
    expect(hostView.oneShotSettled).toBe(true)
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([])

    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'active', waitHandles: {} })
    const replanned = await f.addTask(['docs'])
    expect(replanned.task_id).toBe('T-2')
  })

  it('干净failed但副作用核对未确认时保持unknown，不把可用性当成停净证明', async () => {
    const f = await makeFixture({ durable: true, failedStart: true, role: 'zhu_jian' })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    f.service().agentControl?.MarkSideEffectRisk(f.starts[0]!.id)
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    f.starts[0]!.gate.release()
    const failed = await running
    expect(failed.status).toBe('failed')
    const hostView = await f.service().getAgentViewForRpc(f.root.id, f.starts[0]!.id) as { needsSideEffectReview?: boolean }
    expect(hostView.needsSideEffectReview).toBe(true)
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'stalled' })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'unknown' })
    ])
  })

  it('复核角色的失败重启后仍保留 shell 副作用 unknown 围栏', async () => {
    const f = await makeFixture({ durable: true, failedStart: true, role: 'fu_he' })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    f.service().agentControl?.MarkSideEffectRisk(f.starts[0]!.id)
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    f.starts[0]!.gate.release()
    const failed = await running
    expect(failed.status).toBe('failed')
    const hostView = await f.service().getAgentViewForRpc(f.root.id, f.starts[0]!.id) as { needsSideEffectReview?: boolean }
    expect(hostView.needsSideEffectReview).toBe(true)
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'stalled' })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'unknown' })
    ])
  })

  it('Notebook shutdownSession 拒绝进入 cleanup failure，且不解除 wait 围栏', async () => {
    const shutdownSession = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('NOTEBOOK_SHUTDOWN_UNKNOWN'))
    installNotebookRuntime(shutdownSession)
    const f = await makeFixture({ durable: true })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    f.starts[0]!.gate.release()
    const failed = await running
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('NOTEBOOK_SHUTDOWN_UNKNOWN')
    expect(failed.error).toContain('委派清理未确认')
    expect(shutdownSession).toHaveBeenCalledTimes(2)
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'stalled' })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'unknown' })
    ])
  })

  it('failed带recovery_required时即使finalization等于ready也不结算wait', async () => {
    const f = await makeFixture({ durable: true, failedStart: true, failureDiagnostic: 'recovery_required' })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])

    f.starts[0]!.gate.release()
    const failed = await running
    expect(failed.status).toBe('failed')
    expect(failed.finalization).toBe('ready')
    expect(failed.error).toMatch(/recovery_required/i)
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])
  })

  it.each(['pass', 'changes_requested'] as const)('规划审核可靠完成(%s)后结算原 wait 句柄，重启不把旧 open 升级为 unknown', async planningVerdict => {
    const f = await makeFixture({ durable: true, planningVerdict })
    const task = await f.addTask(['README.md'])
    f.config.workflow.mode = 'enforced'
    f.config.planningReview.enabled = true
    f.config.planningReview.requireJev = false
    const started = f.nextStart()
    const review = f.service().ReviewPlan({ task_id: task.task_id }, { agent: f.root, signal: new AbortController().signal })
    const start = await Promise.race([
      started,
      review.then(
        () => { throw new Error('规划审核在子会话启动前结束') },
        error => { throw error }
      )
    ])
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open', id: expect.stringMatching(/^planning:/) })
    ])

    start.gate.release()
    const reviewed = await review as { status: string }
    if (planningVerdict === 'pass') expect(['pass', 'pass_with_degradation']).toContain(reviewed.status)
    else expect(reviewed.status).toBe('changes_requested')
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([])
    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'active', waitHandles: {} })
  })

  it('授权等待可靠完成后结算原 wait 句柄，重启不把旧 open 升级为 unknown', async () => {
    const f = await makeFixture({ durable: true })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.pendingAsk()

    const open = f.features().progress.forTask(task.task_id)?.waitHandles ?? {}
    expect(Object.values(open)).toEqual([expect.objectContaining({ kind: 'authorization', state: 'open' })])

    f.starts[0]!.gate.release()
    expect((await running).status).toBe('completed')
    const reply = await f.answer(task.task_id)
    expect(f.decision(task.task_id).phase).toBe('answered')
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([])

    f.service().ObserveManagedMessage(f.root.id, { type: 'user/message', data: reply })
    await f.service().BeforeManagedRequest(f.root)
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([])

    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'active', waitHandles: {} })
  })

  it('目标替换后的晚答复只结算授权句柄，不复活旧目标', async () => {
    const f = await makeFixture()
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.pendingAsk()
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'authorization', state: 'open' })
    ])

    f.changeGoal({ id: 'replacement-goal', revision: 1, activation: 'armed' })
    f.starts[0]!.gate.release()
    expect((await running).status).toBe('completed')
    await f.answer(task.task_id)
    expect(f.decision(task.task_id).phase).toBe('answered')
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([])
    expect(f.goal()).toMatchObject({ id: 'replacement-goal', activation: 'disarmed' })
  })

  it('排队委派在真实 publish 前重验同任务 authorization，等待期间零投递', async () => {
    const f = await makeFixture({ maxActive: 1 })
    const task = await f.addTask(['README.md'])
    const active = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    const queued = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.scheduling(task.task_id).pending).toBe(1))

    await f.prepareWaitingAuthorization(task.task_id, 'queued-auth-call')
    f.starts[0]!.gate.release()
    await active

    const queuedOutcome = queued.then(value => ({ status: 'fulfilled' as const, value }), error => ({ status: 'rejected' as const, error }))
    const observed = await Promise.race([
      queuedOutcome,
      vi.waitFor(() => expect(f.starts).toHaveLength(2)).then(() => ({ status: 'started' as const }))
    ])
    if (observed.status === 'started') {
      f.starts[1]!.gate.release()
      await queuedOutcome
    }
    expect(f.starts).toHaveLength(1)
    if (observed.status === 'rejected') expect(observed.error).toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('同任务授权等待不阻断无依赖只读任务，独立任务仍投递', async () => {
    const f = await makeFixture({ maxActive: 1 })
    const blocked = await f.addTask(['src'])
    const independentWorkflow = {
      schemaVersion: 1,
      mode: 'quick',
      nodes: [
        { id: 'read-only', label: '独立只读核查', operation: 'delegate', role: 'tan_wei', dependsOn: [], gates: [], outputContractVersion: '1' },
        { id: 'checkpoint', label: '检查点', operation: 'checkpoint', dependsOn: ['read-only'], gates: [], outputContractVersion: '1' },
        { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
      ]
    }
    const independent = await f.addTask(['docs'], { workflow: independentWorkflow })
    const active = f.submit(blocked.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    const queued = f.submit(independent.task_id, 'tan_wei')
    await vi.waitFor(() => expect(f.scheduling(independent.task_id).pending).toBe(1))

    await f.prepareWaitingAuthorization(blocked.task_id, 'independent-auth-call')
    f.starts[0]!.gate.release()
    await active
    await vi.waitFor(() => expect(f.starts).toHaveLength(2))
    expect(f.starts[1]!.role).toBe('tan_wei')
    f.starts[1]!.gate.release()
    expect((await queued).status).toBe('completed')
  })

  it('委派完成但清理/停净未确认时保持 wait 未结算，不释放 writer 证据', async () => {
    const f = await makeFixture({ disposeFailure: true })
    const task = await f.addTask(['README.md'])
    const running = f.submit(task.task_id)
    await vi.waitFor(() => expect(f.starts).toHaveLength(1))
    await f.service().BeforeManagedStep(f.root, { kind: 'enter', messages: [] })
    const before = f.features().progress.forTask(task.task_id)
    expect(Object.values(before?.waitHandles ?? {})).toEqual([expect.objectContaining({ kind: 'tool', state: 'open' })])

    f.starts[0]!.gate.release()
    const failed = await running
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('CLEANUP_DISPOSE_FAILURE')
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'open' })
    ])
    await f.restart()
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'stalled' })
    expect(Object.values(f.features().progress.forTask(task.task_id)?.waitHandles ?? {})).toEqual([
      expect.objectContaining({ kind: 'tool', state: 'unknown' })
    ])
  })

  it.each([
    { id: 'authorization:missing-decision', kind: 'authorization' as const },
    { id: `planning:${'d'.repeat(64)}`, kind: 'tool' as const },
    { id: 'delegation:D-unknown:attempt-unknown', kind: 'tool' as const }
  ])('真实 unknown wait 在没有可靠结算证据时保持 stalled，禁止自动重派：$id', async ({ id, kind }) => {
    const f = await makeFixture()
    const task = await f.addTask(['README.md'])
    const stored = f.features().store.read().tasks.find(value => value.taskId === task.task_id)!
    const lineage = await f.features().progress.bindTask(stored, f.features().workspaceId)
    await f.features().progress.observe({
      lineageId: lineage,
      taskId: task.task_id,
      action: 'root-round',
      projection: { uncertainty: 'real-host-wait' },
      waiting: true,
      waitHandle: { id, kind, state: 'unknown', openedAt: 1 }
    })

    await expect(f.submit(task.task_id)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(f.starts).toHaveLength(0)
    expect(f.features().progress.forTask(task.task_id)).toMatchObject({ status: 'stalled' })
  })
})
