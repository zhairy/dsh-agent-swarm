import { type JevClient } from './jev.js';
import { type ToolDefinitionLike } from './tool-shape.js';
/**
 * 内嵌的 7 个 Jev 工具：jev_ask / jev_check / jev_classify / jev_health / jev_match / jev_score / jev_screen。
 * 语义与返回结构对齐 jev-mcp v0.2.1（MIT，Copyright (c) 2026 Blake Stone），由插件直接调用 TypeSafe System One，
 * 共用百工的 Jev 客户端（无本地限流/使用额度，保留错误重试与凭据解析）。返回信封：
 * 成功 { ok: true, model, answers, usage: { input_tokens, output_tokens, est_cost_usd }, latency_ms }，
 * 失败 { ok: false, status, error, details? }。置信度表示判断的集中程度，不等于正确性。
 */
export type JevToolResult = {
    ok: true;
    model: string;
    answers: unknown;
    usage: {
        input_tokens: number | null;
        output_tokens: number | null;
        est_cost_usd: number | null;
        usage_unknown?: boolean;
    };
    latency_ms: number;
} | {
    ok: false;
    status: number;
    error: string;
    details?: Array<{
        loc: string[];
        msg: string;
    }>;
    retry_after_ms?: number;
    [key: string]: unknown;
};
/** 工具层依赖：Jev 客户端与时钟 */
export interface JevToolDepsInfo {
    getClient: () => JevClient;
    now?: () => number;
}
/** 与 jev-mcp 一致的确定性打乱：以选项数为种子，结果与原顺序相同时整体反转 */
export declare const getShuffledCriteria: <T>(criteria: Record<string, T>) => Record<string, T>;
/**
 * 创建内嵌 Jev 工具的实现
 * @param {JevToolDepsInfo} deps - 依赖
 * @returns 7 个操作，参数与 jev-mcp 工具相同
 */
export declare const intJevTools: (deps: JevToolDepsInfo) => {
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
export type JevTools = ReturnType<typeof intJevTools>;
export declare const JEV_TOOL_NAMES: readonly ['jev_ask', 'jev_check', 'jev_classify', 'jev_health', 'jev_match', 'jev_score', 'jev_screen'];
/** 工具结果的文本：一行中文摘要 + 完整 JSON 信封 */
export declare const getJevToolText: (name: string, result: JevToolResult) => string;
/**
 * 生成 7 个内嵌 Jev 工具的宿主定义
 * @param {() => JevTools} getTools - 取得工具实现（每次调用时读取，配置修改即时生效）
 * @returns {ToolDefinitionLike[]} 工具定义
 */
export declare const getJevToolDefinitions: (getTools: () => JevTools) => ToolDefinitionLike[];
