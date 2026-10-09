import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MATH_CONFIG, MATH_GROUP_OPERATORS, MATH_LIMIT_MAXIMA, MAX_MATH_WORK_PER_TASK, MAX_MATH_CALLS_PER_TASK } from '../../src/math/config.js'

interface SlotInfo { provider: string; model: string; reasoningEffort: string }
interface FormSnapshot { status: string; writable: boolean; value: unknown; revision: number | undefined }

const route = (provider: string, model: string) => ({ provider, model })
const DATA = {
  namespace: 'swarm-core',
  math: { defaults: DEFAULT_MATH_CONFIG, groups: MATH_GROUP_OPERATORS, limitMaxima: MATH_LIMIT_MAXIMA, maxWorkPerTask: MAX_MATH_WORK_PER_TASK, maxCallsPerTask: MAX_MATH_CALLS_PER_TASK },
  agents: [
    {
      key: 'tian_shu', name: '天枢', title: '主持与验收', upgradeable: true,
      defaults: [route('q', 'a'), route('g', 'a'), route('d', 'a'), route('d', 'b')],
      upgradeDefault: { enabled: true, chain: [route('o', 'astra')], triggers: ['conflict'] }
    },
    { key: 'shu_ji', name: '枢机', title: '架构', upgradeable: true, defaults: [route('q', 'glm'), route('g', 'k'), route('d', 'a'), route('d', 'b')] },
    { key: 'yu_shi', name: '御史', title: '独立审查', upgradeable: false, defaults: [route('q', 'glm'), route('g', 'k'), route('q', 'a'), route('d', 'a')] }
  ],
  triggers: [{ id: 'conflict', label: '结论冲突' }, { id: 'ambiguous', label: '需求高歧义' }],
  policy: { defaults: { session: 'auto', repeatAbove: 0.5, sameCategoryAbove: 0.5, maxRetries: 3, retryBackoffMs: 5000, promptStyle: 'auto', networkWaitMs: 600000, rootRecoverMs: 600000, modelCallDisplay: 'every' } }
}

/** 以 CommonJS 方式执行设置页源码：注入测试数据与最小 React 桩 */
const loadPage = (): any => {
  const source = readFileSync(join(__dirname, '../../client/settings-page.js'), 'utf8')
    .replace('const DATA = __SWARM_DATA__', `const DATA = ${JSON.stringify(DATA)}`)
  const module = { exports: {} as any }
  const react = { createElement: () => null, useSyncExternalStore: () => undefined, useEffect: () => undefined, Fragment: 'fragment' }
  new Function('require', 'module', 'exports', source)((id: string) => {
    if (id === 'react') return react
    throw new Error(`unexpected require ${id}`)
  }, module, module.exports)
  return module.exports
}

const page = loadPage()
const { getSlots, getSlotErrors, buildRoutes, getOverride, getUpgradeView, getPolicy, getPolicyErrors, buildPolicy, toPolicyDraft, SwarmAgentsController, JevKeyController, getResourceAccessMode, getApprovals, buildApprovals } = page.__test__

const slot = (provider: string, model: string, reasoningEffort = ''): SlotInfo => ({ provider, model, reasoningEffort })

const createForm = (value: unknown, options: { writable?: boolean; accept?: boolean } = {}) => {
  let snapshot: FormSnapshot = { status: 'ready', writable: options.writable ?? true, value, revision: 1 }
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: vi.fn(async (ops: Array<{ op: string; path: string[]; value: unknown }>, _revision?: number) => {
      if (options.accept === false) return false
      const next = { ...(snapshot.value as Record<string, unknown>) }
      for (const op of ops) if (op.op === 'set') next[op.path[0] as string] = op.value
      snapshot = { ...snapshot, value: next, revision: (snapshot.revision ?? 0) + 1 }
      listeners.forEach((listener) => listener())
      return true
    }),
    replace: (next: Partial<FormSnapshot>) => {
      snapshot = { ...snapshot, ...next }
      listeners.forEach((listener) => listener())
    }
  }
}

