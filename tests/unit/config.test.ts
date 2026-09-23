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
    expect(config.budgets.maxCallsPerRole).toBe(4)
    expect(config.routes.fu_he?.chain).toEqual([{ provider: 'p', model: 'm' }])
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
    expect(config.budgets.maxCallsPerRole).toBe(4)
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
