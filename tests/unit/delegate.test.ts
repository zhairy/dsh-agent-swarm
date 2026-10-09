import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig, type SwarmConfigInfo } from '../../src/config.js'
import {
  DispatchAdmissionError,
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
import { intChildEndHub, intThreadRegistry } from '../../src/threads.js'
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
  const session: DelegateSessionInfo = { sessionId: 'root', store, ledger: intLedger(dir, 'root'), editLock: intMutex(), counters: { native: 0 }, threads: intThreadRegistry() }
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
    newChildId: () => `thread-${++seq}`,
    hub: intChildEndHub(),
    sleep: vi.fn(async () => undefined),
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
    expect(record.route).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', reasoningEffort: 'medium' })
    expect(record.attempts).toContainEqual({ route: 'qwen-token-plan-cn/qwen3.8-flash', backend: 'spawn', outcome: 'used' })
    const { name, request } = harness.requests[0] as { name: string; request: SubagentStartRequestLike }
    expect(name).toBe('spawn')
    expect(request.agentOptions).toEqual({ provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', reasoningEffort: 'medium' })
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
    expect(types).toEqual(['delegation/queued', 'delegation/running', 'session/plan', 'delegation/completed'])
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

  it('preflight preserves temporary preferred candidates without reviving an incompatible effort variant', async () => {
    const first = { provider: 'p', model: 'same', reasoningEffort: 'unsupported' }
    const valid = { provider: 'p', model: 'same', reasoningEffort: 'high' }
    const backup = { provider: 'b', model: 'backup' }
    const observed: unknown[] = []
    const h = track(makeHarness({
      config: getSwarmConfig({ routes: { fu_he: { chain: [first, valid, backup] } } }),
      probe: async (route) => route.reasoningEffort === 'unsupported' ? { ok: false, reason: 'capability-incompatible: unsupported-reasoning-effort' } : { ok: true, vision: false },
      onChildStart: ({ agentId }) => { observed.push(h.routeState.getRequestOverride({ id: agentId }, valid, undefined)) }
    }))
    const result = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    expect(result.status).toBe('completed')
    expect(observed).toEqual([valid])
  })

  it('子智能体失败、未提交结构化结果、结果不符合契约（不重试时）', async () => {
    const h = track(makeHarness({ config: getSwarmConfig({ agents: { maxRetries: 0 } }), plans: [
      { result: { output: [{ type: 'text', text: '部分' }], stopReason: 'error', diagnostic: 'QUOTA' } },
      { result: { output: [], stopReason: 'completed' } },
      { result: { output: [], structured: { summary: 's' }, stopReason: 'completed' } }
    ] }))
    const failed = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(failed).toMatchObject({ status: 'failed', summary: '部分' })
    // 原始错误之后附中文说明，便于判断是额度、网络还是账号问题
    expect(failed.error).toBe('error：QUOTA（说明：额度用尽或余额不足：停止原故障域重试；是否已切换及有无备用以运行记录为准）')
    const missing = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(missing.error).toContain('没有提交结构化结果')
    const invalid = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(invalid.error).toContain('不符合契约')
  })

  it('容灾升级：命中触发条件时升级链优先，并记入结果与账本', async () => {
    const h = track(makeHarness({ plans: [{ result: { output: [], structured: VALID_OUTPUTS.zhu_jian, stopReason: 'completed' } }] }))
    const card = ValidateTaskCard({ title: '重构', goal: 'g', acceptance: ['a'], flags: { changesCode: true, crossModuleArchitecture: true } }).card as TaskCard
    h.session.store.UpdateTask('T-1', { card })
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: 'x' }, exec(), h.session)
    expect((h.requests[0]?.request as SubagentStartRequestLike).agentOptions).toEqual({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' })
    expect(record.upgrade).toEqual({ reasons: ['跨模块架构或大范围重构'], chain: ['claude/claude-opus-5-5', 'codex/gpt-6-astra'] })
    expect(getLedgerEvents(h.session.ledger.path).some((e) => e.type === 'route/upgrade')).toBe(true)
  })

  it('容灾升级：天枢显式要求时升级；角色未配置升级时照常执行并注明', async () => {
    const h = track(makeHarness({ plans: [
      { result: { output: [], structured: VALID_OUTPUTS.mou_ding, stopReason: 'completed' } },
      { result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' } }
    ] }))
    const planned = await h.delegator.delegate({ task_id: 'T-1', role: 'mou_ding', prompt: 'x', upgrade: true }, exec(), h.session)
    expect(planned.route).toEqual({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' })
    expect(planned.upgrade?.reasons).toEqual(['天枢显式要求升级'])
    const verified = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x', upgrade: true }, exec(), h.session)
    expect(verified.upgrade).toBeUndefined()
    expect(verified.attempts[0]).toMatchObject({ route: 'upgrade', outcome: 'skipped' })
    expect(ValidateDelegateInput({ task_id: 'T', role: 'fu_he', prompt: 'x', upgrade: 'yes' }).errors.join()).toContain('upgrade')
  })

  it('首条路由启动失败时尝试下一条', async () => {
    const h = track(makeHarness({ plans: [{ startError: 'route rejected', result: { output: [], stopReason: 'error' } }, { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } }] }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.attempts[0]).toMatchObject({ outcome: 'failed', reason: 'start: route rejected' })
    expect(record.route?.model).toBe('mimo-v2.6-flash')
  })

  it('运行中回退：记录 fallback 并以最终路由为准', async () => {
    const config = getSwarmConfig({})
    let registry = intRouteStateRegistry()
    const h = track(makeHarness({ plans: [{
      result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' },
      onStarted: (id) => {
        registry.getRequestOverride({ id }, { provider: 'x', model: 'y' }, undefined)
        registry.getErrorAction({ agent: { id }, provider: 'qwen-token-plan-cn', failure: { code: 'QUOTA' } }, undefined, undefined, config)
        // A fallback selection is not an actual new call until the Host assembles it.
        registry.getRequestOverride({ id }, { provider: 'x', model: 'y' }, undefined)
      }
    }] }))
    registry = h.routeState
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    // 同一 Qwen plan 已用尽，换模型不会恢复额度，应跳到独立资源的备用。
    expect(record.route).toEqual({ provider: 'opencode-go', model: 'mimo-v2.6-flash', reasoningEffort: 'medium' })
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
  it('已发布原生run的登记失败仍会dispose，不退回另一个后端重放或退款已开始调用', async () => {
    const h = track(makeHarness({ providers: ['swarm-codex'] }))
    const dispose = vi.fn(async () => undefined)
    h.subagents.start.mockImplementation(async () => ({ id: 'published-native', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose }))
    h.deps.onChildStart = async () => { throw new Error('registration failed') }
    const result = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', backend: 'codex' }, exec(), h.session)
    expect(result).toMatchObject({ status: 'failed', backend: 'codex', hardIsolation: false, error: 'registration failed' })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
    expect(h.session.counters.native).toBe(1)
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
    const h = track(makeHarness({ plans: [
      { result: { output: [], structured: VALID_OUTPUTS.ji_feng, stopReason: 'completed' } },
      { result: { output: [], structured: VALID_OUTPUTS.ji_feng, stopReason: 'completed' } }
    ] }))
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

  it('专家执行不设时间限制：只有调用方取消才中止，且取消后不重试', async () => {
    const h = track(makeHarness())
    h.subagents.start.mockImplementation(async (_name, request) => ({
      id: 'slow',
      result: new Promise<SubagentResultLike>((r) => request.signal.addEventListener('abort', () => r({ output: [], stopReason: 'aborted' }))),
      dispose: vi.fn(async () => undefined)
    }))
    const controller = new AbortController()
    const pending = h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, { agent, signal: controller.signal }, h.session)
    await new Promise((r) => setTimeout(r, 30))
    expect(h.session.store.getTaskDelegations('T-1')[0]?.status).toBe('running')
    controller.abort()
    const record = await pending
    expect(record).toMatchObject({ status: 'failed', error: 'aborted' })
    expect(record.retries).toBeUndefined()
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
  })
})

interface FakeTurn { stopReason?: string; text?: string; startError?: string; sendError?: string; silent?: boolean }

const json = (role: keyof typeof VALID_OUTPUTS): string => '```json\n' + JSON.stringify(VALID_OUTPUTS[role]) + '\n```'

/** 支持连续会话的宿主替身：startContinuable/sendMessage 之后按 turns 依次发出 subagent/end */
const makeThreadHarness = (turns: FakeTurn[], overrides: Parameters<typeof makeHarness>[0] = {}) => {
  const h = makeHarness(overrides)
  const queue = [...turns]
  const delivered: Array<{ kind: 'start' | 'send'; childId: string; text: string; persona?: string; toolFilter?: unknown }> = []
  const reply = (childId: string): void => {
    const turn = queue.shift() ?? { text: json('zhu_jian') }
    if (turn.silent === true) return
    setTimeout(() => h.deps.hub.Emit({ id: childId, stopReason: turn.stopReason ?? 'completed', lastAssistantMessage: [{ type: 'text', text: turn.text ?? '' }] }), 5)
  }
  const extra = {
    // 与宿主一样依赖 this：解构调用会失败
    startContinuable: vi.fn(async function (this: unknown, spec: { childId: string; request: { prompt: Array<{ text?: string }>; persona?: string; toolFilter?: unknown } }) {
      if (this !== h.subagents) throw new Error('unbound startContinuable')
      if (queue[0]?.startError !== undefined) throw new Error(queue.shift()?.startError)
      delivered.push({ kind: 'start', childId: spec.childId, text: String(spec.request.prompt[0]?.text), persona: spec.request.persona, toolFilter: spec.request.toolFilter })
      reply(spec.childId)
      return { childId: spec.childId, messageId: 'm' }
    }),
    sendMessage: vi.fn(async function (this: unknown, _sender: unknown, childId: string, content: Array<{ text?: string }>) {
      if (this !== h.subagents) throw new Error('unbound sendMessage')
      if (queue[0]?.sendError !== undefined) throw new Error(queue.shift()?.sendError)
      delivered.push({ kind: 'send', childId, text: String(content[0]?.text) })
      reply(childId)
      return 'm'
    }),
    interrupt: vi.fn()
  }
  Object.assign(h.subagents, extra)
  return { ...h, delivered, ...extra }
}

describe('连续会话与自动重试', () => {
  it('人工继续固定到所选thread，手动新模型先于全部不可用的旧角色链预检', async () => {
    const h = track(makeThreadHarness([{ text: json('tan_wei') }, { text: json('tan_wei') }, { text: json('tan_wei') }]))
    const first = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'first', session: 'new' }, exec(), h.session)
    const second = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'second', session: 'new' }, exec(), h.session)
    const target = first.session!.threadId!
    h.routeState.SetChildOverride(target, { provider: 'manual-provider', model: 'chosen' })
    h.deps.probe = async (route) => route.provider === 'manual-provider' ? { ok: true, vision: false } : { ok: false, reason: 'route-isolated' }
    const continued = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'continue exactly first', session: 'continue' }, { ...exec(), controlledThreadId: target }, h.session)
    expect(continued.status).toBe('completed')
    expect(continued.session?.threadId).toBe(target)
    expect(continued.session?.threadId).not.toBe(second.session!.threadId)
    expect(h.delivered.at(-1)).toMatchObject({ kind: 'send', childId: target })
    expect(h.startContinuable).toHaveBeenCalledTimes(2)
  })

  it('指定thread不可用或未接受投递时不会另开专家或自动重放', async () => {
    const h = track(makeThreadHarness([{ text: json('tan_wei') }, { text: json('tan_wei') }, { sendError: 'host did not admit message' }]))
    const first = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'first', session: 'new' }, exec(), h.session)
    await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'other', session: 'new' }, exec(), h.session)
    const target = first.session!.threadId!
    h.session.threads.Update(target, { busy: true })
    const unavailable = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', session: 'continue' }, { ...exec(), controlledThreadId: target }, h.session)
    expect(unavailable).toMatchObject({ status: 'failed', error: expect.stringContaining('不能改为另一专家会话') })
    h.session.threads.Update(target, { busy: false })
    const ended = vi.fn(async () => undefined)
    h.deps.onChildEnd = ended
    const failed = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', session: 'continue' }, { ...exec(), controlledThreadId: target }, h.session)
    expect(failed).toMatchObject({ status: 'failed', childId: target, error: 'host did not admit message' })
    expect(h.startContinuable).toHaveBeenCalledTimes(2)
    expect(h.sendMessage).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith(target, 'not-admitted')
  })
  it('Jev 未配置时按规则：铸剑开连续会话，同一任务的后续委派追加到该会话并保留路由状态', async () => {
    const h = track(makeThreadHarness([{ text: `完成。\n${json('zhu_jian')}` }, { text: json('zhu_jian') }]))
    const first = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: '实现登录' }, exec(), h.session)
    expect(first).toMatchObject({ status: 'completed', session: { kind: 'continuable', appended: false, round: 1, source: 'rules' } })
    const threadId = first.session?.threadId as string
    expect(h.delivered[0]).toMatchObject({ kind: 'start', childId: threadId })
    // 铸剑的首选路由是 Claude：任务说明用 XML 分节，交付要求放在最后
    expect(h.delivered[0]?.text).toContain('<deliverable>')
    expect(h.delivered[0]?.text).toContain('```json')
    expect(h.delivered[0]?.persona).toContain('<role>')
    expect(h.delivered[0]?.persona).toContain('[[swarm:role=zhu_jian]]')
    expect(h.delivered[0]?.toolFilter).toMatchObject({ allow: expect.arrayContaining(['write', 'edit']) })
    expect(h.subagents.start).not.toHaveBeenCalled()
    expect(h.routeState.getChild(threadId)).toBeDefined()
    h.routeState.ReleaseAgent(threadId)
    expect(h.routeState.getChild(threadId)).toBeDefined()
    const second = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: '按审查意见修改' }, exec(), h.session)
    expect(second.session).toMatchObject({ kind: 'continuable', threadId, appended: true, round: 2 })
    expect(h.delivered[1]).toMatchObject({ kind: 'send', childId: threadId })
    expect(h.delivered[1]?.text).toContain('【追加】任务 T-1')
    expect(h.session.threads.list()).toMatchObject([{ threadId, rounds: 2, busy: false, taskIds: ['T-1'] }])
    expect(getLedgerEvents(h.session.ledger.path).filter((e) => e.type === 'session/plan')).toHaveLength(2)
  })

  it('交付不合格或缺少 json 时在同一会话里要求修正；出错时退避后续跑', async () => {
    const h = track(makeThreadHarness([
      { text: '做完了，但忘了 json' },
      { text: '```json\n{"summary":"s"}\n```' },
      { stopReason: 'error', text: '' },
      { text: json('zhu_jian') }
    ]))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: '实现' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.retries?.map((r) => r.action)).toEqual(['continue', 'continue', 'continue'])
    expect(h.delivered.slice(1).map((d) => d.kind)).toEqual(['send', 'send', 'send'])
    expect(h.delivered[1]?.text).toContain('没有可解析的 json')
    expect(h.delivered[2]?.text).toContain('不符合要求')
    expect(h.delivered[3]?.text).toContain('上一次执行中断')
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(getLedgerEvents(h.session.ledger.path).filter((e) => e.type === 'delegation/retry')).toHaveLength(3)
  })

  it('会话无法建立时换新会话重试，多次失败后改为一次性调用', async () => {
    const h = track(makeThreadHarness([{ startError: 'capacity' }, { startError: 'capacity' }], {
      config: getSwarmConfig({ agents: { maxRetries: 1 } }),
      plans: [{ result: { output: [], structured: VALID_OUTPUTS.zhu_jian, stopReason: 'completed' } }]
    }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: '实现' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.session).toMatchObject({ kind: 'oneshot', reason: expect.stringContaining('连续会话无法建立') })
    expect(record.retries?.map((r) => r.action)).toEqual(['restart', 'fallback'])
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
    expect(h.session.threads.list().every((t) => t.closed)).toBe(true)
  })

  it('追加投递失败时关闭旧会话，另开新会话', async () => {
    const h = track(makeThreadHarness([{ text: json('zhu_jian') }, { sendError: 'not-resumable' }, { text: json('zhu_jian') }]))
    const first = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: 'a' }, exec(), h.session)
    const second = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: 'b' }, exec(), h.session)
    expect(second.status).toBe('completed')
    expect(second.session).toMatchObject({ kind: 'continuable', appended: false })
    expect(second.session?.threadId).not.toBe(first.session?.threadId)
    expect(h.session.threads.get(first.session?.threadId as string)?.closed).toBe(true)
  })

  it('衡鉴判定一次性、天枢显式指定会话方式', async () => {
    const planSession = vi.fn(async () => ({ kind: 'oneshot' as const, source: 'jev' as const, reason: '一次性工作（再次调用概率 0.10）' }))
    const h = track(makeThreadHarness([{ text: json('tan_wei') }, { text: json('tan_wei') }], {
      planSession,
      plans: [{ result: { output: [], structured: VALID_OUTPUTS.zhu_jian, stopReason: 'completed' } }]
    }))
    const byJev = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: 'x' }, exec(), h.session)
    expect(byJev.session).toMatchObject({ kind: 'oneshot', source: 'jev' })
    expect(h.subagents.start).toHaveBeenCalledTimes(1)
    const explicitNew = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x', session: 'new' }, exec(), h.session)
    expect(explicitNew.session).toMatchObject({ kind: 'continuable', source: 'explicit', appended: false })
    const explicitContinue = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'y', session: 'continue' }, exec(), h.session)
    expect(explicitContinue.session).toMatchObject({ kind: 'continuable', appended: true, threadId: explicitNew.session?.threadId })
    expect(planSession).toHaveBeenCalledTimes(1)
    const oneshot = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'z', session: 'oneshot' }, exec(), h.session)
    expect(oneshot.session?.kind).toBe('oneshot')
    expect(ValidateDelegateInput({ task_id: 'T', role: 'tan_wei', prompt: 'x', session: 'forever' }).errors.join()).toContain('session')
  })

  it('配置为全部一次性或全部连续会话', async () => {
    const oneshot = track(makeThreadHarness([], { config: getSwarmConfig({ agents: { session: 'oneshot' } }), plans: [{ result: { output: [], structured: VALID_OUTPUTS.zhu_jian, stopReason: 'completed' } }] }))
    expect((await oneshot.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: 'x' }, exec(), oneshot.session)).session).toMatchObject({ kind: 'oneshot', source: 'config' })
    const continuable = track(makeThreadHarness([{ text: json('bo_wen') }], { config: getSwarmConfig({ agents: { session: 'continuable' } }) }))
    expect((await continuable.delegator.delegate({ task_id: 'T-1', role: 'bo_wen', prompt: 'x' }, exec(), continuable.session)).session).toMatchObject({ kind: 'continuable', source: 'config' })
  })

  it('调用方取消时中止会话当前一轮，不重试，会话保留', async () => {
    const h = track(makeThreadHarness([{ silent: true }]))
    const controller = new AbortController()
    const pending = h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: 'x' }, { agent, signal: controller.signal }, h.session)
    await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    const record = await pending
    expect(record).toMatchObject({ status: 'failed', error: 'aborted' })
    expect(record.retries).toBeUndefined()
    expect(h.interrupt).toHaveBeenCalledWith(record.session?.threadId, { kind: 'ancestor', agent })
    expect(h.session.threads.list()[0]).toMatchObject({ busy: false, closed: false })
    // 被中止的一轮投给天枢的「子智能体已结束」通知会被滤掉，停止后天枢不会被再次唤醒
    expect(h.deps.hub.TakeConsumed(record.session?.threadId as string)).toBe(true)
  })

  it('一次性调用出错或交付不合格时重新启动；拒绝不重试', async () => {
    const h = track(makeHarness({ plans: [
      { result: { output: [], stopReason: 'error', diagnostic: 'overloaded' } },
      { result: { output: [], structured: { summary: 's' }, stopReason: 'completed' } },
      { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } },
      { result: { output: [{ type: 'text', text: '不做' }], stopReason: 'refusal' } }
    ] }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: '定位入口' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.retries?.map((r) => r.action)).toEqual(['restart', 'restart'])
    expect(h.deps.sleep).toHaveBeenCalledTimes(1)
    expect(String(h.requests[1]?.request.prompt[0]?.text)).toContain('第 1 次重试')
    const refused = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' }, exec(), h.session)
    expect(refused.status).toBe('failed')
    expect(refused.retries).toBeUndefined()
  })

  it('暂时没有可用路由时等待后重新检查', async () => {
    let calls = 0
    const h = track(makeHarness({ probe: async () => (++calls <= 4 ? { ok: false, reason: 'provider-not-configured' } : { ok: true, vision: true }) }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(record.retries?.[0]?.reason).toContain('no-usable-route')
  })
})