const CATALOG = {
  ok: true,
  value: {
    groups: [
      { id: 'q', name: 'Qwen', models: [{ id: 'a', name: 'A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }, { id: 'glm', name: 'GLM' }] },
      { id: 'g', name: 'Go', models: [{ id: 'a', name: 'A' }, { id: 'k', name: 'K' }] },
      { id: 'o', name: 'Codex', models: [{ id: 'astra', name: 'Astra' }, { id: 'sol', name: 'Sol' }] }
    ],
    failures: []
  }
}

const createCtx = (form: ReturnType<typeof createForm>) => ({
  configForms: { get: vi.fn(() => form) },
  remote: { session: { modelCatalog: vi.fn(async () => CATALOG) } }
})

const rowOf = (controller: any, key: string) => controller.getSnapshot().rows.find((row: { key: string }) => row.key === key)
const savedRoutes = (form: ReturnType<typeof createForm>) => form.mutate.mock.calls.at(-1)![0][0].value

describe('settings page pure helpers', () => {
  it('链原样变成槽位，空链给出一个空槽位', () => {
    expect(getSlots([route('q', 'a')])).toEqual([slot('q', 'a')])
    expect(getSlots(DATA.agents[0]!.defaults)).toHaveLength(4)
    expect(getSlots(undefined)).toEqual([slot('', '')])
  })

  it('常规链或升级任一存在即视为覆盖', () => {
    expect(getOverride({ yu_shi: { chain: [] } }, 'yu_shi')).toBeUndefined()
    expect(getOverride({ yu_shi: { chain: [route('q', 'a')] } }, 'yu_shi')).toBeDefined()
    expect(getOverride({ shu_ji: { chain: [], upgrade: { enabled: false } } }, 'shu_ji')).toBeDefined()
    expect(getOverride(undefined, 'yu_shi')).toBeUndefined()
  })

  it('升级视图：默认、未配置、已保存覆盖；不可升级的角色没有', () => {
    const [tian, shu, yu] = DATA.agents
    expect(getUpgradeView(tian, undefined)).toEqual({ enabled: true, slots: [slot('o', 'astra')], triggers: ['conflict'] })
    expect(getUpgradeView(shu, undefined)).toEqual({ enabled: false, slots: [slot('', '')], triggers: [] })
    expect(getUpgradeView(tian, { upgrade: { enabled: false, chain: [route('o', 'sol')], triggers: ['ambiguous', 'bogus'] } }))
      .toEqual({ enabled: false, slots: [slot('o', 'sol')], triggers: ['ambiguous'] })
    expect(getUpgradeView(yu, undefined)).toBeUndefined()
  })

  it('校验：主模型/首个升级模型必填，空的非首层要选上或删除，未选模型、重复都报错', () => {
    expect(getSlotErrors([slot('', ''), slot('', '')])).toEqual(['errPrimary', 'errEmptyLayer'])
    expect(getSlotErrors([slot('', '')], 'errUpgradePrimary')).toEqual(['errUpgradePrimary'])
    expect(getSlotErrors([slot('q', '')])[0]).toBe('errModel')
    expect(getSlotErrors([slot('q', 'a'), slot('q', 'a')])[1]).toBe('errDuplicate')
    expect(getSlotErrors([slot('q', 'a'), slot('g', 'a'), slot('g', 'k'), slot('d', 'a'), slot('d', 'b')])).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('生成 routes：与默认相同的部分不写入，全等于默认时删除覆盖；保留原生升级通道；无效草稿拒绝', () => {
    const routes = { tian_shu: { chain: [route('g', 'a')], escalation: 'codex' }, shu_ji: { chain: [route('q', 'glm')] } }
    const drafts = new Map<string, unknown>([
      ['tian_shu', { reset: false, slots: getSlots(DATA.agents[0]!.defaults), upgrade: { enabled: false, slots: [slot('o', 'astra')], triggers: ['conflict'] } }],
      ['shu_ji', { reset: false, slots: getSlots(DATA.agents[1]!.defaults), upgrade: { enabled: false, slots: [slot('', '')], triggers: [] } }]
    ])
    expect(buildRoutes(routes, drafts)).toEqual({
      ok: true,
      routes: { tian_shu: { chain: [], escalation: 'codex', upgrade: { enabled: false, chain: [route('o', 'astra')], triggers: ['conflict'] } } }
    })
    const bad = new Map([['shu_ji', { reset: false, slots: [slot('', '')], upgrade: undefined }]])
    expect(buildRoutes(routes, bad)).toEqual({ ok: false, keys: ['shu_ji'] })
    const badUpgrade = new Map([['shu_ji', { reset: false, slots: [slot('q', 'glm')], upgrade: { enabled: true, slots: [slot('', '')], triggers: [] } }]])
    expect(buildRoutes(routes, badUpgrade)).toEqual({ ok: false, keys: ['shu_ji'] })
  })
})

describe('SwarmAgentsController', () => {
  it('工具审批默认inherit，三态/作用域保存往返保留其它配置及未知审批字段', async () => {
    expect(getApprovals(undefined)).toEqual({ mode: 'inherit', scope: ['write', 'shell', 'external_mcp', 'jev'] })
    const value = { routes: {}, jev: { enabled: true, apiKeyEnv: 'CUSTOM_KEY' }, workflow: { mode: 'enforced' }, approvals: { mode: 'inherit', scope: ['shell', 'jev'], futurePolicy: { version: 2 } } }
    const form = createForm(value)
    const controller = new SwarmAgentsController(createCtx(form))
    controller.setApprovals({ mode: 'ask' })
    controller.toggleApprovalScope('write')
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: false, approvals: { dirty: true, value: { mode: 'ask', scope: ['shell', 'jev', 'write'] } } })
    await controller.save()
    expect(form.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['approvals'], value: { mode: 'ask', scope: ['write', 'shell', 'jev'], futurePolicy: { version: 2 } } }], 1)
    expect(form.getSnapshot().value).toEqual({ ...value, approvals: { mode: 'ask', scope: ['write', 'shell', 'jev'], futurePolicy: { version: 2 } } })
    controller.setApprovals({ mode: 'deny', scope: [] })
    expect(controller.getSnapshot().invalid).toBe(false)
    controller.discard()
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, approvals: { value: { mode: 'ask' } } })
    controller.setApprovals({ mode: 'invalid' })
    expect(controller.getSnapshot().invalid).toBe(true)
    await controller.save()
    expect(form.mutate).toHaveBeenCalledTimes(1)
    expect(buildApprovals({ mode: 'ask', scope: ['not-a-scope'] }, {})).toBeUndefined()
  })

  it('审批草稿遵守现有revision冲突与只读保护，恢复成已保存配置时清理草稿', async () => {
    const form = createForm({ approvals: { mode: 'deny', scope: ['shell'] } })
    const controller = new SwarmAgentsController(createCtx(form))
    controller.setApprovals({ mode: 'ask' })
    controller.setApprovals({ mode: 'deny' })
    expect(controller.getSnapshot().dirty).toBe(false)
    controller.setApprovals({ mode: 'ask' })
    form.replace({ revision: 2 })
    await controller.save()
    expect(controller.getSnapshot().conflicted).toBe(true)
    expect(form.mutate).not.toHaveBeenCalled()
    const readOnly = new SwarmAgentsController(createCtx(createForm({}, { writable: false })))
    readOnly.setApprovals({ mode: 'deny' })
    expect(readOnly.getSnapshot().dirty).toBe(false)
  })
  it('保存常规与升级链往返保留不由页面编辑的额度域/资源 policy', async () => {
    const policy = { accessMode: 'subscription', quotaDomainId: 'account:shared', quotaScope: 'account', poolId: 'pool:known', capabilities: { tools: true }, futureMetadata: { version: 1 } }
    const upgradePolicy = { accessMode: 'metered_api', quotaDomainId: 'account:paid', quotaScope: 'account' }
    const form = createForm({ routes: { tian_shu: { chain: [{ provider: 'q', model: 'a', policy }], upgrade: { enabled: true, chain: [{ provider: 'o', model: 'astra', policy: upgradePolicy }], triggers: ['conflict'] } } } })
    const controller = new SwarmAgentsController(createCtx(form))
    await controller.loadCatalog()
    expect(rowOf(controller, 'tian_shu').slots[0].policy).toEqual(policy)
    controller.setSlot('tian_shu', 0, { reasoningEffort: 'high' })
    controller.setSlot('tian_shu', 0, { reasoningEffort: 'high' }, 'upgrade')
    await controller.save()
    const saved = (savedRoutes(form) as { tian_shu: { chain: Array<Record<string, unknown>>; upgrade: { chain: Array<{ policy: unknown }> } } }).tian_shu
    expect(saved.chain[0]).toEqual({ provider: 'q', model: 'a', reasoningEffort: 'high', policy })
    expect(saved.upgrade.chain[0].policy).toEqual(upgradePolicy)
    expect(getResourceAccessMode(rowOf(controller, 'tian_shu').slots[0])).toBe('subscription')
    expect(getResourceAccessMode(rowOf(controller, 'tian_shu').upgrade.slots[0])).toBe('metered_api')
    expect(policy.capabilities.tools).toBe(true)
  })

  it('policy覆盖不能被与默认模型相同而删除，损坏超限policy阻止保存', () => {
    const agent = DATA.agents[0]!
    const chain = agent.defaults.map((item, index) => index === 0 ? { ...item, policy: { accessMode: 'unknown', quotaDomainId: 'account:explicit' } } : item)
    const built = buildRoutes({ tian_shu: { chain } }, new Map([['tian_shu', { reset: false, slots: getSlots(chain), upgrade: getUpgradeView(agent, undefined) }]]))
    expect(built.routes.tian_shu.chain[0].policy.quotaDomainId).toBe('account:explicit')
    const oversized = getSlots([{ ...agent.defaults[0], policy: { quotaDomainId: 'x'.repeat(1025) } }])
    expect(getSlotErrors(oversized)).toEqual(['errRoutePolicy'])
  })
  it('默认显示内置的 4 层；可增删层并保存为自定义链', async () => {
    const form = createForm({ routes: {} })
    const controller = new SwarmAgentsController(createCtx(form))
    await controller.loadCatalog()
    expect(rowOf(controller, 'yu_shi')).toMatchObject({ custom: false, dirty: false })
    expect(rowOf(controller, 'yu_shi').slots).toHaveLength(4)

    controller.addLayer('yu_shi')
    expect(rowOf(controller, 'yu_shi').slots).toHaveLength(5)
    expect(rowOf(controller, 'yu_shi').errors.chain[4]).toBe('errEmptyLayer')
    expect(controller.getSnapshot().invalid).toBe(true)
    controller.setSlot('yu_shi', 4, { provider: 'o' })
    controller.setSlot('yu_shi', 4, { model: 'sol' })
    controller.removeLayer('yu_shi', 0)
    expect(rowOf(controller, 'yu_shi').slots).toHaveLength(5)
    controller.removeLayer('yu_shi', 2)
    controller.setSlot('yu_shi', 0, { provider: 'g' })
    expect(rowOf(controller, 'yu_shi').slots[0]).toEqual(slot('g', ''))
    controller.setSlot('yu_shi', 0, { model: 'a' })
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: false })

    await controller.save()
    expect(form.mutate).toHaveBeenCalledWith([{
      op: 'set',
      path: ['routes'],
      value: { yu_shi: { chain: [route('g', 'a'), route('g', 'k'), route('d', 'a'), route('o', 'sol')] } }
    }], 1)
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, notice: 'saved' })
    expect(rowOf(controller, 'yu_shi')).toMatchObject({ custom: true })
    expect(rowOf(controller, 'yu_shi').upgrade).toBeUndefined()
  })

  it('容灾升级：启用、添加升级模型、勾选触发条件后只写入升级部分', async () => {
    const form = createForm({ routes: {} })
    const controller = new SwarmAgentsController(createCtx(form))
    await controller.loadCatalog()
    expect(rowOf(controller, 'shu_ji').upgrade).toEqual({ enabled: false, slots: [slot('', '')], triggers: [] })
    controller.setUpgradeEnabled('shu_ji', true)
    expect(rowOf(controller, 'shu_ji').errors.upgrade).toEqual(['errUpgradePrimary'])
    controller.setSlot('shu_ji', 0, { provider: 'o' }, 'upgrade')
    controller.setSlot('shu_ji', 0, { model: 'astra' }, 'upgrade')
    controller.addLayer('shu_ji', 'upgrade')
    controller.setSlot('shu_ji', 1, { provider: 'q' }, 'upgrade')
    controller.setSlot('shu_ji', 1, { model: 'a' }, 'upgrade')
    controller.toggleTrigger('shu_ji', 'ambiguous')
    controller.toggleTrigger('shu_ji', 'conflict')
    controller.toggleTrigger('shu_ji', 'ambiguous')
    await controller.save()
    expect(savedRoutes(form)).toEqual({ shu_ji: { chain: [], upgrade: { enabled: true, chain: [route('o', 'astra'), route('q', 'a')], triggers: ['conflict'] } } })
    expect(rowOf(controller, 'shu_ji')).toMatchObject({ custom: true, dirty: false })
    expect(rowOf(controller, 'shu_ji').upgrade.slots).toHaveLength(2)
  })

  it('停用默认升级并恢复默认；改回与已保存一致时草稿自动消失', async () => {
    const form = createForm({ routes: { tian_shu: { chain: [route('q', 'a')] } } })
    const controller = new SwarmAgentsController(createCtx(form))
    controller.setUpgradeEnabled('tian_shu', false)
    expect(rowOf(controller, 'tian_shu').dirty).toBe(true)
    controller.setUpgradeEnabled('tian_shu', true)
    expect(rowOf(controller, 'tian_shu').dirty).toBe(false)
    controller.resetAgent('tian_shu')
    expect(rowOf(controller, 'tian_shu')).toMatchObject({ custom: false, dirty: true })
    expect(rowOf(controller, 'tian_shu').slots).toHaveLength(4)
    await controller.save()
    expect(savedRoutes(form)).toEqual({})
  })

  it('保存被拒或版本冲突时保留草稿', async () => {
    const refused = createForm({ routes: {} }, { accept: false })
    const controller = new SwarmAgentsController(createCtx(refused))
    controller.setSlot('yu_shi', 0, { provider: 'o' })
    controller.setSlot('yu_shi', 0, { model: 'sol' })
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, notice: 'saveFailed' })

    const moving = createForm({ routes: {} })
    const other = new SwarmAgentsController(createCtx(moving))
    other.setSlot('yu_shi', 0, { provider: 'q' })
    other.setSlot('yu_shi', 0, { model: 'a' })
    moving.replace({ revision: 7 })
    expect(other.getSnapshot().conflicted).toBe(true)
    await other.save()
    expect(moving.mutate).not.toHaveBeenCalled()
    other.discard()
    expect(other.getSnapshot()).toMatchObject({ dirty: false, conflicted: false })
  })

  it('只读部署忽略编辑；目录加载失败时记录状态', async () => {
    const form = createForm({ routes: {} }, { writable: false })
    const ctx = createCtx(form)
    ctx.remote.session.modelCatalog.mockResolvedValueOnce({ ok: false } as never)
    const controller = new SwarmAgentsController(ctx)
    controller.addLayer('yu_shi')
    controller.setUpgradeEnabled('shu_ji', true)
    expect(controller.getSnapshot().dirty).toBe(false)
    await controller.loadCatalog()
    expect(controller.getSnapshot().catalog.status).toBe('error')
  })
})

