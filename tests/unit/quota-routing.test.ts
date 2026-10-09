import { describe, expect, it } from 'vitest'
import { createQuotaReader, getQuotaAccountId, SUBSCRIPTION_QUOTA_PROVIDERS, type QuotaRouteInput, type QuotaRpcInvoke } from '../../src/quota.js'
import { createQuotaRouteEvaluator, getQuotaRouteDecision, getQuotaRouteMembership, getSubscriptionPoolConfiguration, stableOrderQuotaRoutes, type QuotaRoutingInput } from '../../src/quota-routing.js'

const route = { provider: 'codex', model: 'gpt' }
const window = (usedPercent: number, scope?: string, resetsAt: number | undefined = 100_000) => ({ kind: 'weekly', usedPercent, ...(scope === undefined ? {} : { scope }), ...(resetsAt === undefined ? {} : { resetsAt }) })
type AccountFixture = { key: string; models?: string[]; windows?: unknown[]; unavailable?: boolean; preferences?: Record<string, unknown> }
const inputFor = async (accounts: Record<string, AccountFixture[]> = { codex: [{ key: 'a' }, { key: 'b' }] }, pool: unknown = {}): Promise<QuotaRoutingInput> => {
  const invoke: QuotaRpcInvoke = async (method, payload) => method === 'subscriptions-auth.status' ? { providers: Object.fromEntries(SUBSCRIPTION_QUOTA_PROVIDERS.map((provider) => [provider, { accounts: (accounts[provider] ?? []).map((account, index) => ({ key: account.key, isDefault: index === 0 })) }])) } : { supported: true, windows: accounts[payload.provider!].find((account) => account.key === payload.account)?.windows ?? [window(100)] }
  const quota = await createQuotaReader({ invoke, now: () => 1000 }).read()
  return { quota, poolConfiguration: { source: 'dsh-config-editor', namespace: 'llm-subscriptions', pool }, registeredProviders: SUBSCRIPTION_QUOTA_PROVIDERS,
    providerSettings: Object.fromEntries(Object.entries(accounts).map(([provider, entries]) => [provider, { provider, settings: { accounts: Object.fromEntries(entries.filter((account) => account.preferences !== undefined).map((account) => [account.key, account.preferences])) }, accounts: entries.map((account) => ({ key: account.key, models: (account.models ?? ['gpt']).map((id) => ({ id, name: id })), ...(account.unavailable === undefined ? {} : { unavailable: account.unavailable }) })) }])), now: 1000 }
}

describe('公开宿主订阅配置投影', () => {
  it('只读取唯一active exact subscription的providers和pool已知字段，秘密getter从未访问', () => {
    let secretReads = 0
    const config = { providers: ['codex'], pool: { enabled: true, families: { gpt: [{ provider: 'codex', account: 'a', model: 'gpt', unrelatedSecret: 'NO-COPY' }] } }, get apiKey() { secretReads++; throw new Error('secret accessed') } }
    const entry = { options: { name: 'dsh-plugin-subscriptions', id: 'custom-subs' }, fiber: { state: 2, runtime: {}, config } }
    const result = getSubscriptionPoolConfiguration({ entries: () => [entry] })
    expect(result).toEqual({ source: 'dsh-config-editor', namespace: 'custom-subs', providers: ['codex'], pool: { enabled: true, families: { gpt: [{ provider: 'codex', account: 'a', model: 'gpt' }] } } })
    expect(secretReads).toBe(0)
    expect(JSON.stringify(result)).not.toContain('NO-COPY')
    config.pool.families.gpt[0].account = 'changed'
    expect(JSON.stringify(result)).not.toContain('changed')
  })
  it('缺失、多owner、非active、相似插件名称都unknown，不猜owner', () => {
    const entry = { options: { name: 'dsh-plugin-subscriptions', id: 's' }, fiber: { state: 2, runtime: {}, config: {} } }
    expect(getSubscriptionPoolConfiguration(undefined)).toBeUndefined()
    expect(getSubscriptionPoolConfiguration({ entries: () => [entry, entry] })).toBeUndefined()
    expect(getSubscriptionPoolConfiguration({ entries: () => [{ ...entry, fiber: { ...entry.fiber, state: 3 } }] })).toBeUndefined()
    expect(getSubscriptionPoolConfiguration({ entries: () => [{ ...entry, options: { ...entry.options, name: 'dsh-plugin-subscriptions-copy' } }] })).toBeUndefined()
  })
  it('保留特殊字典键且限制总成员，超限变unknown而不静默丢弃pool覆盖', () => {
    const families = JSON.parse('{"__proto__":[{"provider":"codex","account":"a","model":"gpt"}]}')
    const config: Record<string, unknown> = { pool: { families } }
    const editor = { entries: () => [{ options: { name: 'dsh-plugin-subscriptions', id: 's' }, fiber: { state: 2, runtime: {}, config } }] }
    const result = getSubscriptionPoolConfiguration(editor)!
    expect(Object.hasOwn((result.pool as any).families, '__proto__')).toBe(true)
    config.pool = { families: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`p-${i}`, Array.from({ length: 512 }, () => ({ provider: 'codex', account: 'a', model: 'gpt' }))])) }
    expect(getSubscriptionPoolConfiguration(editor)).toBeUndefined()
  })
})

