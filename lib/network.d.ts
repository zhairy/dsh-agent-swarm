import type { LlmFailureLike } from './host-contract.js';
/**
 * 联网探测：模型请求因传输失败、超时或订阅令牌刷新失败而出错时，先判断是整机断网还是单个供应商故障。
 * 断网时整条路由链都会失败（2026-10-06 14:03–15:15 的故障即如此：所有供应商约 10 秒连接超时，
 * 最后一层 DeepSeek 官方接口报 "DeepSeek Messages transport failed"），此时应等待网络恢复后重试原路由，
 * 而不是把整条链耗尽、让天枢停在兜底模型上。
 */
/** 网络监视器 */
export interface NetworkMonitorInfo {
    /** 任一探测地址有 HTTP 响应即视为联网；结果短时缓存 */
    isOnline: () => Promise<boolean>;
    /**
     * 等待网络恢复
     * @returns 恢复为 true；超时或取消为 false
     */
    waitOnline: (signal: AbortSignal | undefined, maxMs: number) => Promise<boolean>;
}
export interface NetworkMonitorDepsInfo {
    fetch: typeof fetch;
    getUrls: () => readonly string[];
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    now?: () => number;
    /** 单个探测的超时（毫秒） */
    timeoutMs?: number;
    /** 探测结果的缓存时间（毫秒） */
    cacheMs?: number;
    /** 等待期间两次探测的间隔（毫秒） */
    intervalMs?: number;
}
/** 可被取消的等待 */
export declare const SleepWithSignal: (ms: number, signal?: AbortSignal) => Promise<void>;
/**
 * 这次失败是否可能由断网引起（传输失败、超时、订阅令牌无法刷新）
 * @param {LlmFailureLike | undefined} failure - 失败信息
 * @returns {boolean} 是否需要先做联网探测
 */
export declare const isNetworkSuspect: (failure: LlmFailureLike | undefined) => boolean;
/**
 * 创建网络监视器
 * @param {NetworkMonitorDepsInfo} deps - 依赖
 * @returns {NetworkMonitorInfo} 监视器
 */
export declare const intNetworkMonitor: (deps: NetworkMonitorDepsInfo) => NetworkMonitorInfo;
