import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getRoleRoute, getSwarmConfig, type SwarmConfigInfo } from '../../src/config.js'
import { getLedgerEvents } from '../../src/evidence.js'
import type { LlmLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { ValidateAcceptInput, intSwarmService, type SwarmServiceDepsInfo } from '../../src/service.js'
import { getAcceptText, getDelegationText, getStatusText } from '../../src/tools.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const root = { id: 'root-1', session: { header: { agentPreset: 'tian-shu', cwd: process.cwd() } } }
const exec = () => ({ agent: root, signal: new AbortController().signal })

const jevBody = { answers: { math_task: { choice: 'research', confidence: 0.9 }, need_benchmark: { noul: 0.1 }, novelty: { score: 0.2, confidence: 0.9 } } }

const makeService = (options: { config?: Record<string, unknown>; env?: Partial<SwarmServiceDepsInfo> } = {}) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'swarm-service-'))
  dirs.push(dshHome)
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(jevBody), { status: 200 }))
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => (name === 'spawn' ? { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } } : undefined),
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      const structured = role === 'suan_heng' ? { ...(VALID_OUTPUTS.suan_heng as object), mode: request.persona?.includes('验算') ? 'verify' : 'research' } : VALID_OUTPUTS[role]
      return { id: `child-${role}-${subagents.start.mock.calls.length}`, result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), dispose: async () => undefined }
    })
  }
  // 旧门禁/路由用例聚焦原行为，独立规划审核由 planning-runtime 用例覆盖。
  const config: SwarmConfigInfo = getSwarmConfig({ planningReview: { enabled: false }, ...options.config })
  const fixtureLlm = { listProviders: () => [{ id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }, { id: 'deepseek-official' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'], reasoning: { efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((id) => ({ id, name: id })) } }) }
  const deps: SwarmServiceDepsInfo = {
    getConfig: () => config,
    getLlm: () => fixtureLlm,
    getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].map((name) => ({ name })), guard: () => () => undefined }),
    getAttachments: () => undefined,
    getCredentials: () => ({ resolve: async (ref: string) => (ref === 'TYPESAFE_API_KEY' ? { value: 'k' } : undefined) }),
    dshHome,
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => undefined,
    gitStatus: async () => undefined,
    now: (() => { let clock = 1000; return () => (clock += 10) })(),
    ...options.env
  }
  return { service: intSwarmService(deps), fetchMock, subagents, dshHome, config }
}

