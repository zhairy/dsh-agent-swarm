import { describe, expect, it } from 'vitest'
import { intRouteHealth, MAX_ROUTE_HEALTH_KEYS, validateRouteHealthSnapshot, type RouteHealthSnapshot } from '../../src/route-health.js'
import { normalizeRouteFailure, type FailureKind } from '../../src/provider-policy.js'
import type { RouteInfo } from '../../src/routes.js'
import { validatePersistedRouteHealth } from '../../src/feature-session.js'

const codex: RouteInfo = { provider: 'codex', model: 'gpt-6.1-sol' }
const other: RouteInfo = { provider: 'other', model: 'gpt-6.1-sol' }
const failure = (route: RouteInfo, kind: FailureKind) => normalizeRouteFailure({ kind }, route)

describe('RouteHealth受控恢复，不把暂时故障永久封锁', () => {
  it('真实force探针成功后，另一个根的旧隔离snapshot不能复活已恢复资源', () => {
    let at = 100
    const health = intRouteHealth(() => at)
    health.record(codex, failure(codex, 'pool_exhausted'))
    const oldRoot = health.getSnapshot()
    const legacyRoot = health.list()
    at = 101
    expect(health.claimManualRetry(codex, 'actual-request', { force: true }).ok).toBe(true)
    expect(health.succeeded(codex, 'wrong-owner')).toBe(false)
    expect(health.succeeded(codex, 'actual-request')).toBe(true)
    expect(health.getSnapshot().cleared).toHaveLength(1)
    expect(health.getSnapshot().cleared[0]).toMatchObject({ failedAt: 100, clearedAt: 101 })
    health.restore(oldRoot)
    health.restore(legacyRoot)
    expect(health.list()).toEqual([])
    expect(health.isAvailable(codex)).toBe(true)
  })

  it('成功墓碑跨进程恢复，两种根加载顺序都抑制同次/更旧失败', () => {
    const first = intRouteHealth(() => 10)
    first.record(codex, failure(codex, 'auth_invalid'))
    const failed = first.getSnapshot()
    first.claimManualRetry(codex, 'probe', { force: true })
    first.succeeded(codex, 'probe')
    const success = first.getSnapshot()
    for (const snapshots of [[failed, success], [success, failed]]) {
      const restarted = intRouteHealth(() => 11)
      for (const snapshot of snapshots) restarted.restore(JSON.parse(JSON.stringify(snapshot)))
      expect(restarted.list()).toEqual([])
      expect(restarted.getSnapshot().cleared).toEqual(success.cleared)
      expect(restarted.isAvailable(codex)).toBe(true)
    }
  })

  it('同毫秒恢复后真实新失败仍生效，旧成功snapshot不会吞掉它', () => {
    const health = intRouteHealth(() => 10)
    health.record(codex, failure(codex, 'auth_invalid'))
    health.claimManualRetry(codex, 'first', { force: true }); health.succeeded(codex, 'first')
    const success = health.getSnapshot()
    health.record(codex, failure(codex, 'auth_invalid'))
    const later = health.getSnapshot()
    expect(later.entries[0]!.failedAt).toBeGreaterThan(success.cleared[0]!.failedAt)
    expect(later.entries[0]!.failureId).not.toBe(success.cleared[0]!.failureId)
    health.restore(success)
    expect(health.isAvailable(codex)).toBe(false)
    const restarted = intRouteHealth(() => 10)
    restarted.restore(success); restarted.restore(later)
    expect(restarted.isAvailable(codex)).toBe(false)
    restarted.restore(success)
    expect(restarted.list()[0]!.failureId).toBe(later.entries[0]!.failureId)
  })

  it('shared quota和pool所有alias同次清除；不同账号故障不被全局success时间吞掉', () => {
    const a = { ...codex, policy: { quotaDomainId: 'plan-a', quotaScope: 'plan' as const } }
    const same = { ...other, policy: { quotaDomainId: 'plan-a', quotaScope: 'plan' as const } }
    const different = { provider: 'another', model: 'same-model', policy: { quotaDomainId: 'plan-b', quotaScope: 'plan' as const } }
    const health = intRouteHealth(() => 100)
    health.record(a, failure(a, 'quota_exhausted'))
    health.record(different, failure(different, 'quota_exhausted'))
    const old = health.getSnapshot()
    health.claimManualRetry(same, 'real-probe', { force: true }); health.succeeded(same, 'real-probe')
    health.restore(old)
    expect(health.isAvailable(a)).toBe(true)
    expect(health.isAvailable(codex)).toBe(true)
    expect(health.isAvailable(different)).toBe(false)
    expect(health.getSnapshot().cleared.map((marker) => marker.key)).toContain('domain:plan-a')
    const pool = { ...codex, policy: { poolId: 'codex:pool' } }
    health.record(pool, failure(pool, 'pool_exhausted'))
    const oldPool = health.getSnapshot()
    health.claimManualRetry(pool, 'pool-probe', { force: true }); health.succeeded(pool, 'pool-probe')
    health.restore(oldPool)
    expect(health.isAvailable(pool)).toBe(true)
    expect(health.getSnapshot().cleared.map((marker) => marker.key)).toContain('pool:codex:pool')
  })

  it('clear和陈旧成功记录都不能越过已知provider reset', () => {
    let at = 0
    const health = intRouteHealth(() => at)
    health.record(codex, normalizeRouteFailure({ code: 'QUOTA', resetAt: new Date(1000).toISOString() }, codex))
    health.clear(); health.clear(health.list()[0]!.key)
    expect(health.claimManualRetry(codex, 'force', { force: true }).reason).toBe('provider-reset-pending')
    const marker = { key: health.list()[0]!.key, failedAt: 100, clearedAt: 100 }
    health.restore({ schemaVersion: 1, entries: [], cleared: [marker] })
    expect(health.isAvailable(codex)).toBe(false)
    at = 1000
    health.clear()
    expect(health.list()).toEqual([])
  })

  it('新增failure保留原资源尚未到期的provider reset floor', () => {
    const health = intRouteHealth(() => 0)
    health.record(codex, normalizeRouteFailure({ code: 'QUOTA', resetAt: new Date(1000).toISOString() }, codex))
    health.record(codex, failure(codex, 'auth_invalid'))
    expect(health.claimManualRetry(codex, 'force', { force: true })).toMatchObject({ ok: false, reason: 'provider-reset-pending', retryAt: 1000 })
  })

  it('live owner不入durable snapshot，失败恢复不能覆盖当前half-open', () => {
    const health = intRouteHealth(() => 10)
    health.record(codex, failure(codex, 'auth_invalid'))
    const failed = health.getSnapshot()
    health.claimManualRetry(codex, 'owner', { force: true })
    expect(health.getSnapshot().entries[0]).not.toHaveProperty('halfOpenAgent')
    expect(validateRouteHealthSnapshot(health.getSnapshot())).toBe(true)
    expect(validateRouteHealthSnapshot(health.list())).toBe(false)
    health.restore(failed)
    expect(health.list()[0]!.halfOpenAgent).toBe('owner')
    expect(health.claimManualRetry(codex, 'other-owner', { force: true }).reason).toBe('retry-in-flight')
  })

  it('墓碑/entry原子校验，容量满不LRU遗忘恢复事实或部分改写', () => {
    const health = intRouteHealth(() => 10)
    const full: RouteHealthSnapshot = { schemaVersion: 1, entries: [], cleared: Array.from({ length: MAX_ROUTE_HEALTH_KEYS }, (_, index) => ({ key: `route:p/m-${index}`, failedAt: 0, clearedAt: 1 })) }
    expect(validateRouteHealthSnapshot(full)).toBe(true)
    health.restore(full)
    const before = health.getSnapshot()
    expect(() => health.record(codex, failure(codex, 'auth_invalid'))).toThrow('route-health-capacity-recovery-required')
    expect(() => health.restore({ schemaVersion: 1, entries: [], cleared: [...full.cleared, { key: 'route:new/model', failedAt: 1, clearedAt: 2 }] })).toThrow()
    expect(health.getSnapshot()).toEqual(before)
    expect(validateRouteHealthSnapshot({ ...full, cleared: [{ key: 'route:p/m', failedAt: 2, clearedAt: 1 }] })).toBe(false)
    expect(() => health.restore({ schemaVersion: 1, entries: [], cleared: [{ ...full.cleared[0], secret: 'not-allowed' }] })).toThrow('invalid-route-health-clear')
    const existing = { provider: 'p', model: 'm-0' }
    health.record(existing, failure(existing, 'auth_invalid'))
    health.claimManualRetry(existing, 'probe', { force: true }); health.succeeded(existing, 'probe')
    expect(health.getSnapshot().cleared).toHaveLength(MAX_ROUTE_HEALTH_KEYS)
    expect(health.list()).toEqual([])
  })

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
    expect(validatePersistedRouteHealth([{ ...saved[0], route: { ...codex, provider: '__proto__' } }])).toBe(false)
    expect(validatePersistedRouteHealth([{ ...saved[0], route: { ...codex, policy: { quotaDomainId: 'constructor' } } }])).toBe(false)
    expect(validatePersistedRouteHealth([{ ...saved[0], retryAt: Infinity }])).toBe(false)
    expect(validatePersistedRouteHealth([{ ...saved[0], retryCount: 33 }])).toBe(false)
    const restored = intRouteHealth(() => 60_000)
    restored.restore(saved)
    expect(restored.claim(codex, 'restored-owner')).toBe(true)
    expect(validatePersistedRouteHealth(restored.list())).toBe(false) // live ownership must be stripped by persistence
  })
})