describe('连续会话的工具范围', () => {
  it('开放 web 与否不同的委派不追加到同一会话', async () => {
    const h = track(makeThreadHarness([{ text: json('bo_wen') }, { text: json('bo_wen') }, { text: json('bo_wen') }], { config: getSwarmConfig({ agents: { session: 'continuable' } }) }))
    const plain = await h.delegator.delegate({ task_id: 'T-1', role: 'bo_wen', prompt: 'a' }, exec(), h.session)
    const web = await h.delegator.delegate({ task_id: 'T-1', role: 'bo_wen', prompt: 'b', allow_web: true, session: 'continue' }, exec(), h.session)
    expect(web.session?.threadId).not.toBe(plain.session?.threadId)
    expect(h.delivered[1]?.toolFilter).toMatchObject({ allow: expect.arrayContaining(['web_search']) })
    const again = await h.delegator.delegate({ task_id: 'T-1', role: 'bo_wen', prompt: 'c', session: 'continue' }, exec(), h.session)
    expect(again.session).toMatchObject({ appended: true, threadId: plain.session?.threadId })
  })
})

describe('按模型家族组织提示与断网等待', () => {
  const oneshot = getSwarmConfig({ agents: { session: 'oneshot' } })

  it('Jev 判断工具只开放给有 jev 能力的角色', () => {
    expect(getToolFilter('yu_shi', [...VISIBLE, 'jev_check', 'jev_screen'], false)?.allow).toEqual(expect.arrayContaining(['jev_check', 'jev_screen']))
    expect(getToolFilter('zhu_jian', [...VISIBLE, 'jev_check'], false)?.allow).not.toContain('jev_check')
  })

  it('persona 与任务说明按实际启动的路由选择风格，并记入委派结果', async () => {
    const h = track(makeHarness({ config: oneshot, plans: [
      { result: { output: [], structured: VALID_OUTPUTS.yu_shi, stopReason: 'completed' } },
      { result: { output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' } },
      { startError: 'claude down', result: { output: [], stopReason: 'error' } },
      { result: { output: [], structured: VALID_OUTPUTS.zhu_jian, stopReason: 'completed' } }
    ] }))
    // 御史首选 GPT-6 Sol（Codex）
    const review = await h.delegator.delegate({ task_id: 'T-1', role: 'yu_shi', prompt: '审查' }, exec(), h.session)
    const reviewRequest = h.requests[0]?.request as SubagentStartRequestLike
    expect(reviewRequest.persona).toMatch(/^Role: /)
    expect((reviewRequest.prompt[0] as { text: string }).text).toMatch(/^GOAL:\n审查/)
    expect(review.promptStyle).toBe('gpt')
    // 探微首选 qwen：通用风格
    const explore = await h.delegator.delegate({ task_id: 'T-1', role: 'tan_wei', prompt: '找代码' }, exec(), h.session)
    expect((h.requests[1]?.request as SubagentStartRequestLike).persona).toContain('必须遵守：')
    expect(explore.promptStyle).toBe('generic')
    // 铸剑首选 Claude 启动失败：退到下一层（DeepSeek）时 persona 也换成该模型的风格
    const build = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: '实现' }, exec(), h.session)
    expect((h.requests[2]?.request as SubagentStartRequestLike).persona).toMatch(/^<role>/)
    expect((h.requests[3]?.request as SubagentStartRequestLike).persona).toContain('必须遵守：')
    expect(build).toMatchObject({ status: 'completed', promptStyle: 'generic' })
  })

  it('断网引起的失败：确认断网后等待网络恢复再重试，而不是按退避时间等待', async () => {
    const network = { isOnline: vi.fn(async () => false), waitOnline: vi.fn(async () => true) }
    const h = track(makeHarness({ config: oneshot, network, plans: [
      { result: { output: [], stopReason: 'error', diagnostic: 'DeepSeek Messages transport failed' } },
      { result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' } }
    ] }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: '跑测试' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(network.waitOnline).toHaveBeenCalledTimes(1)
    expect(h.deps.sleep).not.toHaveBeenCalled()
    expect(record.retries?.[0]?.reason).toContain('说明：网络连接失败')
  })

  it('联网时（单个供应商故障）或非网络类失败按退避时间等待', async () => {
    const network = { isOnline: vi.fn(async () => true), waitOnline: vi.fn(async () => true) }
    const h = track(makeHarness({ config: oneshot, network, plans: [
      { result: { output: [], stopReason: 'error', diagnostic: 'Request timed out.' } },
      { result: { output: [], stopReason: 'error', diagnostic: 'boom' } },
      { result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' } }
    ] }))
    await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: '跑测试' }, exec(), h.session)
    // 执行出错一律先探测；联网时按退避时间等待
    expect(network.isOnline).toHaveBeenCalledTimes(2)
    expect(network.waitOnline).not.toHaveBeenCalled()
    expect(h.deps.sleep).toHaveBeenCalledTimes(2)
  })
})

describe('连续会话的断网等待', () => {
  it('会话出错（没有诊断文本）时也先探测网络；断网则等待恢复而不是按退避时间重试', async () => {
    const network = { isOnline: vi.fn(async () => false), waitOnline: vi.fn(async () => true) }
    const h = track(makeThreadHarness([{ stopReason: 'error', text: '' }, { text: json('zhu_jian') }], { network }))
    const record = await h.delegator.delegate({ task_id: 'T-1', role: 'zhu_jian', prompt: '实现' }, exec(), h.session)
    expect(record.status).toBe('completed')
    expect(network.isOnline).toHaveBeenCalledTimes(1)
    expect(network.waitOnline).toHaveBeenCalledTimes(1)
    expect(h.deps.sleep).not.toHaveBeenCalled()
  })

  it('退避等待带上调用方的取消信号', async () => {
    const h = track(makeHarness({ config: getSwarmConfig({ agents: { session: 'oneshot' } }), plans: [
      { result: { output: [], stopReason: 'error', diagnostic: 'boom' } },
      { result: { output: [], structured: VALID_OUTPUTS.fu_he, stopReason: 'completed' } }
    ] }))
    const signal = new AbortController().signal
    await h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'x' }, { agent, signal }, h.session)
    expect(h.deps.sleep).toHaveBeenCalledWith(5000, signal)
  })
})

