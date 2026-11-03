export interface AuthoritativeModelMetadata {
  contextWindow: number
  maxTokens: number
  source: string
  verifiedAt: string
}

const OPENAI_MODELS_SOURCE = 'https://developers.openai.com/api/docs/models/compare'
const OPENAI_MODELS_VERIFIED_AT = '2026-11-03'

/**
 * pi-ai 1.5.0 still carries 272K for several direct OpenAI models. OpenAI
 * documents 272K only as the long-context price boundary; the actual API
 * context window is 1.05M for this model family.
 *
 * Keep this correction scoped to the direct `openai` API provider. Codex and
 * ChatGPT Work subscriptions have their own lower default context windows, and
 * third-party gateways may impose additional limits.
 */
export const OPENAI_API_MODEL_METADATA: Readonly<Record<string, AuthoritativeModelMetadata>> = Object.freeze({
  'gpt-6-astra': Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000, source: OPENAI_MODELS_SOURCE, verifiedAt: OPENAI_MODELS_VERIFIED_AT }),
  'gpt-6-luna': Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000, source: OPENAI_MODELS_SOURCE, verifiedAt: OPENAI_MODELS_VERIFIED_AT }),
  'gpt-6-sol': Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000, source: OPENAI_MODELS_SOURCE, verifiedAt: OPENAI_MODELS_VERIFIED_AT }),
  'gpt-6.1-sol': Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000, source: OPENAI_MODELS_SOURCE, verifiedAt: OPENAI_MODELS_VERIFIED_AT }),
  'gpt-6.1-terra': Object.freeze({ contextWindow: 1_050_000, maxTokens: 128_000, source: OPENAI_MODELS_SOURCE, verifiedAt: OPENAI_MODELS_VERIFIED_AT })
})

export const getAuthoritativeModelMetadata = (
  provider: string,
  model: string
): AuthoritativeModelMetadata | undefined => provider === 'openai' && Object.hasOwn(OPENAI_API_MODEL_METADATA, model)
  ? OPENAI_API_MODEL_METADATA[model]
  : undefined

export interface ModelMetadataMismatch {
  id: string
  field: 'contextWindow'
  actual: number | undefined
  expected: number
  source: string
}

export const getOpenAIAPIMetadataMismatches = (
  models: readonly { id: string; contextWindow?: number }[]
): ModelMetadataMismatch[] => models.flatMap((model) => {
  if (!Object.hasOwn(OPENAI_API_MODEL_METADATA, model.id)) return []
  const expected = OPENAI_API_MODEL_METADATA[model.id]
  if (expected === undefined || model.contextWindow === expected.contextWindow) return []
  return [{ id: model.id, field: 'contextWindow', actual: model.contextWindow, expected: expected.contextWindow, source: expected.source }]
})
