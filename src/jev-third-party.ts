import { ParseJevAnswers, type JevAskOutcome, type JevClient, type JevConfigInfo, type JevModelsOutcome, type JevOutcome, type JevUsageInfo } from './jev.js'
import type { TaskCard } from './policy.js'
import { getJevState, JEV_QUESTIONS } from './jev.js'

type TextStreamChunk = {
  type: string
  text?: string
  usage?: Record<string, unknown>
  reason?: string | { kind?: string; failure?: { code?: string; status?: number; message?: string } }
}
export interface ThirdPartyJevLlmLike {
  stream: (options: {
    provider: string
    model: string
    reasoningEffort?: string
    system?: string
    messages: Array<{ role: 'user'; content: Array<{ type: 'text'; text: string }> }>
    signal?: AbortSignal
  }) => AsyncIterable<TextStreamChunk>
  resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<unknown>
}

const JSON_FENCE = /^\s*```(?:json)?\s*|\s*```\s*$/gi
const SYSTEM = `You are a Jev-compatible System One judgment model. Return only one JSON object and no prose. The object must have an "answers" object keyed by every question id. For type=noul return {"type":"noul","noul":p}. For type=choice return {"type":"choice","choice":key,"confidence":c,"probabilities":{all option keys: p}}. For type=score return {"type":"score","score":number,"confidence":c,"probabilities":{all zero-based level indexes: p},"legend":{index: level}}. Every probability and confidence must be a finite number from 0 to 1. Choice probabilities must sum to 1. Score must lie between 0 and the last level. Do not call tools.`

const withTimeout = (timeoutMs: number, outer?: AbortSignal): { signal: AbortSignal; dispose: () => void } => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Third-party Jev timeout', 'TimeoutError')), timeoutMs)
  timer.unref?.()
  const relay = () => controller.abort(outer?.reason)
  if (outer?.aborted) relay()
  else outer?.addEventListener('abort', relay, { once: true })
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); outer?.removeEventListener('abort', relay) } }
}

const parseAnswerText = (text: string): Record<string, unknown> | undefined => {
  const cleaned = text.replace(JSON_FENCE, '').trim()
  try {
    const value = JSON.parse(cleaned) as Record<string, unknown>
    const answers = value.answers
    return answers !== null && typeof answers === 'object' && !Array.isArray(answers) ? answers as Record<string, unknown> : undefined
  } catch { return undefined }
}

const usageOf = (records: unknown[]): JevUsageInfo => {
  let inputTokens: number | undefined, outputTokens: number | undefined
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    const usage = (record as { usage?: unknown }).usage
    if (usage === null || typeof usage !== 'object') continue
    const value = usage as Record<string, unknown>
    for (const [key, target] of [['inputTokens', 'input'], ['input_tokens', 'input'], ['outputTokens', 'output'], ['output_tokens', 'output']] as const) {
      if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0) {
        if (target === 'input') inputTokens = value[key] as number
        else outputTokens = value[key] as number
      }
    }
  }
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) }
}

const getFinishFailure = (reason: TextStreamChunk['reason']): string | undefined => {
  if (typeof reason === 'string') return reason === 'error' ? 'model-error' : reason === 'aborted' ? 'aborted' : undefined
  if (reason === null || typeof reason !== 'object') return undefined
  if (reason.kind === 'aborted') return 'aborted'
  if (reason.kind !== 'error') return undefined
  return reason.failure?.code ?? reason.failure?.message ?? 'model-error'
}

const getFailureStatus = (value: unknown, fallback = 503): number => {
  if (value === null || typeof value !== 'object') return fallback
  const record = value as Record<string, unknown>
  const failure = record.failure !== null && typeof record.failure === 'object' ? record.failure as Record<string, unknown> : record
  return typeof failure.status === 'number' && Number.isFinite(failure.status) && failure.status >= 400 && failure.status <= 599
    ? Math.trunc(failure.status) : fallback
}

export const getThirdPartyJevSelection = (config: JevConfigInfo): { provider: string; model: string; reasoningEffort?: string } | undefined => {
  const selected = config.thirdParty
  if (selected === undefined) return undefined
  const provider = selected.provider.trim(), model = selected.model.trim(), reasoningEffort = selected.reasoningEffort?.trim()
  if (provider === '' || model === '' || provider.length > 512 || model.length > 512) return undefined
  return { provider, model, ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }) }
}

