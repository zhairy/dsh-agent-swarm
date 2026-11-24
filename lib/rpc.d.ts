import type { FetchRouteLike } from './host-contract.js';
import type { JevHub } from './jev-hub.js';
/**
 * 设置页使用的宿主 RPC：沿用 DSH 浏览器端 rpc.call('/api', method, payload) 的线格式
 * （POST /api/<method>，请求体 client-request 信封，响应 server-response 信封），由 connection 的认证层保护。
 * 只返回密钥是否已配置与来源，从不返回密钥值。
 */
export declare const RPC_PREFIX = "swarm.";
export declare const RPC_METHODS: readonly ['jevStatus', 'jevHealth'];
export type RpcMethod = typeof RPC_METHODS[number] | 'taskView' | 'taskIndex' | 'agentView' | 'agentControl' | 'quotaView';
export interface AgentControlRpcInput {
    parentSessionId: string;
    childId: string;
    expectedRevision: number;
    action: 'select' | 'stop' | 'continue';
    route?: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
    interruptRunning?: boolean;
    retryRoute?: boolean;
    forceRetry?: boolean;
    confirmSafeToContinue?: boolean;
    steering?: string;
}
export interface TaskRpcDepsInfo {
    quotaView?: (force: boolean, signal: AbortSignal) => unknown | Promise<unknown>;
    taskView?: (sessionId: string, taskId: string) => unknown | Promise<unknown>;
    taskIndex?: (sessionId: string) => unknown | Promise<unknown>;
    agentView?: (parentSessionId: string, childId: string) => unknown | Promise<unknown>;
    agentControl?: (input: AgentControlRpcInput) => unknown | Promise<unknown>;
}
export declare const MERMAID_ASSET_PATH = "/api/swarm-assets/mermaid.min.js";
type RpcResult = {
    ok: true;
    value: unknown;
} | {
    ok: false;
    error: {
        code: string;
        message: string;
        details: {
            issues: unknown[];
        };
    };
};
/**
 * 执行一个 RPC 方法
 * @param {JevHub} jev - Jev 接入点
 * @param {RpcMethod} method - 方法名（不含前缀）
 * @param {AbortSignal} signal - 请求取消信号
 * @returns {Promise<RpcResult>} 结果
 */
export declare const RunRpcMethod: (jev: JevHub, method: RpcMethod, signal: AbortSignal, payload?: unknown, deps?: TaskRpcDepsInfo) => Promise<RpcResult>;
/**
 * 生成 RPC 路由
 * @param {() => JevHub} getJev - 取 Jev 接入点
 * @returns {FetchRouteLike[]} 路由
 */
export declare const getRpcRoutes: (getJev: () => JevHub, deps?: TaskRpcDepsInfo) => FetchRouteLike[];
/** 只读取锁定依赖的固定资源；请求参数从不参与文件路径计算。 */
export declare const getMermaidAssetRoute: () => FetchRouteLike;
export {};