describe('专家会话与重试策略', () => {
  it('读取已保存值时按类型补默认；校验范围；只写与默认不同的字段', () => {
    const defaults = { session: 'auto', repeatAbove: 0.5, sameCategoryAbove: 0.5, maxRetries: 3, retryBackoffMs: 5000, promptStyle: 'auto', networkWaitMs: 600000, rootRecoverMs: 600000, modelCallDisplay: 'every' }
    expect(getPolicy(undefined)).toEqual(defaults)
    expect(getPolicy({ session: 'weird', maxRetries: '5', repeatAbove: 0.7, promptStyle: 'odd' })).toMatchObject({ session: 'auto', maxRetries: 3, repeatAbove: 0.7, promptStyle: 'auto' })
    const draft = toPolicyDraft(getPolicy(undefined))
    expect(draft).toMatchObject({ retryBackoffSec: 5, networkWaitMin: 10, rootRecoverMin: 10, promptStyle: 'auto' })
    expect(getPolicyErrors({ ...draft, repeatAbove: '1.2', sameCategoryAbove: '', maxRetries: 2.5, retryBackoffSec: 700, networkWaitMin: 121, rootRecoverMin: -1 }))
      .toEqual({ repeatAbove: 'errRatio', sameCategoryAbove: 'errRatio', maxRetries: 'errRetries', retryBackoffSec: 'errBackoff', networkWaitMin: 'errNetworkWait', rootRecoverMin: 'errRootRecover' })
    expect(buildPolicy({ ...draft, repeatAbove: '0.5', maxRetries: '3', retryBackoffSec: '5' })).toEqual({})
    expect(buildPolicy({ ...draft, session: 'continuable', sameCategoryAbove: '0.6', maxRetries: '5', retryBackoffSec: '2.5', promptStyle: 'gpt', networkWaitMin: '0', rootRecoverMin: '30', modelCallDisplay: 'turn' }))
      .toEqual({ session: 'continuable', sameCategoryAbove: 0.6, maxRetries: 5, retryBackoffMs: 2500, promptStyle: 'gpt', networkWaitMs: 0, rootRecoverMs: 1800000, modelCallDisplay: 'turn' })
    expect(getPolicy({ modelCallDisplay: 'odd' }).modelCallDisplay).toBe('every')
    expect(buildPolicy({ ...draft, repeatAbove: 'x' })).toBeUndefined()
    // 页面不管理的已保存字段原样保留
    expect(buildPolicy({ ...draft, maxRetries: 4 }, { networkProbeUrls: ['https://example.com'], maxRetries: 1 }))
      .toEqual({ networkProbeUrls: ['https://example.com'], maxRetries: 4 })
  })

  it('保存策略时只保留组合层与用户层写过的字段，不把 schema 默认值固化进用户配置', async () => {
    const defaults = { session: 'auto', maxRetries: 3, networkProbeUrls: ['https://a', 'https://b'] }
    const form = createForm({ routes: {}, agents: { ...defaults, custom: 'x' } })
    form.replace({ base: { agents: { custom: 'x' } }, user: { agents: { maxRetries: 3 } } } as never)
    const controller = new SwarmAgentsController(createCtx(form))
    controller.setPolicy({ maxRetries: '4' })
    await controller.save()
    const ops = form.mutate.mock.calls.at(-1)![0]
    expect(ops).toEqual([{ op: 'set', path: ['agents'], value: { custom: 'x', maxRetries: 4 } }])
  })

  it('修改策略后保存到 agents；与路由修改一起保存；改回原值草稿消失；恢复默认', async () => {
    const form = createForm({ routes: {}, agents: { maxRetries: 1 } })
    const controller = new SwarmAgentsController(createCtx(form))
    expect(controller.getSnapshot().policy).toMatchObject({ custom: true, dirty: false, value: { maxRetries: 1, retryBackoffSec: 5 } })
    controller.setPolicy({ maxRetries: '1' })
    expect(controller.getSnapshot().dirty).toBe(false)
    controller.setPolicy({ session: 'oneshot', maxRetries: '4', retryBackoffSec: '10' })
    controller.setSlot('yu_shi', 0, { provider: 'o' })
    controller.setSlot('yu_shi', 0, { model: 'sol' })
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: false, policy: { dirty: true } })
    await controller.save()
    const ops = form.mutate.mock.calls.at(-1)![0]
    expect(ops.map((op: { path: string[] }) => op.path[0])).toEqual(['routes', 'agents'])
    expect(ops[1].value).toEqual({ session: 'oneshot', maxRetries: 4, retryBackoffMs: 10000 })
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, notice: 'saved', policy: { custom: true, value: { session: 'oneshot' } } })
    controller.setPolicy({ repeatAbove: '2' })
    expect(controller.getSnapshot()).toMatchObject({ invalid: true, policy: { errors: { repeatAbove: 'errRatio' } } })
    await controller.save()
    expect(form.mutate).toHaveBeenCalledTimes(1)
    controller.resetPolicy()
    await controller.save()
    expect(form.mutate.mock.calls.at(-1)![0]).toEqual([{ op: 'set', path: ['agents'], value: {} }])
    expect(controller.getSnapshot().policy).toMatchObject({ custom: false, dirty: false })
  })

  it('只读部署忽略策略修改；放弃修改同时丢弃策略草稿', () => {
    const readOnly = new SwarmAgentsController(createCtx(createForm({ routes: {} }, { writable: false })))
    readOnly.setPolicy({ maxRetries: '5' })
    expect(readOnly.getSnapshot().dirty).toBe(false)
    const controller = new SwarmAgentsController(createCtx(createForm({ routes: {} })))
    controller.setPolicy({ maxRetries: '5' })
    controller.discard()
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, policy: { dirty: false, value: { maxRetries: 3 } } })
  })
})

