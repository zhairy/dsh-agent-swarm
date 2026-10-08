import type { TaskCard, TriageAnswers } from './policy.js'
import { normalizeRouteFailure, isTerminalRouteFailure } from './provider-policy.js'

/** Jev 调用配置 */
export interface JevConfigInfo {
  enabled: boolean
  apiKeyEnv: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxRetries: number
  /** 兼容旧配置；Jev 不主动限流，此值不再参与发送决策 */
  maxRequestsPerSecond: number
  /** 单次请求（state + questions 序列化后）的字符上限 */
  maxRequestChars: number
}

export const DEFAULT_JEV_CONFIG: JevConfigInfo = {
  enabled: true,
  apiKeyEnv: 'TYPESAFE_API_KEY',
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 10000,
  maxRetries: 4,
  maxRequestsPerSecond: 0,
  maxRequestChars: 120000
}

export const JEV_PATH = '/v1/systemone'
export const JEV_MODELS_PATH = '/v1/models'

/** V2 设计稿 §4 定义的三道分流题 */
export const JEV_QUESTIONS = {
  math_task: {
    type: 'choice',
    instructions: '选择此任务需要的数学检查类型；按最高必要强度选择',
    criteria: {
      ordinary: '只改变工程实现，不改变算法语义',
      invariant: '需要检查边界条件、状态不变量或数值精度',
      equivalence: '增量和全量实现需要语义等价验证',
      research: '需要设计新算法并比较复杂度、正确性和性能'
    }
  },
  need_benchmark: {
    type: 'noul',
    instructions: '是否有性能目标或关键数据规模要求，需做可重复基准测试'
  },
  novelty: {
    type: 'score',
    instructions: '算法变化的程度',
    criteria: ['行为不变的局部调整', '改变状态或边界处理', '提出新算法或语义']
  }
} as const

const REDACTED = '[已脱敏]'

/** 键名像密钥的键值对：key: v、key=v，以及 JSON 的 "key": "v"（键名前后可有引号） */
const SECRET_KEY_VALUE = /(["']?)([A-Za-z0-9_.-]*?(?:api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(["']?)([^"'\s,;}\]]{4,})\4/gi

/** 常见密钥格式（不依赖键名） */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|tsk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
]

const MAX_TEXT = 500

/**
 * 去掉密钥样式内容并截断，保证发往 Jev 的只有脱敏摘要。
 * 覆盖 JSON 形式的键值（结构化交付会先 JSON.stringify 再脱敏）、PEM 私钥、JWT 与常见服务的令牌前缀。
 * @param {string} text - 原文
 * @param {number} [max=500] - 截断长度
 * @returns {string} 脱敏文本
 */
export const getRedactedText = (text: string, max = MAX_TEXT): string =>
  SECRET_PATTERNS
    .reduce((acc, pattern) => acc.replace(pattern, REDACTED), text.replace(SECRET_KEY_VALUE, (_m, q1, key, sep, q2) => `${q1}${key}${q1}${sep}${q2}${REDACTED}${q2}`))
    .slice(0, max)

/**
 * 构造 Jev 的 state：只含任务卡的结构化摘要，不含源码、路径内容与密钥
 * @param {TaskCard} card - 任务卡
 * @returns {object} state
 */
