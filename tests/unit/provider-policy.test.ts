import { describe, expect, it } from 'vitest'
import { getRouteFailure, getRouteRecoveryPolicy, getWireReasoningEffort, isTerminalRouteFailure, normalizeRouteFailure, type FailureKind } from '../../src/provider-policy.js'
import { getFailureHint } from '../../src/util/failure-hint.js'

const route = { provider: 'codex', model: 'gpt-6.1-sol' }
describe('供应商失败语义与恢复时间', () => {
  it('预检和调度共享真实wire effort，只有Codex ultra映射max', () => {
    expect(getWireReasoningEffort({ provider: 'codex', reasoningEffort: 'ultra' })).toBe('max')
    expect(getWireReasoningEffort({ provider: 'codex', reasoningEffort: 'low' })).toBe('low')
    expect(getWireReasoningEffort({ provider: 'other', reasoningEffort: 'ultra' })).toBe('ultra')
  })
  it.each([
    [{ code: 'QUOTA' }, 'quota_exhausted'],
    [{ status: 429, message: 'Your token-plan 1-month quota has been exhausted.' }, 'quota_exhausted'],
    [{ code: 'RATE_LIMIT', message: 'pool "gpt-6.1-sol" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 }, 'pool_exhausted'],
    [{ code: 'NO_ADAPTER', message: 'No eligible account for codex/gpt-6.1-sol' }, 'pool_exhausted'],
    [{ code: 'NO_ADAPTER', message: 'No eligible account: token refresh transport failed' }, 'network_transient'],
    [{ code: 'NO_ADAPTER', message: 'provider is not registered' }, 'model_unavailable'],
    [{ code: 'MISSING_CREDENTIAL' }, 'auth_invalid'],
    [{ status: 401 }, 'auth_invalid'], [{ status: 403 }, 'auth_invalid'],
    [{ status: 404, message: 'model not found' }, 'model_unavailable'],
    [{ status: 400, message: 'Invalid value: tool' }, 'unknown'],
    [{ status: 402, message: 'payment required' }, 'unknown'],
    [{ status: 404, message: 'endpoint not found' }, 'unknown'],
    [{ status: 422, message: 'invalid request' }, 'unknown'],
    [{ code: 'IMAGE_UNSUPPORTED' }, 'capability_mismatch'],
    [{ code: 'UNSUPPORTED_OPTION', status: 400 }, 'capability_mismatch'],
    [{ code: 'UNSUPPORTED_REASONING_EFFORT' }, 'capability_mismatch'],
    [{ code: 'CONTEXT_WINDOW_EXCEEDED', status: 400, message: 'Invalid request: Your request exceeded model token limit: 262144 (requested: 459079)' }, 'context_exceeded'],
    [{ status: 400, message: 'maximum context length is 262144 tokens' }, 'context_exceeded'],
    [{ code: 'INVALID_REQUEST', status: 400, message: 'The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: r1)' }, 'protocol_incompatible'],
    [{ status: 429, message: 'quota per minute exceeded' }, 'rate_limited']
  ] as const)('%j => %s，不能把账户/上下文/协议错误都称为额度耗尽', (failure, kind) => {
    expect(normalizeRouteFailure(failure, route).kind).toBe(kind)
  })

  it('池巨额retry hint不等于订阅重置：按提示隔离但至多 30 分钟重探；当前请求立即回退', () => {
    const failure = normalizeRouteFailure({ code: 'RATE_LIMIT', message: 'pool "gpt-6.1-sol" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 }, route)
    expect(failure.resetAt).toBeUndefined()
    expect(getRouteRecoveryPolicy(failure).retryDelayMs).toBe(1_800_000)
    expect(getRouteRecoveryPolicy({ ...failure, providerRetryAfterMs: 600_000 }).retryDelayMs).toBe(600_000)
    const auth = normalizeRouteFailure({ code: 'AUTH', message: 'pool "claude-opus-5-5" exhausted: every member is cooling down; claude/token-x/* (AUTH) recovers in 23h55m', providerRetryAfterMs: 86_100_000 }, route)
    expect(auth.kind).toBe('auth_invalid')
    expect(getRouteRecoveryPolicy(auth).retryDelayMs).toBe(1_800_000)
    expect(getRouteRecoveryPolicy({ kind: 'rate_limited', providerRetryAfterMs: 9060669 }).retryDelayMs).toBe(9060669)
  })

  it.each([
    // AUTH 也可能是模型权限或临时刷新失败，不能仅凭 code 扩大为 provider 认证隔离。
    [{ code: 'AUTH', message: 'pool "claude-opus-5-5" exhausted: every member is cooling down; claude/token-x/* (AUTH) recovers in 2h' }, 'auth_invalid'],
    [{ code: 'AUTH', message: '403 Access to model denied.' }, 'model_unavailable'],
    [{ code: 'AUTH', status: 403, message: 'Access to model denied.' }, 'model_unavailable'],
    [{ code: 'AUTH', message: '403 Access to model denied. Please log in again.' }, 'model_unavailable'],
    [{ code: 'AUTH', message: 'Codex token refresh failed' }, 'unknown'],
    [{ code: 'AUTH', message: 'Codex token refresh failed: fetch failed' }, 'unknown'],
    [{ code: 'AUTH', message: 'pool "claude-opus-5-5" exhausted: 2 of 2 member(s) failed; last claude/a (AUTH: 403 Access to model denied.)' }, 'pool_exhausted'],
    [{ code: 'AUTH', status: 401, message: 'invalid api key' }, 'auth_invalid'],
    [{ code: 'AUTH' }, 'unknown'],
    [{ code: 'AUTH', message: '403 request rejected' }, 'unknown'],
    [{ message: 'invalid credentials' }, 'unknown']
  ] as const)('AUTH 细分：%j => %s', (failure, kind) => {
    expect(normalizeRouteFailure(failure, route).kind).toBe(kind)
  })

  it.each([
    // 已核验 pi-ai mapStopReason 的 AUTH failure 只有 code/message、无 status；以下为该形状的合成反例。
    '401 invalid api key',
    '403 authentication failed',
    '401 invalid credentials',
    '401 token expired',
    '401 Token has expired',
    '401 Please log in again',
    '401 login required',
    '401 not logged in'
  ])('宿主无 status 的明确 AUTH 文本仍按认证失效处理：%s', (message) => {
    const failure = getRouteFailure({ failure: { code: 'AUTH', message } })
    expect(failure.status).toBeUndefined()
    expect(normalizeRouteFailure(failure, route).kind).toBe('auth_invalid')
  })

  it('按已观察到的Qwen月额度UTC句式保留确切reset，其他provider不能借此互相污染', () => {
    const at = Date.parse('2026-10-08T10:31:06Z')
    const failure = { code: 'QUOTA', message: 'Your token-plan 1-month quota has been exhausted. The quota will reset at 10-18 16:00:00 UTC.' }
    expect(normalizeRouteFailure(failure, { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }, at).resetAt).toBe('2026-10-18T16:00:00.000Z')
    expect(normalizeRouteFailure(failure, route, at).resetAt).toBeUndefined()
    expect(normalizeRouteFailure({ ...failure, resetAt: '2026-10-20T00:00:00Z' }, route, at).resetAt).toBe('2026-10-20T00:00:00Z')
    expect(normalizeRouteFailure({ ...failure, message: 'The quota will reset at 02-30 16:00:00 UTC.' }, { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }, at).resetAt).toBeUndefined()
  })

  it('所有真实provider故障给有限恢复探针；context为请求问题，不隔离route', () => {
    const kinds: FailureKind[] = ['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'protocol_incompatible', 'unknown']
    for (const kind of kinds) {
      const policy = getRouteRecoveryPolicy({ kind }, 32)
      expect(policy.isolate).toBe(true)
      expect(policy.retryDelayMs).toBeGreaterThan(0)
      expect(Number.isFinite(policy.retryDelayMs)).toBe(true)
    }
    expect(getRouteRecoveryPolicy({ kind: 'context_exceeded' })).toEqual({ isolate: false, retryDelayMs: 0 })
    expect(getRouteRecoveryPolicy({ kind: 'capability_mismatch' })).toEqual({ isolate: false, retryDelayMs: 0 })
  })

  it('thinking 协议不兼容会终止当前路由并立即回退，避免同一会话反复命中', () => {
    const failure = normalizeRouteFailure({ code: 'INVALID_REQUEST', status: 400, message: 'The `content[].thinking` in the thinking mode must be passed back to the API.' }, route)
    expect(failure.kind).toBe('protocol_incompatible')
    expect(isTerminalRouteFailure(failure)).toBe(true)
    expect(getRouteRecoveryPolicy(failure)).toEqual({ isolate: true, retryDelayMs: 1_800_000 })
  })

  it('提示区分池不可用、适配器缺失、上下文过长与真正额度', () => {
    expect(getFailureHint('pool "gpt-6-sol" exhausted: every member is unavailable or failed')).toContain('具体成员故障原因尚不确定')
    expect(getFailureHint('NO_ADAPTER: provider not registered')).toContain('检查 provider')
    expect(getFailureHint('No eligible account')).toContain('不证明订阅额度耗尽')
    expect(getFailureHint('CONTEXT_WINDOW_EXCEEDED')).toContain('先压缩')
    expect(getFailureHint('The `content[].thinking` in the thinking mode must be passed back to the API')).toContain('thinking 消息格式')
    expect(getFailureHint('HTTP 401')).toContain('订阅账号请检查登录状态')
    expect(getFailureHint('UNSUPPORTED_REASONING_EFFORT')).toContain('其它合法档位仍可使用')
    expect(getFailureHint('QUOTA')).toContain('停止原故障域重试')
  })
})
