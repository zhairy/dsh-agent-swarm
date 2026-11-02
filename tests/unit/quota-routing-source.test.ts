import { describe, expect, it, vi } from 'vitest'
import { createQuotaRoutingSource } from '../../src/quota-routing-source.js'
import { getQuotaAccountId, normalizeSubscriptionUsage, type QuotaProvider, type QuotaView } from '../../src/quota.js'
import type { QuotaPoolConfiguration } from '../../src/quota-routing.js'
const a = { provider: 'codex', model: 'gpt-a' }, b = { provider: 'claude', model: 'claude-b' }, api = { provider: 'deepseek-official', model: 'ds' }
const fixture = () => {
  let time = 1000
  const configuration: QuotaPoolConfiguration = { source: 'dsh-config-editor', namespace: 'subscriptions', providers: ['codex', 'claude'], pool: { enabled: true, autoAccounts: true, strategy: 'quota_aware' } }
  const providers = (['codex', 'claude'] as const).map(provider => ({ provider, status: 'reported', readAt: time, warnings: [], accounts: [{ id: getQuotaAccountId(provider, provider + '-account'), label: 'Account 1', isDefault: true, readAt: time, sampledAt: null, freshness: 'upstream-not-disclosed', ...normalizeSubscriptionUsage(provider, provider + '-account', { supported: true, windows: [{ kind: 'session', usedPercent: provider === 'codex' ? 100 : 20, resetsAt: 1_000_000 }] }, time) }] })) as QuotaProvider[]
  const view: QuotaView = { source: 'dsh-plugin-subscriptions', readAt: time, sampledAt: null, freshness: 'upstream-not-disclosed', providers, routes: [], warnings: [], delivery: 'read', cacheAgeMs: 0, refreshRequested: false, refreshJoinedExisting: false }
  const reader = { read: vi.fn(async () => structuredClone(view)), invalidate: vi.fn() }
  const invoke = vi.fn(async (_method: unknown, payload: any) => ({ provider: payload.provider, settings: { accounts: {} }, accounts: [{ key: payload.provider + '-account', models: [{ id: payload.provider === 'codex' ? a.model : b.model }] }] }))
  const source = createQuotaRoutingSource({ reader, invoke, getPoolConfiguration: () => configuration, getRegisteredProviders: () => ['codex', 'claude', 'deepseek-official'], available: () => true, now: () => time, waitMs: 50 })
  return { source, reader, invoke, view, configuration, advance: (ms: number) => { time += ms; view.readAt = time } }
}
describe('automatic quota source composition', () => {
  it('automatically defers complete reported-full subscription inside its segment, never after API', async () => {
    const f = fixture()
    expect(await f.source.orderQuotaRoutes([a, b, api])).toEqual([b, a, api])
    expect(await f.source.orderQuotaRoutes([a, b, api])).toEqual([b, a, api])
    expect(f.reader.read).toHaveBeenCalledTimes(1)
    expect(f.invoke).toHaveBeenCalledTimes(2)
    expect(f.source.diagnostics()).toMatchObject({ status: 'observed', reordered: true, authoritativeQuota: false })
  })
  it('does not allow an automatic hint to move a protected preferred/manual trial', async () => {
    const f = fixture()
    expect(await f.source.orderQuotaRoutes([a, b, api], undefined, [a])).toEqual([a, b, api])
  })
  it('actual success overrides the same stale full fingerprint across re-reads; new window facts are considered', async () => {
    const f = fixture()
    await f.source.orderQuotaRoutes([a, b, api]); f.source.succeeded(a)
    expect(await f.source.orderQuotaRoutes([a, b, api])).toEqual([a, b, api])
    f.advance(1); f.source.invalidate()
    expect(await f.source.orderQuotaRoutes([a, b, api])).toEqual([a, b, api])
    f.view.providers[0]!.accounts[0]!.windows[0]!.resetsAt = 2_000_000
    f.source.invalidate()
    expect(await f.source.orderQuotaRoutes([a, b, api])).toEqual([b, a, api])
  })
  it('policy conflicts for the same quota identity cannot choose one role declaration as authority', async () => {
    const f = fixture()
    const variant = { ...a, policy: { accessMode: 'metered_api' as const } }
    expect(await f.source.orderQuotaRoutes([a, b, variant, api])).toEqual([a, b, variant, api])
    expect(f.source.diagnostics()).toMatchObject({ decisions: [expect.objectContaining({ hint: 'unknown' }), expect.anything(), expect.anything()] })
  })
  it('configuration changes during awaited source reading return unknown without persisting the stale projection', async () => {
    const f = fixture(), pending = f.source.orderQuotaRoutes([a, b, api])
    f.configuration.pool = { enabled: false }
    expect(await pending).toEqual([a, b, api])
    expect(f.source.diagnostics()).toMatchObject({ status: 'unknown-context-changed' })
  })
  it('timeouts and source failures keep the declared chain; cancellation does not dispatch source work', async () => {
    const invoke = vi.fn(async () => new Promise<never>(() => {}))
    const reader = { read: vi.fn(async () => new Promise<never>(() => {})) }
    const source = createQuotaRoutingSource({ reader, invoke, getPoolConfiguration: () => ({ source: 'dsh-config-editor', namespace: 'subscriptions', pool: {} }), getRegisteredProviders: () => ['codex'], available: () => true, waitMs: 5 })
    const controller = new AbortController(); controller.abort()
    await expect(source.orderQuotaRoutes([a, b, api], controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(reader.read).not.toHaveBeenCalled()
    expect(await source.orderQuotaRoutes([a, b, api])).toEqual([a, b, api])
    expect(source.diagnostics()).toMatchObject({ status: 'unknown-timeout' })
    source.dispose(); source.succeeded(a)
    expect(await source.orderQuotaRoutes([a, b, api])).toEqual([a, b, api])
    expect(source.diagnostics()).toMatchObject({ status: 'disposed' })
  })
})
