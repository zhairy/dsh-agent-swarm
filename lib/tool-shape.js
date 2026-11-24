import { SwarmError } from './util/errors.js';
import { ValidateJsonValue } from './util/json-schema.js';
/** 宿主要求 lossless JSON：明确省略可选字段，不把非有限数或宿主句柄静默转成 null。 */
export const getLosslessToolValue = (value) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value;
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (Array.isArray(value))
        return value.map(getLosslessToolValue);
    if (value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, getLosslessToolValue(item)]));
    }
    throw new SwarmError('INVALID_ARGS', '工具结果包含不能无损编码的值');
};
/**
 * 把工具声明转换为宿主工具定义：执行前按参数 schema 校验，结果渲染为文本块
 * 不依赖宿主内部包 @deepseek-ai/dsh-tools，避免第三方包的解析问题
 * @param {ToolSpecInfo<A, R>} spec - 工具声明
 * @returns {ToolDefinitionLike} 可注册的工具定义
 */
export const getToolDefinition = (spec) => {
    const concurrency = spec.isConcurrencySafe;
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (args, value) => [{ type: 'text', text: spec.render(args, value) }]
        },
        ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
        ...(concurrency === undefined
            ? {}
            : {
                isConcurrencySafe: (args) => ValidateJsonValue(spec.parameters, args).length === 0 && concurrency(args)
            }),
        execute: async (args, exec) => {
            const violations = ValidateJsonValue(spec.parameters, args);
            if (violations.length > 0)
                throw new SwarmError('INVALID_ARGS', `参数不合法：${violations.join('；')}`);
            return getLosslessToolValue(await spec.execute(args, exec));
        }
    };
};
//# sourceMappingURL=tool-shape.js.map