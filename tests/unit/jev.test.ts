import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_CONFIG, JEV_PATH, JEV_QUESTIONS, ParseJevAnswers, getJevState, getRedactedText, intJevClient } from '../../src/jev.js'
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
})

describe('intJevClient', () => {
  const sleep = async () => undefined

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
    expect(await failing.triage(card)).toEqual({ ok: false, reason: 'http-529', attempts: 3 })
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

  it('超时视为可重试失败', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const client = intJevClient({ ...DEFAULT_JEV_CONFIG, timeoutMs: 5, maxRetries: 1 }, { fetch: hanging as unknown as typeof fetch, getApiKey: async () => 'k', sleep })
    expect(await client.triage(card)).toEqual({ ok: false, reason: 'timeout', attempts: 2 })
  })
})
