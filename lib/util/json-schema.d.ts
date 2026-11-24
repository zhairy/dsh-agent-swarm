/** 本插件使用的 JSON Schema 子集（同时用作 DSH outputSchema，避免使用宿主可能不支持的关键字） */
export interface JsonSchemaObject {
    type?: 'object' | 'array' | 'string' | 'number' | 'boolean';
    description?: string;
    properties?: Record<string, JsonSchemaObject>;
    required?: readonly string[];
    additionalProperties?: boolean;
    items?: JsonSchemaObject;
    enum?: readonly string[];
}
/**
 * 按 JSON Schema 子集校验值
 * @param {JsonSchemaObject} schema - 校验规则
 * @param {unknown} value - 待校验值
 * @param {string} [path='$'] - 错误信息中的路径前缀
 * @returns {string[]} 违规描述，空数组表示通过
 */
export declare const ValidateJsonValue: (schema: JsonSchemaObject, value: unknown, path?: string) => string[];
