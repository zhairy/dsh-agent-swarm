import { describe, expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteStateRegistry, type FallbackEventInfo } from '../../src/route-state.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'

const config = getSwarmConfig({})
const child = { id: 'c1', session: { header: { parentSession: 'root' } } }
const root = { id: 'root', session: { header: {} } }
const chain = [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2', reasoningEffort: 'high' }, { provider: 'a', model: 'm3' }]

describe('子智能体路由', () => {
  it('请求时套用当前路由并去掉继承的推理强度', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he' })
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y', reasoningEffort: 'max', maxTokens: 10 }, undefined))
      .toEqual({ provider: 'a', model: 'm1', maxTokens: 10 })
    expect(registry.getChildRole('c1')).toBe('fu_he')
  })

  it('致命失败切到下一条并回调；链尽后交回宿主动作', () => {
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he', onFallback: (event) => events.push(event) })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)
    const action = registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)
    expect(action).toEqual({ kind: 'retry' })
    expect(events[0]).toMatchObject({ scope: 'child', from: { model: 'm1' }, to: { model: 'm2' } })
    expect(registry.getRequestOverride(child, { provider: 'a', model: 'm1' }, undefined)).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'high' })
    expect(registry.getErrorAction({ agent: child, provider: 'b', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    registry.getRequestOverride(child, { provider: 'b', model: 'm2' }, undefined)
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toBeUndefined()
    expect(registry.getChild('c1')).toMatchObject({ route: { model: 'm3' }, role: 'fu_he', switches: 3 })
  })

  it('认证失败跳过同 provider 路由；瞬时失败且宿主仍在重试时不干预', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain: [chain[0], chain[2], chain[1]], role: 'fu_he' })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)
    const hostRetry = { kind: 'retry' }
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'RATE_LIMIT', status: 429 } }, hostRetry, undefined, config)).toBe(hostRetry)
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { status: 401 } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild('c1')?.route).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'high' })
  })

  it('DelAgent 清理状态', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he' })
    registry.DelAgent('c1')
    expect(registry.getChild('c1')).toBeUndefined()
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)).toEqual({ provider: 'x', model: 'y' })
  })
})

describe('根会话回退', () => {
  it('选择器路由致命失败时按角色链回退，跳过已失败路由', () => {
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry((event) => events.push(event))
    const first = DEFAULT_ROUTE_CHAINS.tian_shu[0]
    registry.getRequestOverride(root, { provider: first.provider, model: first.model }, 'tian_shu')
    expect(registry.getErrorAction({ agent: root, provider: first.provider, failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(events[0]?.to).toEqual(DEFAULT_ROUTE_CHAINS.tian_shu[1])
    expect(registry.getRequestOverride(root, { provider: first.provider, model: first.model }, 'tian_shu'))
      .toMatchObject({ provider: DEFAULT_ROUTE_CHAINS.tian_shu[1].provider, model: DEFAULT_ROUTE_CHAINS.tian_shu[1].model })
  })

  it('回退后用户在选择器里换了模型：清除覆盖与已试记录，尊重新选择', () => {
    const registry = intRouteStateRegistry()
    const picked = { provider: 'p', model: 'picked' }
    registry.getRequestOverride(root, picked, 'tian_shu')
    registry.getErrorAction({ agent: root, provider: 'p', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)
    expect(registry.getRequestOverride(root, picked, 'tian_shu').model).toBe(DEFAULT_ROUTE_CHAINS.tian_shu[0].model)
    const changed = { provider: 'q', model: 'new-choice' }
    expect(registry.getRequestOverride(root, changed, 'tian_shu')).toEqual(changed)
    expect(registry.getErrorAction({ agent: root, provider: 'q', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, changed, 'tian_shu').model).toBe(DEFAULT_ROUTE_CHAINS.tian_shu[0].model)
  })

  it('关闭 rootFallback、非 swarm 预设、未跟踪的子会话都不干预', () => {
    const registry = intRouteStateRegistry()
    const off = getSwarmConfig({ rootFallback: false })
    const failure = { agent: root, provider: 'x', failure: { code: 'QUOTA' } }
    expect(registry.getErrorAction(failure, undefined, 'tian_shu', off)).toBeUndefined()
    expect(registry.getErrorAction(failure, undefined, undefined, config)).toBeUndefined()
    expect(registry.getErrorAction({ ...failure, agent: { id: 'fork', session: { header: { parentSession: 'root' } } } }, undefined, 'tian_shu', config)).toBeUndefined()
  })
})
