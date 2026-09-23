import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig, type SwarmConfigInfo } from '../../src/config.js'
import {
  ParseNativeOutput,
  ValidateDelegateInput,
  getAvoidFamilies,
  getNativeKind,
  getOutputText,
  getToolFilter,
  intDelegator,
  type DelegateDepsInfo,
  type DelegateSessionInfo
} from '../../src/delegate.js'
import { getLedgerEvents, intLedger, intTaskStore, type DelegationRecord } from '../../src/evidence.js'
import type { SubagentResultLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'
import { intRouteStateRegistry } from '../../src/route-state.js'
import type { RouteProbe } from '../../src/routes.js'
import { intMutex } from '../../src/util/mutex.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const WORKSPACE = resolve('/workspace/project')
const VISIBLE = ['read', 'read_image', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_search', 'web_fetch', 'swarm_delegate', 'skill']
const agent = { id: 'root', session: { header: { cwd: WORKSPACE } } }

interface FakeRunPlan {
  result: SubagentResultLike
  onStarted?: (id: string) => void
  startError?: string
}

const makeHarness = (overrides: Partial<DelegateDepsInfo> & { config?: SwarmConfigInfo; plans?: FakeRunPlan[]; providers?: string[] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-delegate-'))
  const store = intTaskStore()
  const card = ValidateTaskCard({ title: '修复', goal: '修好', acceptance: ['测试通过'], scope: ['src/a.ts'], flags: { changesCode: true } }).card as TaskCard
  store.AddTask({ taskId: 'T-1', sessionId: 'root', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1 })
  const session: DelegateSessionInfo = { sessionId: 'root', store, ledger: intLedger(dir, 'root'), editLock: intMutex(), counters: { native: 0 } }
  const requests: Array<{ name: string; request: SubagentStartRequestLike }> = []
  const plans = [...(overrides.plans ?? [])]
  const providers = new Set(['spawn', ...(overrides.providers ?? [])])
  let seq = 0
  const routeState = intRouteStateRegistry()
  const subagents = {
    list: () => [...providers],
    getProvider: (name: string) => (providers.has(name) ? { capabilities: {} } : undefined),
    start: vi.fn(async (name: string, request: SubagentStartRequestLike) => {
      requests.push({ name, request })
      const plan = plans.shift() ?? { result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' } }
      if (plan.startError !== undefined) throw new Error(plan.startError)
      const id = `child-${++seq}`
      // 模拟宿主：子智能体的首个请求发生在 start() resolve 之后
      setTimeout(() => plan.onStarted?.(id), 0)
      // 模拟宿主：dispose 触发 agent/disposed，运行时行随即清理该子智能体的路由状态
      return { id, result: new Promise<SubagentResultLike>((r) => setTimeout(() => r(plan.result), 5)), dispose: vi.fn(async () => { routeState.DelAgent(id) }) }
    })
  }
  const probe: RouteProbe = async () => ({ ok: true, vision: true })
  let clock = 1000
  const deps: DelegateDepsInfo = {
    getConfig: () => overrides.config ?? getSwarmConfig({}),
    getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, schemas: () => VISIBLE.map((name) => ({ name })), guard: () => () => undefined }),
    getAttachments: () => ({ saveImages: async (inputs) => inputs.map((_, i) => ({ ref: i })) }),
    probe,
    routeState,
    readFile: async () => new Uint8Array([1]),
    gitStatus: async () => undefined,
    now: () => (clock += 10),
    newId: (prefix) => `${prefix}-${++seq}`,
    ...overrides
  }
  return { dir, session, deps, requests, subagents, routeState, delegator: intDelegator(deps) }
}

const exec = () => ({ agent, signal: new AbortController().signal })
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const track = <T extends { dir: string }>(h: T): T => { dirs.push(h.dir); return h }

describe('ValidateDelegateInput', () => {
  it('接受合法输入', () => {
    expect(ValidateDelegateInput({ task_id: 'T-1', role: 'fu_he', prompt: '跑测试' }).input?.role).toBe('fu_he')
    expect(ValidateDelegateInput({ task_id: 'T-1', role: 'suan_heng', mode: 'verify', prompt: 'x', allow_web: true }).errors).toEqual([])
  })

  it('拒绝非法组合', () => {
    const errors = (raw: unknown) => ValidateDelegateInput(raw).errors.join('|')
    expect(errors('x')).toContain('参数必须是对象')
    expect(errors({ task_id: 'T-1', role: 'tian_shu', prompt: 'x' })).toContain('role 必须是可委派角色')
    expect(errors({ task_id: '', role: 'fu_he', prompt: '' })).toContain('task_id')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', mode: 'verify' })).toContain('mode 只适用于 suan_heng')
    expect(errors({ task_id: 'T', role: 'suan_heng', prompt: 'x', mode: 'guess' })).toContain('mode 必须是 research 或 verify')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', image_paths: ['a.png'] })).toContain('image_paths 只适用于 guan_xiang')
    expect(errors({ task_id: 'T', role: 'yu_shi', prompt: 'x', allow_web: true })).toContain('不开放 web')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', gate: 'G_X' })).toContain('gate')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', backend: 'gpt' })).toContain('backend')
    expect(errors({ task_id: 'T', role: 'fu_he', prompt: 'x', context_paths: [1] })).toContain('context_paths')
  })
})