describe('默认预检的短网络元数据恢复', () => {
  const route = { provider: 'codex', model: 'gpt-6-astra' }
  const child = { id: 'metadata-child', session: { header: { parentSession: root.id } } }
  const networkFailures = [
    { code: 'TRANSPORT', message: 'fetch failed: ENETUNREACH' },
    { code: 'NETWORK', message: 'fetch failed: ENETUNREACH' },
    { code: 'TIMEOUT', message: 'metadata request timed out' },
    { code: 'NO_ADAPTER', message: 'transport failed: fetch failed' }
  ]
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000) })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

  // 不替换 probe、observer、健康态或准入等待，只控制外部元数据与时钟。
  const returning = async (resolveModelInfo: LlmLike['resolveModelInfo'], options: { providerConfigured?: boolean; requireVision?: boolean } = {}) => {
    const llm = { listProviders: () => options.providerConfigured === false ? [] : [{ id: route.provider }], resolveModelInfo }
    const made = makeService({ config: { persistence: { enabled: false }, jev: { enabled: false }, agents: { networkWaitMs: 70_000 } },
      env: { getLlm: () => llm, now: () => Date.now() } })
    const registry = made.service.routeState
    registry.AddChild(child.id, { chain: [route], role: 'zhu_jian', logicalRequestId: 'metadata-request', requireVision: options.requireVision })
    registry.BeginRequestStep(child.id, 1, 1)
    await registry.ObserveRouteFailure(route, { code: 'POOL_EXHAUSTED' }, made.config)
    vi.setSystemTime(registry.getRouteDueAt(route))
    return { ...made, registry }
  }

  it.each([
    ...networkFailures.map((failure) => ({ ...failure, providerRetryAfterMs: undefined, resetAfterMs: undefined, waitMs: 10_000 })),
    { ...networkFailures[0]!, providerRetryAfterMs: 500, resetAfterMs: undefined, waitMs: 10_000 },
    { ...networkFailures[0]!, providerRetryAfterMs: 60_000, resetAfterMs: undefined, waitMs: 60_000 },
    { ...networkFailures[0]!, providerRetryAfterMs: undefined, resetAfterMs: 45_000, waitMs: 45_000 }
  ])('$code 元数据失败后隔离等待 $waitMs 毫秒，恢复准入不早于冷却或供应商下限', async ({ code, message, providerRetryAfterMs, resetAfterMs, waitMs }) => {
    const calls: number[] = []
    const resolveModelInfo = vi.fn(async () => {
      calls.push(Date.now())
      if (calls.length === 1) throw Object.assign(new Error(message), { failure: { code, message, providerRetryAfterMs,
        ...(resetAfterMs === undefined ? {} : { resetAt: new Date(Date.now() + resetAfterMs).toISOString() }) } })
      return { inputModalities: ['text', 'image'] }
    })
    const { registry, config, fetchMock } = await returning(resolveModelInfo)
    const startedAt = Date.now()
    const result = registry.AdmitRequest(child, route, undefined, config).then((value) => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(waitMs - 1)
    expect(registry.getRecovery(child.id)).toMatchObject({ attempts: 0, admissionHolds: 1, holdWaitedMs: waitMs })
    expect(registry.getHealth()).toMatchObject([{ kind: 'network_transient', retryCount: 1, retryAt: startedAt + waitMs }])
    expect(registry.isRouteAvailable(route)).toBe(false)
    expect(calls).toEqual([startedAt])
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ value: route })
    expect(calls).toEqual([startedAt, startedAt + waitMs])
    expect(registry.getRecovery(child.id)).toMatchObject({ attempts: 1, admissionHolds: 1, holdWaitedMs: waitMs, attemptedRoutes: ['codex/gpt-6-astra'] })
    expect(registry.getHealth()).toMatchObject([{ kind: 'network_transient', halfOpenAgent: child.id }])
    expect(registry.getTerminal(child.id)).toBeUndefined()
    registry.MarkRequestSucceeded(child.id)
    await registry.WaitHealthReady(child.id)
    expect(registry.getHealth()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(networkFailures)('$code 持续元数据失败按 10/20/40 秒退避，并在准入等待预算耗尽后终止', async (failure) => {
    const calls: number[] = []
    const { registry, config, fetchMock } = await returning(async () => {
      calls.push(Date.now())
      throw Object.assign(new Error(failure.message), { failure })
    })
    const startedAt = Date.now()
    const result = registry.AdmitRequest(child, route, undefined, config).then((value) => ({ value }), (error: unknown) => ({ error }))
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ error: { message: 'route_chain_exhausted' } })
    expect(calls.map((at) => at - startedAt)).toEqual([0, 10_000, 30_000, 70_000])
    expect(Date.now() - startedAt).toBe(70_000)
    expect(registry.getRecovery(child.id)).toMatchObject({ attempts: 0, admissionHolds: 3, holdWaitedMs: 70_000, terminal: 'route_chain_exhausted' })
    expect(registry.getHealth()).toMatchObject([{ kind: 'network_transient', retryCount: 4, retryAt: startedAt + 130_000 }])
    expect(registry.getHealth().every((entry) => entry.halfOpenAgent === undefined)).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { name: '确定模型不可用', failure: { code: 'UNKNOWN_MODEL', message: 'model not found' }, providerConfigured: true, vision: true },
    { name: '供应商未配置', failure: undefined, providerConfigured: false, vision: true },
    { name: '明确能力不符', failure: { code: 'UNSUPPORTED_REASONING_EFFORT', message: 'unsupported reasoning effort' }, providerConfigured: true, vision: true },
    { name: '缺少视觉能力', failure: undefined, providerConfigured: true, vision: false },
    { name: '无结构化网络事实的错误文本', failure: { message: 'fetch failed: ENETUNREACH' }, providerConfigured: true, vision: true }
  ])('$name 仍拒绝准入，不将所有 model-unavailable 当作网络故障', async ({ failure, providerConfigured, vision }) => {
    const resolveModelInfo = vi.fn(async () => {
      if (failure !== undefined) throw Object.assign(new Error(failure.message), { failure })
      return { inputModalities: vision ? ['text', 'image'] : ['text'] }
    })
    const { registry, config } = await returning(resolveModelInfo, { providerConfigured, requireVision: true })
    const startedAt = Date.now()
    await expect(registry.AdmitRequest(child, route, undefined, config)).rejects.toThrow('route_chain_exhausted')
    expect(Date.now()).toBe(startedAt)
    expect(registry.getRecovery(child.id)).toMatchObject({ attempts: 0, terminal: 'route_chain_exhausted' })
    expect(registry.getRecovery(child.id)?.admissionHolds ?? 0).toBe(0)
    expect(registry.getHealth().every((entry) => entry.kind !== 'network_transient' && entry.halfOpenAgent === undefined)).toBe(true)
    expect(resolveModelInfo).toHaveBeenCalledTimes(providerConfigured ? 1 : 0)
  })

  it('真实 signal 在元数据查询期间 abort 后不再隔离、等待或准入，迟到的网络失败也不继续', async () => {
    let rejectMetadata!: (error: unknown) => void
    const resolveModelInfo = vi.fn(() => new Promise<Awaited<ReturnType<LlmLike['resolveModelInfo']>>>((_resolve, reject) => { rejectMetadata = reject }))
    const { registry, config } = await returning(resolveModelInfo)
    const before = registry.getHealthSnapshot()
    const controller = new AbortController()
    const result = registry.AdmitRequest(child, route, undefined, config, false, controller.signal)
      .then((value) => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(0)
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(await result).toMatchObject({ error: { code: 'RECOVERY_REQUIRED' } })
    rejectMetadata(Object.assign(new Error(networkFailures[0]!.message), { failure: networkFailures[0] }))
    await vi.runAllTimersAsync()
    expect(registry.getHealthSnapshot()).toEqual(before)
    expect(registry.getRecovery(child.id)?.attempts).toBe(0)
    expect(registry.getRecovery(child.id)?.admissionHolds ?? 0).toBe(0)
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  })

  it('真实 signal 在网络隔离等待期间 abort 后不再次查询元数据或准入', async () => {
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text', 'image'] }))
      .mockRejectedValueOnce(Object.assign(new Error(networkFailures[0]!.message), { failure: networkFailures[0] }))
    const { registry, config } = await returning(resolveModelInfo)
    const controller = new AbortController()
    const result = registry.AdmitRequest(child, route, undefined, config, false, controller.signal)
      .then((value) => ({ value }), (error: unknown) => ({ error }))
    await vi.advanceTimersByTimeAsync(0)
    expect(registry.getRecovery(child.id)).toMatchObject({ attempts: 0, admissionHolds: 1 })
    controller.abort()
    expect(await result).toMatchObject({ error: { code: 'RECOVERY_REQUIRED' } })
    await vi.runAllTimersAsync()
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
    expect(registry.getRecovery(child.id)?.attempts).toBe(0)
    expect(registry.getHealth()).toMatchObject([{ kind: 'network_transient' }])
    expect(registry.getHealth().every((entry) => entry.halfOpenAgent === undefined)).toBe(true)
  })
})

