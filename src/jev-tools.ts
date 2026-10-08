import { getJevFailureKind, isJevProbability, isJevScore, type JevAskOutcome, type JevClient } from './jev.js'
import {
  CHECK_FLAG_THRESHOLD,
  CHECK_UNCERTAIN_MAX,
  CHECK_UNCERTAIN_MIN,
  CHOICE_MAX_OPTIONS,
  CLASSIFY_BAND_THRESHOLDS,
  CLASSIFY_DEFAULT_INSTRUCTIONS,
  CLASSIFY_OTHER_DESCRIPTION,
  DEFAULT_PRICE_PER_MTOK,
  MATCH_DEADLINE_MS,
  MATCH_DEFAULT_INSTRUCTIONS,
  MATCH_DEFAULT_WINDOW,
  MATCH_EXISTS_CRITERIA,
  MATCH_EXISTS_INSTRUCTIONS,
  MATCH_MAX_CANDIDATES,
  MATCH_MAX_WINDOW,
  MATCH_MIN_WINDOW,
  MATCH_NONE_DESCRIPTION,
  SCORE_MAX_LEVELS,
  SCORE_MIN_LEVELS,
  SCREEN_NOULS,
  SCREEN_RISK_INSTRUCTIONS,
  SCREEN_RISK_LEVELS,
  SCREEN_VERDICT_THRESHOLDS
} from './jev-questions.js'
import { getToolDefinition, type ToolDefinitionLike } from './tool-shape.js'
import type { JsonSchemaObject } from './util/json-schema.js'

/**
 * 内嵌的 7 个 Jev 工具：jev_ask / jev_check / jev_classify / jev_health / jev_match / jev_score / jev_screen。
 * 语义与返回结构对齐 jev-mcp v0.2.1（MIT，Copyright (c) 2026 Blake Stone），由插件直接调用 TypeSafe System One，
 * 共用百工的 Jev 客户端（无本地限流/使用额度，保留错误重试与凭据解析）。返回信封：
 * 成功 { ok: true, model, answers, usage: { input_tokens, output_tokens, est_cost_usd }, latency_ms }，
 * 失败 { ok: false, status, error, details? }。置信度表示判断的集中程度，不等于正确性。
 */

export type JevToolResult =
  | {
      ok: true
      model: string
      answers: unknown
      usage: { input_tokens: number | null; output_tokens: number | null; est_cost_usd: number | null; usage_unknown?: boolean }
      latency_ms: number
    }
  | { ok: false; status: number; error: string; details?: Array<{ loc: string[]; msg: string }>; retry_after_ms?: number; [key: string]: unknown }

/** 工具层依赖：Jev 客户端与时钟 */
export interface JevToolDepsInfo {
  getClient: () => JevClient
  now?: () => number
}

type StateValue = string | Record<string, unknown> | unknown[]

class InvalidInput extends Error {
  constructor (message: string, readonly loc: string[]) {
    super(message)
  }
}

class OutOfOptions extends Error {}

const OUT_OF_OPTIONS = 'TypeSafe returned an answer outside the submitted options'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const fail = (message: string, ...loc: string[]): never => { throw new InvalidInput(message, loc) }

const getState = (value: unknown, name = 'state'): StateValue => {
  if (typeof value === 'string' || Array.isArray(value) || isRecord(value)) return value as StateValue
  return fail(`${name} must be a string, object, or array`, name)
}

const getOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[], loc: string[]): void => {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  if (extra.length > 0) fail('unknown field', ...loc, extra[0] as string)
}

const isJsonContent = (value: unknown): boolean => typeof value === 'string' || Array.isArray(value) || isRecord(value)

