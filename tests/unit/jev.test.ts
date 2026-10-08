import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_CONFIG, JEV_PATH, JEV_QUESTIONS, ParseJevAnswers, getJevState, getRedactedText, intJevClient, intRequestLimiter, getJevFailureKind, isJevAvailabilityFailure } from '../../src/jev.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'

const card = ValidateTaskCard({
  title: '优化增量笔 key=sk-abcdefghijklmnop',
  goal: '降低延迟，token: secret123',
  acceptance: ['差分测试通过'],
  scope: ['src/bi.ts'],
  flags: { changesAlgorithm: true, touchesFinancialLogic: true },
  perf: { p95Ms: 50 }
}).card as TaskCard

const okBody = {
  model: 'jev-1.13.0',
  answers: {
    math_task: { type: 'choice', choice: 'equivalence', probabilities: {}, confidence: 0.82 },
    need_benchmark: { type: 'noul', noul: 0.91 },
    novelty: { type: 'score', score: 1.2, legend: [], probabilities: [], confidence: 0.7 }
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('脱敏与请求体', () => {
  it('去除密钥样式内容并截断', () => {
    expect(getRedactedText('key=sk-abcdefghijklmnop')).not.toContain('sk-abcdefghijklmnop')
    expect(getRedactedText('Authorization: Bearer abc.def')).toContain('[已脱敏]')
    expect(getRedactedText('x'.repeat(600)).length).toBeLessThanOrEqual(500)
    // 结构化交付先 JSON.stringify 再脱敏：带引号的键值同样要去掉
    const json = getRedactedText(JSON.stringify({ password: 'hunter2xx', api_key: 'abc123SECRET', db_token: 'zzzzzzzz', maxTokens: 12, note: 'ok' }), 2000)
    expect(json).not.toMatch(/hunter2xx|abc123SECRET|zzzzzzzz/)
    expect(json).toContain('"password":"[已脱敏]"')
    expect(json).toContain('"note":"ok"')
    const formats = [
      'AKIAABCDEFGHIJKLMNOP',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'github_pat_abcdefghijklmnopqrstuvwxyz',
      'tsk_live_abcdefgh12345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
      'xoxb-1234567890-abcdefghij',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    ]
    for (const secret of formats) expect(getRedactedText(`值：${secret} 结束`, 2000)).not.toContain(secret)
    expect(getRedactedText('token: abc', 100)).toBe('token: abc')
  })

  it('state 只含结构化摘要，不含源码与密钥', () => {
    const state = getJevState(card)
    expect(state.task).not.toContain('sk-abc')
    expect(state.goal).not.toContain('secret123')
    expect(state.flags).toMatchObject({ changesAlgorithm: true })
    expect(state).toMatchObject({ acceptance_count: 1, scope_count: 1, profile: { p95Ms: 50 } })
    expect(Object.keys(JEV_QUESTIONS)).toEqual(['math_task', 'need_benchmark', 'novelty'])
  })

  it('解析答案：noul 没有 confidence', () => {
    expect(ParseJevAnswers(okBody)).toEqual({ mathTask: { choice: 'equivalence', confidence: 0.82 }, needBenchmark: 0.91, novelty: { score: 1.2, confidence: 0.7 } })
    expect(ParseJevAnswers({})).toEqual({})
    expect(ParseJevAnswers(null)).toEqual({})
  })

  it('非法概率、非有限数与超出数学分流选项/档位的答案不能进入判断', () => {
    for (const value of [-0.1, 1.1, NaN, Infinity]) {
      expect(ParseJevAnswers({ answers: { math_task: { choice: 'equivalence', confidence: value }, need_benchmark: { noul: value }, novelty: { score: 1, confidence: value } } })).toEqual({})
    }
    expect(ParseJevAnswers({ answers: { math_task: { choice: 'invented', confidence: 0.9 }, novelty: { score: 3, confidence: 0.9 } } })).toEqual({})
  })
})

describe('intJevClient', () => {
  const sleep = async () => undefined

  it('服务未报告或报告非法usage时保留unknown；合法零与部分观测分别保留', async () => {
    for (const usage of [undefined, {}, { input_tokens: -1, output_tokens: -2 }, { input_tokens: NaN, output_tokens: Infinity }, { input_tokens: 1.5, output_tokens: Number.MAX_SAFE_INTEGER + 1 }]) {
      const response = jsonResponse(200, okBody)
      response.json = async () => ({ ...okBody, ...(usage === undefined ? {} : { usage }) })
      const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: (async () => response) as typeof globalThis.fetch, getApiKey: async () => 'k', sleep })
      const outcome = await client.ask({}, {})
      expect(outcome.ok).toBe(true)
      expect(outcome.ok && outcome.usage).toEqual({})
    }
    for (const [usage, expected] of [[{ input_tokens: 0, output_tokens: 0 }, { inputTokens: 0, outputTokens: 0 }], [{ input_tokens: 12, output_tokens: -1 }, { inputTokens: 12 }]]) {
      const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: (async () => jsonResponse(200, { ...okBody, usage })) as typeof globalThis.fetch, getApiKey: async () => 'k', sleep })
      expect(await client.ask({}, {})).toMatchObject({ ok: true, usage: expected })
    }
  })

  it('旧非零RPS配置不限制并行请求；0 limiter 真正旁路', async () => {
    const wait = vi.fn(async () => undefined)
    await Promise.all(Array.from({ length: 100 }, () => intRequestLimiter(0, wait)()))
    const fetch = vi.fn(async () => jsonResponse(200, okBody))
    const client = intJevClient({ ...DEFAULT_JEV_CONFIG, maxRequestsPerSecond: 1 }, { fetch: fetch as typeof globalThis.fetch, getApiKey: async () => 'k', sleep: wait })
    await Promise.all(Array.from({ length: 32 }, () => client.ask({}, { q: { type: 'noul' } })))
    expect(fetch).toHaveBeenCalledTimes(32)
    expect(wait).not.toHaveBeenCalled()
  })

  it('余额和明确quota型429终态不重试；长Retry-After不截短提前调用', async () => {
    for (const status of [401, 402, 403, 429]) {
      const wait = vi.fn(async () => undefined)
      const fetch = vi.fn(async () => jsonResponse(status, { error: { code: 'insufficient_quota', message: 'quota exhausted' } }))
      const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetch as typeof globalThis.fetch, getApiKey: async () => 'k', sleep: wait })
      expect(await client.ask({}, {})).toMatchObject({ ok: false, attempts: 1 })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(wait).not.toHaveBeenCalled()
    }
    const fetch = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '9060.669' } }))
    const wait = vi.fn(async () => undefined)
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetch as typeof globalThis.fetch, getApiKey: async () => 'k', sleep: wait })
    expect(await client.ask({}, {})).toMatchObject({ ok: false, attempts: 1, retryAfterMs: 9060669 })
    expect(wait).not.toHaveBeenCalled()
    const terminalBody = new Response('{}', { status: 402 })
    terminalBody.json = vi.fn(async () => { throw new Error('terminal response body must not be consumed') })
    const terminalClient = intJevClient(DEFAULT_JEV_CONFIG, { fetch: (async () => terminalBody) as typeof globalThis.fetch, getApiKey: async () => 'k', sleep: wait })
    expect(await terminalClient.ask({}, {})).toMatchObject({ ok: false, status: 402, attempts: 1 })
    expect(terminalBody.json).not.toHaveBeenCalled()
  })

  it('成功调用：发送 Bearer 与 JSON，返回答案', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k1', sleep })
    const outcome = await client.triage(card)
    expect(outcome).toEqual({ ok: true, attempts: 1, answers: ParseJevAnswers(okBody) })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://api.typesafe.ai${JEV_PATH}`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k1')
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'jev-latest', questions: { need_benchmark: { type: 'noul' } } })
  })

  it('未启用或没有密钥时不调用', async () => {
    const fetchMock = vi.fn()
    const disabled = intJevClient({ ...DEFAULT_JEV_CONFIG, enabled: false }, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await disabled.triage(card)).toEqual({ ok: false, reason: 'disabled', attempts: 0 })
    const noKey = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => undefined, sleep })
    expect(await noKey.triage(card)).toEqual({ ok: false, reason: 'missing-api-key', attempts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('429/529 退避重试，超过次数后失败', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(529, {}))
      .mockResolvedValueOnce(jsonResponse(200, okBody))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect((await client.triage(card)).attempts).toBe(3)
    const always = vi.fn(async () => jsonResponse(529, {}))
    const failing = intJevClient(DEFAULT_JEV_CONFIG, { fetch: always as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await failing.triage(card)).toEqual({ ok: false, reason: 'http-529', attempts: 5 })
    const rpm = vi.fn().mockResolvedValueOnce(jsonResponse(429, { error: { code: 'RATE_LIMIT', message: 'TPM quota exceeded: tokens per minute' } })).mockResolvedValueOnce(jsonResponse(200, okBody))
    const limited = intJevClient(DEFAULT_JEV_CONFIG, { fetch: rpm as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect((await limited.triage(card)).attempts).toBe(2)
  })

  it('401/422 不重试；网络错误与格式错误', async () => {
    const unauthorized = vi.fn(async () => jsonResponse(401, {}))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: unauthorized as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await client.triage(card)).toEqual({ ok: false, reason: 'http-401', attempts: 1 })
    const network = vi.fn(async () => { throw new TypeError('fetch failed') })
    const net = intJevClient({ ...DEFAULT_JEV_CONFIG, maxRetries: 0 }, { fetch: network as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await net.triage(card)).toEqual({ ok: false, reason: 'network', attempts: 1 })
    const malformed = vi.fn(async () => jsonResponse(200, { answers: {} }))
    const bad = intJevClient(DEFAULT_JEV_CONFIG, { fetch: malformed as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await bad.triage(card)).toEqual({ ok: false, reason: 'malformed-response', attempts: 1 })
  })

  it('HTTP成功但JSON损坏是响应错误，ask和health均不执行网络重试', async () => {
    const fetchMock = vi.fn(async () => new Response('not valid JSON', { status: 200 }))
    const wait = vi.fn(async () => undefined)
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as typeof fetch, getApiKey: async () => 'k', sleep: wait })
    expect(await client.ask({}, {})).toEqual({ ok: false, reason: 'malformed-response', attempts: 1, status: 502 })
    expect(await client.listModels()).toEqual({ ok: false, reason: 'malformed-response', status: 502 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(wait).not.toHaveBeenCalled()
  })

  it('取消Retry-After等待立即结束；不会等待注入sleep完成或发第二次请求', async () => {
    const controller = new AbortController()
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { entered = resolve })
    const wait = vi.fn(async () => { entered(); await new Promise<void>(() => undefined) })
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as typeof fetch, getApiKey: async () => 'k', sleep: wait })
    const pending = client.ask({}, {}, controller.signal)
    await waiting
    controller.abort()
    expect(await pending).toEqual({ ok: false, reason: 'aborted', attempts: 1, status: 499 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('默认backoff取消会清理定时器；取消后不等30秒', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const fetchMock = vi.fn(async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
      const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as typeof fetch, getApiKey: async () => 'k' })
      const pending = client.ask({}, {}, controller.signal)
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      controller.abort()
      expect(await pending).toMatchObject({ ok: false, reason: 'aborted', attempts: 1 })
      expect(vi.getTimerCount()).toBe(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('权限/取消/坏响应/余额终态与可降级服务不可用保持不同分类', async () => {
    for (const [failure, kind] of [
      [{ reason: 'malformed-response', status: 502 }, 'invalid-response'],
      [{ reason: 'credential-permission-denied', status: 403 }, 'permission'],
      [{ reason: 'credential-unavailable', status: 503 }, 'unknown'],
      [{ reason: 'aborted', status: 499 }, 'cancelled'],
      [{ reason: 'http-401', status: 401 }, 'authentication'],
      [{ reason: 'http-402', status: 402 }, 'billing'],
      [{ reason: 'request-too-large', status: 400 }, 'invalid-request']
    ] as const) {
      expect(getJevFailureKind(failure)).toBe(kind)
      expect(isJevAvailabilityFailure(failure)).toBe(false)
    }
    expect(isJevAvailabilityFailure({ reason: 'network', status: 503 })).toBe(true)
    expect(isJevAvailabilityFailure({ reason: 'disabled' })).toBe(true)
    expect(isJevAvailabilityFailure({ reason: 'missing-api-key', status: 401 })).toBe(true)
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: (async () => jsonResponse(429, { error: { code: 'insufficient_quota' } })) as typeof fetch, getApiKey: async () => 'k' })
    const outcome = await client.ask({}, {})
    expect(outcome).toMatchObject({ ok: false, failureKind: 'billing', attempts: 1 })
    if (!outcome.ok) expect(isJevAvailabilityFailure(outcome)).toBe(false)
  })

  it('非标准HTTP状态中的明确认证/权限/模型错误也不误降级为临时不可用', async () => {
    for (const [code, kind] of [['UNAUTHORIZED', 'authentication'], ['FORBIDDEN', 'permission'], ['UNKNOWN_MODEL', 'invalid-request']] as const) {
      const fetchMock = vi.fn(async () => jsonResponse(429, { error: { code } }))
      const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as typeof fetch, getApiKey: async () => 'k' })
      const outcome = await client.ask({}, {})
      expect(outcome).toMatchObject({ ok: false, failureKind: kind, attempts: 1 })
      if (!outcome.ok) expect(isJevAvailabilityFailure(outcome)).toBe(false)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
  })

  it('调用方取消后不再请求、不再重试', async () => {
    const fetchMock = vi.fn()
    const client = intJevClient(DEFAULT_JEV_CONFIG, { fetch: fetchMock as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    const pre = new AbortController()
    pre.abort()
    expect(await client.triage(card, pre.signal)).toEqual({ ok: false, reason: 'aborted', attempts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
    const during = new AbortController()
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      setTimeout(() => during.abort(), 1)
    }))
    const cancelled = intJevClient(DEFAULT_JEV_CONFIG, { fetch: hanging as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await cancelled.triage(card, during.signal)).toEqual({ ok: false, reason: 'aborted', attempts: 1 })
  })

  it('性能预算中的自由文本同样脱敏并截断', () => {
    const withText = ValidateTaskCard({
      title: 't', goal: 'g', acceptance: ['a'], flags: {},
      perf: { p95Ms: 50, throughput: 'token=abcdef 1k/s', dataScale: 'x'.repeat(900) }
    }).card as TaskCard
    const profile = getJevState(withText).profile as Record<string, unknown>
    expect(profile.p95Ms).toBe(50)
    expect(String(profile.throughput)).not.toContain('abcdef')
    expect(String(profile.dataScale).length).toBeLessThanOrEqual(500)
  })

  it('超时视为可重试失败', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const client = intJevClient({ ...DEFAULT_JEV_CONFIG, timeoutMs: 5, maxRetries: 1 }, { fetch: hanging as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await client.triage(card)).toEqual({ ok: false, reason: 'timeout', attempts: 2 })
  })
})
