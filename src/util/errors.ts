/** 插件内部错误码 */
export type SwarmErrorCode =
  | 'INVALID_ARGS'
  | 'UNKNOWN_TASK'
  | 'UNKNOWN_ROLE'
  | 'INVALID_TRANSITION'
  | 'PATH_OUTSIDE_WORKSPACE'
  | 'UNSUPPORTED_IMAGE'
  | 'SERVICE_UNAVAILABLE'
  | 'BUDGET_EXHAUSTED'
  | 'PLANNING_REVIEW_REQUIRED'
  | 'STALE_EVIDENCE'
  | 'PERMISSION_DENIED'
  | 'RECOVERY_REQUIRED'

/** 带稳定错误码的插件错误，工具层把它转成模型可读的错误结果 */
export class SwarmError extends Error {
  readonly code: SwarmErrorCode

  constructor(code: SwarmErrorCode, message: string) {
    super(message)
    this.name = 'SwarmError'
    this.code = code
  }
}

/**
 * 取错误的可读文本
 * @param {unknown} error - 任意抛出值
 * @returns {string} 错误消息
 */
export const getErrorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