describe('实际同账户/池成员的公开证据', () => {
  it('auto pools只含目录支持且pool偏好允许的账户', async () => {
    const input = await inputFor({ codex: [{ key: 'a' }, { key: 'disabled', preferences: { poolEnabled: false } }, { key: 'none', preferences: { poolModels: [] } }, { key: 'other', models: ['other'] }] })
    expect(getQuotaRouteMembership(route, input)).toMatchObject({ status: 'proven', source: 'public-pool-configuration', members: [{ provider: 'codex', model: 'gpt', accountId: getQuotaAccountId('codex', 'a') }] })
  })
  it.each([{ enabled: false }, { autoAccounts: false }, { autoFamilies: false }])('关闭池或auto后遵守default-first eligible fallback：%j', async (pool) => {
    const input = await inputFor({ codex: [{ key: 'default-disabled', preferences: { poolEnabled: false } }, { key: 'b' }, { key: 'c' }] }, pool)
    expect(getQuotaRouteMembership(route, input)).toMatchObject({ source: 'public-account-fallback', members: [{ accountId: getQuotaAccountId('codex', 'b') }] })
  })
  it('families覆盖auto成员，异provider的family成员按上游规则排除', async () => {
    const input = await inputFor({ codex: [{ key: 'a' }, { key: 'b' }], claude: [{ key: 'c' }] }, { families: { gpt: [{ provider: 'codex', account: 'b', model: 'gpt' }, { provider: 'claude', account: 'c', model: 'gpt' }] } })
    expect(getQuotaRouteMembership(route, input).members).toEqual([{ provider: 'codex', model: 'gpt', accountId: getQuotaAccountId('codex', 'b') }])
  })
  it('tiers覆盖同ID family并保留跨provider成员，不把heterogeneous池误当本provider所有账号', async () => {
    const input = await inputFor({ codex: [{ key: 'a' }, { key: 'b' }], claude: [{ key: 'c', models: ['claude-opus'] }] }, { families: { gpt: [{ provider: 'codex', account: 'a', model: 'gpt' }] }, tiers: { gpt: [{ provider: 'codex', account: 'b', model: 'gpt' }, { provider: 'claude', account: 'c', model: 'claude-opus' }] } })
    expect(getQuotaRouteMembership(route, input).members).toEqual([{ provider: 'codex', model: 'gpt', accountId: getQuotaAccountId('codex', 'b') }, { provider: 'claude', model: 'claude-opus', accountId: getQuotaAccountId('claude', 'c') }])
  })
  it('默认账户唯一才解析省略account；未知别名或目录故障不猜fallback', async () => {
    const input = await inputFor(undefined, { families: { gpt: [{ provider: 'codex', model: 'gpt' }] } })
    expect(getQuotaRouteMembership(route, input).members[0].accountId).toBe(getQuotaAccountId('codex', 'a'))
    input.quota.providers[0].accounts[1].isDefault = true
    expect(getQuotaRouteMembership(route, input).status).toBe('unknown')
    input.poolConfiguration!.pool = { families: { gpt: [{ provider: 'codex', account: 'legacy-alias', model: 'gpt' }] } }
    expect(getQuotaRouteMembership(route, input).status).toBe('unknown')
    expect(getQuotaRouteMembership(route, await inputFor({ codex: [{ key: 'a' }, { key: 'b', unavailable: true }] })).status).toBe('unknown')
  })
  it('status与catalog在login/logout期间不一致时降unknown，非本owner provider不引用额度', async () => {
    const input = await inputFor()
    ;(input.providerSettings.codex as any).accounts.pop()
    expect(getQuotaRouteMembership(route, input).status).toBe('unknown')
    const other = await inputFor()
    other.poolConfiguration!.providers = ['claude']
    expect(getQuotaRouteMembership(route, other).status).toBe('unknown')
  })
  it('独立账户允许pool禁用但必须independentEntry/目录/owner都证明', async () => {
    const input = await inputFor({ codex: [{ key: 'a:b', preferences: { poolEnabled: false, independentEntry: true } }] })
    const independent = { provider: 'codex', model: '~account:a%3Ab:gpt' }
    expect(getQuotaRouteMembership(independent, input)).toMatchObject({ status: 'proven', source: 'independent-account', members: [{ accountId: getQuotaAccountId('codex', 'a:b') }] })
    expect(getQuotaRouteMembership({ ...independent, model: '~account:a%3ab:gpt' }, input).status).toBe('unknown')
    input.poolConfiguration = undefined
    expect(getQuotaRouteMembership(independent, input).status).toBe('unknown')
  })
})

