import type { CredentialsLike } from './host-contract.js';
import { type JevClient, type JevConfigInfo } from './jev.js';
import { type ThirdPartyJevLlmLike } from './jev-third-party.js';
import { type JevToolResult } from './jev-tools.js';
/**
 * Jev 接入点：衡鉴（分流、会话判断、复评）、7 个 jev_* 工具与设置页共用同一个客户端，
 * 所有入口共用凭据解析、取消与错误重试；无本地限流/调用额度，配置变化时重建客户端。
 */
export interface JevHubDepsInfo {
    getConfig: () => JevConfigInfo;
    getCredentials: () => CredentialsLike | undefined;
    getLlm?: () => ThirdPartyJevLlmLike | undefined;
    fetch: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    logger?: {
        warn: (message: string) => void;
    };
}
/** 密钥状态：只说明是否已配置、来自哪一层、能否写入，从不包含密钥值 */
export interface JevKeyStatusInfo {
    ref: string;
    configured: boolean;
    source?: string;
    writable?: boolean;
}
/** 凭据引用名必须像环境变量名；不合法时（例如误把密钥本身填进 apiKeyEnv）既不读取也不回显 */
export declare const isCredentialRefName: (ref: string) => boolean;
/** 设置页「测试连接」的结果 */
export interface JevHealthInfo {
    key: JevKeyStatusInfo;
    enabled: boolean;
    model: string;
    baseUrl: string;
    result: JevToolResult;
}
/**
 * 创建 Jev 接入点
 * @param {JevHubDepsInfo} deps - 依赖
 * @returns 共享客户端、密钥读取、工具实现与健康检查
 */
export declare const intJevHub: (deps: JevHubDepsInfo) => {
    getClient: () => JevClient;
    describeKey: () => Promise<JevKeyStatusInfo>;
    getHealth: (signal?: AbortSignal) => Promise<JevHealthInfo>;
    tools: {
        ask: (args: {
            state?: unknown;
            questions?: unknown;
        }, signal?: AbortSignal) => Promise<JevToolResult>;
        classify: (args: {
            state?: unknown;
            labels?: unknown;
            question?: unknown;
            add_other?: unknown;
            ensemble?: unknown;
        }, signal?: AbortSignal) => Promise<JevToolResult>;
        score: (args: {
            state?: unknown;
            levels?: unknown;
            question?: unknown;
        }, signal?: AbortSignal) => Promise<JevToolResult>;
        check: (args: {
            state?: unknown;
            propositions?: unknown;
        }, signal?: AbortSignal) => Promise<JevToolResult>;
        screen: (args: {
            text?: unknown;
            source?: unknown;
        }, signal?: AbortSignal) => Promise<JevToolResult>;
        match: (args: {
            query?: unknown;
            candidates?: unknown;
            question?: unknown;
            window?: unknown;
        }, signal?: AbortSignal) => Promise<JevToolResult>;
        health: (signal?: AbortSignal) => Promise<JevToolResult>;
    };
};
export type JevHub = ReturnType<typeof intJevHub>;
