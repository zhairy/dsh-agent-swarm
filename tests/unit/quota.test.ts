import { describe, expect, it, vi } from 'vitest'
import { createQuotaReader, createSubscriptionQuotaInvoker, getQuotaAccountId, mapQuotaRoutes, normalizeSubscriptionUsage, QUOTA_FRESHNESS_NOTICE, SUBSCRIPTION_QUOTA_PROVIDERS, type QuotaRpcInvoke } from '../../src/quota.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'
import { DEFAULT_UPGRADES } from '../../src/upgrade.js'

const status = (accounts: Record<string, { key: string; isDefault: boolean }[]> = {}) => ({ providers: Object.fromEntries(SUBSCRIPTION_QUOTA_PROVIDERS.map((provider) => [provider, { busy: false, accounts: accounts[provider] ?? [] }])) })
const usage = (usedPercent = 42) => ({ supported: true, windows: [{ kind: 'session', usedPercent, resetsAt: 20_000 }, { kind: 'weekly', usedPercent: 12, resetsAt: 100_000 }] })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('供应商额度的准确边界', () => {
  it('保留真实百分比和原始窗口类别，不推算token、金额或5小时长度', () => {
    const result = normalizeSubscriptionUsage('codex', 'a', usage(37.125), 10_000)
    expect(result.status).toBe('reported')
    expect(result.windows).toEqual([
      expect.objectContaining({ kind: 'session', unit: 'percent', usedPercent: 37.125, resetsAt: 20_000, resetState: 'future' }),
      expect.objectContaining({ kind: 'weekly', usedPercent: 12 })
    ])
    expect(JSON.stringify(result)).not.toMatch(/remainingTokens|tokenLimit|durationMs|remainingMoney/)
    expect(result.warnings).toContain(QUOTA_FRESHNESS_NOTICE)
  })

  it('两个账号的同类窗口独立，账户weekly和模型weekly独立保留', () => {
    const raw = { supported: true, windows: [{ kind: 'weekly', usedPercent: 31 }, { kind: 'weekly', scope: 'Opus', usedPercent: 67 }] }
    const a = normalizeSubscriptionUsage('claude', 'a', raw, 10)
    const b = normalizeSubscriptionUsage('claude', 'b', raw, 10)
    expect(a.windows).toHaveLength(2)
    expect(a.windows.map((window) => window.usedPercent)).toEqual([31, 67])
    expect(new Set([...a.windows, ...b.windows].map((window) => window.id)).size).toBe(4)
    expect(a).not.toHaveProperty('total')
  })

  it('完全相同窗口去重，冲突窗口明确拒绝，不能任取一个', () => {
    const same = { kind: 'weekly', usedPercent: 30, resetsAt: 1000 }
    expect(normalizeSubscriptionUsage('codex', 'a', { supported: true, windows: [same, same] }, 10).windows).toHaveLength(1)
    expect(normalizeSubscriptionUsage('codex', 'a', { supported: true, windows: [same, { ...same, usedPercent: 70 }] }, 10)).toMatchObject({ status: 'error', windows: [] })
  })

  it('非法/缺失/空窗口不是0消耗或者无限，部分非法保留可用窗口并提示不完整', () => {
    for (const raw of [undefined, { supported: true }, { supported: true, windows: [] }, { supported: true, windows: [{ kind: 'session', usedPercent: NaN }] }]) {
      const result = normalizeSubscriptionUsage('codex', 'a', raw, 10)
      expect(result.status).not.toBe('reported')
      expect(result.windows).toEqual([])
    }
    const result = normalizeSubscriptionUsage('codex', 'a', { supported: true, windows: [{ kind: 'weekly', usedPercent: 40 }, { kind: 'session', usedPercent: 101 }] }, 10)
    expect(result.status).toBe('reported')
    expect(result.windows).toHaveLength(1)
    expect(result.warnings.join(' ')).toContain('不是完整')
  })

  it('100%上报值原样保留，但过去reset明确过期且不认定恢复', () => {
    const result = normalizeSubscriptionUsage('claude', 'a', { supported: true, windows: [{ kind: 'session', usedPercent: 100, resetsAt: 1000 }] }, 2000)
    expect(result.windows[0]).toMatchObject({ usedPercent: 100, resetState: 'elapsed' })
    expect(result.warnings.join(' ')).toContain('不能据此认定')
  })

  it('明确unsupported不能表示为100%剩余', () => {
    expect(normalizeSubscriptionUsage('copilot', 'a', { supported: false }, 1)).toMatchObject({ status: 'unsupported', windows: [] })
  })
})

