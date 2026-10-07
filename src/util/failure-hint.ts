/**
 * 模型调用失败原因的中文说明：宿主与供应商的原始错误多为英文（例如 "DeepSeek Messages transport failed"），
 * 在委派结果里附一句可操作的解释，帮助天枢与用户判断是网络、账号、额度还是请求本身的问题。
 */

const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/transport failed|fetch failed|ECONN(RESET|REFUSED|ABORTED)|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|\bTRANSPORT\b|\bNETWORK\b/i,
    '网络连接失败：无法连到模型服务（常见于本机断网、代理异常或服务端故障），网络恢复后会自动重试'],
  [/timed? ?out|\bTIMEOUT\b|ETIMEDOUT/i, '请求超时：模型服务长时间没有响应，可能是网络不稳定或服务繁忙'],
  [/No eligible account|NO_ADAPTER/i, '订阅账号暂不可用：未登录、令牌过期或刷新令牌时连不上网络，请在「设置 → 订阅」检查登录状态'],
  [/Unpurchased|Access to model denied|not eligible for (using )?(this|the) model/i, '账号未开通该模型：请换用其他模型或开通对应套餐'],
  [/usage limit|quota|insufficient (balance|quota)|余额不足|额度|exhausted/i, '额度用尽或余额不足：已按路由链切换备用模型，可稍后再试或充值'],
  [/RATE_LIMIT|\b429\b|rate.?limit|too many requests/i, '触发限流：请求过于频繁，稍后会自动重试'],
  [/INVALID_CREDENTIAL|UNAUTHORIZED|FORBIDDEN|\b401\b|\b403\b|invalid api key|authentication/i, '认证失败：API Key 无效或已过期，请在「设置 → 模型」更新密钥'],
  [/UNKNOWN_MODEL|model[^\n]*not (found|exist)|model-unavailable/i, '模型不可用：供应商目录里没有该模型，请检查路由配置'],
  [/UNSUPPORTED_OPTION|unsupported (reasoning|effort)|reasoning[_ ]effort/i, '请求参数不被该模型支持（例如推理强度档位），请检查路由里的推理强度'],
  [/OVERLOADED|\b5\d\d\b|SERVER_ERROR|internal error/i, '模型服务端错误或过载：稍后会自动重试']
]

/**
 * 为失败文本生成中文说明
 * @param {string | undefined} text - 原始错误
 * @returns {string | undefined} 说明；无法识别时为 undefined
 */
export const getFailureHint = (text: string | undefined): string | undefined => {
  if (text === undefined || text === '') return undefined
  return RULES.find(([pattern]) => pattern.test(text))?.[1]
}

/**
 * 在错误文本后附加中文说明（已附加过则不重复）
 * @param {string} text - 原始错误
 * @returns {string} 带说明的错误
 */
export const getExplainedError = (text: string): string => {
  const hint = getFailureHint(text)
  return hint === undefined || text.includes('（说明：') ? text : `${text}（说明：${hint}）`
}