describe('自动路由依据不冒充实时准入权威', () => {
  it('全部明确成员各有适用100%窗口仅给soft hint，采样未知不hard skip', async () => {
    const decision = getQuotaRouteDecision(route, await inputFor())
    expect(decision).toMatchObject({ eligibility: 'unknown', hardSkip: false, preference: 'neutral', hint: 'reported-full', confidence: 'reported-possibly-cached', freshness: 'upstream-not-disclosed', sampledAt: null, scope: 'pool' })
    expect(decision.windowIds).toHaveLength(2)
  })
  it('95%不是耗尽；一个未知/部分/无deadline/过期成员禁止full hint', async () => {
    expect(getQuotaRouteDecision(route, await inputFor({ codex: [{ key: 'a', windows: [window(95)] }] })).hint).toBe('reported-capacity')
    for (const accounts of [
      [{ key: 'a' }, { key: 'b', windows: [] }],
      [{ key: 'a', windows: [window(100), { kind: 'weekly', usedPercent: NaN }] }],
      [{ key: 'a', windows: [{ kind: 'weekly', usedPercent: 100 }] }],
      [{ key: 'a', windows: [window(100, undefined, 900)] }]
    ]) expect(getQuotaRouteDecision(route, await inputFor({ codex: accounts })).hint).toBe('unknown')
  })
  it('使用上游明确windowApplies规则，Opus满额不污染Sonnet scoped窗口', async () => {
    const input = await inputFor({ claude: [{ key: 'a', models: ['claude-opus', 'claude-sonnet'], windows: [window(10), window(100, 'Opus'), window(20, 'Sonnet')] }] })
    expect(getQuotaRouteDecision({ provider: 'claude', model: 'claude-opus' }, input).hint).toBe('reported-full')
    expect(getQuotaRouteDecision({ provider: 'claude', model: 'claude-sonnet' }, input).hint).toBe('reported-capacity')
  })
  it('老本地快照和资源策略冲突为unknown，不能由缓存更新时间制造实时性', async () => {
    const input = await inputFor()
    input.now = input.quota.readAt + 30_000
    expect(getQuotaRouteDecision(route, input).hint).toBe('unknown')
    input.now = 1000
    input.quota.routes = [{ routeId: getQuotaRouteDecision(route, input).routeId, provider: 'codex', model: 'gpt', modelIdentity: 'wire', accessMode: 'unknown', status: 'unknown', policyConflict: true, mapping: 'unmapped', accountIds: [], windowIds: [], warnings: [] }]
    expect(getQuotaRouteDecision(route, input).hint).toBe('unknown')
  })
  it('success保护指纹不包含readAt或其他provider，包含本route窗口/成员/有效策略', async () => {
    const input = await inputFor({ codex: [{ key: 'a' }], claude: [{ key: 'c', windows: [window(10)] }] })
    const first = getQuotaRouteDecision(route, input)
    input.quota.readAt = 2000; input.now = 2000
    input.quota.providers[1].accounts[0].windows[0].usedPercent = 100
    expect(getQuotaRouteDecision(route, input).fingerprint).toBe(first.fingerprint)
    input.quota.providers[0].accounts[0].windows[0].usedPercent = 80
    expect(getQuotaRouteDecision(route, input).fingerprint).not.toBe(first.fingerprint)
    input.quota.providers[0].accounts[0].windows[0].usedPercent = 100
    input.poolConfiguration!.pool = { strategy: 'priority' }
    expect(getQuotaRouteDecision(route, input).fingerprint).not.toBe(first.fingerprint)
  })
  it('同一上游lastSnapshot从本地过期变为重新读取时，hint变化不改变原数据指纹', async () => {
    const input = await inputFor()
    const full = getQuotaRouteDecision(route, input)
    input.now = 32_000
    const stale = getQuotaRouteDecision(route, input)
    expect(stale.hint).toBe('unknown')
    input.quota.readAt = 32_000
    const refreshedSameWindows = getQuotaRouteDecision(route, input)
    expect(refreshedSameWindows.hint).toBe('reported-full')
    expect(stale.fingerprint).toBe(full.fingerprint)
    expect(refreshedSameWindows.fingerprint).toBe(full.fingerprint)
  })
  it('scoped evaluator与逐次计算逐字段一致，并保持一次批次快照；下次批次重新读取变化', async () => {
    const input = await inputFor({ codex: [{ key: 'a', preferences: { independentEntry: true } }], claude: [{ key: 'c', models: ['sonnet'], windows: [window(10)] }] }, { tiers: { tier: [{ provider: 'codex', account: 'a', model: 'gpt' }, { provider: 'claude', account: 'c', model: 'sonnet' }] } })
    const routes = [route, { provider: 'codex', model: 'tier' }, { provider: 'codex', model: '~account:a:gpt' }, { provider: 'deepseek-official', model: 'api' }]
    const evaluate = createQuotaRouteEvaluator(input)
    expect(routes.map(evaluate)).toEqual(routes.map((candidate) => getQuotaRouteDecision(candidate, input)))
    const before = evaluate(route)
    input.quota.providers[0].accounts[0].windows[0].usedPercent = 20
    ;(input.providerSettings.codex as any).accounts[0].models = []
    input.poolConfiguration!.pool = { enabled: false }
    expect(evaluate(route)).toEqual(before)
    expect(createQuotaRouteEvaluator(input)(route).membership.status).toBe('unknown')
    expect(getQuotaRouteDecision(route, input).membership.status).toBe('unknown')
  })
})

