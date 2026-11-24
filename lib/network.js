import { isTerminalRouteFailure, normalizeRouteFailure } from './domain/routing/provider-policy.js';
/** 可被取消的等待 */
export const SleepWithSignal = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted === true) {
        resolve();
        return;
    }
    const timer = setTimeout(done, ms);
    function done() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
});
const NETWORK_CODES = new Set(['TRANSPORT', 'TIMEOUT', 'NETWORK']);
const NETWORK_MESSAGE = /transport failed|fetch failed|timed out|ECONN(RESET|REFUSED|ABORTED)|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|network|No eligible account/i;
/**
 * 这次失败是否可能由断网引起（传输失败、超时、订阅令牌无法刷新）
 * @param {LlmFailureLike | undefined} failure - 失败信息
 * @returns {boolean} 是否需要先做联网探测
 */
export const isNetworkSuspect = (failure) => {
    if (failure === undefined)
        return false;
    if (isTerminalRouteFailure(normalizeRouteFailure(failure, { provider: '', model: '' }))) {
        // NO_ADAPTER 可能来自断网时的登录刷新；已确认 pool/quota/余额不走网络恢复。
        if (String(failure.code ?? '').toUpperCase() !== 'NO_ADAPTER' || !/No eligible account/i.test(failure.message ?? ''))
            return false;
    }
    if (NETWORK_CODES.has(String(failure.code ?? '').toUpperCase()))
        return true;
    return NETWORK_MESSAGE.test(failure.message ?? '');
};
/**
 * 创建网络监视器
 * @param {NetworkMonitorDepsInfo} deps - 依赖
 * @returns {NetworkMonitorInfo} 监视器
 */
export const intNetworkMonitor = (deps) => {
    const now = deps.now ?? Date.now;
    const sleep = deps.sleep ?? SleepWithSignal;
    const timeoutMs = deps.timeoutMs ?? 5000;
    const cacheMs = deps.cacheMs ?? 5000;
    const intervalMs = deps.intervalMs ?? 15_000;
    let cached;
    let pending;
    /** 探测请求只受自身超时控制：结果由并发调用方共用，不能被某一个调用方的取消打断 */
    const ProbeOne = async (url) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // 任何 HTTP 状态（含 401/404）都说明网络可达
            await deps.fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'manual' });
            return true;
        }
        catch {
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    };
    const isOnline = async () => {
        if (cached !== undefined && now() - cached.at < cacheMs)
            return cached.online;
        // 并发的探测请求共用一次结果
        pending ??= (async () => {
            const urls = deps.getUrls();
            if (urls.length === 0)
                return true;
            // 任一地址可达即返回，不等被墙或无响应的地址超时
            return Promise.any(urls.map(async (url) => {
                if (await ProbeOne(url))
                    return true;
                throw new Error('unreachable');
            })).catch(() => false);
        })().then((online) => {
            cached = { at: now(), online };
            pending = undefined;
            return online;
        }, () => {
            pending = undefined;
            return true;
        });
        return pending;
    };
    const waitOnline = async (signal, maxMs) => {
        const started = now();
        for (;;) {
            if (signal?.aborted === true)
                return false;
            if (await isOnline())
                return true;
            const left = maxMs - (now() - started);
            if (left <= 0)
                return false;
            await sleep(Math.min(intervalMs, left), signal);
        }
    };
    return { isOnline, waitOnline };
};
//# sourceMappingURL=network.js.map