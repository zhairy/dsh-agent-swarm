/** 带稳定错误码的插件错误，工具层把它转成模型可读的错误结果 */
export class SwarmError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'SwarmError';
        this.code = code;
    }
}
/**
 * 取错误的可读文本
 * @param {unknown} error - 任意抛出值
 * @returns {string} 错误消息
 */
export const getErrorText = (error) => (error instanceof Error ? error.message : String(error));
//# sourceMappingURL=errors.js.map