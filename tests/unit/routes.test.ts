import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ESCALATION,
  DEFAULT_ROUTE_CHAINS,
  FindUsableRoutes,
  OPENCODE_GO_MODELS,
  PROVIDER_DS,
  PROVIDER_GO,
  PROVIDER_QWEN,
  QWEN_PREFERRED_MODELS,
  QWEN_TOKEN_PLAN_MODELS,
  getCatalogVision,
  getFailureClass,
  getModelFamily,
  getRouteKey,
  getRouteLabel,
  intRouteProbe,
  isSameRoute,
  isSwitchWorthy,
  type RouteInfo,
  type RouteProbe
} from '../../src/routes.js'
import { ROLE_IDS } from '../../src/role-registry.js'

describe('默认路由表', () => {
  it('每个路由键都有非空链，且覆盖全部角色（算衡分研算/验算）', () => {
    for (const role of ROLE_IDS) {
      if (role === 'suan_heng') continue
      expect(DEFAULT_ROUTE_CHAINS[role].length).toBeGreaterThan(0)
    }
    expect(DEFAULT_ROUTE_CHAINS['suan_heng:research'][0]).toEqual({ provider: PROVIDER_QWEN, model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    expect(DEFAULT_ROUTE_CHAINS['suan_heng:verify'].length).toBeGreaterThan(0)
  })

  it('qwen 优先：链中凡是 qwen 目录有的模型，qwen 路由都排在同模型 go 路由之前', () => {
    for (const [key, chain] of Object.entries(DEFAULT_ROUTE_CHAINS)) {
      chain.forEach((route, index) => {
        if (route.provider !== PROVIDER_GO || !(route.model in QWEN_TOKEN_PLAN_MODELS)) return
        const qwenIndex = chain.findIndex((r) => r.provider === PROVIDER_QWEN && r.model === route.model)
        expect(qwenIndex, `${key} ${route.model}`).toBeGreaterThanOrEqual(0)
        expect(qwenIndex, `${key} ${route.model}`).toBeLessThan(index)
      })
    }
  })

  it('链中的模型都存在于对应 provider 的内置目录', () => {
    const catalogs: Record<string, Record<string, unknown>> = {
      [PROVIDER_QWEN]: QWEN_TOKEN_PLAN_MODELS,
      [PROVIDER_GO]: OPENCODE_GO_MODELS,
      [PROVIDER_DS]: { 'deepseek-flash': 1, 'deepseek-v4-pro': 1 }
    }
    for (const chain of Object.values(DEFAULT_ROUTE_CHAINS)) {
      for (const route of chain) expect(catalogs[route.provider]?.[route.model], getRouteLabel(route)).toBeDefined()
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
