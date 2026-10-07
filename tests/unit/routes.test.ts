import { describe, expect, it } from 'vitest'
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  DEEPSEEK_OFFICIAL_MODELS,
  DEFAULT_ESCALATION,
  DEFAULT_ROUTE_CHAINS,
  FindUsableRoutes,
  MODEL_REASONING_EFFORTS,
  OPENCODE_GO_MODELS,
  PROVIDER_CLAUDE,
  PROVIDER_CODEX,
  PROVIDER_DS,
  PROVIDER_GO,
  PROVIDER_QWEN,
  PROVIDER_LABELS,
  PROBE_FAIL_TTL_MS,
  PROBE_OK_TTL_MS,
  QWEN_PREFERRED_MODELS,
  QWEN_TOKEN_PLAN_MODELS,
  getCatalogVision,
  getFailureClass,
  getModelFamily,
  getRouteDisplay,
  getRouteKey,
  getRouteLabel,
  intRouteProbe,
  isSameRoute,
  isSwitchWorthy,
  type RouteInfo,
  type RouteProbe
} from '../../src/routes.js'
import { ROLE_IDS } from '../../src/role-registry.js'
import { DEFAULT_UPGRADES } from '../../src/upgrade.js'
import { normalizeRouteFailure, getRouteResourcePolicy, getRouteResourceInfo } from '../../src/provider-policy.js'
import { intRouteStateRegistry } from '../../src/route-state.js'

describe('默认路由表', () => {
  it('每个路由键都有非空链，且覆盖全部角色（算衡分研算/验算）', () => {
    for (const role of ROLE_IDS) {
      if (role === 'suan_heng') continue
      expect(DEFAULT_ROUTE_CHAINS[role].length).toBeGreaterThan(0)
    }
    expect(DEFAULT_ROUTE_CHAINS['suan_heng:research'][0]).toEqual({ provider: PROVIDER_CODEX, model: 'gpt-6-astra', reasoningEffort: 'max' })
    for (const chain of Object.values(DEFAULT_ROUTE_CHAINS)) expect(chain).toHaveLength(4)
    expect(DEFAULT_ROUTE_CHAINS['suan_heng:verify'].length).toBeGreaterThan(0)
  })

  it('同一模型的 provider 优先级：先消耗订阅（qwen → go），DeepSeek 官方 API 兜底并位于最后一层', () => {
    /** 各 provider 下同一模型的 ID 不同：官方 API 的 deepseek-flash 即 V4.1 Flash */
    const canonical = (route: RouteInfo): string => (route.provider === PROVIDER_DS && route.model === 'deepseek-flash' ? 'deepseek-v4.1-flash' : route.model)
    const rank: Record<string, number> = { [PROVIDER_QWEN]: 0, [PROVIDER_GO]: 1, [PROVIDER_DS]: 2 }
    for (const [key, chain] of Object.entries(DEFAULT_ROUTE_CHAINS)) {
      chain.forEach((route, index) => {
        chain.slice(index + 1).filter((later) => canonical(later) === canonical(route) && rank[later.provider] !== undefined)
          .forEach((later) => expect(rank[route.provider], `${key} ${canonical(route)}`).toBeLessThan(rank[later.provider] as number))
      })
      expect(chain.at(-1)?.provider, `${key} 兜底层`).toBe(PROVIDER_DS)
      expect(chain.slice(0, -1).some((r) => r.provider === PROVIDER_DS), `${key} 官方 API 只在兜底层`).toBe(false)
      // 第一次出现的 go 路由：若 qwen 目录也有该模型，说明应改走 qwen（kimi-k2.7-code 在 qwen 未开通，例外）
      chain.filter((route) => route.provider === PROVIDER_GO && route.model in QWEN_TOKEN_PLAN_MODELS && route.model !== 'kimi-k2.7-code')
        .forEach((route) => expect(chain.some((r) => r.provider === PROVIDER_QWEN && r.model === route.model), `${key} ${route.model}`).toBe(true))
    }
  })

  it('链中的模型都存在于对应 provider 的内置目录', () => {
    const catalogs: Record<string, Record<string, unknown>> = {
      [PROVIDER_QWEN]: QWEN_TOKEN_PLAN_MODELS,
      [PROVIDER_GO]: OPENCODE_GO_MODELS,
      [PROVIDER_DS]: DEEPSEEK_OFFICIAL_MODELS,
      [PROVIDER_CODEX]: CODEX_MODELS,
      [PROVIDER_CLAUDE]: CLAUDE_MODELS
    }
    for (const chain of Object.values(DEFAULT_ROUTE_CHAINS)) {
      for (const route of chain) expect(catalogs[route.provider]?.[route.model], getRouteLabel(route)).toBeDefined()
    }
  })

  it('默认链与升级链的推理强度都在该模型支持的档位内，且每层都显式指定', () => {
    const routes = [...Object.values(DEFAULT_ROUTE_CHAINS).flat(), ...Object.values(DEFAULT_UPGRADES).flatMap((upgrade) => upgrade?.chain ?? [])]
    for (const route of routes) {
      const efforts = MODEL_REASONING_EFFORTS[getRouteLabel(route)]
      expect(efforts, getRouteLabel(route)).toBeDefined()
      expect(efforts, `${getRouteLabel(route)} ${route.reasoningEffort}`).toContain(route.reasoningEffort)
    }
  })

  it('观象链只含支持图片的模型；御史与铸剑、验算与研算首选家族不同', () => {
    for (const route of DEFAULT_ROUTE_CHAINS.guan_xiang) expect(getCatalogVision(route)).toBe(true)
    expect(getModelFamily(DEFAULT_ROUTE_CHAINS.yu_shi[0].model)).not.toBe(getModelFamily(DEFAULT_ROUTE_CHAINS.zhu_jian[0].model))
    expect(getModelFamily(DEFAULT_ROUTE_CHAINS['suan_heng:verify'][0].model))
      .not.toBe(getModelFamily(DEFAULT_ROUTE_CHAINS['suan_heng:research'][0].model))
  })

  it('交集与升级通道', () => {
    expect(QWEN_PREFERRED_MODELS).toEqual(expect.arrayContaining(['deepseek-v4-pro', 'qwen3.8-max', 'kimi-k2.7-code', 'glm-5.2']))
    expect(QWEN_PREFERRED_MODELS).not.toContain('MiniMax-M2.5')
    expect(DEFAULT_ESCALATION.zhu_jian).toBe('claude')
    expect(DEFAULT_ESCALATION.fu_he).toBeUndefined()
  })
})

