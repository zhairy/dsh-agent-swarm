/**
 * 模型调用失败原因的中文说明：宿主与供应商的原始错误多为英文（例如 "DeepSeek Messages transport failed"），
 * 在委派结果里附一句可操作的解释，帮助天枢与用户判断是网络、账号、额度还是请求本身的问题。
 */
/**
 * 为失败文本生成中文说明
 * @param {string | undefined} text - 原始错误
 * @returns {string | undefined} 说明；无法识别时为 undefined
 */
export declare const getFailureHint: (text: string | undefined) => string | undefined;
/**
 * 在错误文本后附加中文说明（已附加过则不重复）
 * @param {string} text - 原始错误
 * @returns {string} 带说明的错误
 */
export declare const getExplainedError: (text: string) => string;