export const getJevState = (card: TaskCard) => ({
  task: getRedactedText(card.title),
  goal: getRedactedText(card.goal),
  flags: card.flags,
  profile: Object.fromEntries(Object.entries(card.perf ?? {}).map(([key, value]) => [key, typeof value === 'string' ? getRedactedText(value) : value])),
  acceptance_count: card.acceptance.length,
  scope_count: card.scope.length
})

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** 所有 Jev 判断入口共用数值合同；非法值不能进入分流、分档或审核结论。 */
export const isJevProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
export const isJevScore = (value: unknown, levels: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= levels - 1

export type JevFailureKind = 'disabled' | 'configuration' | 'permission' | 'authentication' | 'billing' | 'availability' | 'invalid-request' | 'invalid-response' | 'cancelled' | 'unknown'
interface JevFailureLike { reason: string; status?: number; failureKind?: JevFailureKind }

/** 根据稳定事实分类；不把权限、坏响应或取消伪装为可降级的服务不可用。 */
export const getJevFailureKind = (failure: JevFailureLike): JevFailureKind => {
  if (failure.failureKind !== undefined) return failure.failureKind
  if (failure.reason === 'disabled') return 'disabled'
  if (failure.reason === 'missing-api-key') return 'configuration'
  if (failure.reason === 'credential-permission-denied' || failure.status === 403) return 'permission'
  if (failure.reason === 'credential-unavailable') return 'unknown'
  if (failure.status === 401) return 'authentication'
  if (failure.status === 402) return 'billing'
  if (failure.reason === 'aborted') return 'cancelled'
  if (['malformed-response', 'no-models'].includes(failure.reason)) return 'invalid-response'
  if (failure.reason === 'request-too-large' || [400, 404, 422].includes(failure.status ?? 0)) return 'invalid-request'
  if (['network', 'timeout'].includes(failure.reason) || failure.status === 429 || (failure.status ?? 0) >= 500) return 'availability'
  return 'unknown'
}

/** 可选 Jev 审核只允许有明确原因的关闭、缺少配置或上游临时不可用降级。 */
export const isJevAvailabilityFailure = (failure: JevFailureLike): boolean => ['disabled', 'configuration', 'availability'].includes(getJevFailureKind(failure))

/** 凭据错误只带受控原因；宿主拒绝后不尝试另一凭据来源。 */
export class JevCredentialError extends Error {
  constructor (readonly reason: 'credential-permission-denied' | 'credential-unavailable') { super(reason); this.name = 'JevCredentialError' }
}

export const getJevCredentialError = (error: unknown): JevCredentialError => {
  if (error instanceof JevCredentialError) return error
  const facts = asRecord(error)
  const code = String(facts.code ?? '').toLowerCase()
  const message = error instanceof Error ? error.message : String(facts.message ?? '')
  const denied = facts.status === 403 || /permission|forbidden|approval|denied|eacces|eperm/.test(code) || /permission denied|access denied|requires approval|approval policy|not authorized|forbidden/i.test(message)
  return new JevCredentialError(denied ? 'credential-permission-denied' : 'credential-unavailable')
}

/**
 * 只读取程序需要的字段：math_task.choice/confidence、need_benchmark.noul、novelty.score/confidence
 * @param {unknown} body - Jev 响应体
 * @returns {TriageAnswers} 解析结果
 */
export const ParseJevAnswers = (body: unknown): TriageAnswers => {
  const answers = asRecord(asRecord(body).answers)
  const mathTask = asRecord(answers.math_task)
  const benchmark = asRecord(answers.need_benchmark)
  const novelty = asRecord(answers.novelty)
  return {
    ...(typeof mathTask.choice === 'string' && Object.hasOwn(JEV_QUESTIONS.math_task.criteria, mathTask.choice) && isJevProbability(mathTask.confidence)
      ? { mathTask: { choice: mathTask.choice, confidence: mathTask.confidence } }
      : {}),
    ...(isJevProbability(benchmark.noul) ? { needBenchmark: benchmark.noul } : {}),
    ...(isJevScore(novelty.score, JEV_QUESTIONS.novelty.criteria.length) && isJevProbability(novelty.confidence)
      ? { novelty: { score: novelty.score, confidence: novelty.confidence } }
      : {})
  }
}

export type JevOutcome =
  | { ok: true; answers: TriageAnswers; attempts: number }
  | { ok: false; reason: string; attempts: number }

/** Jev 用量：输入与输出 token（服务端报告） */
export interface JevUsageInfo {
  /** 缺失/非法服务用量为 unknown，不能冒充零。 */
  inputTokens?: number
  outputTokens?: number
}

/** 通用提问的结果：answers 为 Jev 原始答案（按题目 ID） */
export type JevAskOutcome =
  | { ok: true; answers: Record<string, unknown>; model?: string; attempts: number; usage: JevUsageInfo; latencyMs: number }
  | { ok: false; reason: string; attempts: number; status?: number; retryAfterMs?: number; failureKind?: JevFailureKind }

/** 模型列表（健康检查） */
export type JevModelsOutcome =
  | { ok: true; models: Array<{ name: string; description: string; releaseDate: string }>; latencyMs: number }
  | { ok: false; reason: string; status?: number; failureKind?: JevFailureKind }

/** Jev 客户端依赖 */
export interface JevDepsInfo {
  fetch: typeof fetch
  getApiKey: () => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

type PostResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'http'; status: number; retryAfterMs?: number; terminal?: boolean; failureKind?: JevFailureKind }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'aborted' }
  | { kind: 'malformed-response' }

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])
const MAX_RETRY_AFTER_MS = 30_000