const cardInput = (flags: Record<string, boolean>, extra: Record<string, unknown> = {}) => ({ title: '任务', goal: '目标', acceptance: ['通过'], scope: ['src/a.ts'], flags, ...extra })

describe('天枢容灾升级', () => {
  const okProbe = { probe: async () => ({ ok: true as const, vision: true }) }
  const fullUpgradeChain = ['codex/gpt-6-astra', 'claude/claude-opus-5-5', 'codex/gpt-6-sol', 'qwen-token-plan-cn/deepseek-v4.1-flash', 'deepseek-official/deepseek-flash']

  it('任务卡命中触发条件时切到升级链，任务标记未完成后恢复', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } }, env: okProbe })
    const card = await service.AddTaskCard(cardInput({ changesCode: true, crossModuleArchitecture: true }), exec())
    expect(card.rootUpgrade).toMatchObject({ taskIds: ['T-1'], chain: fullUpgradeChain })
    expect(card.rootUpgrade?.reasons[0]).toContain('跨模块')
    expect(service.routeState.getRootUpgrade(root.id)?.map((route) => `${route.provider}/${route.model}`)).toEqual(fullUpgradeChain)
    expect(service.getStatus({}, exec()).rootUpgrade?.chain).toEqual(fullUpgradeChain)
    await service.AcceptTask({ task_id: 'T-1', decision: 'incomplete', summary: 's', stopReason: '用户中止' }, exec())
    expect(service.routeState.getRootUpgrade(root.id)).toBeUndefined()
    expect(service.getStatus({}, exec()).rootUpgrade).toBeNull()
  })

  it('无触发条件时不升级；显式要求可升级、可取消；升级模型不可用时如实报告', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } }, env: okProbe })
    expect((await service.AddTaskCard(cardInput({ changesCode: true }), exec())).rootUpgrade).toBeNull()
    const upgraded = await service.AddTaskCard(cardInput({ changesCode: true }, { task_id: 'T-1', upgrade: true }), exec())
    expect(upgraded.rootUpgrade?.reasons).toEqual(['T-1：天枢显式要求升级'])
    const cancelled = await service.AddTaskCard(cardInput({ changesCode: true }, { task_id: 'T-1', upgrade: false }), exec())
    expect(cancelled.rootUpgrade).toBeNull()
    const offline = makeService({ config: { jev: { enabled: false } }, env: { probe: async () => ({ ok: false, reason: 'all-models-unavailable' }) } })
    const unavailable = await offline.service.AddTaskCard(cardInput({ ambiguousRequirements: true }), exec())
    expect(unavailable.rootUpgrade).toMatchObject({ chain: [] })
    expect(offline.service.routeState.getRootUpgrade(root.id)).toBeUndefined()
  })

  it('新建会话后才切换到百工模式：按会话当前预设（agentPreset 投影）识别天枢', async () => {
    const switched = { id: 'root-2', session: { header: { agentPreset: 'expert-mode', cwd: process.cwd() } } }
    const projections = { stateOf: vi.fn((session: unknown, key: string) => (session === switched.session && key === 'agentPreset' ? 'tian-shu' : undefined)) }
    const { service } = makeService({ config: { jev: { enabled: false } }, env: { ...okProbe, getSessionProjections: () => projections } })
    const card = await service.AddTaskCard(cardInput({ ambiguousRequirements: true }), { agent: switched, signal: new AbortController().signal })
    expect(card.rootUpgrade?.chain).toEqual(fullUpgradeChain)
    expect(service.getRoleForAgent(switched)).toBe('tian_shu')
    const broken = makeService({ config: { jev: { enabled: false } }, env: { ...okProbe, getSessionProjections: () => ({ stateOf: () => { throw new Error('unknown session') } }) } })
    expect((await broken.service.AddTaskCard(cardInput({ ambiguousRequirements: true }), { agent: switched, signal: new AbortController().signal })).rootUpgrade).toBeNull()
  })

  it('用户在对话框换模型后，不再自动覆盖用户的选择', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } }, env: okProbe })
    await service.AddTaskCard(cardInput({ ambiguousRequirements: true }), exec())
    service.routeState.getRequestOverride(root, { provider: 'codex', model: 'gpt-6-sol' }, 'tian_shu')
    service.routeState.getRequestOverride(root, { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }, 'tian_shu')
    expect(service.getStatus({}, exec()).rootUpgrade).toMatchObject({ chain: [], cancelledByUser: true })
    const again = await service.AddTaskCard(cardInput({ ambiguousRequirements: true }, { task_id: 'T-1' }), exec())
    expect(again.rootUpgrade?.cancelledByUser).toBe(true)
    expect(service.routeState.getRootUpgrade(root.id)).toBeUndefined()
    const explicit = await service.AddTaskCard(cardInput({ ambiguousRequirements: true }, { task_id: 'T-1', upgrade: true }), exec())
    expect(explicit.rootUpgrade?.cancelledByUser).toBe(true)
    expect(service.routeState.getRootUpgrade(root.id)).toBeUndefined()
  })

  it.each([0, 180000])('相同任务卡及委派收尾刷新升级不越过恢复间隔 %i', async (rootRecoverMs) => {
    const preferred = { provider: 'qwen-token-plan-cn', model: 'preferred' }
    const backup = { provider: 'qwen-token-plan-cn', model: 'backup' }
    const { service, config } = makeService({ config: { jev: { enabled: false }, review: { enabled: false },
      agents: { rootRecoverMs, networkWaitMs: 0 },
      routes: { tian_shu: { chain: [backup], upgrade: { enabled: true, chain: [preferred, backup], triggers: ['ambiguous'] } } } },
      env: { ...okProbe, now: () => 1000 } })
    const input = cardInput({ ambiguousRequirements: true })
    const card = await service.AddTaskCard(input, exec())
    const registry = service.routeState
    registry.BeginRequestStep(root.id, 0, 0)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', config, true).model).toBe('preferred')
    const failed = { agent: root, provider: preferred.provider, signal: exec().signal, failure: { code: 'SERVER_ERROR', message: 'temporary fixture failure' } }
    expect(await registry.getErrorAction(failed, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(await registry.getErrorAction(failed, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, backup, 'tian_shu', config, true).model).toBe('backup')
    registry.MarkRequestSucceeded(root.id)
    expect(registry.getHealth()).toEqual([])
    const refreshed = await service.AddTaskCard({ ...input, task_id: card.task_id }, exec())
    expect(refreshed.cardRevision).toBe(card.cardRevision)
    registry.BeginRequestStep(root.id, 0, 1)
    await registry.PreparePreferredRecovery(root, backup, 'tian_shu', config)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', config, true).model).toBe('backup')
    registry.MarkRequestSucceeded(root.id)
    expect((await service.delegate({ task_id: card.task_id, role: 'miao_bi', prompt: '只读检查', backend: 'api', session: 'oneshot' }, exec())).status).toBe('completed')
    registry.BeginRequestStep(root.id, 0, 2)
    await registry.PreparePreferredRecovery(root, backup, 'tian_shu', config)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', config, true).model).toBe('backup')
  })

  it('关闭多个触发任务时逐个清理原因，最后一个关闭才撤销升级', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } }, env: okProbe })
    await service.AddTaskCard(cardInput({ ambiguousRequirements: true }), exec())
    await service.AddTaskCard(cardInput({ crossModuleArchitecture: true }), exec())
    await service.AcceptTask({ task_id: 'T-1', decision: 'incomplete', summary: '停止', stopReason: '停止' }, exec())
    expect(service.getStatus({}, exec()).rootUpgrade).toMatchObject({ taskIds: ['T-2'] })
    expect(service.getStatus({}, exec()).rootUpgrade?.reasons.every((reason) => reason.startsWith('T-2：'))).toBe(true)
    expect(service.routeState.getRootUpgrade(root.id)).toBeDefined()
    await service.AcceptTask({ task_id: 'T-2', decision: 'incomplete', summary: '停止', stopReason: '停止' }, exec())
    expect(service.getStatus({}, exec()).rootUpgrade).toBeNull()
    expect(service.routeState.getRootUpgrade(root.id)).toBeUndefined()
  })

  it('触发条件解除或在线关闭升级时撤销覆盖；显式升级在同任务中保留', async () => {
    const { service, config } = makeService({ config: { jev: { enabled: false } }, env: okProbe })
    await service.AddTaskCard(cardInput({ ambiguousRequirements: true }), exec())
    expect((await service.AddTaskCard(cardInput({}, { task_id: 'T-1' }), exec())).rootUpgrade).toBeNull()
    await service.AddTaskCard(cardInput({}, { task_id: 'T-1', upgrade: true }), exec())
    expect((await service.AddTaskCard(cardInput({}, { task_id: 'T-1' }), exec())).rootUpgrade?.chain).toEqual(fullUpgradeChain)
    config.routes.tian_shu = { ...getRoleRoute(config, 'tian_shu'), upgrade: { ...getRoleRoute(config, 'tian_shu').upgrade!, enabled: false } }
    expect(service.getStatus({}, exec()).rootUpgrade).toBeNull()
    expect(service.routeState.getRootUpgrade(root.id)).toBeUndefined()
  })
})

