import { describe, expect, it, vi } from 'vitest'
import { SleepWithSignal, intNetworkMonitor, isNetworkSuspect } from '../../src/network.js'
import { getExplainedError, getFailureHint } from '../../src/util/failure-hint.js'

describe('isNetworkSuspect', () => {
  it('传输失败、超时与订阅令牌刷新失败需要先探测网络；额度与认证失败不需要', () => {
    expect(isNetworkSuspect({ message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' })).toBe(true)
    expect(isNetworkSuspect({ message: 'Request timed out.', code: 'TIMEOUT' })).toBe(true)
    expect(isNetworkSuspect({ message: 'No eligible account for codex/gpt-6-sol', code: 'NO_ADAPTER' })).toBe(true)
    expect(isNetworkSuspect({ message: 'fetch failed: ECONNRESET' })).toBe(true)
    expect(isNetworkSuspect({ message: 'usage limit reached', code: 'QUOTA' })).toBe(false)
    expect(isNetworkSuspect({ status: 401, code: 'UNAUTHORIZED' })).toBe(false)
    expect(isNetworkSuspect(undefined)).toBe(false)
  })
})

describe('intNetworkMonitor', () => {
  const makeClock = () => {
    let at = 0
    return { now: () => at, advance: (ms: number) => { at += ms } }
  }

  it('任一探测地址有 HTTP 响应即联网；结果短时缓存，并发探测共用一次', async () => {
    const clock = makeClock()
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('down')) throw new Error('ECONNREFUSED')
      return new Response(null, { status: 404 })
    })
    const monitor = intNetworkMonitor({ fetch: fetch as unknown as typeof globalThis.fetch, getUrls: () => ['https://down.example', 'https://up.example'], now: clock.now })
    const [a, b] = await Promise.all([monitor.isOnline(), monitor.isOnline()])
    expect(a && b).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    await monitor.isOnline()
    expect(fetch).toHaveBeenCalledTimes(2)
    clock.advance(6000)
    await monitor.isOnline()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('全部失败视为断网；等待期间网络恢复返回 true，超时或取消返回 false', async () => {
    const clock = makeClock()
    let online = false
    const fetch = vi.fn(async () => {
      if (!online) throw new Error('ETIMEDOUT')
      return new Response(null, { status: 200 })
    })
    const sleep = vi.fn(async (ms: number) => {
      clock.advance(ms)
      if (clock.now() >= 30_000) online = true
    })
    const monitor = intNetworkMonitor({ fetch: fetch as unknown as typeof globalThis.fetch, getUrls: () => ['https://a'], now: clock.now, sleep, cacheMs: 0, intervalMs: 15_000 })
    expect(await monitor.isOnline()).toBe(false)
    expect(await monitor.waitOnline(undefined, 60_000)).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
    online = false
    clock.advance(-clock.now())
    const short = intNetworkMonitor({ fetch: fetch as unknown as typeof globalThis.fetch, getUrls: () => ['https://a'], now: clock.now, sleep: async (ms) => clock.advance(ms), cacheMs: 0 })
    expect(await short.waitOnline(undefined, 10_000)).toBe(false)
    const controller = new AbortController()
    controller.abort()
    expect(await short.waitOnline(controller.signal, 10_000)).toBe(false)
    expect(await intNetworkMonitor({ fetch: fetch as unknown as typeof globalThis.fetch, getUrls: () => [] }).isOnline()).toBe(true)
  })

  it('任一地址可达即返回，不等无响应的地址超时', async () => {
    const fetch = vi.fn((url: string) => url.includes('blackhole')
      ? new Promise<Response>(() => undefined)
      : Promise.resolve(new Response(null, { status: 200 })))
    const monitor = intNetworkMonitor({ fetch: fetch as unknown as typeof globalThis.fetch, getUrls: () => ['https://blackhole.example', 'https://ok.example'], timeoutMs: 60_000 })
    const started = Date.now()
    expect(await monitor.isOnline()).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('SleepWithSignal 可被取消', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = SleepWithSignal(60_000, controller.signal)
    controller.abort()
    await pending
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('失败原因的中文说明', () => {
  it('识别常见失败并附加一次说明', () => {
    expect(getFailureHint('DeepSeek Messages transport failed')).toContain('网络连接失败')
    expect(getFailureHint('Request timed out.')).toContain('请求超时')
    expect(getFailureHint('No eligible account for codex/gpt-6-sol')).toContain('订阅账号暂不可用')
    expect(getFailureHint('Access to model denied: Unpurchased')).toContain('未开通')
    expect(getFailureHint('HTTP 401 invalid api key')).toContain('认证失败')
    expect(getFailureHint('something odd')).toBeUndefined()
    expect(getFailureHint(undefined)).toBeUndefined()
    const once = getExplainedError('error：DeepSeek Messages transport failed')
    expect(once).toMatch(/（说明：网络连接失败/)
    expect(getExplainedError(once)).toBe(once)
    expect(getExplainedError('odd')).toBe('odd')
  })
})
