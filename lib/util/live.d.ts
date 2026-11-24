/**
 * 读取 volatile 字段的当前值；旧宿主给的普通值原样返回
 * @param {unknown} value - 配置字段值
 * @returns {T} 当前值
 */
export declare const readLive: <T = unknown>(value: unknown) => T;
/**
 * 逐字段读取配置对象的当前值，每次调用都重新读取以便设置页修改即时生效
 * @param {unknown} raw - 插件收到的 Config
 * @returns {Record<string, unknown>} 普通对象
 */
export declare const readLiveObject: (raw: unknown) => Record<string, unknown>;