describe('AddTaskCard', () => {
  it('规则门禁 + Jev 追加门禁，写账本', async () => {
    const { service, fetchMock, dshHome } = makeService()
    const result = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(result.task_id).toBe('T-1')
    expect(result.requiredGates.map((g) => g.gate).sort()).toEqual(['G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_VERIFY'])
    expect(result.triage.source).toBe('rules+jev')
    expect(result.suggestedRoles.map((s) => s.role)).toContain('fu_he')
    expect(result.requiredGates[0]).toHaveProperty('roleName')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ledgerPath.startsWith(join(dshHome, 'share', 'dsh-agent-swarm', 'ledger'))).toBe(true)
    expect(getLedgerEvents(result.ledgerPath).map((e) => e.type)).toEqual(['jev/call', 'task/card'])
  })

  it('Jev 关闭时只用规则；无关任务不调用 Jev', async () => {
    const { service, fetchMock } = makeService({ config: { jev: { enabled: false } } })
    const disabled = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(disabled.triage).toMatchObject({ source: 'rules', fallbackReason: 'jev-disabled' })
    const copy = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(copy.triage.source).toBe('rules')
    expect(copy.task_id).toBe('T-2')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Jev 缺少密钥时走严格路径；Jev 调用不设会话额度（旧配置里的额度字段被忽略）', async () => {
    const { service } = makeService({ config: { jev: { apiKeyEnv: 'SWARM_TEST_UNSET_KEY' } }, env: { getCredentials: () => undefined } })
    const result = await service.AddTaskCard(cardInput({ changesCode: true, changesAlgorithm: true }), exec())
    expect(result.triage).toMatchObject({ source: 'rules+jev-fallback', fallbackReason: 'missing-api-key' })
    expect(result.requiredGates.find((g) => g.gate === 'G_MATH_VERIFY')?.source).toBe('jev-fallback')
    const unlimited = makeService({ config: { jev: { maxCallsPerSession: 0 } } })
    for (let i = 0; i < 25; i++) {
      const card = await unlimited.service.AddTaskCard(cardInput({ changesCode: true }), exec())
      expect(card.triage.source).toBe('rules+jev')
    }
    expect(unlimited.fetchMock).toHaveBeenCalledTimes(25)
  })

  it('环境变量兜底 Jev 密钥', async () => {
    process.env.SWARM_TEST_JEV_KEY = 'env-key'
    const { service, fetchMock } = makeService({ config: { jev: { apiKeyEnv: 'SWARM_TEST_JEV_KEY' } } })
    await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-key')
    delete process.env.SWARM_TEST_JEV_KEY
  })

  it('更新已有任务时门禁只增不减；未知任务与非法卡片报错', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    await service.AddTaskCard(cardInput({ hasVisualInput: true }), exec())
    const updated = await service.AddTaskCard(cardInput({ changesCode: true }, { task_id: 'T-1' }), exec())
    expect(updated.task_id).toBe('T-1')
    expect(updated.requiredGates.map((g) => g.gate).sort()).toEqual(['G_VERIFY', 'G_VISION'])
    await expect(service.AddTaskCard(cardInput({}, { task_id: 'T-9' }), exec())).rejects.toThrow('未知任务')
    await expect(service.AddTaskCard({ title: '' }, exec())).rejects.toThrow('title')
  })
})

