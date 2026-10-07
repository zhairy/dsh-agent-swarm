/** 判断是否为 volatile 配置引用（DSH 0.1.7 起 Config 字段值带 get()） */
const isLiveRef = (value: unknown): value is { get: () => unknown } =>
  value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'

/**
 * 读取 volatile 字段的当前值；旧宿主给的普通值原样返回
 * @param {unknown} value - 配置字段值
 * @returns {T} 当前值
 */
export const readLive = <T = unknown>(value: unknown): T => (isLiveRef(value) ? value.get() : value) as T

/**
 * 逐字段读取配置对象的当前值，每次调用都重新读取以便设置页修改即时生效
 * @param {unknown} raw - 插件收到的 Config
 * @returns {Record<string, unknown>} 普通对象
 */
export const readLiveObject = (raw: unknown): Record<string, unknown> => {
  if (raw === null || typeof raw !== 'object') return {}
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, readLive(value)]))
}
