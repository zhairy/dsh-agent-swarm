import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_NATIVE_CONFIG, ROUTE_KEYS, getRoleRoute, getSwarmConfig } from '../../src/config.js'
import { DEFAULT_BUDGETS, DEFAULT_TRIAGE_THRESHOLDS } from '../../src/policy.js'
import { DEFAULT_JEV_CONFIG } from '../../src/jev.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'

describe('Config schema', () => {
  it('空配置解析出 volatile 引用，合并后等于默认值', () => {
    const parsed = Config({})
    expect(typeof (parsed as unknown as { rootFallback: { get: () => unknown } }).rootFallback.get).toBe('function')
    const config = getSwarmConfig(parsed)
    expect(config.rootFallback).toBe(true)
    expect(config.nativeEscalation).toBe('manual')
    expect(config.native).toEqual(DEFAULT_NATIVE_CONFIG)
    expect(config.jev).toEqual(DEFAULT_JEV_CONFIG)
    expect(config.thresholds).toEqual(DEFAULT_TRIAGE_THRESHOLDS)
    expect(config.budgets).toEqual(DEFAULT_BUDGETS)
    expect(config.routes).toEqual({})
    expect(config.ledgerDir).toBe('')
  })

  it('覆盖值生效，嵌套字段按默认补齐', () => {
    const parsed = Config({
      rootFallback: false,
      nativeEscalation: 'auto',
      jev: { enabled: false, mathConfidence: 0.8 },
      budgets: { maxAutoFixRounds: 1 },
      routes: { fu_he: { chain: [{ provider: 'p', model: 'm' }] } }
    })
    const config = getSwarmConfig(parsed)
    expect(config.rootFallback).toBe(false)
    expect(config.nativeEscalation).toBe('auto')
    expect(config.jev.enabled).toBe(false)
    expect(config.jev.timeoutMs).toBe(10000)
    expect(config.thresholds.mathConfidence).toBe(0.8)
    expect(config.budgets.maxAutoFixRounds).toBe(1)
    expect(config.budgets.maxCallsPerRole).toBe(0)
    expect(config.agents).toEqual({
      session: 'auto', repeatAbove: 0.5, sameCategoryAbove: 0.5, maxRetries: 3, retryBackoffMs: 5000,
      promptStyle: 'auto', networkWaitMs: 600000, rootRecoverMs: 600000,
      networkProbeUrls: ['https://api.deepseek.com', 'https://dashscope.aliyuncs.com', 'https://www.baidu.com'],
      modelCallDisplay: 'every'
    })
    expect(config.jev).toMatchObject({ maxRequestsPerSecond: 0, maxRequestChars: 120000 })
    expect(getSwarmConfig({ agents: { modelCallDisplay: 'turn' } }).agents.modelCallDisplay).toBe('turn')
    expect(getSwarmConfig({ agents: { modelCallDisplay: 'sometimes' } }).agents.modelCallDisplay).toBe('every')
    expect(config.routes.fu_he?.chain).toEqual([{ provider: 'p', model: 'm' }])
  })

  it('提示风格与探测地址：非法值退回默认', () => {
    const config = getSwarmConfig({ agents: { promptStyle: 'weird', networkProbeUrls: ['ftp://x', 3], networkWaitMs: 0 } })
    expect(config.agents.promptStyle).toBe('auto')
    expect(config.agents.networkProbeUrls).toEqual(['https://api.deepseek.com', 'https://dashscope.aliyuncs.com', 'https://www.baidu.com'])
    expect(config.agents.networkWaitMs).toBe(0)
    expect(getSwarmConfig({ agents: { promptStyle: 'claude', networkProbeUrls: ['http://127.0.0.1:9'] } }).agents)
      .toMatchObject({ promptStyle: 'claude', networkProbeUrls: ['http://127.0.0.1:9'] })
  })

  it('数学配置保持旧扩展授权兼容且显式组权限优先，限制在宿主schema验证', () => {
    expect(getSwarmConfig(Config({ math: { enableExtended: true } })).math.groups).toMatchObject({ matrix: true, polynomial: true })
    const config = getSwarmConfig(Config({ math: { enableExtended: true, groups: { matrix: false }, operators: { add: false }, numericModes: { rational: false }, limits: { maxArrayElements: 100 }, maxWorkUnitsPerTask: 2000 } }))
    expect(config.math).toMatchObject({ groups: { matrix: false, polynomial: true }, operators: { add: false }, numericModes: { rational: false }, limits: { maxArrayElements: 100 }, maxWorkUnitsPerTask: 2000 })
    expect(config.math.configurationError).toBeUndefined()
    expect(() => Config({ math: { maxWorkUnitsPerTask: 0 } })).toThrow()
    expect(() => Config({ math: { limits: { maxMatrixDimension: 10000 } } })).toThrow()
    expect(getSwarmConfig({ math: { groups: { unknown: true } } }).math.configurationError).toBeDefined()
  })
})

describe('getSwarmConfig', () => {
  it('接受普通对象，丢弃非法路由覆盖', () => {
    const config = getSwarmConfig({
      routes: {
        nobody: { chain: [{ provider: 'p', model: 'm' }] },
        fu_he: { chain: [{ provider: 'p' }] },
        yu_shi: { chain: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }], escalation: 'claude' },
        tan_wei: 'x'
      },
      nativeEscalation: 'weird',
      budgets: { maxCallsPerRole: 'many' }
    })
    expect(Object.keys(config.routes)).toEqual(['yu_shi'])
    expect(config.routes.yu_shi).toEqual({ chain: [{ provider: 'p', model: 'm', reasoningEffort: 'high' }], escalation: 'claude' })
    expect(config.nativeEscalation).toBe('manual')
    expect(config.budgets.maxCallsPerRole).toBe(0)
    expect(getSwarmConfig({ agents: { session: 'weird', maxRetries: 1 } }).agents).toMatchObject({ session: 'auto', maxRetries: 1 })
    expect(getSwarmConfig(undefined).rootFallback).toBe(true)
  })

  it('getRoleRoute：覆盖优先，空链回退到默认，并带默认升级通道', () => {
    const config = getSwarmConfig({ routes: { yu_shi: { chain: [{ provider: 'p', model: 'm' }] }, fu_he: { chain: [] } } })
    expect(getRoleRoute(config, 'yu_shi')).toEqual({ chain: [{ provider: 'p', model: 'm' }], escalation: 'codex' })
    expect(getRoleRoute(config, 'fu_he')).toEqual({ chain: [...DEFAULT_ROUTE_CHAINS.fu_he] })
    expect(ROUTE_KEYS).toContain('suan_heng:verify')
    expect(ROUTE_KEYS).not.toContain('suan_heng')
  })
})