describe('衡鉴复评', () => {
  const okProbe = { probe: async () => ({ ok: true as const, vision: true }) }
  /** 分诊题返回分诊答案，其余返回给定的复评答案 */
  const jevFetch = (score: number, supported: number) => vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const answers = 'math_task' in body.questions
      ? jevBody.answers
      : 'repeat' in body.questions
        ? { repeat: { type: 'noul', noul: 0.2 } }
        : { supported: { type: 'noul', noul: supported }, complete: { type: 'noul', noul: 0.8 }, reliability: { type: 'score', score, confidence: 0.8 } }
    return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 })
  })

  it('专家交付后复评：存疑写入未解决事项与账本，并在文本、状态与验收中显示', async () => {
    const fetch = jevFetch(0.6, 0.2)
    const { service } = makeService({ env: { fetch: fetch as unknown as typeof globalThis.fetch } })
    const { task_id, ledgerPath } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    const record = await service.delegate({ task_id, role: 'miao_bi', prompt: '写文案' }, exec())
    expect(record.assessment).toMatchObject({ status: 'ok', verdict: 'doubtful', model: 'jev-test' })
    expect(record.assessment?.reliability).toBeCloseTo(0.2, 12)
    expect(record.unresolved.join('')).toContain('衡鉴复评存疑')
    expect(getDelegationText(record)).toContain('衡鉴复评：存疑（可信度 0.20；证据支撑 0.20；完整性 0.80）')
    const reviewed = getLedgerEvents(ledgerPath).filter((e) => e.type === 'review/assessment')
    expect(reviewed).toHaveLength(1)
    const status = service.getStatus({ task_id }, exec())
    expect(status.usage.reviewCalls).toBe(1)
    expect(getStatusText(status)).toContain('衡鉴复评：存疑')
    const accepted = await service.AcceptTask({ task_id, decision: 'accept', summary: '完成', stopReason: '完成' }, exec())
    expect(accepted.status).toBe('accepted')
    expect(accepted.assessment?.verdict).toBe('doubtful')
    expect(getAcceptText(accepted)).toContain('衡鉴复评（验收结论）：存疑')
    expect(getLedgerEvents(ledgerPath).filter((e) => e.type === 'review/assessment')).toHaveLength(2)
    const bodies = fetch.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)) as { state: Record<string, unknown>; questions: Record<string, unknown> })
    const review = bodies.find((body) => 'role_check' in body.questions)
    expect(review?.state).toMatchObject({ role: '妙笔', request: '写文案' })
    expect(bodies.some((body) => 'repeat' in body.questions && body.state.new_request === '写文案')).toBe(true)
    expect(record.session).toMatchObject({ kind: 'oneshot', source: 'jev' })
  })

  it('复评存疑触发同角色与天枢的容灾升级', async () => {
    const { service } = makeService({ env: { ...okProbe, fetch: jevFetch(0.5, 0.2) as unknown as typeof globalThis.fetch } })
    const { task_id } = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const first = await service.delegate({ task_id, role: 'zhu_jian', prompt: '实现' }, exec())
    expect(first.upgrade).toBeUndefined()
    expect(first.assessment?.verdict).toBe('doubtful')
    const second = await service.delegate({ task_id, role: 'zhu_jian', prompt: '按复评意见重做' }, exec())
    expect(second.upgrade?.reasons.join('')).toContain(first.delegationId)
    expect(second.route).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5' })
    expect(service.getStatus({}, exec()).rootUpgrade?.reasons.join('')).toContain('衡鉴复评存疑')
  })

  it('复评可信时不写未解决；关闭时不影响委派；复评不设额度', async () => {
    const trusted = makeService({ env: { fetch: jevFetch(3, 0.9) as unknown as typeof globalThis.fetch } })
    const card = await trusted.service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    const ok = await trusted.service.delegate({ task_id: card.task_id, role: 'miao_bi', prompt: 'x' }, exec())
    expect(ok.assessment?.verdict).toBe('trusted')
    expect(ok.unresolved).toEqual([])
    const off = makeService({ config: { review: { enabled: false } } })
    const offCard = await off.service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect((await off.service.delegate({ task_id: offCard.task_id, role: 'miao_bi', prompt: 'x' }, exec())).assessment).toBeUndefined()
    expect(off.fetchMock.mock.calls.every((call) => !String((call as unknown[])[1] === undefined ? '' : ((call as unknown[])[1] as RequestInit).body).includes('role_check'))).toBe(true)
    const unlimited = makeService({ config: { review: { maxCallsPerSession: 0 } }, env: { fetch: jevFetch(3, 0.9) as unknown as typeof globalThis.fetch } })
    const unlimitedCard = await unlimited.service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    for (let i = 0; i < 3; i++) {
      const reviewed = await unlimited.service.delegate({ task_id: unlimitedCard.task_id, role: 'miao_bi', prompt: `x${i}` }, exec())
      expect(reviewed.assessment).toMatchObject({ status: 'ok', verdict: 'trusted' })
      expect(getDelegationText(reviewed)).not.toContain('未执行')
    }
    expect(unlimited.service.getStatus({}, exec()).usage.reviewCalls).toBe(3)
  })
})