describe('公开订阅RPC读取与映射', () => {
  it('status全提供方只请求一次，usage按账户只请求一次，不公开邮箱/账户原始key', async () => {
    const invoke = vi.fn<QuotaRpcInvoke>(async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key: 'private@example.test', isDefault: true }, { key: 'b', isDefault: false }], claude: [{ key: 'c', isDefault: true }] }) : usage())
    const view = await createQuotaReader({ invoke, now: () => 1000 }).read({ force: true })
    expect(invoke.mock.calls.filter(([method]) => method === 'subscriptions-auth.status')).toHaveLength(1)
    expect(invoke.mock.calls.filter(([method]) => method === 'subscriptions-auth.usage')).toHaveLength(3)
    expect(invoke.mock.calls.filter(([method]) => method === 'subscriptions-auth.usage').every(([, payload]) => payload.force === true)).toBe(true)
    expect(JSON.stringify(view)).not.toContain('private@example.test')
    expect(view.providers[0].accounts[0]).toMatchObject({ label: '账户 1', id: getQuotaAccountId('codex', 'private@example.test'), readAt: 1000, sampledAt: null, freshness: 'upstream-not-disclosed' })
  })

  it('全提供方共享并发4上限，不是各自并发4', async () => {
    let active = 0
    let peak = 0
    const invoke: QuotaRpcInvoke = async (method) => {
      if (method === 'subscriptions-auth.status') return status(Object.fromEntries(SUBSCRIPTION_QUOTA_PROVIDERS.map((provider) => [provider, Array.from({ length: 3 }, (_, i) => ({ key: `${provider}-${i}`, isDefault: i === 0 }))])))
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setImmediate(resolve))
      active--
      return usage()
    }
    const result = await createQuotaReader({ invoke }).read()
    expect(peak).toBe(4)
    expect(result.providers.flatMap((provider) => provider.accounts)).toHaveLength(15)
  })

  it('总账户数上限不会隐式遗漏还宣称完整，也不为超限提供方发usage请求', async () => {
    const invoke = vi.fn<QuotaRpcInvoke>(async (method) => method === 'subscriptions-auth.status' ? status({ codex: Array.from({ length: 128 }, (_, i) => ({ key: `a-${i}`, isDefault: i === 0 })), claude: [{ key: 'overflow', isDefault: true }] }) : usage())
    const view = await createQuotaReader({ invoke }).read()
    expect(view.providers.flatMap((provider) => provider.accounts)).toHaveLength(128)
    expect(view.providers[1]).toMatchObject({ status: 'unknown', accounts: [] })
    expect(view.providers[1].warnings.join(' ')).toContain('视图不完整')
    expect(invoke.mock.calls.filter(([method]) => method === 'subscriptions-auth.usage')).toHaveLength(128)
  })

  it('全视图最多保留1024窗口，溢出账户明确unknown而不截断假装完整', async () => {
    const invoke: QuotaRpcInvoke = async (method) => method === 'subscriptions-auth.status' ? status({ codex: Array.from({ length: 9 }, (_, i) => ({ key: `a-${i}`, isDefault: i === 0 })) }) : { supported: true, windows: Array.from({ length: 128 }, (_, i) => ({ kind: 'other', scope: `scope-${i}`, usedPercent: 30 })) }
    const view = await createQuotaReader({ invoke }).read()
    expect(view.providers.flatMap((provider) => provider.accounts).flatMap((account) => account.windows)).toHaveLength(1024)
    const overflow = view.providers[0].accounts.filter((account) => account.status === 'unknown')
    expect(overflow).toHaveLength(1)
    expect(overflow[0].warnings.join(' ')).toContain('视图不完整')
    expect(view.providers[0].warnings.join(' ')).toContain('不代表完整')
  })

  it('缓存保留原读取时间，force加入正在进行请求而不假称额外强刷成功', async () => {
    let now = 1000
    const gate = deferred<unknown>()
    const invoke = vi.fn<QuotaRpcInvoke>(async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key: 'a', isDefault: true }] }) : gate.promise)
    const reader = createQuotaReader({ invoke, now: () => now })
    const first = reader.read()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    const forced = reader.read({ force: true })
    gate.resolve(usage())
    const [a, b] = await Promise.all([first, forced])
    expect(a.delivery).toBe('read')
    expect(b).toMatchObject({ delivery: 'shared-read', refreshRequested: true, refreshJoinedExisting: true, sampledAt: null })
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke.mock.calls[1][1].force).toBe(false)
    now = 2000
    a.providers[0].accounts[0].windows[0].usedPercent = 999
    const cached = await reader.read()
    expect(cached).toMatchObject({ delivery: 'local-cache', readAt: 1000, cacheAgeMs: 1000 })
    expect(cached.providers[0].accounts[0].windows[0].usedPercent).toBe(42)
    await reader.read({ force: true })
    expect(invoke).toHaveBeenCalledTimes(4)
    expect(invoke.mock.calls[3][1].force).toBe(true)
    now = 33_000
    await reader.read()
    expect(invoke).toHaveBeenCalledTimes(6)
  })

  it('取消单个等待者不取消共享读取，另一个调用者仍收到结果', async () => {
    const gate = deferred<unknown>()
    const invoke = vi.fn<QuotaRpcInvoke>(async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key: 'a', isDefault: true }] }) : gate.promise)
    const reader = createQuotaReader({ invoke })
    const controller = new AbortController()
    const first = reader.read({ signal: controller.signal })
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = reader.read()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    controller.abort()
    await rejected
    expect(invoke.mock.calls[1][2].aborted).toBe(false)
    gate.resolve(usage())
    expect((await second).providers[0].accounts[0].status).toBe('reported')
  })

  it('提供方失败和单账户失败独立；错误正文不泄露，失败不当耗尽', async () => {
    const invoke: QuotaRpcInvoke = async (method, payload) => {
      if (method === 'subscriptions-auth.status') return status({ codex: [{ key: 'a', isDefault: true }, { key: 'b', isDefault: false }] })
      if (payload.account === 'a') throw new Error('Bearer SECRET private@example.test exhausted')
      return usage(99)
    }
    const result = await createQuotaReader({ invoke }).read()
    expect(result.providers[0].status).toBe('reported')
    expect(result.providers[0].accounts.map((account) => account.status)).toEqual(['error', 'reported'])
    expect(result.providers[0].warnings.join(' ')).toContain('不代表完整')
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private@example/)
  })

  it('status内部返回detail错误不能伪装成正常退出登录，重复账户不重复统计', async () => {
    const raw = status()
    Object.assign(raw.providers.codex, { detail: 'secret error' })
    raw.providers.claude.accounts = [{ key: 'a', isDefault: true }, { key: 'a', isDefault: true }]
    const invoke = vi.fn<QuotaRpcInvoke>(async () => raw)
    const view = await createQuotaReader({ invoke }).read()
    expect(view.providers[0].status).toBe('error')
    expect(view.providers[1].status).toBe('error')
    expect(view.providers[2].status).toBe('logged-out')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(view)).not.toContain('secret error')
  })

  it('精确独立账户共享窗口引用一次，scope不做模型名称模糊匹配', async () => {
    const invoke: QuotaRpcInvoke = async (method) => method === 'subscriptions-auth.status' ? status({ claude: [{ key: 'a:b', isDefault: true }] }) : { supported: true, windows: [{ kind: 'weekly', usedPercent: 30 }, { kind: 'weekly', scope: 'Opus', usedPercent: 70 }] }
    const view = await createQuotaReader({ invoke }).read({ routes: [{ provider: 'claude', model: '~account:a%3Ab:claude-opus' }, { provider: 'claude', model: '~account:a%3Ab:claude-sonnet' }] })
    expect(view.routes.map((route) => route.mapping)).toEqual(['independent-account', 'independent-account'])
    expect(view.routes[0].windowIds).toEqual(view.routes[1].windowIds)
    expect(view.routes[0].windowIds).toHaveLength(1)
    expect(view.providers[1].accounts[0].windows).toHaveLength(2)
  })

  it('普通模型只关联提供方账户管理视图，绝不宣称禁用pool账号参与或给出汇总模型额度', async () => {
    const invoke: QuotaRpcInvoke = async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key: 'a', isDefault: true }, { key: 'b', isDefault: false }] }) : usage()
    const view = await createQuotaReader({ invoke }).read({ routes: [{ provider: 'codex', model: 'gpt-6-astra' }] })
    expect(view.routes[0]).toMatchObject({ status: 'unknown', mapping: 'provider-accounts', windowIds: [] })
    expect(view.routes[0].warnings.join(' ')).toContain('未披露')
  })

  it('非法百分号、非canonical编码、缺失账户不回到default', async () => {
    const invoke: QuotaRpcInvoke = async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key: 'a:b', isDefault: true }] }) : usage()
    const view = await createQuotaReader({ invoke }).read({ routes: ['~account:a%3ab:gpt', '~account:%zz:gpt', '~account:missing:gpt', '~account:a%3Ab:'].map((model) => ({ provider: 'codex', model })) })
    for (const route of view.routes) expect(route).toMatchObject({ status: 'unknown', mapping: 'unmapped', accountIds: [], windowIds: [] })
  })

  it('独立账户模型ID内嵌的邮箱也脱敏，两个账户仍用opaque routeId区分', async () => {
    const key = 'private@example.test'
    const invoke: QuotaRpcInvoke = async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key, isDefault: true }, { key: 'other', isDefault: false }] }) : usage()
    const view = await createQuotaReader({ invoke }).read({ routes: [{ provider: 'codex', model: `~account:${encodeURIComponent(key)}:gpt-6` }, { provider: 'codex', model: '~account:other:gpt-6' }, { provider: 'codex', model: `~account:${encodeURIComponent(key)}:%ZZ` }] })
    expect(view.routes[0]).toMatchObject({ model: 'gpt-6', modelIdentity: 'account-redacted', mapping: 'independent-account' })
    expect(view.routes[1].model).toBe('gpt-6')
    expect(view.routes[0].routeId).not.toBe(view.routes[1].routeId)
    expect(JSON.stringify(view)).not.toMatch(/private|example|%40|~account:/)
  })

  it('API、Qwen、Go无公开接口时均unknown，不把有计费方式当有无限余额', () => {
    const views = mapQuotaRoutes([{ provider: 'deepseek-official', model: 'deepseek-flash' }, { provider: 'qwen-token-plan-cn', model: 'glm' }, { provider: 'opencode-go', model: 'glm' }, { provider: 'jev', model: 'jev' }], [])
    expect(views.every((route) => route.status === 'unknown' && route.mapping === 'unmapped' && route.windowIds.length === 0)).toBe(true)
    expect(views.map((route) => route.accessMode)).toEqual(['metered_api', 'subscription', 'subscription', 'judgment_api'])
  })

  it('默认常规/升级全链按真实提供方模型身份去重，不产生重复routeId/Reactkey', () => {
    const routes = [...Object.values(DEFAULT_ROUTE_CHAINS).flat(), ...Object.values(DEFAULT_UPGRADES).flatMap((upgrade) => upgrade?.chain ?? [])]
    const views = mapQuotaRoutes(routes, [])
    expect(views.length).toBe(new Set(routes.map((route) => JSON.stringify([route.provider, route.model]))).size)
    expect(new Set(views.map((route) => route.routeId)).size).toBe(views.length)
  })

  it('同身份的有效资源策略冲突仅降计费标签unknown，不污染账户真实上报值', async () => {
    const invoke: QuotaRpcInvoke = async (method) => method === 'subscriptions-auth.status' ? status({ codex: [{ key: 'a', isDefault: true }] }) : usage(37.125)
    const view = await createQuotaReader({ invoke }).read({ routes: [
      { provider: 'codex', model: '~account:a:gpt', policy: { accessMode: 'subscription', quotaScope: 'account', quotaDomainId: 'd1' } },
      { provider: 'codex', model: '~account:a:gpt', policy: { quotaDomainId: 'd2', quotaScope: 'account', accessMode: 'metered_api' } }
    ] })
    expect(view.routes).toHaveLength(1)
    expect(view.routes[0]).toMatchObject({ accessMode: 'unknown', mapping: 'independent-account' })
    expect(view.routes[0].warnings.join(' ')).toContain('冲突')
    expect(view.providers[0].accounts[0].windows[0].usedPercent).toBe(37.125)
    const same = mapQuotaRoutes([
      { provider: 'codex', model: 'gpt', policy: { quotaDomainId: 'd', quotaScope: 'account', capabilities: { tools: true, vision: false } } },
      { provider: 'codex', model: 'gpt', policy: { capabilities: { vision: false, tools: true }, quotaScope: 'account', quotaDomainId: 'd' } }
    ], [])
    expect(same[0].accessMode).toBe('subscription')
    expect(same[0].warnings.join(' ')).not.toContain('冲突')
  })
})

