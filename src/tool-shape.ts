import type { AgentLike, ContentBlockLike } from './host-contract.js'
import { SwarmError } from './util/errors.js'
import { ValidateJsonValue, type JsonSchemaObject } from './util/json-schema.js'

/** 工具执行上下文中本插件用到的字段 */
export interface ToolExecLike {
  agent?: AgentLike
  signal: AbortSignal
  callId?: string
}

/** 本插件声明工具的方式 */
export interface ToolSpecInfo<A, R> {
  name: string
  description: string
  parameters: JsonSchemaObject
  execute: (args: A, exec: ToolExecLike) => Promise<R>
  render: (args: A, value: R) => string
  isConcurrencySafe?: (args: A) => boolean
  timeoutMs?: number
}

/** 交给 ctx.tools.register 的工具定义（DSH 0.1.7 形状） */
export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: JsonSchemaObject
  output: { schema: JsonSchemaObject; render: (args: unknown, value: unknown) => ContentBlockLike[] }
  execute: (args: unknown, exec: ToolExecLike) => Promise<unknown>
  isConcurrencySafe?: (args: unknown) => boolean
  timeoutMs?: number
}

/**
 * 把工具声明转换为宿主工具定义：执行前按参数 schema 校验，结果渲染为文本块
 * 不依赖宿主内部包 @deepseek-ai/dsh-tools，避免第三方包的解析问题
 * @param {ToolSpecInfo<A, R>} spec - 工具声明
 * @returns {ToolDefinitionLike} 可注册的工具定义
 */
export const getToolDefinition = <A, R>(spec: ToolSpecInfo<A, R>): ToolDefinitionLike => {
  const concurrency = spec.isConcurrencySafe
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: spec.render(args as A, value as R) }]
    },
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    ...(concurrency === undefined
      ? {}
      : {
          isConcurrencySafe: (args: unknown) =>
            ValidateJsonValue(spec.parameters, args).length === 0 && concurrency(args as A)
        }),
    execute: async (args, exec) => {
      const violations = ValidateJsonValue(spec.parameters, args)
      if (violations.length > 0) throw new SwarmError('INVALID_ARGS', `参数不合法：${violations.join('；')}`)
      return spec.execute(args as A, exec)
    }
  }
}
