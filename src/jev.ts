import type { TaskCard, TriageAnswers } from './policy.js'

/** Jev 调用配置 */
export interface JevConfigInfo {
  enabled: boolean
  apiKeyEnv: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxRetries: number
  maxCallsPerSession: number
}

export const DEFAULT_JEV_CONFIG: JevConfigInfo = {
  enabled: true,
  apiKeyEnv: 'TYPESAFE_API_KEY',
  baseUrl: 'https://api.typesafe.ai',
  model: 'jev-latest',
  timeoutMs: 10000,
  maxRetries: 2,
  maxCallsPerSession: 20
}

export const JEV_PATH = '/v1/systemone'

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

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi
]

const MAX_TEXT = 500

/**
 * 去掉密钥样式内容并截断，保证发往 Jev 的只有脱敏摘要
 * @param {string} text - 原文
 * @returns {string} 脱敏文本
 */
export const getRedactedText = (text: string): string =>
  SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[已脱敏]'), text).slice(0, MAX_TEXT)

/**
 * 构造 Jev 的 state：只含任务卡的结构化摘要，不含源码、路径内容与密钥
 * @param {TaskCard} card - 任务卡
 * @returns {object} state
 */
export const getJevState = (card: TaskCard) => ({
  task: getRedactedText(card.title),
  goal: getRedactedText(card.goal),
  flags: card.flags,
  profile: card.perf ?? {},
  acceptance_count: card.acceptance.length,
  scope_count: card.scope.length
})

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

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
    ...(typeof mathTask.choice === 'string' && typeof mathTask.confidence === 'number'
      ? { mathTask: { choice: mathTask.choice, confidence: mathTask.confidence } }
      : {}),
    ...(typeof benchmark.noul === 'number' ? { needBenchmark: benchmark.noul } : {}),
    ...(typeof novelty.score === 'number' && typeof novelty.confidence === 'number'
      ? { novelty: { score: novelty.score, confidence: novelty.confidence } }
      : {})
  }
}

export type JevOutcome =
  | { ok: true; answers: TriageAnswers; attempts: number }
  | { ok: false; reason: string; attempts: number }

/** Jev 客户端依赖 */
export interface JevDepsInfo {
  fetch: typeof fetch
  getApiKey: () => Promise<string | undefined>
  sleep?: (ms: number) => Promise<void>
}

type PostResult = { kind: 'ok'; body: unknown } | { kind: 'http'; status: number } | { kind: 'timeout' } | { kind: 'network' }

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529])

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 创建 Jev 客户端
 * @param {JevConfigInfo} config - 调用配置
 * @param {JevDepsInfo} deps - fetch、密钥读取与等待函数
 * @returns {{ triage: (card: TaskCard, signal?: AbortSignal) => Promise<JevOutcome> }} 客户端
 */
export const intJevClient = (config: JevConfigInfo, deps: JevDepsInfo) => {
  const sleep = deps.sleep ?? defaultSleep

  const postOnce = async (body: string, key: string, signal?: AbortSignal): Promise<PostResult> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await deps.fetch(`${config.baseUrl.replace(/\/$/, '')}${JEV_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal
      })
      if (!response.ok) return { kind: 'http', status: response.status }
      return { kind: 'ok', body: await response.json() }
    } catch {
      return controller.signal.aborted ? { kind: 'timeout' } : { kind: 'network' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const triage = async (card: TaskCard, signal?: AbortSignal): Promise<JevOutcome> => {
    if (!config.enabled) return { ok: false, reason: 'disabled', attempts: 0 }
    const key = await deps.getApiKey()
    if (key === undefined || key === '') return { ok: false, reason: 'missing-api-key', attempts: 0 }
    const body = JSON.stringify({ model: config.model, state: getJevState(card), questions: JEV_QUESTIONS })
    for (let attempt = 1; ; attempt++) {
      const result = await postOnce(body, key, signal)
      if (result.kind === 'ok') {
        const answers = ParseJevAnswers(result.body)
        if (Object.keys(answers).length === 0) return { ok: false, reason: 'malformed-response', attempts: attempt }
        return { ok: true, answers, attempts: attempt }
      }
      const retryable = result.kind !== 'http' || RETRYABLE_STATUS.has(result.status)
      const reason = result.kind === 'http' ? `http-${result.status}` : result.kind
      if (!retryable || attempt > config.maxRetries) return { ok: false, reason, attempts: attempt }
      await sleep(500 * 2 ** (attempt - 1))
    }
  }

  return { triage }
}
