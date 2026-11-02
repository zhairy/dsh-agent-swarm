import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService } from '../../src/service.js'
import {
  getPlanningReviewQuestions, getPlanningReviewState, getReviewSnapshot, isPlanningReviewCurrent, isPlanningReviewReusable,
  type PlanningReviewRecord, type PlanningReviewResult, type ReviewSnapshot
} from '../../src/planning-review.js'
import { getRuleGates, ValidateTaskCard } from '../../src/policy.js'
import { getDefaultWorkflow } from '../../src/workflow.js'
import { getTaskBrief } from '../../src/delegate.js'
import { getAcceptanceState, getReviewState } from '../../src/review.js'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import type { AgentLike, SubagentResultLike, SubagentRunLike, SubagentStartRequestLike } from '../../src/host-contract.js'

// Parser syntax/projection behavior has its own tests. These tests isolate the
// review lifecycle so a parser worker cannot consume the short review deadline.
vi.mock('../../src/workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workflow.js')>()
  return { ...actual, ParseWorkflowMermaid: async (_workflow: unknown, source: string) => ({
    parserVersion: actual.MERMAID_PARSER_VERSION, generatorVersion: actual.WORKFLOW_GENERATOR_VERSION,
    sourceDigest: actual.getValueDigest(source), parseVerdict: 'pass', projectionVerdict: 'pass', errors: []
  }) }
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const within = async <T>(promise: Promise<T>, ms = 2_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('审核活性回归：操作未在测试截止时间内结束')), ms)
    })])
  } finally { clearTimeout(timer) }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

type HangPoint = 'none' | 'start' | 'result' | 'dispose'
const makeRuntime = (initial: { hang?: HangPoint; lowScores?: boolean; timeoutMs?: number } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'planning-liveness-'))
  const goal = '核对输入并交付有依据的分析结论'
  const root: AgentLike = { id: 'planning-liveness-root', session: {
    header: { agentPreset: 'tian-shu', cwd: home },
    deriveMessages: () => [{ id: 'human-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: goal }] }]
  } }
  const config = getSwarmConfig({ workflow: { mode: 'enforced' }, agents: { session: 'oneshot' },
    planningReview: { requireJev: true, timeoutMs: initial.timeoutMs ?? 100 },
    routes: { yu_shi: { chain: [{ provider: 'fixture', model: 'reviewer' }] } } })
  const behavior = { hang: initial.hang ?? 'none', lowScores: initial.lowScores ?? false }
  const requests: SubagentStartRequestLike[] = []
  const snapshots: ReviewSnapshot[] = []
  const started = deferred<void>()
  const lateStart = deferred<SubagentRunLike>()
  const lateResult = deferred<SubagentResultLike>()
  const lateDispose = deferred<void>()
  let firstHandle: SubagentRunLike | undefined
  let firstResult: SubagentResultLike | undefined
  const dispose = vi.fn(async () => {
    if (behavior.hang === 'dispose') await lateDispose.promise
  })
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ model: 'jev-fixture',
    answers: Object.fromEntries(Object.keys(getPlanningReviewQuestions()).map((id) => [id, {
      noul: behavior.lowScores && id === 'requirement_coverage' ? 0.35
        : behavior.lowScores && id === 'execution_boundaries' ? 0.79 : 0.95
    }])), usage: { input_tokens: 20, output_tokens: 3 }
  }), { status: 200 }))
  const start = vi.fn(async (_provider: string, request: SubagentStartRequestLike): Promise<SubagentRunLike> => {
    requests.push(request)
    const match = /快照（完整当前合同与源码）：\n([\s\S]+?)\n交付 JSON schema：/.exec(request.prompt[0]?.text ?? '')
    if (!match) throw new Error('缺少冻结审核快照')
    const snapshot = JSON.parse(match[1]!) as ReviewSnapshot
    snapshots.push(snapshot)
    const dimension = { verdict: 'pass' as const, summary: '原始需求对应本次分析产出与验收', evidenceRefs: ['R1', 'A1', 'analysis'] }
    const structured: PlanningReviewResult = {
      snapshotDigest: snapshot.snapshotDigest, verdict: 'pass', goalReview: dimension,
      designReview: dimension, mermaidReview: dimension,
      requirementCoverage: snapshot.requirements.map((requirement) => ({ requirementId: requirement.id, covered: true, evidence: 'analysis 产出有依据结论，由 A1 核对' })),
      findings: [], assumptions: [], unresolved: []
    }
    const result: SubagentResultLike = { output: [], structured, stopReason: 'completed' }
    const handle: SubagentRunLike = { id: `review-child-${requests.length}`,
      result: behavior.hang === 'result' ? lateResult.promise : Promise.resolve(result), dispose }
    if (requests.length === 1) { firstHandle = handle; firstResult = result; started.resolve() }
    return behavior.hang === 'start' ? lateStart.promise : handle
  })
  const service = intSwarmService({
    getConfig: () => config, getLlm: () => undefined,
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: {
      agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true
    } }), start }),
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined,
      schemas: () => ['read', 'write', 'edit', 'bash', 'glob', 'grep'].map((name) => ({ name })) }),
    getAttachments: () => undefined, getCredentials: () => ({ resolve: async () => ({ value: 'fixture-key' }) }),
    dshHome: home, fetch: fetchMock as typeof fetch, now: () => Date.now(),
    probe: async () => ({ ok: true, vision: true }), gitStatus: async () => undefined
  })
  const releaseLateWork = () => {
    behavior.hang = 'none'
    if (firstHandle) lateStart.resolve(firstHandle)
    if (firstResult) lateResult.resolve(firstResult)
    lateDispose.resolve()
  }
  cleanups.push(async () => {
    releaseLateWork()
    try { await within(service.dispose()) } finally { rmSync(home, { recursive: true, force: true }) }
  })
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  const card = () => ({ title: '规划活性测试', goal, acceptance: ['产出有依据且回应输入的分析'], scope: [], flags: {} })
  const getReview = (): PlanningReviewRecord | null => service.getStatus({ task_id: 'T-1' }, exec()).tasks[0]!.planningReview
  return { service, config, behavior, start, requests, snapshots, started, dispose, fetchMock, releaseLateWork, exec, card, getReview }
}