describe('连续会话', () => {
  it('从子会话 turn/end 捕获 thinking 协议错误并交给连续会话恢复分类', async () => {
    let service: ReturnType<typeof makeService>['service'] | undefined
    let childId: string | undefined
    const subagents = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: {} }),
      start: vi.fn(async () => { throw new Error('should not use one-shot') }),
      startContinuable: vi.fn(async (spec: { childId: string }) => {
        childId = spec.childId
        return { childId: spec.childId, messageId: 'm' }
      }),
      sendMessage: vi.fn(async () => 'm')
    }
    const made = makeService({
      config: { jev: { enabled: false }, agents: { session: 'continuable', maxRetries: 0 } },
      env: { getSubagents: () => subagents as never }
    })
    service = made.service
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    const pending = service.delegate({ task_id, role: 'zhu_jian', prompt: '继续实现' }, exec())
    await vi.waitFor(() => expect(childId).toBeTypeOf('string'))
    service.OnJobEvent(childId!, {
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { message: 'The `content[].thinking` in the thinking mode must be passed back to the API.' } } }
    })
    service.OnSubagentEnd({ id: childId!, stopReason: 'error' })
    const record = await pending
    expect(record.status).toBe('failed')
    expect(record.error).toContain('content[].thinking')
    expect(record.unresolved.join('')).toContain('自动重建会话次数已用尽')
  })

  it('衡鉴判定同类时追加到已有会话；取走结果后滤掉宿主给天枢的重复结束通知；状态列出会话', async () => {
    let service: ReturnType<typeof makeService>['service'] | undefined
    const reply = (childId: string): void => {
      setTimeout(() => service?.OnSubagentEnd({ id: childId, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '```json\n' + JSON.stringify(VALID_OUTPUTS.fu_he) + '\n```' }] }), 5)
    }
    const subagents = {
      list: () => ['spawn'],
      getProvider: () => ({ capabilities: {} }),
      start: vi.fn(async () => { throw new Error('should not use one-shot') }),
      startContinuable: vi.fn(async (spec: { childId: string }) => { reply(spec.childId); return { childId: spec.childId, messageId: 'm' } }),
      sendMessage: vi.fn(async (_sender: unknown, childId: string) => { reply(childId); return 'm' })
    }
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
      const answers = 'repeat' in body.questions
        ? { repeat: { type: 'noul', noul: 0.9 }, ...('same_category' in body.questions ? { same_category: { type: 'noul', noul: 0.85 } } : {}) }
        : 'math_task' in body.questions ? jevBody.answers : { supported: { noul: 0.9 }, complete: { noul: 0.9 }, reliability: { score: 3, confidence: 0.9 } }
      return new Response(JSON.stringify({ answers }), { status: 200 })
    })
    const made = makeService({ env: { getSubagents: () => subagents as never, fetch: fetchMock as unknown as typeof globalThis.fetch } })
    service = made.service
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    const first = await service.delegate({ task_id, role: 'fu_he', prompt: '跑测试' }, exec())
    expect(first.session).toMatchObject({ kind: 'continuable', appended: false, source: 'jev' })
    const second = await service.delegate({ task_id, role: 'fu_he', prompt: '修复后重跑' }, exec())
    expect(second.session).toMatchObject({ kind: 'continuable', appended: true, round: 2, threadId: first.session?.threadId })
    expect(getDelegationText(second)).toContain('追加到连续会话')
    const threadId = first.session?.threadId as string
    const notice = { source: { kind: 'subagent-settled', senderSessionId: threadId } }
    const user = { source: { kind: 'user' } }
    expect(service.FilterPreStep({ kind: 'enter', messages: [notice, user] })).toEqual({ kind: 'enter', messages: [user] })
    expect(service.FilterPreStep({ kind: 'enter', messages: [notice] })).toEqual({ kind: 'enter', messages: [] })
    // 两轮只消费了两次：之后的通知（例如用户在界面里直接和该会话对话）原样保留
    expect(service.FilterPreStep({ kind: 'enter', messages: [notice] })).toEqual({ kind: 'enter', messages: [notice] })
    expect(service.FilterPreStep({ kind: 'reject' })).toEqual({ kind: 'reject' })
    const status = service.getStatus({}, exec())
    expect(status.threads).toMatchObject([{ threadId, roleName: '复核', rounds: 2, busy: false }])
    expect(status.usage.sessionCalls).toBe(2)
    expect(getStatusText(status)).toContain('连续会话：')
    expect(service.isManagedAgent({ id: threadId, session: { header: { parentSession: 'root-1' } } })).toBe(true)
  })
})