const getQuestion = (name: string, raw: unknown): Record<string, unknown> => {
  if (!isRecord(raw)) return fail('question must be an object', 'questions', name)
  const type = raw.type
  if (type === 'noul') {
    getOnlyKeys(raw, ['type', 'instructions', 'criteria'], ['questions', name])
    if (raw.criteria !== undefined && raw.criteria !== null) {
      if (!isRecord(raw.criteria)) fail('noul criteria must be an object', 'questions', name, 'criteria')
      if (Object.keys(raw.criteria as object).some((key) => key !== 'true' && key !== 'false')) fail('noul criteria may contain only true and false', 'questions', name, 'criteria')
    }
    return raw
  }
  if (type === 'choice') {
    getOnlyKeys(raw, ['type', 'instructions', 'criteria'], ['questions', name])
    if (!isRecord(raw.criteria) || Object.keys(raw.criteria).length === 0) fail('choice criteria must not be empty', 'questions', name, 'criteria')
    if (Object.keys(raw.criteria as object).length > CHOICE_MAX_OPTIONS) fail(`choice criteria may contain at most ${CHOICE_MAX_OPTIONS} entries`, 'questions', name, 'criteria')
    return raw
  }
  if (type === 'score') {
    getOnlyKeys(raw, ['type', 'instructions', 'criteria'], ['questions', name])
    const levels = raw.criteria
    if (!Array.isArray(levels) || levels.length < SCORE_MIN_LEVELS || levels.length > SCORE_MAX_LEVELS) {
      fail(`score criteria must contain ${SCORE_MIN_LEVELS} to ${SCORE_MAX_LEVELS} levels`, 'questions', name, 'criteria')
    }
    if (!(levels as unknown[]).every(isJsonContent)) fail('score levels must be strings, objects, or arrays', 'questions', name, 'criteria')
    return raw
  }
  return fail('question type must be noul, choice, or score', 'questions', name, 'type')
}

const round = (value: number): number => Math.round(value * 1000) / 1000

const getAnswer = (answers: Record<string, unknown>, id: string): Record<string, unknown> => {
  const raw = answers[id]
  if (!isRecord(raw)) throw new Error(`missing answer ${id}`)
  return raw
}

const getChoice = (answers: Record<string, unknown>, id: string, allowed?: readonly string[]) => {
  const raw = getAnswer(answers, id)
  if (typeof raw.choice !== 'string' || !isJevProbability(raw.confidence) || !isRecord(raw.probabilities) || !Object.values(raw.probabilities).every(isJevProbability)) throw new Error(`malformed choice answer ${id}`)
  if (allowed !== undefined && (!allowed.includes(raw.choice) || !Object.keys(raw.probabilities).every((key) => allowed.includes(key)))) throw new OutOfOptions()
  return { choice: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities as Record<string, number> }
}

const getScore = (answers: Record<string, unknown>, id: string, levels: number) => {
  const raw = getAnswer(answers, id)
  if (!isJevScore(raw.score, levels) || !isJevProbability(raw.confidence)) throw new Error(`malformed score answer ${id}`)
  if ([raw.probabilities, raw.legend].some((value) => value !== undefined && !isRecord(value))) throw new Error(`malformed score metadata ${id}`)
  const allowed = new Set(Array.from({ length: levels }, (_, index) => String(index)))
  if (isRecord(raw.probabilities) && !Object.values(raw.probabilities).every(isJevProbability)) throw new Error(`malformed score probabilities ${id}`)
  if ([raw.probabilities, raw.legend].some((value) => isRecord(value) && !Object.keys(value).every((key) => allowed.has(key)))) throw new OutOfOptions()
  return {
    score: raw.score,
    confidence: raw.confidence,
    probabilities: isRecord(raw.probabilities) ? raw.probabilities : {},
    legend: isRecord(raw.legend) ? raw.legend : {}
  }
}

const getNoul = (answers: Record<string, unknown>, id: string): number => {
  const raw = getAnswer(answers, id)
  if (!isJevProbability(raw.noul)) throw new Error(`malformed noul answer ${id}`)
  return raw.noul
}

const getBand = (confidence: number): 'act' | 'verify' | 'review' =>
  confidence >= CLASSIFY_BAND_THRESHOLDS.act ? 'act' : confidence >= CLASSIFY_BAND_THRESHOLDS.verify ? 'verify' : 'review'

/** 与 jev-mcp 一致的确定性打乱：以选项数为种子，结果与原顺序相同时整体反转 */
export const getShuffledCriteria = <T>(criteria: Record<string, T>): Record<string, T> => {
  const items = Object.entries(criteria)
  if (items.length < 2) return { ...criteria }
  const originalKeys = items.map(([key]) => key)
  let seed = items.length
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let index = items.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1))
    ;[items[index], items[swap]] = [items[swap] as [string, T], items[index] as [string, T]]
  }
  if (items.every(([key], index) => key === originalKeys[index])) items.reverse()
  return Object.fromEntries(items)
}