describe('trusted dispatch admission', () => {
  it.each(['api', 'codex'] as const)('rechecks after preflight for %s and never retries a refused publication', async (backend) => {
    const h = track(makeHarness({ providers: ['codex'] }))
    const task = structuredClone(h.session.store.getTask('T-1')!)
    const publish = vi.fn(async () => { throw new DispatchAdmissionError('contract changed after preflight') })
    await expect(h.delegator.delegate({ task_id: 'T-1', role: 'yu_shi', prompt: 'review', backend, session: 'oneshot' }, { ...exec(), admission: { task, dispatch: publish } }, h.session)).rejects.toThrow('contract changed')
    expect(publish).toHaveBeenCalledTimes(1)
    expect(h.requests).toHaveLength(0)
    expect(h.routeState.getRecoveryDiagnostics().logicalRequests).toBe(0)
  })
  it('gates continuable creation and does not fall back to a new session on refusal', async () => {
    const h = track(makeHarness())
    const startContinuable = vi.fn(async () => ({ childId: 'unused', messageId: 'unused' }))
    const sendMessage = vi.fn(async () => 'unused')
    h.deps.getSubagents = () => ({ ...h.subagents, startContinuable, sendMessage })
    const task = structuredClone(h.session.store.getTask('T-1')!)
    await expect(h.delegator.delegate({ task_id: 'T-1', role: 'fu_he', prompt: 'verify', backend: 'api', session: 'new' }, {
      ...exec(), admission: { task, dispatch: async () => { throw new DispatchAdmissionError('contract changed') } }
    }, h.session)).rejects.toThrow('contract changed')
    expect(startContinuable).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
    expect(h.session.threads.list().every(thread => !thread.busy)).toBe(true)
  })
})