describe('委派、状态与验收', () => {
  it('缺少复核时验收被拦下，补齐后通过；状态显示门禁与委派', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const edit = await service.delegate({ task_id, role: 'ji_feng', prompt: '改文件' }, exec())
    expect(edit.status).toBe('completed')
    const blocked = await service.AcceptTask({ task_id, decision: 'accept', summary: '完成', stopReason: '完成' }, exec())
    expect(blocked.status).toBe('blocked')
    expect(blocked.missing.join('')).toContain('G_VERIFY')
    await service.delegate({ task_id, role: 'fu_he', prompt: '跑测试' }, exec())
    const status = service.getStatus({ task_id }, exec())
    expect(status.tasks[0]?.gates[0]).toMatchObject({ gate: 'G_VERIFY', satisfied: true })
    expect(status.tasks[0]?.delegations.map((d) => d.role)).toEqual(['ji_feng', 'fu_he'])
    expect(status.tasks[0]?.delegations[0]?.structured).toBeUndefined()
    expect(service.getStatus({ task_id, verbose: true }, exec()).tasks[0]?.delegations[0]?.structured).toBeDefined()
    const accepted = await service.AcceptTask({ task_id, decision: 'accept', summary: '完成', unresolved: [], stopReason: '门禁全部满足' }, exec())
    expect(accepted.status).toBe('accepted')
    expect(service.getStatus({}, exec()).tasks[0]?.acceptance?.status).toBe('accepted')
  })

  it('天枢在复核之后亲自改文件，已有验证失效，需重新复核', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    await service.delegate({ task_id, role: 'ji_feng', prompt: '改文件' }, exec())
    await service.delegate({ task_id, role: 'fu_he', prompt: '跑测试' }, exec())
    expect(service.getGuardReason({ name: 'edit', agent: root })).toBeUndefined()
    service.ObserveToolDispatch({ name: 'edit', agent: root })
    const stale = await service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())
    expect(stale.status).toBe('blocked')
    expect(stale.missing.join('')).toContain('G_VERIFY')
    await service.delegate({ task_id, role: 'fu_he', prompt: '重新跑测试' }, exec())
    expect((await service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())).status).toBe('accepted')
  })

  it('天枢在任务创建之前的编辑不影响之后的任务；子会话的写操作不算天枢编辑', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    service.getGuardReason({ name: 'write', agent: root })
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    await service.delegate({ task_id, role: 'miao_bi', prompt: '提供独立可核对的文案交付' }, exec())
    expect((await service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())).status).toBe('accepted')
    const child = { id: 'kid-2', session: { header: { agentPreset: 'tian-shu', parentSession: 'root-1' } } }
    service.getGuardReason({ name: 'write', agent: child })
    expect(service.getStatus({ task_id }, exec()).tasks[0]?.gates).toEqual([])
  })

  it('御史高危发现需要处理说明', async () => {
    const { service, subagents } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ crossModuleArchitecture: true }), exec())
    subagents.start.mockImplementationOnce(async () => ({
      id: 'review', dispose: async () => undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed', structured: { summary: 's', unresolved: [], findings: [{ severity: 'high', location: 'a', issue: 'i', suggestion: 's' }] } })
    }))
    const review = await service.delegate({ task_id, role: 'yu_shi', prompt: '审查' }, exec())
    const first = await service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())
    expect(first.missing.join('')).toContain(`${review.delegationId}#0`)
    const second = await service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's', findingResolutions: [{ delegationId: review.delegationId, index: 0, resolution: '已修复并补测试' }] }, exec())
    expect(second.status).toBe('accepted')
  })

  it('拒绝会累计修复轮次，超过上限后 blocked；incomplete 仅记录', async () => {
    const { service } = makeService({ config: { jev: { enabled: false }, budgets: { maxAutoFixRounds: 1 } } })
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(await service.AcceptTask({ task_id, decision: 'reject', summary: 's', stopReason: '需修复' }, exec())).toMatchObject({ status: 'recorded', roundsUsed: 1 })
    expect(await service.AcceptTask({ task_id, decision: 'reject', summary: 's', stopReason: '需修复' }, exec())).toMatchObject({ status: 'blocked', roundsUsed: 2 })
    expect((await service.AcceptTask({ task_id, decision: 'incomplete', summary: 's', stopReason: '缺少信息' }, exec())).status).toBe('recorded')
    await expect(service.AcceptTask({ task_id: 'T-9', decision: 'accept', summary: 's', stopReason: 's' }, exec())).rejects.toThrow('未知任务')
    expect(() => service.getStatus({ task_id: 'T-9' }, exec())).toThrow('未知任务')
  })

  it('ValidateAcceptInput', () => {
    expect(ValidateAcceptInput('x').errors).toEqual(['参数必须是对象'])
    const result = ValidateAcceptInput({ task_id: 1, decision: 'maybe', summary: 1, stopReason: '', unresolved: [1], findingResolutions: [{ delegationId: 'd' }] })
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
    expect(ValidateAcceptInput({ task_id: 'T', decision: 'accept', summary: 's', stopReason: 's' }).input).toMatchObject({ unresolved: [], findingResolutions: [] })
  })
})

