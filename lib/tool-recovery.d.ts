/**
 * 已知宿主工具错误的只读恢复提示。只补充失败呈现，不能改变 isError、
 * 原始错误码或工具的事实结果，也不发网络请求或重放调用。
 */
export declare const getToolRecoveryResult: (name: string, result: unknown) => unknown;
