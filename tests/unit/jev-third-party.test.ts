import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_JEV_CONFIG, getJevFailureKind, type JevConfigInfo } from '../../src/jev.js'
import { intThirdPartyJevClient, type ThirdPartyJevLlmLike } from '../../src/jev-third-party.js'

const thirdPartyConfig = (patch: Partial<JevConfigInfo> = {}): JevConfigInfo => ({
  ...DEFAULT_JEV_CONFIG,
  source: 'third-party',
  thirdParty: { provider: 'opencode', model: 'jev-free', reasoningEffort: 'high' },
  ...patch
})

const textStream = (text: string, usage?: Record<string, number>): AsyncIterable<Record<string, unknown>> => ({
  async *[Symbol.asyncIterator] () {
    yield { type: 'text-delta', index: 0, text }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'completed', stopReason: 'stop' } }
  }
})

const answerJson = JSON.stringify({ answers: { safe: { type: 'noul', noul: 0.8 } } })

describe('第三方 JEV models adapter', () => {
  it('使用 DSH 当前供应商与模型，解析 JSON 和真实 token 用量', async () => {
    const stream = vi.fn(() => textStream('```json\n' + answerJson + '\n```', { inputTokens: 123, outputTokens: 17 }))
    const client = intThirdPartyJevClient(thirdPartyConfig(), { getLlm: () => ({ stream }), now: () => 1000 })

    await expect(client.ask({ value: 1 }, { safe: { type: 'noul' } })).resolves.toEqual({
      ok: true, answers: { safe: { type: 'noul', noul: 0.8 } }, model: 'jev-free',
      attempts: 1, usage: { inputTokens: 123, outputTokens: 17 }, latencyMs: 0
    })
    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'opencode', model: 'jev-free', reasoningEffort: 'high', system: expect.stringContaining('Return only one JSON object')
    }))
  })

  it('官方来源或缺失第三方路由时拒绝调用模型', async () => {
    const stream = vi.fn(() => textStream(answerJson))
    const official = intThirdPartyJevClient({ ...thirdPartyConfig(), source: 'official' }, { getLlm: () => ({ stream }) })
    const missing = intThirdPartyJevClient(thirdPartyConfig({ thirdParty: { provider: '', model: '' } }), { getLlm: () => ({ stream }) })
    expect(await official.ask({}, {})).toMatchObject({ ok: false, reason: 'missing-third-party-model', status: 400 })
    expect(await missing.ask({}, {})).toMatchObject({ ok: false, reason: 'missing-third-party-model', status: 400 })
    expect(stream).not.toHaveBeenCalled()
  })

  it('拒绝空答案、非 JSON 和 DSH 的终止错误，不把模型文本冒充 JEV 结果', async () => {
    const malformed = intThirdPartyJevClient(thirdPartyConfig(), { getLlm: () => ({ stream: () => textStream('not json') }) })
    expect(await malformed.ask({}, {})).toMatchObject({ ok: false, reason: 'malformed-response', status: 502 })

    const failedStream = (): AsyncIterable<Record<string, unknown>> => ({
      async *[Symbol.asyncIterator] () {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'provider_quota_exhausted', status: 429 } } }
      }
    })
    const failed = intThirdPartyJevClient(thirdPartyConfig(), { getLlm: () => ({ stream: failedStream }) })
    await expect(failed.ask({}, {})).resolves.toMatchObject({ ok: false, reason: 'provider_quota_exhausted', status: 429 })
    expect(getJevFailureKind({ reason: 'provider_quota_exhausted', status: 429 })).toBe('availability')
  })

  it('超时和外部取消分别返回 504 与 499，并中止 DSH 流', async () => {
    vi.useFakeTimers()
    try {
      const timeoutStream = ({ signal }: { signal?: AbortSignal }): AsyncIterable<Record<string, unknown>> => ({
        async *[Symbol.asyncIterator] () {
          await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
        }
      })
      const timeoutClient = intThirdPartyJevClient(thirdPartyConfig({ timeoutMs: 5 }), {
        getLlm: () => ({ stream: timeoutStream as ThirdPartyJevLlmLike['stream'] })
      })
      const pending = timeoutClient.ask({}, {})
      await vi.advanceTimersByTimeAsync(5)
      await expect(pending).resolves.toMatchObject({ ok: false, reason: 'timeout', status: 504 })

      const controller = new AbortController()
      const abortedClient = intThirdPartyJevClient(thirdPartyConfig({ timeoutMs: 100 }), {
        getLlm: () => ({ stream: timeoutStream as ThirdPartyJevLlmLike['stream'] })
      })
      const aborted = abortedClient.ask({}, {}, controller.signal)
      controller.abort('request-cancelled')
      await expect(aborted).resolves.toMatchObject({ ok: false, reason: 'aborted', status: 499 })

      const preAborted = new AbortController()
      preAborted.abort('already-cancelled')
      const ignoresSignal = intThirdPartyJevClient(thirdPartyConfig(), {
        getLlm: () => ({ stream: () => textStream(answerJson) })
      })
      await expect(ignoresSignal.ask({}, {}, preAborted.signal)).resolves.toMatchObject({ ok: false, reason: 'aborted', status: 499 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('健康检查通过 DSH 模型目录验证第三方模型资格', async () => {
    const resolveModelInfo = vi.fn(async () => ({ inputModalities: ['text'] }))
    const stream = vi.fn()
    const client = intThirdPartyJevClient(thirdPartyConfig(), { getLlm: () => ({ stream, resolveModelInfo }), now: () => 12 })
    await expect(client.listModels()).resolves.toMatchObject({ ok: true, models: [{ name: 'jev-free' }], latencyMs: 0 })
    expect(resolveModelInfo).toHaveBeenCalledWith('opencode', 'jev-free', undefined)

    const unavailable = intThirdPartyJevClient(thirdPartyConfig(), {
      getLlm: () => ({ stream, resolveModelInfo: async () => { throw new Error('model unavailable') } })
    })
    await expect(unavailable.listModels()).resolves.toMatchObject({ ok: false, reason: 'model unavailable', status: 503 })
    const noCatalog = intThirdPartyJevClient(thirdPartyConfig(), { getLlm: () => ({ stream }) })
    await expect(noCatalog.listModels()).resolves.toEqual({ ok: false, reason: 'model-catalog-unavailable', status: 503 })
  })

  it('拒绝无界输出、不可序列化输入和空白模型选择', async () => {
    const huge = intThirdPartyJevClient(thirdPartyConfig({ maxRequestChars: 64 }), {
      getLlm: () => ({ stream: () => textStream('x'.repeat(65)) })
    })
    await expect(huge.ask({}, {})).resolves.toMatchObject({ ok: false, reason: 'response-too-large', status: 502 })

    const circular: Record<string, unknown> = {}; circular.self = circular
    const invalid = intThirdPartyJevClient(thirdPartyConfig(), { getLlm: () => ({ stream: () => textStream(answerJson) }) })
    await expect(invalid.ask(circular, {})).resolves.toMatchObject({ ok: false, reason: 'request-not-serializable', status: 400 })

    const blank = intThirdPartyJevClient(thirdPartyConfig({ thirdParty: { provider: '  ', model: '\t' } }), { getLlm: () => ({ stream: () => textStream(answerJson) }) })
    await expect(blank.ask({}, {})).resolves.toMatchObject({ ok: false, reason: 'missing-third-party-model', status: 400 })
  })
})
