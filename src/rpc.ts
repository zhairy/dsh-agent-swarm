import type { FetchRouteLike } from './host-contract.js'
import type { JevHub } from './jev-hub.js'

/**
 * 设置页使用的宿主 RPC：沿用 DSH 浏览器端 rpc.call('/api', method, payload) 的线格式
 * （POST /api/<method>，请求体 client-request 信封，响应 server-response 信封），由 connection 的认证层保护。
 * 只返回密钥是否已配置与来源，从不返回密钥值。
 */

export const RPC_PREFIX = 'swarm.'
export const RPC_METHODS = ['jevStatus', 'jevHealth'] as const
export type RpcMethod = typeof RPC_METHODS[number]

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: { issues: unknown[] } } }

const serverResponse = (rpcId: string, result: RpcResult): Response => Response.json({ type: 'server-response', rpcId, result })

const failure = (code: string, message: string): RpcResult => ({ ok: false, error: { code, message, details: { issues: [] } } })

const readEnvelope = (body: unknown): { rpcId: string; method: string; payload: unknown } | undefined => {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || typeof record.method !== 'string') return undefined
  return { rpcId: record.rpcId, method: record.method, payload: record.payload }
}

/**
 * 执行一个 RPC 方法
 * @param {JevHub} jev - Jev 接入点
 * @param {RpcMethod} method - 方法名（不含前缀）
 * @param {AbortSignal} signal - 请求取消信号
 * @returns {Promise<RpcResult>} 结果
 */
export const RunRpcMethod = async (jev: JevHub, method: RpcMethod, signal: AbortSignal): Promise<RpcResult> => {
  try {
    if (method === 'jevStatus') return { ok: true, value: await jev.describeKey() }
    return { ok: true, value: await jev.getHealth(signal) }
  } catch (error) {
    return failure('swarm/internal', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 生成 RPC 路由
 * @param {() => JevHub} getJev - 取 Jev 接入点
 * @returns {FetchRouteLike[]} 路由
 */
export const getRpcRoutes = (getJev: () => JevHub): FetchRouteLike[] =>
  RPC_METHODS.map((method) => {
    const full = `${RPC_PREFIX}${method}`
    return {
      path: `/api/${full}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const envelope = readEnvelope(body)
        if (envelope === undefined) {
          const rawId = (body as { rpcId?: unknown } | null)?.rpcId
          return serverResponse(typeof rawId === 'string' ? rawId : 'invalid-request', failure('gateway/bad-request', 'invalid client-request message'))
        }
        if (envelope.method !== full) return serverResponse(envelope.rpcId, failure('gateway/bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(full)}`))
        return serverResponse(envelope.rpcId, await RunRpcMethod(getJev(), method, request.signal))
      }
    }
  })
