import { describe, expect, it } from 'vitest'
import { intRouteHealth } from '../../src/route-health.js'
import { normalizeRouteFailure, type FailureKind } from '../../src/provider-policy.js'
import type { RouteInfo } from '../../src/routes.js'
import { validatePersistedRouteHealth } from '../../src/feature-session.js'

const codex: RouteInfo = { provider: 'codex', model: 'gpt-6.1-sol' }
const other: RouteInfo = { provider: 'other', model: 'gpt-6.1-sol' }
const failure = (route: RouteInfo, kind: FailureKind) => normalizeRouteFailure({ kind }, route)

describe('RouteHealth受控恢复，不把暂时故障永久封锁', () => {
  it.each(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'unknown'] as const)('%s无reset也能在后续请求单half-open，成功后恢复', (kind) => {
    let at = 100
    const health = intRouteHealth(() => at)
    health.record(codex, failure(codex, kind))
    expect(health.isAvailable(codex)).toBe(false)
    expect(health.claim(codex, 'first')).toBe(false)
    const entry = health.list()[0]!
    expect(entry.resetAt).toBeUndefined()
    expect(entry.retryAt).toBeGreaterThan(at)
    at = entry.retryAt!
    expect(health.isAvailable(codex)).toBe(true)
    expect(health.claim(codex, 'first')).toBe(true)
    expect(health.claim(codex, 'second')).toBe(false)
    health.succeeded(codex, 'first')
    expect(health.list()).toEqual([])
  })

  it('明确provider reset优先且manual force也不能越过它', () => {
    let at = 0
    const health = intRouteHealth(() => at)
    health.record(codex, normalizeRouteFailure({ code: 'QUOTA', resetAt: new Date(1000).toISOString() }, codex))
    expect(health.list()[0]?.retryAt).toBe(1000)
    expect(health.claimManualRetry(codex, 'user', { force: true })).toMatchObject({ ok: false, reason: 'provider-reset-pending', retryAt: 1000 })
    at = 1000
    expect(health.claim(codex, 'probe')).toBe(true)
    expect(health.failHalfOpen(codex, 'probe')).toBe(true)
    expect(health.list()[0]?.resetAt).toBe(1000)
    expect(health.list()[0]?.retryAt).toBeGreaterThan(at)
    at = health.list()[0]!.retryAt!
    expect(health.claim(codex, 'later')).toBe(true)
  })

  it('manual只授予所选故障域一个owner，不全清、不覆盖并发或另一provider', () => {
    const health = intRouteHealth(() => 0)
    health.record(codex, failure(codex, 'auth_invalid'))
    health.record(other, failure(other, 'pool_exhausted'))
    expect(health.claimManualRetry(codex, 'user')).toMatchObject({ ok: false, reason: 'cooldown-pending' })
    const permit = health.claimManualRetry(codex, 'user', { force: true })
    expect(permit).toMatchObject({ ok: true, keys: ['route:codex/gpt-6.1-sol'] })
    expect(health.claim(codex, 'user')).toBe(true)
    expect(health.claim(codex, 'another')).toBe(false)
    expect(health.claimManualRetry(codex, 'user', { force: true })).toMatchObject({ ok: false, reason: 'retry-in-flight' })
    expect(health.isAvailable(other)).toBe(false)
    health.release('user')
    expect(health.isAvailable(codex)).toBe(false)
    expect(health.claimManualRetry(codex, 'new-user', { force: true }).ok).toBe(true)
    health.succeeded(codex, 'new-user')
    expect(health.list()).toHaveLength(1)
    expect(health.list()[0]?.route.provider).toBe('other')
  })

  it('共享确切quota域保留隔离；认证、模型和上下文不能污染另一provider', () => {
    const a = { ...codex, policy: { quotaDomainId: 'shared-plan', quotaScope: 'plan' as const } }
    const b = { ...other, policy: { quotaDomainId: 'shared-plan', quotaScope: 'plan' as const } }
    const quota = intRouteHealth(() => 0)
    quota.record(a, failure(a, 'quota_exhausted'))
    expect(quota.isAvailable(b)).toBe(false)
    for (const kind of ['auth_invalid', 'model_unavailable', 'context_exceeded', 'capability_mismatch'] as const) {
      const health = intRouteHealth(() => 0)
      health.record(a, failure(a, kind))
      expect(health.isAvailable(b)).toBe(true)
    }
  })

  it('图像或effort不匹配不会隔离同模型的合法text/不同角色调用', () => {
    const health = intRouteHealth(() => 0)
    for (const code of ['IMAGE_UNSUPPORTED', 'UNSUPPORTED_OPTION', 'UNSUPPORTED_REASONING_EFFORT']) {
      health.record(codex, normalizeRouteFailure({ code }, codex))
      expect(health.list()).toEqual([])
      expect(health.claim({ ...codex, reasoningEffort: 'low' }, 'text-role')).toBe(true)
    }
  })

  it('同名文本池跨provider不共享封锁，巨额聚合hint不永久等待', () => {
    let at = 0
    const health = intRouteHealth(() => at)
    const raw = { code: 'RATE_LIMIT', message: 'pool "gpt-6.1-sol" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 }
    health.record(codex, normalizeRouteFailure(raw, codex))
    expect(health.isAvailable(other)).toBe(true)
    expect(health.list()[0]?.resetAt).toBeUndefined()
    expect(health.list()[0]?.retryAt).toBe(300_000)
    at = 300_000
    expect(health.claim(codex, 'new-logical-request')).toBe(true)
  })

  it('旧永久隔离snapshot恢复为有限探针；不恢复owner，保持已知provider reset', () => {
    let at = 600_001
    const health = intRouteHealth(() => at)
    health.restore([{ key: 'route:codex/gpt-6.1-sol', kind: 'auth_invalid', failedAt: 0, route: codex, halfOpenAgent: 'dead-process' }])
    expect(health.list()[0]?.retryAt).toBe(120_000)
    expect(health.list()[0]?.halfOpenAgent).toBeUndefined()
    expect(health.claim(codex, 'fresh')).toBe(true)
    health.release('fresh')
    const withReset = intRouteHealth(() => at)
    withReset.restore([{ key: 'route:codex/gpt-6.1-sol', kind: 'quota_exhausted', failedAt: 0, resetAt: 700_000, route: codex }])
    expect(withReset.claimManualRetry(codex, 'fresh', { force: true })).toMatchObject({ ok: false, reason: 'provider-reset-pending' })
    at = 700_000
    expect(withReset.claim(codex, 'fresh')).toBe(true)
  })

  it('retryCount有界、restore原子验证、related只返回独立快照', () => {
    const health = intRouteHealth(() => 0)
    for (let n = 0; n < 100; n++) health.record(codex, failure(codex, 'auth_invalid'))
    expect(health.list()[0]?.retryCount).toBe(32)
    expect(health.list()[0]?.retryAt).toBe(900_000)
    const before = health.list()
    for (const retryCount of [-1, 33, 1.5, Infinity]) expect(() => health.restore([{ ...before[0], retryCount }])).toThrow('invalid-route-health-entry')
    expect(() => health.restore([{ ...before[0], retryAt: Infinity }])).toThrow('invalid-route-health-entry')
    expect(health.list()).toEqual(before)
    health.getRelatedEntries(codex)[0]!.route.provider = 'mutated-snapshot'
    expect(health.list()[0]?.route.provider).toBe('codex')
  })

  it('新的稳定恢复字段通过真实FeatureState边界，非法时间/计数不能进入持久状态', () => {
    const health = intRouteHealth(() => 0)
    health.record(codex, failure(codex, 'pool_exhausted'))
    const saved = JSON.parse(JSON.stringify(health.list()))
    expect(validatePersistedRouteHealth(saved)).toBe(true)
    expect(validatePersistedRouteHealth([{ ...saved[0], retryAt: Infinity }])).toBe(false)
    expect(validatePersistedRouteHealth([{ ...saved[0], retryCount: 33 }])).toBe(false)
    const restored = intRouteHealth(() => 60_000)
    restored.restore(saved)
    expect(restored.claim(codex, 'restored-owner')).toBe(true)
    expect(validatePersistedRouteHealth(restored.list())).toBe(false) // live ownership must be stripped by persistence
  })
})
