import type { LlmFailureLike } from './host-contract.js'

/**
 * 联网探测：模型请求因传输失败、超时或订阅令牌刷新失败而出错时，先判断是整机断网还是单个供应商故障。
 * 断网时整条路由链都会失败（2026-10-06 14:03–15:15 的故障即如此：所有供应商约 10 秒连接超时，
 * 最后一层 DeepSeek 官方接口报 "DeepSeek Messages transport failed"），此时应等待网络恢复后重试原路由，
 * 而不是把整条链耗尽、让天枢停在兜底模型上。
 */

/** 网络监视器 */
export interface NetworkMonitorInfo {
  /** 任一探测地址有 HTTP 响应即视为联网；结果短时缓存 */
  isOnline: () => Promise<boolean>
  /**
   * 等待网络恢复
   * @returns 恢复为 true；超时或取消为 false
   */
  waitOnline: (signal: AbortSignal | undefined, maxMs: number) => Promise<boolean>
}

export interface NetworkMonitorDepsInfo {
  fetch: typeof fetch
  getUrls: () => readonly string[]
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  /** 单个探测的超时（毫秒） */
  timeoutMs?: number
  /** 探测结果的缓存时间（毫秒） */
  cacheMs?: number
  /** 等待期间两次探测的间隔（毫秒） */
  intervalMs?: number
}

/** 可被取消的等待 */
export const SleepWithSignal = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal?.aborted === true) {
    resolve()
    return
  }
  const timer = setTimeout(done, ms)
  function done (): void {
    clearTimeout(timer)
    signal?.removeEventListener('abort', done)
    resolve()
  }
  signal?.addEventListener('abort', done, { once: true })
})

const NETWORK_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'NETWORK'])
const NETWORK_MESSAGE = /transport failed|fetch failed|timed out|ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|No eligible account/i

/**
 * 这次失败是否可能由断网引起（传输失败、超时、订阅令牌无法刷新）
 * @param {LlmFailureLike | undefined} failure - 失败信息
 * @returns {boolean} 是否需要先做联网探测
 */
export const isNetworkSuspect = (failure: LlmFailureLike | undefined): boolean => {
  if (failure === undefined) return false
  if (NETWORK_CODES.has(String(failure.code ?? '').toUpperCase())) return true
  return NETWORK_MESSAGE.test(failure.message ?? '')
}

/**
 * 创建网络监视器
 * @param {NetworkMonitorDepsInfo} deps - 依赖
 * @returns {NetworkMonitorInfo} 监视器
 */
export const intNetworkMonitor = (deps: NetworkMonitorDepsInfo): NetworkMonitorInfo => {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? SleepWithSignal
  const timeoutMs = deps.timeoutMs ?? 5000
  const cacheMs = deps.cacheMs ?? 5000
  const intervalMs = deps.intervalMs ?? 15_000
  let cached: { at: number; online: boolean } | undefined
  let pending: Promise<boolean> | undefined

  /** 探测请求只受自身超时控制：结果由并发调用方共用，不能被某一个调用方的取消打断 */
  const ProbeOne = async (url: string): Promise<boolean> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // 任何 HTTP 状态（含 401/404）都说明网络可达
      await deps.fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  const isOnline = async (): Promise<boolean> => {
    if (cached !== undefined && now() - cached.at < cacheMs) return cached.online
    // 并发的探测请求共用一次结果
    pending ??= (async () => {
      const urls = deps.getUrls()
      if (urls.length === 0) return true
      // 任一地址可达即返回，不等被墙或无响应的地址超时
      return Promise.any(urls.map(async (url) => {
        if (await ProbeOne(url)) return true
        throw new Error('unreachable')
      })).catch(() => false)
    })().then((online) => {
      cached = { at: now(), online }
      pending = undefined
      return online
    }, () => {
      pending = undefined
      return true
    })
    return pending
  }

  const waitOnline = async (signal: AbortSignal | undefined, maxMs: number): Promise<boolean> => {
    const started = now()
    for (;;) {
      if (signal?.aborted === true) return false
      if (await isOnline()) return true
      const left = maxMs - (now() - started)
      if (left <= 0) return false
      await sleep(Math.min(intervalMs, left), signal)
    }
  }

  return { isOnline, waitOnline }
}