/** 把 Jev 调用失败映射为工具信封（不含任何调用方传入的内容） */
const getFailure = (outcome: Extract<JevAskOutcome, { ok: false }>): JevToolResult => {
  const status = outcome.status ?? 500
  const error = outcome.reason === 'missing-api-key' ? 'Jev credential is not set（请在「设置 → 百工 Agent」顶部填写 Jev API key）'
    : outcome.reason === 'disabled' ? 'Jev is disabled in swarm-core config'
      : outcome.reason === 'request-too-large' ? 'request exceeds the configured maxRequestChars limit'
        : outcome.reason === 'timeout' ? 'TypeSafe request timed out'
          : outcome.reason === 'network' ? 'TypeSafe service unavailable'
            : outcome.reason === 'malformed-response' ? 'TypeSafe API response invalid'
              : outcome.reason === 'aborted' ? 'request aborted'
                : outcome.reason === 'credential-permission-denied' || outcome.status === 403 ? 'Jev credential or API access denied; plugin settings cannot override host permission policy'
                  : outcome.reason === 'credential-unavailable' ? 'Jev credential service unavailable; no alternate credential source was used'
                    : 'TypeSafe API request failed'
  return { ok: false, status, error, reason: outcome.reason, failure_kind: getJevFailureKind(outcome), ...(outcome.retryAfterMs === undefined ? {} : { retry_after_ms: outcome.retryAfterMs }) }
}

const getErrorResult = (error: unknown): JevToolResult => {
  if (error instanceof InvalidInput) return { ok: false, status: 400, error: 'invalid tool input', details: [{ loc: error.loc.map((part) => part.slice(0, 64)), msg: error.message.slice(0, 160) }] }
  if (error instanceof OutOfOptions) return { ok: false, status: 502, error: OUT_OF_OPTIONS }
  if (error instanceof MatchDeadline) return { ok: false, status: 504, error: 'match deadline exceeded', windows_completed: error.completed, windows_total: error.total }
  return { ok: false, status: 502, error: 'TypeSafe API response invalid' }
}

class MatchDeadline extends Error {
  constructor (readonly completed: number, readonly total: number) {
    super('match deadline exceeded')
  }
}

/**
 * 创建内嵌 Jev 工具的实现
 * @param {JevToolDepsInfo} deps - 依赖
 * @returns 7 个操作，参数与 jev-mcp 工具相同
 */
