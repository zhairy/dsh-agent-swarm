import type { FetchRouteLike } from './host-contract.js'
import type { JevHub } from './jev-hub.js'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { JevCredentialError } from './jev.js'
import { SwarmError } from './util/errors.js'

/**
 * 设置页使用的宿主 RPC：沿用 DSH 浏览器端 rpc.call('/api', method, payload) 的线格式
 * （POST /api/<method>，请求体 client-request 信封，响应 server-response 信封），由 connection 的认证层保护。
 * 只返回密钥是否已配置与来源，从不返回密钥值。
 */

export const RPC_PREFIX = 'swarm.'
export const RPC_METHODS = ['jevStatus', 'jevHealth'] as const
export type RpcMethod = typeof RPC_METHODS[number] | 'taskView' | 'agentView' | 'agentControl' | 'quotaView'
export interface AgentControlRpcInput {
  parentSessionId: string
  childId: string
  expectedRevision: number
  action: 'select' | 'stop' | 'continue'
  route?: { provider: string; model: string; reasoningEffort?: string }
  interruptRunning?: boolean
  retryRoute?: boolean
  forceRetry?: boolean
  confirmSafeToContinue?: boolean
  steering?: string
}
export interface TaskRpcDepsInfo {
  quotaView?: (force: boolean, signal: AbortSignal) => unknown | Promise<unknown>
  taskView?: (sessionId: string, taskId: string) => unknown | Promise<unknown>
  agentView?: (parentSessionId: string, childId: string) => unknown | Promise<unknown>
  agentControl?: (input: AgentControlRpcInput) => unknown | Promise<unknown>
}
export const MERMAID_ASSET_PATH = '/api/swarm-assets/mermaid.min.js'
const RPC_BODY_LIMIT = 16384

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: { issues: unknown[] } } }

const serverResponse = (rpcId: string, result: RpcResult): Response => Response.json({ type: 'server-response', rpcId, result })

const failure = (code: string, message: string): RpcResult => ({ ok: false, error: { code, message, details: { issues: [] } } })

const readEnvelope = (body: unknown): { rpcId: string; method: string; payload: unknown } | undefined => {
  if (body === null || typeof body !== 'object') return undefined
  const record = body as Record<string, unknown>
  if (record.type !== 'client-request' || typeof record.rpcId !== 'string' || record.rpcId.length === 0 || record.rpcId.length > 128 || typeof record.method !== 'string') return undefined
  return { rpcId: record.rpcId, method: record.method, payload: record.payload }
}

/**
 * 执行一个 RPC 方法
 * @param {JevHub} jev - Jev 接入点
 * @param {RpcMethod} method - 方法名（不含前缀）
 * @param {AbortSignal} signal - 请求取消信号
 * @returns {Promise<RpcResult>} 结果
 */
