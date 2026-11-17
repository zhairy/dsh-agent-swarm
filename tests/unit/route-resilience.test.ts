import { describe, expect, it, vi } from 'vitest'
import { createRouteEngine } from '../../src/application/routing/engine.js'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteHealth } from '../../src/domain/routing/health.js'
import { getRouteRecoveryPolicy, normalizeRouteFailure } from '../../src/domain/routing/provider-policy.js'

const agent = { id: 'resilient-child', session: { header: { parentSession: 'root' } } }
const primary = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' }
const secondary = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }
const tail = { provider: 'dsh-opencode-go', model: 'kimi-k3.1-pro' }
const config = getSwarmConfig({ agents: { networkWaitMs: 30000 }, recovery: { maxTransientRetries: 1, maxTransientWaitMs: 5000 } })
const transport = { code: 'TRANSPORT', message: 'pool "model" exhausted: last member (TRANSPORT: API request failed)' }

describe('provider failure and route recovery integration', () => {
  it('联网探测器存在也保留已配置的同路由短重试，额度充足的短暂传输失败不立即切模型', async () => {
    const sleep = vi.fn(async () => undefined), fallback = vi.fn()
    const network = { isOnline: vi.fn(async () => true), waitOnline: vi.fn(async () => false) }
    const engine = createRouteEngine(undefined, undefined, { sleep, network })
    engine.AddChild(agent.id, { chain: [primary, secondary], role: 'shu_ji', persistent: true, logicalRequestId: 'resilience-short', onFallback: fallback })
    engine.getRequestOverride(agent, primary, 'shu_ji', config)
    await engine.getErrorAction({ agent, provider: primary.provider, failure: transport }, undefined, 'shu_ji', config)
    expect(engine.getRequestOverride(agent, primary, 'shu_ji', config)).toMatchObject(primary)
    expect(sleep).toHaveBeenCalledWith(500, undefined)
    expect(fallback).not.toHaveBeenCalled()
    expect(network.waitOnline).not.toHaveBeenCalled()
  })

  it('链尾余额不足时仍能在有界预算内重探先前短暂传输失败的订阅路由', async () => {
    let at = 0
    const health = intRouteHealth(() => at), waits: number[] = []
    const engine = createRouteEngine(undefined, undefined, { health, now: () => at,
      sleep: async ms => { waits.push(ms); at += ms }, network: { isOnline: async () => true, waitOnline: async () => false } })
    engine.AddChild(agent.id, { chain: [primary, secondary, tail], role: 'shu_ji', persistent: true, logicalRequestId: 'resilience-tail' })
    engine.getRequestOverride(agent, primary, 'shu_ji', config)
    await engine.getErrorAction({ agent, provider: primary.provider, failure: transport }, undefined, 'shu_ji', config)
    engine.getRequestOverride(agent, primary, 'shu_ji', config)
    await engine.getErrorAction({ agent, provider: primary.provider, failure: transport }, undefined, 'shu_ji', config)
    expect(engine.getRequestOverride(agent, primary, 'shu_ji', config)).toMatchObject(secondary)
    await engine.getErrorAction({ agent, provider: secondary.provider, failure: transport }, undefined, 'shu_ji', config)
    expect(engine.getRequestOverride(agent, primary, 'shu_ji', config)).toMatchObject(tail)
    await engine.getErrorAction({ agent, provider: tail.provider, failure: { code: 'QUOTA', status: 402, message: 'Insufficient balance' } }, undefined, 'shu_ji', config)
    expect(engine.getRecovery(agent.id)?.terminal).toBeUndefined()
    expect(engine.getRequestOverride(agent, primary, 'shu_ji', config)).toMatchObject(primary)
    expect(waits.some(ms => ms >= 10000)).toBe(true)
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(config.agents.networkWaitMs)
  })

  it('某条历史的thinking回放格式错误不隔离同模型的其它新会话', () => {
    const route = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const failure = normalizeRouteFailure({ code: 'INVALID_REQUEST', status: 400, message: 'The `content[].thinking` in the thinking mode must be passed back to the API.' }, route)
    expect(getRouteRecoveryPolicy(failure)).toEqual({ isolate: false, retryDelayMs: 0 })
    const health = intRouteHealth(() => 1)
    health.record(route, failure)
    expect(health.isAvailable(route)).toBe(true)
    expect(health.getSnapshot().entries).toHaveLength(0)
  })
})