describe('只在连续订阅段稳定自动排序', () => {
  it('reported-full后移但始终API前尝试，unknown和已报告容量保原序', async () => {
    const input = await inputFor({ codex: [{ key: 'a' }], claude: [{ key: 'b', models: ['sonnet'], windows: [window(10)] }] })
    const routes = [route, { provider: 'claude', model: 'sonnet' }, { provider: 'opencode-go', model: 'g' }, { provider: 'deepseek-official', model: 'deepseek' }]
    const ordered = stableOrderQuotaRoutes(routes, (candidate) => getQuotaRouteDecision(candidate, input))
    expect(ordered).toEqual([routes[1], routes[2], routes[0], routes[3]])
    expect(new Set(ordered)).toEqual(new Set(routes))
  })
  it('protected preferred/manual保持原位，非subscription路由形成不可跨越边界', async () => {
    const input = await inputFor()
    const routes: QuotaRouteInput[] = [route, { provider: 'codex', model: 'unknown' }, { provider: 'custom-api', model: 'x' }, route, { provider: 'codex', model: 'another' }]
    const getDecision = (candidate: QuotaRouteInput) => getQuotaRouteDecision(candidate, input)
    expect(stableOrderQuotaRoutes(routes, getDecision, [route])).toEqual(routes)
    expect(stableOrderQuotaRoutes(routes, getDecision)).toEqual([routes[1], routes[0], routes[2], routes[4], routes[3]])
    expect(stableOrderQuotaRoutes([route, route], getDecision)).toHaveLength(2)
  })
})