describe('可信宿主只读RPC载体', () => {
  it('只向正式quota路径发送固定RPC信封且不携带浏览器凭据', async () => {
    const handler = vi.fn(async (request: Request) => {
      expect(request.url).toBe('http://localhost/api/subscriptions-auth.usage')
      expect(request.headers.has('authorization')).toBe(false)
      expect(request.headers.has('cookie')).toBe(false)
      const body = await request.json()
      expect(body).toMatchObject({ type: 'client-request', method: 'subscriptions-auth.usage', payload: { provider: 'codex', account: 'a', force: true } })
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: usage() } })
    })
    expect(await createSubscriptionQuotaInvoker(() => handler)('subscriptions-auth.usage', { provider: 'codex', account: 'a', force: true }, new AbortController().signal)).toEqual(usage())
  })

  it('兼容真实SDK的{fetch,requestBodyMode} carrier对象', async () => {
    const carrier = {
      requestBodyMode: () => 'buffered',
      async fetch(request: Request) {
        const body = await request.json()
        return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: status() } })
      }
    }
    expect(await createSubscriptionQuotaInvoker(() => carrier)('subscriptions-auth.status', {}, new AbortController().signal)).toEqual(status())
  })

  it('并发读取使用不同rpcId，仍严格核对回包身份', async () => {
    const ids = new Set<string>()
    const invoker = createSubscriptionQuotaInvoker(() => async (request) => {
      const body = await request.json()
      ids.add(body.rpcId)
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: status() } })
    })
    await Promise.all(Array.from({ length: 20 }, () => invoker('subscriptions-auth.status', {}, new AbortController().signal)))
    expect(ids.size).toBe(20)
  })

  it('拒绝未知endpoint/缺失handler/错信封/失败响应，未知错误不吞成0', async () => {
    const signal = new AbortController().signal
    const missing = createSubscriptionQuotaInvoker(() => undefined)
    await expect(missing('subscriptions-auth.status', {}, signal)).rejects.toThrow('unavailable')
    await expect(missing('subscriptions-auth.logout' as never, { provider: 'codex' }, signal)).rejects.toThrow('Unsupported')
    await expect(missing('subscriptions-auth.usage', {}, signal)).rejects.toThrow('Unsupported')
    for (const response of [new Response('unauthorized', { status: 401 }), Response.json({ type: 'server-response', rpcId: 'wrong', result: { ok: true, value: usage() } }), Response.json({ type: 'server-response', rpcId: 'swarm-quota-read', result: { ok: false, error: { message: 'secret' } } })]) {
      await expect(createSubscriptionQuotaInvoker(() => async () => response)('subscriptions-auth.status', {}, signal)).rejects.toThrow()
    }
  })

  it('响应大小上限明确失败，不无限读取返回内容', async () => {
    const invoker = createSubscriptionQuotaInvoker(() => async () => new Response('x'.repeat(512 * 1024 + 1)))
    await expect(invoker('subscriptions-auth.status', {}, new AbortController().signal)).rejects.toThrow('too large')
  })
})