const getRetryAfterMs = (value: string | null, now: () => number): number | undefined => {
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now())
}

const getUsage = (record: Record<string, unknown>): JevUsageInfo => {
  const usage = asRecord(record.usage)
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  return {
    ...(valid(usage.input_tokens) ? { inputTokens: usage.input_tokens } : {}),
    ...(valid(usage.output_tokens) ? { outputTokens: usage.output_tokens } : {})
  }
}

/** 读取取消状态（经函数读取，避免 await 前后的类型收窄误判） */
const isAborted = (signal?: AbortSignal): boolean => signal?.aborted === true

/**
 * 进程内滑动窗口限流：每个窗口最多 max 个请求，超出的请求排队等待
 * @deprecated 仅保留旧公开接口兼容；当前 Jev 客户端不调用它，也不建立本地限流队列。
 * @param {number} max - 每秒请求上限
 * @param {(ms: number) => Promise<void>} sleep - 等待函数
 * @param {() => number} now - 时钟
 * @returns {() => Promise<void>} 申请一个请求名额
 */
export const intRequestLimiter = (max: number, sleep: (ms: number) => Promise<void>, now: () => number = Date.now) => {
  if (max <= 0) return async (): Promise<void> => undefined
  const stamps: number[] = []
  let chain = Promise.resolve()
  const acquire = async (): Promise<void> => {
    for (;;) {
      const at = now()
      while (stamps.length > 0 && at - (stamps[0] as number) >= 1000) stamps.shift()
      if (stamps.length < Math.max(1, max)) {
        stamps.push(at)
        return
      }
      await sleep(Math.max(1, 1000 - (at - (stamps[0] as number))))
    }
  }
  // 串行化名额申请，避免并发请求同时读到同一个窗口
  return (): Promise<void> => {
    const next = chain.then(acquire)
    chain = next.catch(() => undefined)
    return next
  }
}

/**
 * 创建 Jev 客户端（TypeSafe System One HTTP API）
 * @param {JevConfigInfo} config - 调用配置
 * @param {JevDepsInfo} deps - fetch、密钥读取与等待函数
 * @returns 客户端：ask（任意题目）、triage（任务分流）、listModels（健康检查）
 */