export const intJevTools = (deps: JevToolDepsInfo) => {
  const now = deps.now ?? Date.now

  const getUsage = (outcomes: Array<Extract<JevAskOutcome, { ok: true }>>) => {
    const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    const inputs = outcomes.map((item) => item.usage?.inputTokens)
    const outputs = outcomes.map((item) => item.usage?.outputTokens)
    const input = inputs.every(valid) ? inputs.reduce((sum: number, value) => sum + value, 0) : null
    const output = outputs.every(valid) ? outputs.reduce((sum: number, value) => sum + value, 0) : null
    const unknown = input === null || output === null
    return { input_tokens: input, output_tokens: output, est_cost_usd: unknown ? null : input * DEFAULT_PRICE_PER_MTOK / 1_000_000, ...(unknown ? { usage_unknown: true } : {}) }
  }

  const success = (outcomes: Array<Extract<JevAskOutcome, { ok: true }>>, answers: unknown, started: number): JevToolResult => ({
    ok: true,
    model: outcomes[0]?.model ?? deps.getClient().config.model,
    answers,
    usage: getUsage(outcomes),
    latency_ms: now() - started
  })

  /** 一次提问；失败时抛出带信封的错误，供组合操作统一处理 */
  const askOnce = async (state: unknown, questions: Record<string, unknown>, signal?: AbortSignal) => {
    const outcome = await deps.getClient().ask(state, questions, signal)
    if (!outcome.ok) throw Object.assign(new Error('jev failed'), { envelope: getFailure(outcome) })
    // 组合工具和任意提问共用完整性/范围校验，防止各入口对同一坏答案得出不同结论。
    for (const [id, raw] of Object.entries(questions)) {
      const question = raw as { type: string; criteria?: unknown }
      if (question.type === 'noul') getNoul(outcome.answers, id)
      else if (question.type === 'choice') getChoice(outcome.answers, id, Object.keys(question.criteria as object))
      else if (question.type === 'score') getScore(outcome.answers, id, (question.criteria as unknown[]).length)
    }
    return outcome
  }

  const run = async (body: (started: number) => Promise<JevToolResult>): Promise<JevToolResult> => {
    const started = now()
    try {
      return await body(started)
    } catch (error) {
      const envelope = (error as { envelope?: JevToolResult }).envelope
      return envelope ?? getErrorResult(error)
    }
  }

  /** jev_ask：任意 noul / choice / score 题；完整、合法的答案原样返回。 */
  const ask = (args: { state?: unknown; questions?: unknown }, signal?: AbortSignal) => run(async (started) => {
    const state = getState(args.state)
    if (!isRecord(args.questions) || Object.keys(args.questions).length === 0) fail('at least one question is required', 'questions')
    const questions: Record<string, unknown> = Object.create(null)
    for (const [name, raw] of Object.entries(args.questions as Record<string, unknown>)) {
      if (name.trim() === '') fail('question names must not be empty', 'questions')
      questions[name] = getQuestion(name, raw)
    }
    const outcome = await askOnce(state, questions, signal)
    return success([outcome], outcome.answers, started)
  })

  /** jev_classify：从封闭标签集合中选一个；ensemble 时用打乱顺序的第二次判断检验一致性 */
  const classify = (args: { state?: unknown; labels?: unknown; question?: unknown; add_other?: unknown; ensemble?: unknown }, signal?: AbortSignal) => run(async (started) => {
    const state = getState(args.state)
    if (!isRecord(args.labels) || Object.keys(args.labels).length === 0) fail('at least one label is required', 'labels')
    const labels = args.labels as Record<string, unknown>
    const criteria: Record<string, unknown> = Object.create(null)
    for (const [label, description] of Object.entries(labels)) {
      if (label.trim() === '') fail('label names must not be empty', 'labels')
      if (typeof description === 'string') criteria[label] = description
      else if (isRecord(description) && typeof description.what === 'string' && typeof description.not_for === 'string' && Array.isArray(description.examples)) {
        criteria[label] = { what: description.what, not_for: description.not_for, examples: description.examples }
      } else fail('label description must be a string or { what, not_for, examples }', 'labels', label)
    }
    const addOther = args.add_other !== false
    if (addOther && !Object.hasOwn(labels, 'other')) criteria.other = CLASSIFY_OTHER_DESCRIPTION
    if (Object.keys(criteria).length > CHOICE_MAX_OPTIONS) fail(`labels plus other may contain at most ${CHOICE_MAX_OPTIONS} entries`, 'labels')
    const instructions = typeof args.question === 'string' && args.question.trim() !== '' ? args.question : CLASSIFY_DEFAULT_INSTRUCTIONS
    const first = await askOnce(state, { choice: { type: 'choice', instructions, criteria } }, signal)
    const primary = getChoice(first.answers, 'choice')
    if (args.ensemble !== true) {
      return success([first], { ...primary, band: getBand(primary.confidence) }, started)
    }
    const second = await askOnce(state, { choice: { type: 'choice', instructions, criteria: getShuffledCriteria(criteria) } }, signal)
    const alternate = getChoice(second.answers, 'choice')
    const agreement = primary.choice === alternate.choice
    return success([first, second], { ...primary, band: agreement ? getBand(primary.confidence) : 'review', agreement, alternate_choice: alternate.choice }, started)
  })

  /** jev_score：把 state 放到给定的有序档位上（从低到高），normalized 为 0–1 */
  const score = (args: { state?: unknown; levels?: unknown; question?: unknown }, signal?: AbortSignal) => run(async (started) => {
    const state = getState(args.state)
    const levels = args.levels
    if (!Array.isArray(levels) || levels.length < SCORE_MIN_LEVELS || levels.length > SCORE_MAX_LEVELS || !levels.every((level) => typeof level === 'string')) {
      fail(`levels must contain ${SCORE_MIN_LEVELS} to ${SCORE_MAX_LEVELS} strings`, 'levels')
    }
    if (typeof args.question !== 'string' || args.question.trim() === '') fail('question is required', 'question')
    const outcome = await askOnce(state, { score: { type: 'score', instructions: args.question, criteria: levels } }, signal)
    const answer = getScore(outcome.answers, 'score', (levels as string[]).length)
    return success([outcome], { ...answer, normalized: round(answer.score / ((levels as string[]).length - 1)) }, started)
  })

  /** jev_check：一组独立的是/否检查；≥0.7 记为 flags，0.3–0.7 记为 uncertain */
  const check = (args: { state?: unknown; propositions?: unknown }, signal?: AbortSignal) => run(async (started) => {
    const state = getState(args.state)
    if (!isRecord(args.propositions) || Object.keys(args.propositions).length === 0) fail('at least one proposition is required', 'propositions')
    const questions: Record<string, unknown> = Object.create(null)
    for (const [id, proposition] of Object.entries(args.propositions as Record<string, unknown>)) {
      if (id.trim() === '') fail('proposition ids must not be empty', 'propositions')
      if (typeof proposition === 'string') questions[id] = { type: 'noul', instructions: proposition }
      else if (isRecord(proposition) && typeof proposition.statement === 'string' && typeof proposition.true === 'string' && typeof proposition.false === 'string') {
        questions[id] = { type: 'noul', instructions: proposition.statement, criteria: { true: proposition.true, false: proposition.false } }
      } else fail('proposition must be a string or { statement, true, false }', 'propositions', id)
    }
    const outcome = await askOnce(state, questions, signal)
    const probabilities = Object.fromEntries(Object.keys(questions).map((id) => [id, getNoul(outcome.answers, id)]))
    const flags = Object.entries(probabilities).filter(([, p]) => p >= CHECK_FLAG_THRESHOLD).map(([id]) => id)
    const uncertain = Object.entries(probabilities).filter(([, p]) => p >= CHECK_UNCERTAIN_MIN && p < CHECK_UNCERTAIN_MAX).map(([id]) => id)
    return success([outcome], { probabilities, flags, uncertain }, started)
  })

  /** jev_screen：筛查不可信文本中的提示注入信号；它是过滤器，不是安全边界 */
  const screen = (args: { text?: unknown; source?: unknown }, signal?: AbortSignal) => run(async (started) => {
    if (typeof args.text !== 'string') fail('text must be a string', 'text')
    const state: Record<string, unknown> = { text: args.text }
    if (typeof args.source === 'string') state.source = args.source
    const questions: Record<string, unknown> = Object.fromEntries(Object.entries(SCREEN_NOULS).map(([id, definition]) => [id, { type: 'noul', ...definition }]))
    questions.risk = { type: 'score', instructions: SCREEN_RISK_INSTRUCTIONS, criteria: [...SCREEN_RISK_LEVELS] }
    const outcome = await askOnce(state, questions, signal)
    const nouls = Object.fromEntries(Object.keys(SCREEN_NOULS).map((id) => [id, getNoul(outcome.answers, id)]))
    const risk = getScore(outcome.answers, 'risk', SCREEN_RISK_LEVELS.length)
    const verdict = risk.score >= SCREEN_VERDICT_THRESHOLDS.blockRisk ? 'block'
      : risk.score >= SCREEN_VERDICT_THRESHOLDS.reviewRisk || Object.values(nouls).some((p) => p >= SCREEN_VERDICT_THRESHOLDS.reviewNoul) ? 'review' : 'pass'
    const reasons = Object.fromEntries(Object.entries(nouls).filter(([, p]) => p >= SCREEN_VERDICT_THRESHOLDS.reviewNoul))
    return success([outcome], { verdict, risk: risk.score, risk_confidence: risk.confidence, reasons }, started)
  })

  /** jev_match：在候选中找最佳匹配，并给出「确实存在匹配」的独立信号（exists）与弃权概率 */
  const match = (args: { query?: unknown; candidates?: unknown; question?: unknown; window?: unknown }, signal?: AbortSignal) => run(async (started) => {
    if (typeof args.query !== 'string') fail('query must be a string', 'query')
    if (!isRecord(args.candidates) || Object.keys(args.candidates).length === 0) fail('at least one candidate is required', 'candidates')
    const candidates = args.candidates as Record<string, unknown>
    for (const [id, text] of Object.entries(candidates)) {
      if (id.trim() === '') fail('candidate ids must not be empty', 'candidates')
      if (id === 'none') fail("candidate id 'none' is reserved", 'candidates')
      if (typeof text !== 'string') fail('candidate text must be a string', 'candidates', id)
    }
    if (Object.keys(candidates).length > MATCH_MAX_CANDIDATES) fail(`candidates exceeds the limit of ${MATCH_MAX_CANDIDATES} entries`, 'candidates')
    const window = args.window === undefined ? MATCH_DEFAULT_WINDOW : args.window
    if (typeof window !== 'number' || !Number.isInteger(window) || window < MATCH_MIN_WINDOW || window > MATCH_MAX_WINDOW) {
      fail(`window must be between ${MATCH_MIN_WINDOW} and ${MATCH_MAX_WINDOW}`, 'window')
    }
    const query = args.query as string
    const instructions = typeof args.question === 'string' && args.question.trim() !== '' ? args.question : MATCH_DEFAULT_INSTRUCTIONS
    const choiceQuestion = (group: Record<string, string>) => ({ type: 'choice', instructions, criteria: { ...group, none: MATCH_NONE_DESCRIPTION } })
    const items = Object.entries(candidates as Record<string, string>)
    const chunks: Array<Record<string, string>> = []
    for (let index = 0; index < items.length; index += window as number) chunks.push(Object.fromEntries(items.slice(index, index + (window as number))))
    const deadline = started + MATCH_DEADLINE_MS
    const outcomes: Array<Extract<JevAskOutcome, { ok: true }>> = []
    const windows: Array<{ candidates: Record<string, string>; choice: ReturnType<typeof getChoice>; exists: number }> = []
    const checkDeadline = () => { if (now() >= deadline) throw new MatchDeadline(windows.length, chunks.length) }
    const selected = (choice: ReturnType<typeof getChoice>, group: Record<string, string>): string | undefined => {
      if (choice.choice === 'none') return undefined
      if (!(choice.choice in group)) throw new OutOfOptions()
      return choice.choice
    }
    for (const chunk of chunks) {
      checkDeadline()
      const outcome = await askOnce({ query, candidates: chunk }, {
        choice: choiceQuestion(chunk),
        exists: { type: 'noul', instructions: MATCH_EXISTS_INSTRUCTIONS, criteria: { ...MATCH_EXISTS_CRITERIA } }
      }, signal)
      outcomes.push(outcome)
      const choice = getChoice(outcome.answers, 'choice')
      selected(choice, chunk)
      windows.push({ candidates: chunk, choice, exists: getNoul(outcome.answers, 'exists') })
      checkDeadline()
    }
    const finalists: Record<string, string> = Object.create(null)
    for (const item of windows) {
      const id = selected(item.choice, item.candidates)
      if (id !== undefined) finalists[id] = item.candidates[id] as string
    }
    let finalChoice: ReturnType<typeof getChoice> | undefined
    let finalGroup: Record<string, string> = {}
    if (windows.length > 1 && Object.keys(finalists).length > 0) {
      // 多窗口：各窗口胜出者再比一轮（超过选项上限时分组淘汰）
      let current = finalists
      while (Object.keys(current).length > CHOICE_MAX_OPTIONS - 1) {
        const reduced: Record<string, string> = Object.create(null)
        const entries = Object.entries(current)
        for (let index = 0; index < entries.length; index += CHOICE_MAX_OPTIONS - 1) {
          const group = Object.fromEntries(entries.slice(index, index + CHOICE_MAX_OPTIONS - 1))
          checkDeadline()
          const outcome = await askOnce({ query, candidates: group }, { choice: choiceQuestion(group) }, signal)
          outcomes.push(outcome)
          const choice = getChoice(outcome.answers, 'choice')
          const id = selected(choice, group)
          if (id !== undefined) reduced[id] = group[id] as string
        }
        if (Object.keys(reduced).length === 0) break
        current = reduced
      }
      if (Object.keys(current).length <= CHOICE_MAX_OPTIONS - 1) {
        checkDeadline()
        const outcome = await askOnce({ query, candidates: current }, { choice: choiceQuestion(current) }, signal)
        outcomes.push(outcome)
        finalChoice = getChoice(outcome.answers, 'choice')
        selected(finalChoice, current)
        finalGroup = current
      }
    } else {
      const source = windows.reduce((best, item) => (item.exists > best.exists ? item : best), windows[0] as (typeof windows)[number])
      finalChoice = source.choice
      finalGroup = source.candidates
    }
    const best = finalChoice === undefined ? undefined : selected(finalChoice, finalGroup)
    const confidence = finalChoice !== undefined && best !== undefined ? finalChoice.confidence : null
    const top3 = finalChoice === undefined ? [] : Object.entries(finalChoice.probabilities)
      .filter(([id]) => id !== 'none' && id in finalGroup)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([id, probability]) => ({ id, probability }))
    const exists = Math.max(...windows.map((item) => item.exists))
    const band = finalChoice === undefined ? 'none'
      : best !== undefined && confidence !== null && exists >= 0.7 && confidence >= 0.5 ? 'match'
        : exists >= 0.3 ? 'review' : 'none'
    return success(outcomes, {
      best_id: best ?? null,
      best_text: best === undefined ? null : (candidates as Record<string, string>)[best],
      confidence,
      abstain_probability: finalChoice === undefined ? 1 : (finalChoice.probabilities.none ?? 0),
      exists,
      windows: windows.length,
      exists_by_window: windows.map((item) => item.exists),
      top3,
      band
    }, started)
  })

  /** jev_health：配置的模型与账号可用模型（不计费） */
  const health = async (signal?: AbortSignal): Promise<JevToolResult> => {
    const started = now()
    const client = deps.getClient()
    const outcome = await client.listModels(signal)
    if (!outcome.ok) {
      return getFailure({ ok: false, reason: outcome.reason, attempts: 0, ...(outcome.failureKind === undefined ? {} : { failureKind: outcome.failureKind }), ...(outcome.status === undefined ? {} : { status: outcome.status }) })
    }
    return {
      ok: true,
      model: client.config.model,
      answers: { models: outcome.models.map((m) => ({ name: m.name, description: m.description, release_date: m.releaseDate })), round_trip_latency_ms: outcome.latencyMs },
      usage: { input_tokens: 0, output_tokens: 0, est_cost_usd: 0 },
      latency_ms: now() - started
    }
  }

  return { ask, classify, score, check, screen, match, health }
}