describe('路由工具函数', () => {
  it('已核验Qwen单key内置provider是共享plan，Go按model，Claude/Codex不臆测账号；显式policy优先', () => {
    expect(getRouteResourcePolicy({ provider: PROVIDER_QWEN, model: 'glm-5.3' })).toEqual({ accessMode: 'subscription', quotaScope: 'plan', quotaDomainId: 'provider-instance:qwen-token-plan-cn' })
    expect(getRouteResourcePolicy({ provider: PROVIDER_GO, model: 'glm-5.3' })).toEqual({ accessMode: 'subscription', quotaScope: 'model' })
    expect(getRouteResourcePolicy({ provider: PROVIDER_CLAUDE, model: 'opus' })).toEqual({ accessMode: 'subscription', quotaScope: 'unknown' })
    expect(getRouteResourcePolicy({ provider: PROVIDER_CODEX, model: 'astra' }).quotaDomainId).toBeUndefined()
    expect(getRouteResourcePolicy({ provider: PROVIDER_QWEN, model: 'custom', policy: { accessMode: 'metered_api' } })).toEqual({ accessMode: 'metered_api', quotaScope: 'unknown' })
    expect(getRouteResourceInfo({ provider: PROVIDER_DS, model: 'deepseek-flash' })).toMatchObject({ inferredResourceType: 'metered_api', metadataSource: 'provider-kind' })
  })
  it('解析预检的结构化quota进入共享隔离，缓存15s过期也不反复查询同账号', async () => {
    let at = 0
    const state = intRouteStateRegistry(undefined, undefined, { now: () => at })
    const calls: string[] = []
    const first: RouteInfo = { provider: 'p', model: 'first', policy: { quotaDomainId: 'account-a', quotaScope: 'account' } }
    const peer: RouteInfo = { provider: 'p', model: 'peer', policy: { quotaDomainId: 'account-a', quotaScope: 'account' } }
    const backup: RouteInfo = { provider: 'p', model: 'backup', policy: { quotaDomainId: 'account-b', quotaScope: 'account' } }
    const probe = intRouteProbe(() => ({ listProviders: () => [{ id: 'p' }], resolveModelInfo: async (_provider, model) => {
      calls.push(model)
      if (model === 'first') throw Object.assign(new Error('subscription quota exhausted'), { failure: { code: 'QUOTA', message: 'subscription quota exhausted', quotaDomainId: 'account-a', quotaScope: 'account' } })
      return { inputModalities: ['text'] }
    } }), { now: () => at, isRouteAvailable: (route) => state.isRouteAvailable(route), onFailure: (route, failure) => state.ObserveRouteFailure(route, failure) })
    expect((await probe(first)).ok).toBe(false)
    at = PROBE_FAIL_TTL_MS + 1
    expect(await probe(first)).toEqual({ ok: false, reason: 'route-isolated' })
    expect(await probe(peer)).toEqual({ ok: false, reason: 'route-isolated' })
    expect((await probe(backup)).ok).toBe(true)
    expect(calls).toEqual(['first', 'backup'])
  })

  it('解析预检等待健康态提交，持久写失败不能变成可忽略预检结果', async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const state = intRouteStateRegistry(undefined, undefined, { onHealthChange: () => pending })
    const route: RouteInfo = { provider: 'p', model: 'first', policy: { quotaDomainId: 'account', quotaScope: 'account' } }
    const source = () => ({ listProviders: () => [{ id: 'p' }], resolveModelInfo: async () => { throw Object.assign(new Error('quota exhausted'), { code: 'QUOTA' }) } })
    const probe = intRouteProbe(source, { isRouteAvailable: (route) => state.isRouteAvailable(route), onFailure: (route, failure) => state.ObserveRouteFailure(route, failure) })
    let done = false
    const result = probe(route).then((value) => { done = true; return value })
    await Promise.resolve(); await Promise.resolve()
    expect(done).toBe(false)
    release()
    expect(await result).toEqual({ ok: false, reason: 'route-isolated' })
    const broken = intRouteProbe(source, { onFailure: async () => { throw new Error('storage-failed') } })
    await expect(broken(route)).rejects.toThrow('storage-failed')
  })
  it('结构化终态/池不可用优先，普通每分钟配额不封禁账号，402只在已知按量域解释余额', () => {
    const route = { provider: 'deepseek-official', model: 'deepseek-flash' }
    expect(normalizeRouteFailure({ status: 402 }, route).kind).toBe('insufficient_balance')
    expect(normalizeRouteFailure({ status: 429, message: 'quota per minute: too many requests' }, route).kind).toBe('rate_limited')
    expect(normalizeRouteFailure({ status: 429, code: 'RATE_LIMIT', message: 'TPM quota exceeded: tokens per minute' }, route).kind).toBe('rate_limited')
    expect(normalizeRouteFailure({ status: 429, code: 'RATE_LIMIT', message: 'You exceeded your current quota, please check your plan and billing details.' }, route).kind).toBe('quota_exhausted')
    expect(getFailureClass({ status: 429, message: 'quota per minute: too many requests' })).toBe('transient')
    expect(normalizeRouteFailure({ status: 429, message: "You've hit your limit" }, route).kind).toBe('quota_exhausted')
    expect(normalizeRouteFailure({ code: 'SERVER_ERROR', message: 'pool "claude-opus-5-5" exhausted: every member is unavailable or failed' }, route).kind).toBe('pool_exhausted')
    const poolError = { message: 'pool "opus" exhausted: every member is unavailable or failed' }
    expect(normalizeRouteFailure(poolError, { provider: 'account-a-pool', model: 'opus' }).poolId).not.toBe(normalizeRouteFailure(poolError, { provider: 'independent-account-pool', model: 'opus' }).poolId)
  })
  it('路由键、标签、相等', () => {
    expect(getRouteKey('suan_heng')).toBe('suan_heng:research')
    expect(getRouteKey('suan_heng', 'verify')).toBe('suan_heng:verify')
    expect(getRouteKey('fu_he')).toBe('fu_he')
    expect(getRouteLabel({ provider: 'p', model: 'm' })).toBe('p/m')
    expect(isSameRoute({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { provider: 'p', model: 'm' })).toBe(true)
    expect(isSameRoute({ provider: 'p', model: 'm' }, { provider: 'q', model: 'm' })).toBe(false)
  })

  it('模型家族', () => {
    expect(getModelFamily('deepseek-v4-pro')).toBe('deepseek')
    expect(getModelFamily('qwen3.8-max')).toBe('qwen')
    expect(getModelFamily('kimi-k2.7-code')).toBe('kimi')
    expect(getModelFamily('glm-5.3')).toBe('glm')
    expect(getModelFamily('MiniMax-M2.5')).toBe('minimax')
    expect(getModelFamily('mimo-v2.5-pro')).toBe('mimo')
    expect(getModelFamily('gpt-5.6-luna')).toBe('gpt')
    expect(getModelFamily('codex-native')).toBe('gpt')
    expect(getModelFamily('claude-native')).toBe('claude')
    expect(getModelFamily('grok-4.6')).toBe('grok')
    expect(getModelFamily('hy4-preview')).toBe('hunyuan')
    expect(getModelFamily('longcat-2.0')).toBe('longcat')
    expect(getModelFamily('mystery')).toBe('other')
  })

  it('目录视觉能力', () => {
    expect(getCatalogVision({ provider: PROVIDER_QWEN, model: 'qwen3.8-max' })).toBe(true)
    expect(getCatalogVision({ provider: PROVIDER_GO, model: 'deepseek-v4-pro' })).toBe(false)
    expect(getCatalogVision({ provider: PROVIDER_DS, model: 'deepseek-flash' })).toBe(true)
    expect(getCatalogVision({ provider: 'other', model: 'x' })).toBeUndefined()
  })
})