describe('纯函数', () => {
  it('工具白名单与可见工具求交集；无交集时改用 deny', () => {
    expect(getToolFilter('fu_he', VISIBLE, false)).toEqual({ allow: ['read', 'read_image', 'glob', 'grep', 'pwsh'] })
    expect(getToolFilter('bo_wen', VISIBLE, false)?.allow).toContain('web_search')
    expect(getToolFilter('shu_ji', VISIBLE, false)?.allow).not.toContain('web_search')
    expect(getToolFilter('shu_ji', VISIBLE, true)?.allow).toContain('web_fetch')
    expect(getToolFilter('fu_he', ['swarm_delegate', 'structured_output'], false)).toEqual({ deny: ['swarm_delegate'] })
    expect(getToolFilter('fu_he', [], false)).toBeUndefined()
  })

  it('原生后端种类', () => {
    expect(getNativeKind('zhu_jian', 'claude')).toBe('claude-edit')
    expect(getNativeKind('zhu_jian', 'codex')).toBe('codex-edit')
    expect(getNativeKind('yu_shi', 'codex')).toBe('codex')
    expect(getNativeKind('shu_ji', 'claude')).toBe('claude-plan')
    expect(getNativeKind('fu_he', 'codex')).toBeUndefined()
  })

  it('解析原生输出：取最后一个 json 代码块，退化为花括号片段', () => {
    expect(ParseNativeOutput('a\n```json\n{"x":1}\n```\n```json\n{"x":2}\n```')).toEqual({ x: 2 })
    expect(ParseNativeOutput('结果 {"y":3} 完')).toEqual({ y: 3 })
    expect(ParseNativeOutput('没有 JSON')).toBeUndefined()
    expect(getOutputText({ output: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }], stopReason: 'completed' })).toBe('a\nb')
  })

  it('独立性：御史避开实现者家族，验算避开研算家族', () => {
    const done = (role: DelegationRecord['role'], model: string, mode?: 'research'): DelegationRecord => ({
      delegationId: role, taskId: 'T-1', role, roleName: role, status: 'completed', summary: '', evidence: [], attempts: [],
      independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 1, route: { provider: 'p', model }, ...(mode ? { mode } : {})
    })
    expect(getAvoidFamilies('yu_shi', undefined, [done('zhu_jian', 'kimi-k2.7-code'), done('tan_wei', 'mimo-v2.5-pro')])).toEqual(['kimi'])
    expect(getAvoidFamilies('suan_heng', 'verify', [done('suan_heng', 'deepseek-v4-pro', 'research')])).toEqual(['deepseek'])
    expect(getAvoidFamilies('fu_he', undefined, [done('zhu_jian', 'kimi-k2.7-code')])).toEqual([])
  })
})

