import type { AgentLike, ContentBlockLike } from './host-contract.js';
import { type JsonSchemaObject } from './util/json-schema.js';
/** 工具执行上下文中本插件用到的字段 */
export interface ToolExecLike {
    agent?: AgentLike;
    signal: AbortSignal;
    callId?: string;
}
/** 本插件声明工具的方式 */
export interface ToolSpecInfo<A, R> {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
    execute: (args: A, exec: ToolExecLike) => Promise<R>;
    render: (args: A, value: R) => string;
    isConcurrencySafe?: (args: A) => boolean;
    timeoutMs?: number;
}
/** 交给 ctx.tools.register 的工具定义（DSH 0.1.7 形状） */
export interface ToolDefinitionLike {
    name: string;
    description: string;
    parameters: JsonSchemaObject;
    output: {
        schema: JsonSchemaObject;
        render: (args: unknown, value: unknown) => ContentBlockLike[];
    };
    execute: (args: unknown, exec: ToolExecLike) => Promise<unknown>;
    isConcurrencySafe?: (args: unknown) => boolean;
    timeoutMs?: number;
}
/** 宿主要求 lossless JSON：明确省略可选字段，不把非有限数或宿主句柄静默转成 null。 */
export declare const getLosslessToolValue: (value: unknown) => unknown;
/**
 * 把工具声明转换为宿主工具定义：执行前按参数 schema 校验，结果渲染为文本块
 * 不依赖宿主内部包 @deepseek-ai/dsh-tools，避免第三方包的解析问题
 * @param {ToolSpecInfo<A, R>} spec - 工具声明
 * @returns {ToolDefinitionLike} 可注册的工具定义
 */
export declare const getToolDefinition: <A, R>(spec: ToolSpecInfo<A, R>) => ToolDefinitionLike;