export type JevTools = ReturnType<typeof intJevTools>

const STATE_DESCRIPTION = '交给 Jev 判断的状态：字符串、对象或数组。放入判断所需的全部事实（原文、身份、关系、规则），多部分时用命名字段；不要放密钥。'

export const JEV_TOOL_NAMES = ['jev_ask', 'jev_check', 'jev_classify', 'jev_health', 'jev_match', 'jev_score', 'jev_screen'] as const

const JEV_TOOL_SPECS: ReadonlyArray<{ name: (typeof JEV_TOOL_NAMES)[number]; description: string; parameters: JsonSchemaObject }> = [
  {
    name: 'jev_ask',
    description: '用 Jev（TypeSafe System One）对给定 state 做类型化判断：questions 里每题为 noul（是/否概率）、choice（从封闭选项中选一个）或 score（有序档位）。不用于生成文本或抽取数值。置信度表示分布集中程度，不等于正确性。',
    parameters: {
      type: 'object',
      properties: {
        state: { description: STATE_DESCRIPTION },
        questions: {
          type: 'object',
          description: '题目表，键为题目 ID（只给代码用，不发给模型，题干里要写全含义）。每题 { type: "noul", instructions, criteria?: { true, false } } / { type: "choice", instructions, criteria: { 选项ID: 说明 } } / { type: "score", instructions, criteria: [低…高档位说明，2–10 档] }。'
        }
      },
      required: ['state', 'questions'],
      additionalProperties: false
    }
  },
  {
    name: 'jev_check',
    description: '用 Jev 对 state 做一组互相独立的是/否检查（例如结论是否有证据、是否违反约束）。返回每条命题为真的概率；≥0.7 列入 flags，0.3–0.7 列入 uncertain。概率是证据强度，不是正确性证明。',
    parameters: {
      type: 'object',
      properties: {
        state: { description: STATE_DESCRIPTION },
        propositions: { type: 'object', description: '命题表：{ 命题ID: "陈述" } 或 { 命题ID: { statement, true: "为真时的情形", false: "为假时的情形" } }。' }
      },
      required: ['state', 'propositions'],
      additionalProperties: false
    }
  },
  {
    name: 'jev_classify',
    description: '用 Jev 从封闭标签集合里选一个最合适的（默认自动加入 other）。返回 choice、confidence、probabilities 与 band（≥0.9 act / ≥0.5 verify / 其余 review）；ensemble=true 时用打乱顺序再判一次，不一致则降为 review。',
    parameters: {
      type: 'object',
      properties: {
        state: { description: STATE_DESCRIPTION },
        labels: { type: 'object', description: '标签表：{ 标签: "说明" } 或 { 标签: { what, not_for, examples: [] } }。' },
        question: { type: 'string', description: '可选：自定义题干' },
        add_other: { type: 'boolean', description: '是否自动加入 other（默认 true）' },
        ensemble: { type: 'boolean', description: '是否做打乱顺序的一致性复核（默认 false，多一次调用）' }
      },
      required: ['state', 'labels'],
      additionalProperties: false
    }
  },
  {
    name: 'jev_score',
    description: '用 Jev 把 state 放到一组有序档位上（从低到高，2–10 档，每档描述一个具体情形）。返回 score（档位期望值）、normalized（0–1）、confidence 与各档概率。',
    parameters: {
      type: 'object',
      properties: {
        state: { description: STATE_DESCRIPTION },
        levels: { type: 'array', items: { type: 'string' }, description: '从低到高的档位说明（2–10 条）' },
        question: { type: 'string', description: '题干：要衡量的维度' }
      },
      required: ['state', 'levels', 'question'],
      additionalProperties: false
    }
  },
  {
    name: 'jev_match',
    description: '用 Jev 在候选中找与 query 最匹配的一项，并给出「确实存在真正匹配」的概率 exists 与弃权概率；band 为 match / review / none。候选多时分窗口评估（window 20–254，默认 200）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要匹配的查询' },
        candidates: { type: 'object', description: '候选表 { 候选ID: 文本 }（ID 不能为 none，最多 2000 个）' },
        question: { type: 'string', description: '可选：自定义题干' },
        window: { type: 'number', description: '每个窗口的候选数（20–254，默认 200）' }
      },
      required: ['query', 'candidates'],
      additionalProperties: false
    }
  },
  {
    name: 'jev_screen',
    description: '用 Jev 筛查不可信文本（网页、文件、外部消息）中的提示注入信号：是否对智能体下指令、冒充权限、施压、索取密钥、隐藏内容。返回 verdict（pass / review / block）、风险档位与触发原因。它是过滤器，不是安全边界。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要筛查的文本' },
        source: { type: 'string', description: '可选：文本来源（例如 URL 或文件路径）' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'jev_health',
    description: '检查 Jev 是否可用：返回配置的模型与账号可用的模型及发布日期（不计费）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
]