describe('client entry', () => {
  it('registers the settings section only while swarm-core is served', () => {
    const form = createForm({ routes: {} })
    const registered: unknown[] = []
    const ctx = {
      ...createCtx(form),
      effect: (fn: () => unknown) => { fn() },
      on: vi.fn(() => () => undefined),
      locale: { register: vi.fn(() => () => undefined), bind: () => (key: string) => key },
      remote: { ...createCtx(form).remote, $on: vi.fn(() => () => undefined) },
      slots: {
        inject: (_name: string, fn: () => unknown) => fn(),
        register: (options: unknown) => { registered.push(options); return () => undefined }
      },
      configForms: {
        get: () => form,
        whileServed: (namespaces: string[], register: () => () => void) => {
          expect(namespaces).toEqual(['swarm-core'])
          return register()
        }
      }
    }
    page.apply(ctx)
    expect(page.inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.session', 'remote.credentials', 'configForms'])
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ name: 'settings.section', id: 'swarm-agents' })
    expect((registered[0] as { label: () => string }).label()).toBe('nav')
  })
})

describe('mathematical operator settings', () => {
  it('saves real backend group/operator/mode/limit fields atomically with unknown top-level fields retained', async () => {
    const form = createForm({ routes: {}, math: { futureSetting: { retained: true }, enableExtended: true, maxCallsPerTask: 0 } })
    const controller = new SwarmAgentsController(createCtx(form))
    expect(controller.getSnapshot().math.value.groups).toMatchObject({ matrix: true, polynomial: true })
    controller.setMath({ groups: { matrix: false }, operators: { add: false }, numericModes: { bigint: false }, limits: { maxArrayElements: '128' }, maxWorkUnitsPerTask: '2000' })
    controller.setApprovals({ mode: 'deny' })
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: false, math: { dirty: true } })
    await controller.save()
    const ops = form.mutate.mock.calls.at(-1)![0]
    expect(ops.map((op: { path: string[] }) => op.path[0])).toEqual(['approvals', 'math'])
    expect(ops[1]!.value).toMatchObject({ enableExtended: false, maxCallsPerTask: 0, maxWorkUnitsPerTask: 2000, futureSetting: { retained: true }, groups: { matrix: false, polynomial: true }, operators: { add: false }, numericModes: { bigint: false }, limits: { maxArrayElements: 128 } })
    expect(form.mutate.mock.calls.at(-1)![1]).toBe(1)
    expect(controller.getSnapshot().dirty).toBe(false)
  })

  it('rejects unsafe numeric limits, protects CAS and resets authorization without losing unrelated settings', async () => {
    const form = createForm({ routes: {}, math: { futureSetting: 'keep', operators: { unknown: true } } })
    const controller = new SwarmAgentsController(createCtx(form))
    expect(controller.getSnapshot().math.errors.operators).toBe('errMath')
    controller.resetMath()
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, invalid: false, math: { value: { groups: { matrix: false, polynomial: false } } } })
    await controller.save()
    const result = form.mutate.mock.calls.at(-1)![0][0]!.value as any
    expect(result.futureSetting).toBe('keep')
    expect(result.operators.unknown).toBeUndefined()
    controller.setMath({ limits: { maxWorkUnits: '0' } })
    expect(controller.getSnapshot().invalid).toBe(true)
    await controller.save()
    expect(form.mutate).toHaveBeenCalledTimes(1)
    controller.setMath({ limits: { maxWorkUnits: '20' } })
    form.replace({ revision: 100 })
    await controller.save()
    expect(controller.getSnapshot().conflicted).toBe(true)
    expect(form.mutate).toHaveBeenCalledTimes(1)
    controller.discard()
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, conflicted: false })
  })

  it('ignores read-only changes and drops drafts when all values return to the saved state', () => {
    const readOnly = new SwarmAgentsController(createCtx(createForm({ routes: {} }, { writable: false })))
    readOnly.setMath({ enabled: false })
    expect(readOnly.getSnapshot().dirty).toBe(false)
    const controller = new SwarmAgentsController(createCtx(createForm({ routes: {} })))
    controller.setMath({ groups: { matrix: true } })
    expect(controller.getSnapshot().dirty).toBe(true)
    controller.setMath({ groups: { matrix: false } })
    expect(controller.getSnapshot().dirty).toBe(false)
    controller.setMath({ limits: { maxInputBytes: '  ' } })
    expect(controller.getSnapshot().invalid).toBe(true)
  })
})