describe('FindUsableRoutes', () => {
  const chain: RouteInfo[] = [
    { provider: 'a', model: 'deepseek-v4-pro' },
    { provider: 'b', model: 'qwen3.8-max' },
    { provider: 'c', model: 'glm-5.2' }
  ]
  const probe: RouteProbe = async (route) =>
    route.provider === 'a' ? { ok: false, reason: 'provider-not-configured' } : { ok: true, vision: route.provider === 'b' }

  it('跳过不可用路由并记录原因', async () => {
    const result = await FindUsableRoutes(chain, { probe })
    expect(result.usable.map(getRouteLabel)).toEqual(['b/qwen3.8-max', 'c/glm-5.2'])
    expect(result.skipped).toEqual([{ route: chain[0], reason: 'provider-not-configured' }])
    expect(result.independence).toBe('n/a')
  })

  it('要求视觉时过滤纯文本模型', async () => {
    const result = await FindUsableRoutes(chain, { probe, requireVision: true })
    expect(result.usable.map(getRouteLabel)).toEqual(['b/qwen3.8-max'])
    expect(result.skipped.map((s) => s.reason)).toContain('vision-unsupported')
  })

  it('独立性：优先不同家族，做不到时标注 not-achieved', async () => {
    const achieved = await FindUsableRoutes(chain, { probe, avoidFamilies: ['qwen'] })
    expect(achieved.usable.map(getRouteLabel)).toEqual(['c/glm-5.2'])
    expect(achieved.independence).toBe('achieved')
    expect(achieved.skipped.map((s) => s.reason)).toContain('same-family')
    const notAchieved = await FindUsableRoutes(chain, { probe, avoidFamilies: ['qwen', 'glm'] })
    expect(notAchieved.usable).toHaveLength(2)
    expect(notAchieved.independence).toBe('not-achieved')
    const empty = await FindUsableRoutes([chain[0]], { probe, avoidFamilies: ['glm'] })
    expect(empty.usable).toEqual([])
    expect(empty.independence).toBe('n/a')
  })
})

