import { describe, expect, it } from 'vitest'
import { CONTEXT_SAFETY_MARGIN_TOKENS, formatContextAdmissionError, getContextAdmission } from '../../src/context-admission.js'

describe('context-aware model admission', () => {
  it('reserves output and safety headroom before admitting a measured session', () => {
    const result = getContextAdmission({
      route: { provider: 'openai', model: 'gpt-6.1-sol' },
      call: { maxTokens: 128000 },
      measurement: { totalTokens: 368003 },
      modelInfo: { context: { contextWindow: 272000 }, defaultMaxTokens: 128000 }
    })
    expect(result).toEqual({
      ok: false,
      measuredTokens: 368003,
      contextWindow: 272000,
      reservedOutputTokens: 128000,
      safetyMarginTokens: CONTEXT_SAFETY_MARGIN_TOKENS,
      safeInputTokens: 139904,
      reason: 'context-window-insufficient'
    })
  })

  it('admits a session below the safe input budget and preserves unknown-host compatibility', () => {
    expect(getContextAdmission({
      route: { provider: 'openai', model: 'gpt-6.1-sol' },
      call: { maxTokens: 128000 },
      measurement: { totalTokens: 63500 },
      modelInfo: { context: { contextWindow: 272000 }, defaultMaxTokens: 128000 }
    })).toMatchObject({ ok: true, safeInputTokens: 139904 })
    expect(getContextAdmission({ route: { provider: 'custom', model: 'm' }, call: {} })).toEqual({ ok: true })
    expect(getContextAdmission({ route: { provider: 'custom', model: 'm' }, call: {}, measurement: { totalTokens: 999 }, modelInfo: {} }))
      .toEqual({ ok: true, measuredTokens: 999 })
  })

  it('uses the model default output cap when this request omits maxTokens', () => {
    expect(getContextAdmission({
      route: { provider: 'openai', model: 'gpt-6.1-sol' },
      call: {},
      measurement: { totalTokens: 200000 },
      modelInfo: { context: { contextWindow: 272000 }, defaultMaxTokens: 128000 }
    })).toMatchObject({ ok: false, reservedOutputTokens: 128000, safeInputTokens: 139904 })
    expect(getContextAdmission({
      route: { provider: 'openai', model: 'gpt-6.1-sol' },
      call: { maxTokens: 8192 },
      measurement: { totalTokens: 200000 },
      modelInfo: { context: { contextWindow: 272000 }, defaultMaxTokens: 128000 }
    })).toMatchObject({ ok: false, reservedOutputTokens: 128000 })
  })

  it('caps impossible output reservations and produces a bounded actionable error', () => {
    const impossible = getContextAdmission({
      route: { provider: 'p', model: 'm' }, call: { maxTokens: 999999 }, measurement: { totalTokens: 368003 },
      modelInfo: { context: { contextWindow: 1000 } }
    })
    expect(impossible).toMatchObject({ ok: false, reservedOutputTokens: 999, safetyMarginTokens: 0, safeInputTokens: 1 })
    expect(formatContextAdmissionError([impossible])).toContain('未调用模型')
    expect(formatContextAdmissionError([impossible])).toContain('368')
  })
})
