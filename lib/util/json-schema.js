const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const ValidateObject = (schema, value, path) => {
    if (!isPlainObject(value))
        return [`${path} 必须是对象`];
    const properties = schema.properties ?? {};
    const missing = (schema.required ?? [])
        .filter((key) => value[key] === undefined)
        .map((key) => `${path}.${key} 缺失`);
    const extra = schema.additionalProperties === false
        ? Object.keys(value).filter((key) => !(key in properties)).map((key) => `${path}.${key} 不是允许的字段`)
        : [];
    const nested = Object.entries(properties)
        .filter(([key]) => value[key] !== undefined)
        .flatMap(([key, child]) => ValidateJsonValue(child, value[key], `${path}.${key}`));
    return [...missing, ...extra, ...nested];
};
/**
 * 按 JSON Schema 子集校验值
 * @param {JsonSchemaObject} schema - 校验规则
 * @param {unknown} value - 待校验值
 * @param {string} [path='$'] - 错误信息中的路径前缀
 * @returns {string[]} 违规描述，空数组表示通过
 */
export const ValidateJsonValue = (schema, value, path = '$') => {
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
        return [`${path} 必须是 ${schema.enum.join(' / ')} 之一`];
    }
    switch (schema.type) {
        case 'object':
            return ValidateObject(schema, value, path);
        case 'array': {
            if (!Array.isArray(value))
                return [`${path} 必须是数组`];
            const items = schema.items;
            return items === undefined ? [] : value.flatMap((item, index) => ValidateJsonValue(items, item, `${path}[${index}]`));
        }
        case 'string':
            return typeof value === 'string' ? [] : [`${path} 必须是字符串`];
        case 'number':
            return typeof value === 'number' && Number.isFinite(value) ? [] : [`${path} 必须是数字`];
        case 'boolean':
            return typeof value === 'boolean' ? [] : [`${path} 必须是布尔值`];
        default:
            return [];
    }
};
//# sourceMappingURL=json-schema.js.map