describe('失败分类', () => {
  it('路由致命、认证、瞬时、其他', () => {
    expect(getFailureClass({ code: 'QUOTA', status: 429 })).toBe('route-fatal')
    expect(getFailureClass({ code: 'NO_ADAPTER' })).toBe('route-fatal')
    expect(getFailureClass({ code: 'X', message: 'Usage limit reached' })).toBe('route-fatal')
    expect(getFailureClass({ code: 'X', status: 404 })).toBe('route-fatal')
    expect(getFailureClass({ code: 'INVALID_CREDENTIAL' })).toBe('auth')
    expect(getFailureClass({ status: 401 })).toBe('auth')
    expect(getFailureClass({ code: 'RATE_LIMIT', status: 429 })).toBe('transient')
    expect(getFailureClass({ status: 503 })).toBe('transient')
    expect(getFailureClass({ code: 'WEIRD' })).toBe('other')
    expect(getFailureClass(undefined)).toBe('other')
  })

  it('是否值得换路由', () => {
    expect(isSwitchWorthy('route-fatal', false)).toBe(true)
    expect(isSwitchWorthy('auth', false)).toBe(true)
    expect(isSwitchWorthy('transient', false)).toBe(false)
    expect(isSwitchWorthy('transient', true)).toBe(true)
    expect(isSwitchWorthy('other', true)).toBe(true)
  })
})

