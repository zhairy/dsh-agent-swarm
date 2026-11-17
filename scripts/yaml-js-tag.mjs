/** YAML `!!js` 表达式标签：解析为 JsExpr，输出时写回 `!!js "<源码>"`，保证生成的预设保留 Loader 表达式 */
export class JsExpr {
  constructor(source) {
    this.source = source
  }

  toJSON() {
    return { $js: this.source }
  }
}

export const JS_TAG = {
  tag: 'tag:yaml.org,2002:js',
  identify: (value) => value instanceof JsExpr,
  resolve: (source) => new JsExpr(source),
  stringify: (item) => JSON.stringify(item.value.source)
}

/**
 * 把 JSON 中的 `{ $js }` 还原为 JsExpr（fixture 与生成结果比对时使用）
 * @param {unknown} value - JSON 值
 * @returns {unknown} 还原后的值
 */
export const getJsRevived = (value) => {
  if (value instanceof JsExpr) return value
  if (Array.isArray(value)) return value.map(getJsRevived)
  if (value === null || typeof value !== 'object') return value
  const keys = Object.keys(value)
  if (keys.length === 1 && keys[0] === '$js') return new JsExpr(value.$js)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getJsRevived(item)]))
}