describe('intDelegator.delegate', () => {
  let harness: ReturnType<typeof makeHarness>
  beforeEach(() => { harness = track(makeHarness()) })

  it('复核：spawn 请求带路由、白名单、schema、persona 与深度上限，结果完成并写账本', async () => {
    const record = await harness.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: '运行 npm test', context_paths: ['src/a.ts'], gate: 'G_VERIFY' }, exec(), harness.session)
    expect(record.status).toBe('completed')
    expect(record.summary).toBe('测试通过')
    expect(record.evidence[0]).toMatchObject({ kind: 'command', exitCode: 0 })
    expect(record.route).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' })
    expect(record.attempts).toContainEqual({ route: 'qwen-token-plan-cn/qwen3.8-flash', backend: 'spawn', outcome: 'used' })
    const { name, request } = harness.requests[0] as { name: string; request: SubagentStartRequestLike }
    expect(name).toBe('spawn')
    expect(request.agentOptions).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' })
    expect(request.maxDepth).toBe(1)
    expect(request.toolFilter?.allow).not.toContain('write')
    expect(request.persona).toContain('[[swarm:role=fu_he]]')
    expect(request.outputSchema).toMatchObject({ type: 'object' })
    const text = String(request.prompt[0]?.text)
    expect(text).toContain('T-1')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('G_VERIFY')
    expect(text).toContain('运行 npm test')
    const types = getLedgerEvents(harness.session.ledger.path).map((e) => e.type)
    expect(types).toEqual(['delegation/queued', 'delegation/running', 'delegation/completed'])
    expect(harness.routeState.getChild('child-1')).toBeUndefined()
  })

  it('未知任务抛错；参数非法抛错', async () => {
    await expect(harness.delegator.delegate({ task_id: 'T-9', role: 'fu_he', prompt: 'x' }, exec(), harness.session)).rejects.toThrow('未知任务')
    await expect(harness.delegator.delegate({ task_id: 'T-1', role: 'nobody', prompt: 'x' }, exec(), harness.session)).rejects.toThrow('role')
  })

  it('超出预算时 blocked', async () => {
    const h = track(makeHarness({ config: getSwarmConfig({ budgets: { maxCallsPerRole: 1 } }) }))
    await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    const second = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    expect(second.status).toBe('blocked')
    expect(second.error).toContain('上限')
  })

  it('没有可用路由时 blocked；观象链无视觉模型时给出 vision-unsupported', async () => {
    const none = track(makeHarness({ probe: async () => ({ ok: false, reason: 'provider-not-configured' }) }))
    const blocked = await none.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), none.session)
    expect(blocked.status).toBe('blocked')
    expect(blocked.error).toContain('no-usable-route')
    expect(blocked.attempts.every((a) => a.outcome === 'skipped')).toBe(true)
    const text = track(makeHarness({ probe: async () => ({ ok: true, vision: false }) }))
    const vision = await text.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图' }, exec(), text.session)
    expect(vision.status).toBe('blocked')
    expect(vision.error).toContain('vision-unsupported')
  })

  it('子智能体失败、未提交结构化结果、结果不符合契约', async () => {
    const h = track(makeHarness({ plans: [
      { result: { output: [{ type: 'text', text: '部分' }], stopReason: 'error', diagnostic: 'QUOTA' } },
      { result: { output: [], stopReason: 'completed' } },
      { result: { output: [], structured: { summary: 's' }, stopReason: 'completed' } }
    ] }))
    const failed = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(failed).toMatchObject({ status: 'failed', error: 'error：QUOTA', summary: '部分' })
    const missing = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(missing.error).toContain('没有提交结构化结果')
    const invalid = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(invalid.error).toContain('不符合契约')
  })

  it('首条路由启动失败时尝试下一条', async () => {
    const h = track(makeHarness({ plans: [{ startError: 'route rejected', result: { output: [], stopReason: 'error' } }, { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } }] }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'start: route rejected' })
    expect(record.route?.model).toBe('kimi-k2.7-code')
  })

  it('运行中回退：记录 fallback 并以最终路由为准', async () => {
    const config = getSwarmConfig({})
    let registry = intRouteStateRegistry()
    const h = track(makeHarness({ plans: [{
      result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' },
      onStarted: (id) => {
        registry.getRequestOverride({ id }, { provider: 'x', model: 'y' }, undefined)
        registry.getErrorAction({ agent: { id }, provider: 'qwen-token-plan-cn', failure: { code: 'QUOTA' } }, undefined, undefined, config)
      }
    }] }))
    registry = h.routeState
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    expect(record.route).toEqual({ provider: 'opencode-go', model: 'qwen3.8-flash' })
    expect(record.attempts.some((a) => a.outcome === 'fallback' && a.reason?.includes('QUOTA'))).toBe(true)
    expect(getLedgerEvents(h.session.ledger.path).some((e) => e.type === 'route/fallback')).toBe(true)
  })

  it('原生后端：实例缺失时退回 spawn；存在时解析文本结果并标注无硬隔离', async () => {
    const missing = await harness.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), harness.session)
    expect(missing.attempts[0]).toMatchObject({ backend: 'codex', outcome: 'skipped', reason: 'native-unavailable' })
    expect(missing.backend).toBe('spawn')
    const text = '分析完毕\n```json\n' + JSON.stringify(VALID_OUTPUTS.tan_wei) + '\n```'
    const h = track(makeHarness({ providers: ['swarm-codex'], plans: [{ result: { output: [{ type: 'text', text }], stopReason: 'completed' } }] }))
    const native = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(native).toMatchObject({ status: 'completed', backend: 'codex', hardIsolation: false, route: { provider: 'swarm-codex', model: 'codex-native' } })
    const request = h.requests[0]?.request as SubagentStartRequestLike
    expect(h.requests[0]?.name).toBe('swarm-codex')
    expect(request.persona).toBeUndefined()
    expect(String(request.prompt[0]?.text)).toContain('JSON Schema')
    expect(h.session.counters.native).toBe(1)
  })

  it('原生后端：不支持的角色与超出调用上限时退回 spawn', async () => {
    const h = track(makeHarness({ providers: ['swarm-codex'], config: getSwarmConfig({ native: { maxCallsPerSession: 0 } }) }))
    const budget = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(budget.attempts[0]).toMatchObject({ outcome: 'skipped', reason: 'native-budget' })
    const unsupported = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(unsupported.attempts[0]?.reason).toContain('不支持原生后端')
  })

  it('自动升级：nativeEscalation=auto 且高风险任务时优先原生后端', async () => {
    const text = '```json\n' + JSON.stringify(VALID_OUTPUTS.yu_shi) + '\n```'
    const h = track(makeHarness({ providers: ['swarm-codex'], config: getSwarmConfig({ nativeEscalation: 'auto' }), plans: [{ result: { output: [{ type: 'text', text }], stopReason: 'completed' } }] }))
    h.session.store.UpdateTask('T-1', { gates: [{ gate: 'G_REVIEW', role: 'yu_shi', reason: 'r', source: 'rule' }] })
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'yu_shi', prompt: 'x' }, exec(), h.session)
    expect(record.backend).toBe('codex')
  })

  it('git 改动追踪：编辑角色记录改动，只读角色出现改动时告警', async () => {
    const snapshots = [new Map(), new Map([['hello.txt', '??']]), new Map(), new Map([['x.ts', ' M']])]
    const h = track(makeHarness({
      gitStatus: async () => snapshots.shift(),
      plans: [
        { result: { output: [], structured: VALID_OUTPUTS.ji_feng, stopReason: 'completed' } },
        { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } }
      ]
    }))
    const edit = await h.delegator.delegate({ task_id: 'T-1', role: 'ji_feng', prompt: 'x' }, exec(), h.session)
    expect(edit.changedFiles).toEqual(['hello.txt'])
    expect(edit.changeTracking).toBe('git')
    expect(edit.evidence).toContainEqual({ kind: 'file-change', ref: 'hello.txt' })
    const read = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(read.unresolved.join('')).toContain('x.ts')
    expect(harness.session.store.getTask('T-1')).toBeDefined()
    const noGit = await harness.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), harness.session)
    expect(noGit.changeTracking).toBe('unavailable')
  })

  it('观象：图片入库后随 prompt 发送；越界路径 blocked', async () => {
    const h = track(makeHarness({ plans: [{ result: { output: [], structured: VALID_OUTPUTS.guan_xiang, stopReason: 'completed' } }] }))
    const ok = await h.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图', image_paths: ['shot.png'] }, exec(), h.session)
    expect(ok.status).toBe('completed')
    expect(h.requests[0]?.request.prompt[1]).toEqual({ type: 'image', attachment: { ref: 0 } })
    const outside = await h.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图', image_paths: ['../x.png'] }, exec(), h.session)
    expect(outside.status).toBe('blocked')
    expect(outside.error).toContain('不在工作区内')
    const noAttach = track(makeHarness({ getAttachments: () => undefined }))
    const failed = await noAttach.delegator.delegate({ task_id: 'T-1', role: 'guan_xiang', prompt: '看图', image_paths: ['shot.png'] }, exec(), noAttach.session)
    expect(failed.error).toContain('附件服务不可用')
  })

  it('服务缺失时 blocked', async () => {
    const noSub = track(makeHarness({ getSubagents: () => undefined }))
    expect((await noSub.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), noSub.session)).error).toContain('子智能体服务不可用')
    const noTools = track(makeHarness({ getTools: () => undefined }))
    expect((await noTools.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), noTools.session)).error).toContain('工具服务不可用')
  })

  it('编辑类委派串行执行', async () => {
    const order: string[] = []
    const h = track(makeHarness())
    const slowStart = h.subagents.start.getMockImplementation()
    h.subagents.start.mockImplementation(async (name, request) => {
      order.push(`start:${request.label}`)
      const run = await (slowStart as NonNullable<typeof slowStart>)(name, request)
      return { ...run, result: run.result.then((r) => { order.push(`end:${request.label}`); return r }) }
    })
    await Promise.all([
      h.delegator.delegate({ task_id: 'T-1', role: 'ji_feng', prompt: 'a' }, exec(), h.session),
      h.delegator.delegate({ task_id: 'T-1', role: 'ji_feng', prompt: 'b' }, exec(), h.session)
    ])
    expect(order).toEqual(['start:疾风·T-1', 'end:疾风·T-1', 'start:疾风·T-1', 'end:疾风·T-1'])
  })

  it('原生后端启动失败（例如未登录）时归还调用次数并退回 spawn', async () => {
    const h = track(makeHarness({ providers: ['swarm-codex'], plans: [
      { startError: 'not logged in', result: { output: [], stopReason: 'error' } },
      { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } }
    ] }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(record).toMatchObject({ status: 'completed', backend: 'spawn' })
    expect(record.attempts).toContainEqual({ route: 'swarm-codex', backend: 'codex', outcome: 'failed', reason: 'start: not logged in' })
    expect(h.session.counters.native).toBe(0)
  })

  it('执行中出现意外异常时记录收尾为 failed，不会卡在 running', async () => {
    const h = track(makeHarness({ gitStatus: async () => { throw new Error('git exploded') } }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(record).toMatchObject({ status: 'failed', error: 'git exploded' })
    expect(h.session.store.getDelegation(record.delegationId)?.status).toBe('failed')
  })

  it('调用方已取消时不再启动子智能体', async () => {
    const controller = new AbortController()
    controller.abort()
    const record = await harness.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, { agent, signal: controller.signal }, harness.session)
    expect(record).toMatchObject({ status: 'failed', error: 'aborted' })
    expect(harness.subagents.start).not.toHaveBeenCalled()
  })

  it('超时中止子智能体', async () => {
    const h = track(makeHarness({ config: getSwarmConfig({ budgets: { delegationTimeoutMs: 1 } }) }))
    h.subagents.start.mockImplementation(async (_name, request) => ({
      id: 'slow',
      result: new Promise<SubagentResultLike>((r) => request.signal.addEventListener('abort', () => r({ output: [], stopReason: 'aborted' }))),
      dispose: vi.fn(async () => undefined)
    }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(record).toMatchObject({ status: 'failed', error: 'aborted' })
  })
})