describe('intRouteProbe', () => {
  const llm = {
    listProviders: () => [{ id: 'p' }],
    resolveModelInfo: async (_p: string, model: string) => {
      if (model === 'bad') throw new Error('unknown model')
      return model === 'img' ? { inputModalities: ['text', 'image'] } : {}
    }
  }

  it('按 provider 注册与模型解析给出结果', async () => {
    const probe = intRouteProbe(() => llm)
    expect(await probe({ provider: 'x', model: 'm' })).toEqual({ ok: false, reason: 'provider-not-configured' })
    expect(await probe({ provider: 'p', model: 'img' })).toEqual({ ok: true, vision: true })
    expect(await probe({ provider: 'p', model: 'plain' })).toEqual({ ok: true, vision: false })
    expect(await probe({ provider: 'p', model: 'bad' })).toEqual({ ok: false, reason: 'model-unavailable: unknown model' })
    expect(await intRouteProbe(() => undefined)({ provider: 'p', model: 'm' })).toEqual({ ok: false, reason: 'llm-service-unavailable' })
  })
})

describe('预检缓存与并行', () => {
  it('可用结果缓存较久、失败结果很快过期；并发的同一预检只解析一次', async () => {
    let at = 0
    let calls = 0
    let broken = true
    const llm = {
      listProviders: () => [{ id: 'p' }],
      resolveModelInfo: async (_p: string, model: string) => {
        calls += 1
        if (model === 'flaky' && broken) throw new Error('offline')
        return {}
      }
    }
    const probe = intRouteProbe(() => llm, { now: () => at })
    const ok = { provider: 'p', model: 'ok' }
    await Promise.all([probe(ok), probe(ok), probe(ok)])
    expect(calls).toBe(1)
    at = PROBE_OK_TTL_MS - 1
    await probe(ok)
    expect(calls).toBe(1)
    at = PROBE_OK_TTL_MS
    await probe(ok)
    expect(calls).toBe(2)
    const flaky = { provider: 'p', model: 'flaky' }
    expect((await probe(flaky)).ok).toBe(false)
    broken = false
    expect((await probe(flaky)).ok).toBe(false)
    at += PROBE_FAIL_TTL_MS
    expect(await probe(flaky)).toEqual({ ok: true, vision: false })
  })

  it('各层并行预检，结果按链的顺序', async () => {
    const order: string[] = []
    const probe: RouteProbe = async (route) => {
      await new Promise((resolve) => setTimeout(resolve, route.model === 'slow' ? 20 : 1))
      order.push(route.model)
      return { ok: true, vision: false }
    }
    const result = await FindUsableRoutes([{ provider: 'p', model: 'slow' }, { provider: 'p', model: 'fast' }], { probe })
    expect(order).toEqual(['fast', 'slow'])
    expect(result.usable.map((route) => route.model)).toEqual(['slow', 'fast'])
  })
})

describe('模型与供应商的显示文本', () => {
  it('中文供应商名 + 路由名 + 推理强度；未知供应商显示路由名', () => {
    expect(getRouteDisplay({ provider: PROVIDER_CLAUDE, model: 'claude-opus-5-5', reasoningEffort: 'high' })).toBe('claude-opus-5-5 · Claude 订阅（claude） · 推理 high')
    expect(getRouteDisplay({ provider: 'custom', model: 'm' })).toBe('m · custom')
    expect(Object.keys(PROVIDER_LABELS).sort()).toEqual([PROVIDER_CLAUDE, PROVIDER_CODEX, PROVIDER_DS, PROVIDER_GO, PROVIDER_QWEN].sort())
  })
})