const MAX_RENDER = 6000

/** 工具结果的文本：一行中文摘要 + 完整 JSON 信封 */
export const getJevToolText = (name: string, result: JevToolResult): string => {
  const json = JSON.stringify(result, null, 2)
  const body = json.length > MAX_RENDER ? `${json.slice(0, MAX_RENDER)}\n…（已截断）` : json
  if (!result.ok) return `${name} 失败（${result.status}）：${result.error}\n${body}`
  const cost = result.usage.est_cost_usd === null ? '，用量/费用未知' : result.usage.est_cost_usd > 0 ? `，约 $${result.usage.est_cost_usd.toFixed(6)}` : ''
  return `${name} 完成（${result.model}，${Math.round(result.latency_ms)} ms${cost}）\n${body}`
}

/**
 * 生成 7 个内嵌 Jev 工具的宿主定义
 * @param {() => JevTools} getTools - 取得工具实现（每次调用时读取，配置修改即时生效）
 * @returns {ToolDefinitionLike[]} 工具定义
 */
export const getJevToolDefinitions = (getTools: () => JevTools): ToolDefinitionLike[] =>
  JEV_TOOL_SPECS.map((spec) => getToolDefinition<Record<string, unknown>, JevToolResult>({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const tools = getTools()
      switch (spec.name) {
        case 'jev_ask': return tools.ask(args, exec.signal)
        case 'jev_check': return tools.check(args, exec.signal)
        case 'jev_classify': return tools.classify(args, exec.signal)
        case 'jev_score': return tools.score(args, exec.signal)
        case 'jev_match': return tools.match(args, exec.signal)
        case 'jev_screen': return tools.screen(args, exec.signal)
        default: return tools.health(exec.signal)
      }
    },
    render: (_args, value) => getJevToolText(spec.name, value)
  }))
