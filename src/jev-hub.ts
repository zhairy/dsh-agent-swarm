import type { CredentialsLike } from './host-contract.js'
import { intJevClient, type JevClient, type JevConfigInfo } from './jev.js'
import { intJevTools, type JevToolResult, type JevTools } from './jev-tools.js'

/**
 * Jev 接入点：衡鉴（分流、会话判断、复评）、7 个 jev_* 工具与设置页共用同一个客户端，
 * 这样进程内限流（maxRequestsPerSecond）对所有调用统一生效；配置变化时重建客户端。
 */

export interface JevHubDepsInfo {
  getConfig: () => JevConfigInfo
  getCredentials: () => CredentialsLike | undefined
  fetch: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  logger?: { warn: (message: string) => void }
}

/** 密钥状态：只说明是否已配置、来自哪一层、能否写入，从不包含密钥值 */
export interface JevKeyStatusInfo {
  ref: string
  configured: boolean
  source?: string
  writable?: boolean
}

/** 凭据引用名必须像环境变量名；不合法时（例如误把密钥本身填进 apiKeyEnv）既不读取也不回显 */
export const isCredentialRefName = (ref: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) && ref.length <= 128

const INVALID_REF = '（引用名不合法）'

/** 设置页「测试连接」的结果 */
export interface JevHealthInfo {
  key: JevKeyStatusInfo
  enabled: boolean
  model: string
  baseUrl: string
  result: JevToolResult
}

/**
 * 创建 Jev 接入点
 * @param {JevHubDepsInfo} deps - 依赖
 * @returns 共享客户端、密钥读取、工具实现与健康检查
 */
export const intJevHub = (deps: JevHubDepsInfo) => {
  let memo: { fingerprint: string; client: JevClient } | undefined

  /** 读取密钥：先走宿主凭据服务（设置页写入的值、secrets 文件、环境变量），再退回进程环境变量；只在本模块内使用 */
  const getKey = async (ref: string): Promise<string | undefined> => {
    if (!isCredentialRefName(ref)) return undefined
    try {
      const hit = await deps.getCredentials()?.resolve(ref)
      if (hit?.value) return hit.value
    } catch (error) {
      deps.logger?.warn(`读取 Jev 凭据引用 ${ref} 失败：${String(error)}`)
    }
    const value = process.env[ref]
    return value === undefined || value === '' ? undefined : value
  }

  const getClient = (): JevClient => {
    const config = deps.getConfig()
    const fingerprint = JSON.stringify(config)
    if (memo?.fingerprint === fingerprint) return memo.client
    const client = intJevClient(config, {
      fetch: deps.fetch,
      getApiKey: () => getKey(config.apiKeyEnv),
      ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
      ...(deps.now === undefined ? {} : { now: deps.now })
    })
    memo = { fingerprint, client }
    return client
  }

  const tools: JevTools = intJevTools({ getClient, ...(deps.now === undefined ? {} : { now: deps.now }) })

  const describeKey = async (): Promise<JevKeyStatusInfo> => {
    const ref = deps.getConfig().apiKeyEnv
    if (!isCredentialRefName(ref)) return { ref: INVALID_REF, configured: false }
    const credentials = deps.getCredentials()
    const inEnv = process.env[ref] !== undefined && process.env[ref] !== ''
    try {
      const info = await credentials?.describe?.(ref)
      if (info !== undefined && (info.configured || !inEnv)) {
        return { ref, configured: info.configured, writable: info.writable, ...(info.source === undefined ? {} : { source: info.source }) }
      }
      // 宿主没有 describe（较旧版本）：能解析出值即视为已配置
      if (info === undefined) {
        const hit = await credentials?.resolve(ref)
        if (hit?.value) return { ref, configured: true, ...(hit.source === undefined ? {} : { source: hit.source }) }
      }
    } catch (error) {
      deps.logger?.warn(`查询 Jev 凭据引用 ${ref} 失败：${String(error)}`)
    }
    if (inEnv) return { ref, configured: true, source: 'process-env', writable: false }
    return { ref, configured: false }
  }

  const getHealth = async (signal?: AbortSignal): Promise<JevHealthInfo> => {
    const config = deps.getConfig()
    const [key, result] = await Promise.all([describeKey(), tools.health(signal)])
    return { key, enabled: config.enabled, model: config.model, baseUrl: config.baseUrl, result }
  }

  return { getClient, describeKey, getHealth, tools }
}

export type JevHub = ReturnType<typeof intJevHub>