/** JEV protocol adapter over a DSH-selected third-party model. */
export const intThirdPartyJevClient = (config: JevConfigInfo, deps: { getLlm: () => ThirdPartyJevLlmLike | undefined; now?: () => number }): JevClient => {
  const now = deps.now ?? Date.now
  const selected = getThirdPartyJevSelection(config)
  const ask = async (state: unknown, questions: Record<string, unknown>, signal?: AbortSignal): Promise<JevAskOutcome> => {
    if (!config.enabled) return { ok: false, reason: 'disabled', attempts: 0 }
    if (config.source !== 'third-party' || selected === undefined) return { ok: false, reason: 'missing-third-party-model', attempts: 0, status: 400 }
    const llm = deps.getLlm()
    if (llm === undefined) return { ok: false, reason: 'model-runtime-unavailable', attempts: 0, status: 503 }
    let body: string
    try { body = JSON.stringify({ state, questions }) }
    catch { return { ok: false, reason: 'request-not-serializable', attempts: 0, status: 400 } }
    if (body.length > config.maxRequestChars) return { ok: false, reason: 'request-too-large', attempts: 0, status: 400 }
    const started = now(), timeout = withTimeout(config.timeoutMs, signal)
    let text = '', failure: string | undefined, failureStatus = 503
    const usage: unknown[] = []
    try {
      const stream = llm.stream({ provider: selected.provider, model: selected.model,
        ...(selected.reasoningEffort === undefined || selected.reasoningEffort === '' ? {} : { reasoningEffort: selected.reasoningEffort }),
        system: SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: body }] }], signal: timeout.signal })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
          if (text.length > config.maxRequestChars) { failure = 'response-too-large'; failureStatus = 502; break }
        }
        else if (chunk.type === 'usage') usage.push(chunk)
        else if (chunk.type === 'finish') {
          failure = getFinishFailure(chunk.reason)
          failureStatus = getFailureStatus(chunk.reason)
        }
      }
      if (failure === undefined && signal?.aborted) { failure = 'aborted'; failureStatus = 499 }
      else if (failure === undefined && timeout.signal.aborted) { failure = 'timeout'; failureStatus = 504 }
    } catch (error) {
      failure = signal?.aborted ? 'aborted' : timeout.signal.aborted ? 'timeout' : error instanceof Error ? error.message : String(error)
      failureStatus = getFailureStatus(error)
    } finally { timeout.dispose() }
    if (failure !== undefined) return { ok: false, reason: failure, attempts: 1, status: failure === 'timeout' ? 504 : failure === 'aborted' ? 499 : failureStatus }
    const answers = parseAnswerText(text)
    if (answers === undefined || Object.keys(answers).length === 0) return { ok: false, reason: 'malformed-response', attempts: 1, status: 502 }
    return { ok: true, answers, model: selected.model, attempts: 1, usage: usageOf(usage), latencyMs: now() - started }
  }

  const triage = async (card: TaskCard, signal?: AbortSignal): Promise<JevOutcome> => {
    const outcome = await ask(getJevState(card), JEV_QUESTIONS, signal)
    if (!outcome.ok) return { ok: false, reason: outcome.reason, attempts: outcome.attempts }
    const answers = ParseJevAnswers({ answers: outcome.answers })
    return Object.keys(answers).length === 0 ? { ok: false, reason: 'malformed-response', attempts: outcome.attempts } : { ok: true, answers, attempts: outcome.attempts }
  }

  const listModels = async (signal?: AbortSignal): Promise<JevModelsOutcome> => {
    if (!config.enabled) return { ok: false, reason: 'disabled' }
    if (config.source !== 'third-party' || selected === undefined) return { ok: false, reason: 'missing-third-party-model', status: 400 }
    const llm = deps.getLlm()
    if (llm === undefined) return { ok: false, reason: 'model-runtime-unavailable', status: 503 }
    if (typeof llm.resolveModelInfo !== 'function') return { ok: false, reason: 'model-catalog-unavailable', status: 503 }
    const started = now()
    try {
      await llm.resolveModelInfo(selected.provider, selected.model, signal)
      return { ok: true, models: [{ name: selected.model, description: `${selected.provider} via DSH model catalog`, releaseDate: '' }], latencyMs: now() - started }
    } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : String(error), status: getFailureStatus(error) } }
  }

  return { ask, triage, listModels, config }
}