describe('守卫与诊断', () => {
  it('只读角色调用写工具被拒绝；天枢与非 swarm 预设放行', async () => {
    const { service } = makeService()
    const reason = service.getGuardReason({ name: 'write', agent: { id: 'r', session: { header: { agentPreset: 'yu-shi' } } } })
    expect(reason).toContain('「御史」')
    expect(service.getGuardReason({ name: 'edit', agent: root })).toBeUndefined()
    expect(service.getGuardReason({ name: 'read', agent: { id: 'r', session: { header: { agentPreset: 'yu-shi' } } } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write', agent: { id: 'x', session: { header: { agentPreset: 'standard' } } } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write' })).toBeUndefined()
    service.routeState.AddChild('kid', { chain: [], role: 'fu_he' })
    expect(service.getGuardReason({ name: 'write', agent: { id: 'kid', session: { header: { agentPreset: 'tian-shu' } } } })).toContain('「复核」')
    expect(service.getRoleForAgent({ id: 'kid' })).toBe('fu_he')
  })

  it('百工管理的会话：百工预设的根会话与百工委派的子会话；其他插件的子会话不算', () => {
    const { service } = makeService()
    expect(service.isManagedAgent(root)).toBe(true)
    expect(service.isManagedAgent({ id: 'p', session: { header: { agentPreset: 'yu-shi' } } })).toBe(true)
    expect(service.isManagedAgent({ id: 's', session: { header: { agentPreset: 'standard' } } })).toBe(false)
    expect(service.isManagedAgent({ id: 'other', session: { header: { agentPreset: 'tian-shu', parentSession: 'root-1' } } })).toBe(false)
    service.routeState.AddChild('kid', { chain: [], role: 'fu_he' })
    expect(service.isManagedAgent({ id: 'kid', session: { header: { parentSession: 'root-1' } } })).toBe(true)
    expect(service.isManagedAgent(undefined)).toBe(false)
  })

  it('诊断列出缺失或能力不足的宿主服务', () => {
    const { service } = makeService({ env: { getLlm: () => undefined, getTools: () => undefined, getSubagents: () => ({ list: () => [], getProvider: () => undefined, start: async () => { throw new Error('x') } }) } })
    const diagnostics = service.getDiagnostics().join('\n')
    expect(diagnostics).toContain('ctx.llm')
    expect(diagnostics).toContain('ctx.tools')
    expect(diagnostics).toContain('spawn')
    expect(diagnostics).toContain('附件')
    expect(makeService().service.getDiagnostics().join('')).toContain('附件')
  })
})

it('验收复评绑定具体验收记录，同版本的新决定使旧异步复评失效', async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<void>(resolve => { release = resolve })
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { questions?: Record<string, unknown> }
    if (body.questions?.supported !== undefined) {
      entered(); await blocked
      return new Response(JSON.stringify({ answers: { supported: { noul: 1 }, complete: { noul: 1 }, reliability: { score: 4, confidence: 0.9 } } }), { status: 200 })
    }
    return new Response(JSON.stringify(jevBody), { status: 200 })
  })
  const { service } = makeService({ env: { fetch: fetchMock as typeof fetch, probe: async () => ({ ok: true, vision: true }) } })
  const task = await service.AddTaskCard(cardInput({}), exec())
  const previous = service.AcceptTask({ task_id: task.task_id, decision: 'accept', summary: 'old accepted conclusion', stopReason: 'complete' }, exec())
  void previous.catch(() => undefined)
  try {
    await started
    const current = await service.AcceptTask({ task_id: task.task_id, decision: 'reject', summary: 'new decision same task revision', stopReason: 'needs fix' }, exec())
    expect(current.status).toBe('recorded')
    release()
    await expect(previous).rejects.toThrow('验收记录在复评期间已更新')
    expect(service.getStatus({ task_id: task.task_id }, exec()).tasks[0]!.acceptance?.decision).toBe('reject')
  } finally { release(); await previous.catch(() => undefined) }
})

describe('任务卡流程草稿', () => {
  it('缺少规则要求的 G_MATH_VERIFY 时自动补入算衡·验算节点，而不是报 workflow 缺少必需门禁', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const workflow = { schemaVersion: 1, mode: 'standard', nodes: [
      { id: 'implement', label: '铸剑：B3-e 条件单', operation: 'delegate', role: 'zhu_jian', dependsOn: [], gates: [], outputContractVersion: '1' },
      { id: 'verify', label: '复核', operation: 'delegate', role: 'fu_he', dependsOn: ['implement'], gates: ['G_VERIFY'], outputContractVersion: '1' },
      { id: 'adversarial', label: '御史', operation: 'delegate', role: 'yu_shi', dependsOn: ['implement'], gates: ['G_REVIEW'], outputContractVersion: '1' },
      { id: 'checkpoint', label: '检查点', operation: 'checkpoint', dependsOn: ['verify', 'adversarial'], gates: [], outputContractVersion: '1' },
      { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
    ] }
    const card = await service.AddTaskCard(cardInput({ changesCode: true, touchesFinancialLogic: true, securitySensitive: true, crossModuleArchitecture: true }, { workflow }), exec())
    expect(card.requiredGates.map((gate) => gate.gate)).toContain('G_MATH_VERIFY')
    const math = card.flow?.definition.nodes.find((node) => node.gates.includes('G_MATH_VERIFY'))
    expect(math).toMatchObject({ role: 'suan_heng', mathMode: 'verify', dependsOn: ['implement'] })
    expect(card.flow?.mermaid).toContain(`n_${math!.id}`)
  })

  it('异常大的流程草稿在修补前按配置上限拒绝', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const nodes = Array.from({ length: 40 }, (_, index) => ({ id: `n${index}`, role: 'tan_wei', dependsOn: index === 0 ? [] : [`n${index - 1}`] }))
    await expect(service.AddTaskCard(cardInput({ changesCode: true }, { workflow: { nodes } }), exec())).rejects.toThrow('流程草稿超过配置的上限（32 个节点、64 条依赖边）')
  })
})