export const RunRpcMethod = async (jev: JevHub, method: RpcMethod, signal: AbortSignal, payload?: unknown, deps?: TaskRpcDepsInfo): Promise<RpcResult> => {
  try {
    if (method === 'quotaView') {
      const input = payload === undefined ? {} : payload
      if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'force') || ('force' in input && typeof input.force !== 'boolean')) return failure('gateway/bad-request', 'quotaView accepts only an optional boolean force')
      if (signal.aborted) return failure('gateway/cancelled', 'Quota read cancelled before admission')
      if (deps?.quotaView === undefined) return failure('swarm/unavailable', 'Quota source unavailable')
      try { return { ok: true, value: await deps.quotaView((input as { force?: boolean }).force === true, signal) } }
      catch { return failure(signal.aborted ? 'gateway/cancelled' : 'swarm/quota-unavailable', signal.aborted ? 'Quota read cancelled' : 'Quota source unavailable') }
    }
    if (method === 'jevStatus') return { ok: true, value: await jev.describeKey() }
    if (method === 'jevHealth') return { ok: true, value: await jev.getHealth(signal) }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return failure('gateway/bad-request', 'taskView payload must contain sessionId and taskId')
    const input = payload as Record<string, unknown>
    const validId = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 128 && !/[\u0000-\u001F\u007F]/.test(value)
    if (method === 'agentView' || method === 'agentControl') {
      const allowed = method === 'agentView' ? ['parentSessionId', 'childId'] : ['parentSessionId', 'childId', 'expectedRevision', 'action', 'route', 'interruptRunning', 'retryRoute', 'forceRetry', 'confirmSafeToContinue', 'steering']
      if (Object.keys(input).some((key) => !allowed.includes(key)) || !validId(input.parentSessionId) || !validId(input.childId)) return failure('gateway/bad-request', 'agent controls require bounded parentSessionId and childId')
      if (signal.aborted) return failure('gateway/cancelled', 'agent control request cancelled before admission')
      if (method === 'agentView') return deps?.agentView === undefined ? failure('swarm/unavailable', 'agent control view unavailable') : { ok: true, value: await deps.agentView(input.parentSessionId, input.childId) }
      if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || !['select', 'stop', 'continue'].includes(String(input.action))) return failure('gateway/bad-request', 'agent control action/revision invalid')
      for (const key of ['interruptRunning', 'retryRoute', 'forceRetry', 'confirmSafeToContinue']) if (input[key] !== undefined && typeof input[key] !== 'boolean') return failure('gateway/bad-request', 'agent control flags must be boolean')
      if (input.steering !== undefined && (typeof input.steering !== 'string' || input.steering.length > 8000)) return failure('gateway/bad-request', 'steering must be bounded text')
      if (input.action === 'select') {
        const route = input.route as Record<string, unknown> | undefined
        if (route === null || typeof route !== 'object' || Array.isArray(route) || Object.keys(route).some((key) => !['provider', 'model', 'reasoningEffort'].includes(key)) || !validId(route.provider) || !validId(route.model) || (route.reasoningEffort !== undefined && !validId(route.reasoningEffort))) return failure('gateway/bad-request', 'select requires a bounded model route without policy overrides')
      } else if (input.route !== undefined || input.interruptRunning !== undefined || input.retryRoute !== undefined || input.forceRetry !== undefined) return failure('gateway/bad-request', 'route controls apply only to select')
      if (input.action !== 'continue' && (input.confirmSafeToContinue !== undefined || input.steering !== undefined)) return failure('gateway/bad-request', 'continue controls apply only to continue')
      if (input.forceRetry === true && input.retryRoute !== true) return failure('gateway/bad-request', 'forceRetry requires explicit retryRoute')
      return deps?.agentControl === undefined ? failure('swarm/unavailable', 'agent controls unavailable') : { ok: true, value: await deps.agentControl(input as unknown as AgentControlRpcInput) }
    }
    if (Object.keys(input).some((key) => !['sessionId', 'taskId'].includes(key)) || !validId(input.sessionId) || !validId(input.taskId)) return failure('gateway/bad-request', 'taskView accepts only bounded string sessionId and taskId')
    if (deps?.taskView === undefined) return failure('swarm/unavailable', 'taskView service unavailable')
    return { ok: true, value: await deps.taskView(input.sessionId, input.taskId) }
  } catch (error) {
    if (error instanceof JevCredentialError) return failure(error.reason === 'credential-permission-denied' ? 'swarm/permission-denied' : 'swarm/credential-unavailable', error.reason)
    if (error instanceof SwarmError) return failure(`swarm/${error.code.toLowerCase().replaceAll('_', '-')}`, error.message)
    return failure('swarm/internal', error instanceof Error ? error.message : String(error))
  }
}

/**
 * 生成 RPC 路由
 * @param {() => JevHub} getJev - 取 Jev 接入点
 * @returns {FetchRouteLike[]} 路由
 */
export const getRpcRoutes = (getJev: () => JevHub, deps?: TaskRpcDepsInfo): FetchRouteLike[] => {
  const methods: RpcMethod[] = [...RPC_METHODS, ...(deps?.quotaView === undefined ? [] : ['quotaView' as const]), ...(deps?.taskView === undefined ? [] : ['taskView' as const]), ...(deps?.agentView === undefined ? [] : ['agentView' as const]), ...(deps?.agentControl === undefined ? [] : ['agentControl' as const])]
  const routes = methods.map((method): FetchRouteLike => {
    const full = `${RPC_PREFIX}${method}`
    return {
      path: `/api/${full}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } })
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let body: unknown
        try {
          const text = await request.text()
          if (Buffer.byteLength(text, 'utf8') > RPC_BODY_LIMIT) return new Response('body too large', { status: 413 })
          body = JSON.parse(text)
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const envelope = readEnvelope(body)
        if (envelope === undefined) {
          const rawId = (body as { rpcId?: unknown } | null)?.rpcId
          return serverResponse(typeof rawId === 'string' ? rawId : 'invalid-request', failure('gateway/bad-request', 'invalid client-request message'))
        }
        if (envelope.method !== full) return serverResponse(envelope.rpcId, failure('gateway/bad-request', `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(full)}`))
        return serverResponse(envelope.rpcId, await RunRpcMethod(getJev(), method, request.signal, envelope.payload, deps))
      }
    }
  })
  if (deps?.taskView !== undefined) routes.push(getMermaidAssetRoute())
  return routes
}

/** 只读取锁定依赖的固定资源；请求参数从不参与文件路径计算。 */
export const getMermaidAssetRoute = (): FetchRouteLike => {
  let asset: Promise<Uint8Array> | undefined
  const require = createRequire(import.meta.url)
  return {
    path: MERMAID_ASSET_PATH, methods: ['GET'], requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405, headers: { allow: 'GET' } })
      try {
        asset ??= readFile(require.resolve('mermaid/dist/mermaid.min.js'))
        return new Response(new Uint8Array(await asset), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } })
      } catch {
        asset = undefined
        return new Response('Local Mermaid asset unavailable', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
      }
    }
  }
}