describe('Jev API key 卡片', () => {
  const makeJevCtx = (options: { rpc?: (method: string) => unknown; describe?: unknown; set?: unknown } = {}) => {
    const calls: string[] = []
    const credentials = {
      describe: vi.fn(async (refs: string[]) => options.describe ?? { ok: true, value: { [refs[0] as string]: { configured: false, writable: true } } }),
      set: vi.fn(async () => options.set ?? { ok: true, value: undefined }),
      unset: vi.fn(async () => ({ ok: true, value: undefined }))
    }
    const ctx = {
      get: (name: string) => name === 'connection'
        ? { rpc: { call: vi.fn(async (_channel: string, method: string) => { calls.push(method); return options.rpc === undefined ? { ok: false, error: { code: 'gateway/method-not-found', message: 'no route' } } : { ok: true, value: options.rpc(method) } }) } }
        : undefined,
      remote: { credentials }
    }
    return { ctx, calls, credentials }
  }

  it('读取状态：优先宿主 RPC，RPC 不可用时退回凭据描述；从不出现密钥值', async () => {
    const viaRpc = makeJevCtx({ rpc: () => ({ ref: 'TYPESAFE_API_KEY', configured: true, source: 'env', writable: false }) })
    const jev = new JevKeyController(viaRpc.ctx, () => 'TYPESAFE_API_KEY')
    await jev.load()
    expect(viaRpc.calls).toEqual(['swarm.jevStatus'])
    expect(jev.getSnapshot()).toMatchObject({ status: 'ready', info: { configured: true, source: 'env', writable: false } })
    const fallback = makeJevCtx()
    const other = new JevKeyController(fallback.ctx, () => 'MY_KEY')
    await other.load()
    expect(fallback.credentials.describe).toHaveBeenCalledWith(['MY_KEY'])
    expect(other.getSnapshot()).toMatchObject({ status: 'ready', info: { ref: 'MY_KEY', configured: false } })
  })

  it('保存写入凭据服务后清空输入并刷新；被拒绝时保留错误', async () => {
    const ok = makeJevCtx({ rpc: () => ({ ref: 'TYPESAFE_API_KEY', configured: true, source: 'file', writable: true }) })
    const jev = new JevKeyController(ok.ctx, () => 'TYPESAFE_API_KEY')
    jev.setDraft('  tsk_secret  ')
    await jev.save()
    expect(ok.credentials.set).toHaveBeenCalledWith('TYPESAFE_API_KEY', 'tsk_secret')
    expect(jev.getSnapshot()).toMatchObject({ draft: '', notice: 'jevSaved', saving: false, info: { configured: true } })
    const refused = makeJevCtx({ set: { ok: false, error: { message: 'shadowed by env' } } })
    const blocked = new JevKeyController(refused.ctx, () => 'TYPESAFE_API_KEY')
    blocked.setDraft('tsk_x')
    await blocked.save()
    expect(blocked.getSnapshot()).toMatchObject({ error: 'shadowed by env', draft: 'tsk_x' })
    await blocked.clear()
    expect(refused.credentials.unset).toHaveBeenCalledWith('TYPESAFE_API_KEY')
  })

  it('测试连接调用 jevHealth，失败时记录错误', async () => {
    const health = { key: { ref: 'TYPESAFE_API_KEY', configured: true }, enabled: true, model: 'jev-latest', baseUrl: 'https://api.typesafe.ai', result: { ok: true, answers: { models: [{ name: 'jev-1' }] } } }
    const h = makeJevCtx({ rpc: (method) => (method === 'swarm.jevHealth' ? health : {}) })
    const jev = new JevKeyController(h.ctx, () => 'TYPESAFE_API_KEY')
    await jev.test()
    expect(jev.getSnapshot()).toMatchObject({ testing: false, test: { model: 'jev-latest' } })
    const broken = new JevKeyController(makeJevCtx().ctx, () => 'TYPESAFE_API_KEY')
    await broken.test()
    expect(broken.getSnapshot().test).toEqual({ error: 'no route', code: 'gateway/method-not-found' })
  })

  it('权限拒绝保留code且不改走credentials.describe兼容路径', async () => {
    const h = makeJevCtx()
    const deniedCtx = { ...h.ctx, get: () => ({ rpc: { call: async () => ({ ok: false, error: { code: 'swarm/permission-denied', message: 'credential-permission-denied' } }) } }) }
    const controller = new JevKeyController(deniedCtx, () => 'TYPESAFE_API_KEY')
    await controller.load()
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', loadError: 'swarm/permission-denied: credential-permission-denied' })
    expect(h.credentials.describe).not.toHaveBeenCalled()
    await controller.test()
    expect(controller.getSnapshot().test).toEqual({ error: 'credential-permission-denied', code: 'swarm/permission-denied' })
  })

  it('凭据刷新或引用变化后丢弃旧连接测试结果，不将旧key成功显示为新key已验证', async () => {
    let finish!: (value: unknown) => void
    let ref = 'OLD_KEY'
    const ctx = { get: () => ({ rpc: { call: async (_channel: string, method: string) => method === 'swarm.jevHealth' ? await new Promise((resolve) => { finish = resolve }) : { ok: true, value: { ref, configured: true } } } }) }
    const controller = new JevKeyController(ctx, () => ref)
    const pending = controller.test()
    ref = 'NEW_KEY'
    await controller.load()
    finish({ ok: true, value: { model: 'old-key-model', result: { ok: true } } })
    await pending
    expect(controller.getSnapshot()).toMatchObject({ testing: false, test: undefined, info: { ref: 'NEW_KEY' } })
    const changedOnly = controller.test()
    ref = 'THIRD_KEY'
    finish({ ok: true, value: { model: 'new-key-model' } })
    await changedOnly
    expect(controller.getSnapshot()).toMatchObject({ testing: false, test: undefined })
  })
})