export const intJevClient = (config: JevConfigInfo, deps: JevDepsInfo) => {
  const now = deps.now ?? Date.now
  // 用户明确选择 Jev 全入口不限流；旧非零 RPS 仅保留配置兼容，不建立队列。
  const baseUrl = config.baseUrl.replace(/\/$/, '')

  // 默认定时器可清理；注入 sleep 的 Promise 也可被取消抢先结束，不必等待 Retry-After。
  const waitForRetry = (ms: number, signal?: AbortSignal): Promise<boolean> => new Promise((resolve, reject) => {
    if (isAborted(signal)) { resolve(false); return }
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const cleanup = () => { if (timer !== undefined) clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const finish = (ready: boolean) => { if (settled) return; settled = true; cleanup(); resolve(ready) }
    const onAbort = () => finish(false)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (isAborted(signal)) { finish(false); return }
    if (deps.sleep === undefined) timer = setTimeout(() => finish(true), ms)
    else Promise.resolve().then(() => deps.sleep!(ms)).then(() => finish(true), (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error) })
  })

  const send = async (path: string, init: { method: 'GET' | 'POST'; body?: string }, key: string, signal?: AbortSignal): Promise<PostResult> => {
    if (isAborted(signal)) return { kind: 'aborted' }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await deps.fetch(`${baseUrl}${path}`, {
        method: init.method,
        headers: { Authorization: `Bearer ${key}`, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal
      })
      if (!response.ok) {
        const retryAfterMs = getRetryAfterMs(response.headers?.get?.('retry-after') ?? null, now)
        // 429 既可能是短限速也可能是账号终态；只读取错误类别，不回显服务正文。
        let terminal = response.status === 402 || response.status === 401 || response.status === 403
        if (terminal) return { kind: 'http', status: response.status, terminal, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
        let failureKind: JevFailureKind | undefined
        try {
          const body = asRecord(await response.json())
          const error = asRecord(body.error)
          const code = String(error.code ?? body.code ?? error.type ?? '')
          const message = String(error.message ?? body.message ?? '')
          const failure = normalizeRouteFailure({ code, status: response.status, message }, { provider: 'jev', model: config.model })
          terminal ||= isTerminalRouteFailure(failure)
          if (['quota_exhausted', 'pool_exhausted', 'insufficient_balance'].includes(failure.kind)) failureKind = 'billing'
          else if (failure.kind === 'auth_invalid') failureKind = code.toUpperCase() === 'FORBIDDEN' ? 'permission' : 'authentication'
          else if (failure.kind === 'model_unavailable') failureKind = 'invalid-request'
        } catch { /* 没有结构化错误正文：按 HTTP 状态处理 */ }
        return { kind: 'http', status: response.status, ...(terminal ? { terminal } : {}), ...(failureKind === undefined ? {} : { failureKind }), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
      }
      try { return { kind: 'ok', body: await response.json() } } catch {
        if (isAborted(signal)) return { kind: 'aborted' }
        return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'malformed-response' }
      }
    } catch {
      // 调用方取消优先于超时判断：取消后不应再重试
      if (isAborted(signal)) return { kind: 'aborted' }
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /** 带重试的发送：429/5xx/超时/网络错误按指数退避重试，429 优先遵守 Retry-After */
  const sendWithRetry = async (path: string, init: { method: 'GET' | 'POST'; body?: string }, key: string, signal?: AbortSignal) => {
    for (let attempt = 1; ; attempt++) {
      if (signal?.aborted === true) return { result: { kind: 'aborted' } as PostResult, attempts: attempt - 1 }
      const result = await send(path, init, key, signal)
      if (result.kind === 'ok') return { result, attempts: attempt }
      const retryable = result.kind === 'http' ? !result.terminal && RETRYABLE_STATUS.has(result.status) : result.kind === 'network' || result.kind === 'timeout'
      if (!retryable || attempt > config.maxRetries) return { result, attempts: attempt }
      const backoff = 500 * 2 ** (attempt - 1)
      // 长 Retry-After 不可截短再提前撞服务；返回 unavailable，等待由调用方管理。
      if (result.kind === 'http' && (result.retryAfterMs ?? 0) > MAX_RETRY_AFTER_MS) return { result, attempts: attempt }
      const wait = result.kind === 'http' && result.retryAfterMs !== undefined ? Math.max(backoff, result.retryAfterMs) : backoff
      if (!await waitForRetry(wait, signal)) return { result: { kind: 'aborted' } as PostResult, attempts: attempt }
    }
  }

  const getKey = async (): Promise<string | undefined> => {
    const key = await deps.getApiKey()
    return key === undefined || key === '' ? undefined : key
  }

  /**
   * 通用提问：state 为结构化摘要，questions 为 Jev 题目（noul / choice / score）；失败按配置重试
   * @param {unknown} state - 发给 Jev 的状态（调用方负责脱敏）
   * @param {Record<string, unknown>} questions - 题目
   * @param {AbortSignal} [signal] - 取消信号
   * @returns {Promise<JevAskOutcome>} 原始答案或失败原因
   */
  const ask = async (state: unknown, questions: Record<string, unknown>, signal?: AbortSignal): Promise<JevAskOutcome> => {
    if (!config.enabled) return { ok: false, reason: 'disabled', attempts: 0 }
    let key: string | undefined
    try { key = await getKey() } catch (error) { const failure = getJevCredentialError(error); return { ok: false, reason: failure.reason, attempts: 0, status: failure.reason === 'credential-permission-denied' ? 403 : 503 } }
    if (key === undefined) return { ok: false, reason: 'missing-api-key', attempts: 0, status: 401 }
    const body = JSON.stringify({ model: config.model, state, questions })
    if (body.length > config.maxRequestChars) return { ok: false, reason: 'request-too-large', attempts: 0, status: 400 }
    const started = now()
    const { result, attempts } = await sendWithRetry(JEV_PATH, { method: 'POST', body }, key, signal)
    if (result.kind === 'ok') {
      const record = asRecord(result.body)
      const answers = asRecord(record.answers)
      if (Object.keys(answers).length === 0) return { ok: false, reason: 'malformed-response', attempts, status: 502 }
      return { ok: true, answers, ...(typeof record.model === 'string' ? { model: record.model } : {}), attempts, usage: getUsage(record), latencyMs: now() - started }
    }
    if (result.kind === 'http') return { ok: false, reason: `http-${result.status}`, attempts, status: result.status, ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }), ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) }
    return { ok: false, reason: result.kind, attempts, status: result.kind === 'timeout' ? 504 : result.kind === 'network' ? 503 : result.kind === 'malformed-response' ? 502 : 499 }
  }

  /**
   * 列出账号可用的 Jev 模型（健康检查，不计费）
   * @param {AbortSignal} [signal] - 取消信号
   * @returns {Promise<JevModelsOutcome>} 模型列表或失败原因
   */
  const listModels = async (signal?: AbortSignal): Promise<JevModelsOutcome> => {
    if (!config.enabled) return { ok: false, reason: 'disabled' }
    let key: string | undefined
    try { key = await getKey() } catch (error) { const failure = getJevCredentialError(error); return { ok: false, reason: failure.reason, status: failure.reason === 'credential-permission-denied' ? 403 : 503 } }
    if (key === undefined) return { ok: false, reason: 'missing-api-key', status: 401 }
    const started = now()
    const { result } = await sendWithRetry(JEV_MODELS_PATH, { method: 'GET' }, key, signal)
    if (result.kind === 'ok') {
      const raw = asRecord(result.body)
      const list = Array.isArray(raw.models) ? raw.models : Array.isArray(raw.data) ? raw.data : []
      const models = list.map(asRecord).filter((item) => typeof item.name === 'string' || typeof item.id === 'string').map((item) => ({
        name: String(item.name ?? item.id),
        description: typeof item.description === 'string' ? item.description : '',
        releaseDate: typeof item.release_date === 'string' ? item.release_date : ''
      }))
      if (models.length === 0) return { ok: false, reason: 'no-models', status: 502 }
      return { ok: true, models, latencyMs: now() - started }
    }
    if (result.kind === 'http') return { ok: false, reason: `http-${result.status}`, status: result.status, ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }) }
    return { ok: false, reason: result.kind, status: result.kind === 'timeout' ? 504 : result.kind === 'malformed-response' ? 502 : result.kind === 'aborted' ? 499 : 503 }
  }

  const triage = async (card: TaskCard, signal?: AbortSignal): Promise<JevOutcome> => {
    const outcome = await ask(getJevState(card), JEV_QUESTIONS, signal)
    if (!outcome.ok) return { ok: false, reason: outcome.reason, attempts: outcome.attempts }
    const answers = ParseJevAnswers({ answers: outcome.answers })
    if (Object.keys(answers).length === 0) return { ok: false, reason: 'malformed-response', attempts: outcome.attempts }
    return { ok: true, answers, attempts: outcome.attempts }
  }

  return { ask, triage, listModels, config }
}

export type JevClient = ReturnType<typeof intJevClient>