describe('规划审核活性与否定判断稳定性', () => {
  it('传输去重可还原相同原文，保留不同来源文本和已批准摘要', () => {
    const requestText = '仅实施隔离模拟，禁止实盘。'.repeat(500)
    const card = ValidateTaskCard({ title: '原文去重', goal: '检查模拟边界', acceptance: ['逐条说明边界'], flags: {} }).card!
    const gates = getRuleGates(card)
    const workflow = getDefaultWorkflow(card, gates)
    const snapshot = getReviewSnapshot({ rootSessionId: 'root', workspaceId: 'workspace', taskId: 'T-1',
      requestRevision: 1, cardRevision: 1, workflowRevision: 1, requestText,
      requestRefs: [{ source: 'human-1', text: requestText }, { source: 'human-2', text: '另需人工验收' }],
      card: { ...card, workflow }, workflow, gates })
    const wire = getPlanningReviewState(snapshot)
    expect(wire.requestText).toBe(requestText)
    const recoverText = (item: { text?: string; textRef?: string }): string | undefined => item.textRef === 'requestText' ? wire.requestText : item.text
    expect(wire.requestRefs?.map(recoverText)).toEqual(snapshot.requestRefs?.map((ref) => ref.text))
    expect(wire.requirements.map(recoverText)).toEqual(snapshot.requirements.map((requirement) => requirement.text))
    expect(wire.card.workflow).toEqual({ ref: 'workflow' })
    expect(wire.workflow).toEqual(snapshot.workflow)
    expect(wire.snapshotDigest).toBe(snapshot.snapshotDigest)
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(snapshot).length - requestText.length)
  })

  it('阶段映射保留总需求和延期事项，阶段变更使旧审核快照失效', () => {
    const requestText = '修复规划并实现模拟训练闭环，禁止实盘'
    const card = ValidateTaskCard({ title: '维护阶段', goal: '先修复规划', acceptance: ['验证规划输入与版本绑定'], flags: {},
      planningScope: { kind: 'phase', deliverables: ['修复规划输入与版本绑定'], deferred: ['模拟训练闭环'], rationale: '规划门禁恢复后继续业务实施' }
    }).card!
    const gates = getRuleGates(card)
    const input = { rootSessionId: 'root', workspaceId: 'workspace', taskId: 'T-1', requestRevision: 1, cardRevision: 1,
      workflowRevision: 1, requestText, card, workflow: getDefaultWorkflow(card, gates), gates }
    const snapshot = getReviewSnapshot(input)
    expect(snapshot.requestText).toBe(requestText)
    expect(snapshot.requirements.filter((requirement) => requirement.required).map((requirement) => requirement.text)).toEqual(card.planningScope!.deliverables)
    expect(snapshot.requirements.filter((requirement) => !requirement.required).map((requirement) => requirement.text)).toEqual(card.planningScope!.deferred)
    expect(getReviewSnapshot({ ...input, card: { ...card, planningScope: { ...card.planningScope!, deferred: ['模拟训练与回测闭环'] } } }).snapshotDigest).not.toBe(snapshot.snapshotDigest)
  })

  it('阶段边界传入专家摘要、交付复评与验收复评，不把延期说成已完成', () => {
    const card = ValidateTaskCard({ title: '维护阶段', goal: '修复规划', acceptance: ['版本绑定验证通过'], flags: {},
      planningScope: { kind: 'phase', deliverables: ['规划修复'], deferred: ['模拟训练闭环'], rationale: '先恢复规划再实施业务' }
    }).card!
    const task: TaskRecord = { taskId: 'T-1', sessionId: 'root', card, gates: [], triage: { source: 'rules', rulesApplied: [] },
      delegationIds: [], rounds: 0, createdAt: 0, updatedAt: 0 }
    const record: DelegationRecord = { delegationId: 'D-1', taskId: task.taskId, role: 'mou_ding', roleName: '谋定',
      status: 'completed', summary: '规划修复完成，业务仍待实施', evidence: [], attempts: [], hardIsolation: true,
      independence: 'n/a', unresolved: [], startedAt: 0 }
    const brief = getTaskBrief(task, { task_id: task.taskId, role: 'mou_ding', prompt: '仅核对维护阶段' }, record.delegationId)
    expect(brief).toContain('阶段合同')
    expect(brief).toContain('模拟训练闭环')
    expect(brief).toContain('延期不是已完成')
    const expected = { completion_scope: 'phase', whole_goal_completed: false,
      planning_scope: { deliverables: ['规划修复'], deferred: ['模拟训练闭环'], rationale: '先恢复规划再实施业务' } }
    expect(getReviewState(task, record)).toMatchObject(expected)
    expect(getAcceptanceState(task, [record], { summary: '仅维护阶段完成', unresolved: [], gates: [] })).toMatchObject(expected)
  })

  it('曾可读的宿主需求历史读取异常时拒绝旧批准，恢复后可以重新审核', async () => {
    const runtime = makeRuntime()
    const task = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    expect(task.planningReview?.status).toBe('pass')
    const session = runtime.exec().agent.session!
    const deriveMessages = session.deriveMessages
    session.deriveMessages = () => { throw new Error('private-history-content') }
    const view = runtime.service.getStatus({ task_id: task.task_id }, runtime.exec()).tasks[0]!
    expect(view.intentHistoryNote).toContain('读取失败')
    expect(JSON.stringify(view)).not.toContain('private-history-content')
    await expect(runtime.service.delegate({ task_id: task.task_id, role: 'mou_ding', prompt: '不可用旧授权执行' }, runtime.exec())).rejects.toThrow(/审核|需求|授权/)
    const rejected = await within(runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec())) as PlanningReviewRecord
    expect(['pass', 'pass_with_degradation']).not.toContain(rejected.status)
    expect(rejected.errors.join(' ')).toContain('需求历史')
    expect(runtime.start).toHaveBeenCalledTimes(1)
    session.deriveMessages = deriveMessages
    const recovered = await within(runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec())) as PlanningReviewRecord
    expect(recovered.status).toBe('pass')
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(runtime.service.getStatus({ task_id: task.task_id }, runtime.exec()).tasks[0]!.intentHistoryNote).toBeNull()
  })

  it('固定低分在重复调用及 bypass_cache 后仍阻止执行，不靠重新抽样获得批准', async () => {
    const runtime = makeRuntime({ lowScores: true })
    const task = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    expect(task.planningReview?.status).toBe('review_required')
    runtime.behavior.lowScores = false
    for (const bypass of [false, true, true]) {
      const result = await within(runtime.service.ReviewPlan({ task_id: task.task_id, bypass_cache: bypass }, runtime.exec())) as PlanningReviewRecord
      expect(result.status).toBe('review_required')
      expect(result.jev.answers?.requirement_coverage).toEqual({ noul: 0.35 })
      expect(result.jev.answers?.execution_boundaries).toEqual({ noul: 0.79 })
    }
    expect(runtime.start).toHaveBeenCalledTimes(1)
    expect(runtime.fetchMock).toHaveBeenCalledTimes(1)
    await expect(runtime.service.delegate({ task_id: task.task_id, role: 'mou_ding', prompt: '不得绕过低分' }, runtime.exec())).rejects.toThrow(/审核/)
  })

  it('只改标题不重抽样，实质合同修订后才能获得新审核', async () => {
    const runtime = makeRuntime({ lowScores: true })
    const first = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    runtime.behavior.lowScores = false
    const renamed = await within(runtime.service.AddTaskCard({ ...runtime.card(), title: '展示名变化', task_id: first.task_id }, runtime.exec()))
    expect(renamed.planningReview?.status).toBe('review_required')
    expect(runtime.start).toHaveBeenCalledTimes(1)
    const revised = await within(runtime.service.AddTaskCard({ ...runtime.card(), task_id: first.task_id,
      acceptance: ['给出输入来源、逐条推导及未证实事项'] }, runtime.exec()))
    expect(revised.planningReview?.status).toBe('pass')
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(revised.planningReview?.snapshotDigest).not.toBe(first.planningReview?.snapshotDigest)
  })

  it('旧、缺失或未来题目版本均不能被当作当前批准或缓存', async () => {
    const runtime = makeRuntime()
    const task = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    const record = task.planningReview!
    const snapshot = runtime.snapshots[0]!
    expect(isPlanningReviewCurrent(record, snapshot)).toBe(true)
    expect(isPlanningReviewReusable(record, snapshot)).toBe(true)
    for (const questionVersion of ['1', '2', '3', 'old-question', '', 'future-question']) {
      expect(isPlanningReviewCurrent({ ...record, questionVersion }, snapshot)).toBe(false)
      expect(isPlanningReviewReusable({ ...record, questionVersion }, snapshot)).toBe(false)
    }
    const legacy = structuredClone(record)
    Reflect.deleteProperty(legacy, 'questionVersion')
    expect(isPlanningReviewCurrent(legacy, snapshot)).toBe(false)
    expect(isPlanningReviewReusable(legacy, snapshot)).toBe(false)
  })

  it.each(['start', 'result'] as const)('%s 不结束时有界返回，释放同快照审核且忽略迟到成功', async (hang) => {
    const runtime = makeRuntime({ hang })
    const task = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    expect(['pass', 'pass_with_degradation']).not.toContain(task.planningReview?.status)
    expect(runtime.requests[0]!.signal.aborted).toBe(true)
    runtime.releaseLateWork()
    await new Promise((resolve) => setImmediate(resolve))
    expect(['pass', 'pass_with_degradation']).not.toContain(runtime.getReview()?.status)
    const lateChild: AgentLike = { id: 'review-child-1', session: { header: { agentPreset: 'yu-shi' } } }
    expect(runtime.service.getGuardReason({ name: 'read', arguments: { path: 'input.txt' }, agent: lateChild,
      signal: runtime.requests[0]!.signal })).toBeDefined()
    const review = await within(runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec())) as PlanningReviewRecord
    expect(review.status).toBe('pass')
    expect(runtime.start).toHaveBeenCalledTimes(2)
    expect(runtime.dispose).toHaveBeenCalled()
  })

  it('dispose 不结束也不永久占用审核，取消后的子审核不能执行迟到工具', async () => {
    const runtime = makeRuntime({ hang: 'dispose' })
    const task = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    expect(task.planningReview).toBeDefined()
    expect(runtime.dispose).toHaveBeenCalledTimes(1)
    const request = runtime.requests[0]!
    const child: AgentLike = { id: 'review-child-1', session: { header: { agentPreset: 'yu-shi', cwd: runtime.exec().agent.session!.header!.cwd } } }
    expect(runtime.service.getGuardReason({ name: 'read', arguments: { path: 'input.txt' }, agent: child, signal: request.signal })).toBeDefined()
    runtime.releaseLateWork()
    await within(runtime.service.ReviewPlan({ task_id: task.task_id }, runtime.exec()))
  })

  it('同快照并发等待者取消只结束自身等待，不取消原审核或增加模型调用', async () => {
    const runtime = makeRuntime({ hang: 'result', timeoutMs: 30_000 })
    const initial = runtime.service.AddTaskCard(runtime.card(), runtime.exec())
    await within(runtime.started.promise)
    const caller = new AbortController()
    const joined = runtime.service.ReviewPlan({ task_id: 'T-1' }, { ...runtime.exec(), signal: caller.signal }).then(
      (result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error })
    )
    await new Promise((resolve) => setImmediate(resolve))
    caller.abort(new Error('仅取消第二个等待者'))
    expect((await within(joined)).ok).toBe(false)
    expect(runtime.requests[0]!.signal.aborted).toBe(false)
    expect(runtime.start).toHaveBeenCalledTimes(1)
    runtime.releaseLateWork()
    expect((await within(initial)).planningReview?.status).toBe('pass')
    expect(runtime.start).toHaveBeenCalledTimes(1)
  })

  it('规划总等待为0时超过旧180秒仍在审核，能观测进度并正常结算', async () => {
    const runtime = makeRuntime({ hang: 'result', timeoutMs: 0 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const pending = runtime.service.AddTaskCard(runtime.card(), runtime.exec())
      await runtime.started.promise
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(180_001)
      expect(runtime.requests[0]!.signal.aborted).toBe(false)
      const status = runtime.service.getStatus({ task_id: 'T-1' }, runtime.exec())
      expect(status.planningRuns).toHaveLength(1)
      expect(status.planningRuns![0]).toMatchObject({ task_id: 'T-1', timeoutMs: 0, agentStage: 'reviewing', jevStage: 'settled', route: 'fixture/reviewer' })
      expect(status.planningRuns![0]!.elapsedMs).toBeGreaterThanOrEqual(180_001)
      runtime.releaseLateWork()
      expect((await pending).planningReview?.status).toBe('pass')
      expect(runtime.service.getStatus({}, runtime.exec()).planningRuns).toEqual([])
    } finally { vi.useRealTimers() }
  })

  it('无限总等待仍支持用户取消，并移除审核状态和迟到权限', async () => {
    const runtime = makeRuntime({ hang: 'result', timeoutMs: 0 })
    const controller = new AbortController()
    const pending = runtime.service.AddTaskCard(runtime.card(), { ...runtime.exec(), signal: controller.signal })
    await within(runtime.started.promise)
    controller.abort()
    const result = await within(pending)
    expect(['pass', 'pass_with_degradation']).not.toContain(result.planningReview?.status)
    expect(runtime.requests[0]!.signal.aborted).toBe(true)
    expect(runtime.service.getStatus({}, runtime.exec()).planningRuns).toEqual([])
    runtime.releaseLateWork()
    await new Promise((resolve) => setImmediate(resolve))
    expect(['pass', 'pass_with_degradation']).not.toContain(runtime.getReview()?.status)
  })

  it('未取得审核结果的故障不伪报作者自审违规，仍不授予执行权限', async () => {
    const runtime = makeRuntime({ hang: 'result' })
    const result = await within(runtime.service.AddTaskCard(runtime.card(), runtime.exec()))
    expect(result.planningReview?.status).toBe('unavailable')
    expect(result.planningReview?.errors.join(' ')).toContain('总截止')
    expect(result.planningReview?.errors.join(' ')).not.toContain('必须使用非作者')
    await expect(runtime.service.delegate({ task_id: result.task_id, role: 'mou_ding', prompt: '不能绕过未完成审核' }, runtime.exec())).rejects.toThrow(/审核/)
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648])('非法总截止 %s 明确拒绝，不触发模型或Node计时器溢出', async (timeoutMs) => {
    const runtime = makeRuntime({ timeoutMs })
    await expect(runtime.service.AddTaskCard(runtime.card(), runtime.exec())).rejects.toThrow(/timeoutMs|JSON|finite|有限/)
    expect(runtime.start).not.toHaveBeenCalled()
    expect(runtime.service.getStatus({}, runtime.exec()).planningRuns).toEqual([])
  })

  it('关闭期间取消正在等待的审核，迟到结果不再发布批准', async () => {
    const runtime = makeRuntime({ hang: 'result', timeoutMs: 0 })
    const pending = runtime.service.AddTaskCard(runtime.card(), runtime.exec()).then(
      (result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error })
    )
    await within(runtime.started.promise)
    await within(runtime.service.dispose())
    expect(runtime.requests[0]!.signal.aborted).toBe(true)
    const settled = await within(pending)
    if (settled.ok) expect(['pass', 'pass_with_degradation']).not.toContain(settled.result.planningReview?.status)
    const before = runtime.getReview()
    runtime.releaseLateWork()
    await new Promise((resolve) => setImmediate(resolve))
    expect(runtime.getReview()).toEqual(before)
    expect(['pass', 'pass_with_degradation']).not.toContain(runtime.getReview()?.status)
    await expect(runtime.service.ReviewPlan({ task_id: 'T-1' }, runtime.exec())).rejects.toThrow(/停止|关闭/)
  })
})
