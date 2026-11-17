import { describe, expect, it } from 'vitest'
import { evaluateRouteEligibility, selectEligibleRoutes, toFailureFact } from '../../src/domain/routing/eligibility.js'

const snapshot = { configuredProviders: ['codex', 'dsh-opencode-go'], models: {
  'codex/gpt': { reasoning: ['high'], inputModalities: ['text', 'image'] },
  'dsh-opencode-go/kimi': { reasoning: ['max'], inputModalities: ['text'] }
} }

describe('v3.2.0 route engine', () => {
  it('keeps declared order and removes only explicit ineligibility', () => {
    const codex = { provider: 'codex', model: 'gpt', reasoningEffort: 'high' }
    const go = { provider: 'dsh-opencode-go', model: 'kimi', reasoningEffort: 'max' }
    const missing = { provider: 'antigravity', model: 'gemini' }
    const candidates = [codex, go, missing].map((route) => ({ route, eligibility: evaluateRouteEligibility(route, snapshot, { reasoningEffort: route.reasoningEffort }) }))
    expect(selectEligibleRoutes(candidates)).toEqual([codex, go])
    expect(evaluateRouteEligibility(go, snapshot, { vision: true })).toEqual({ eligible: false, reason: 'vision-unsupported' })
  })

  it('normalizes failures into one structured fact', () => {
    expect(toFailureFact({ provider: 'antigravity', model: 'gemini-4-argon-high' }, { status: 429, message: 'Individual quota reached', providerRetryAfterMs: 1000 }, 1000))
      .toMatchObject({ kind: 'quota_exhausted', retryable: false, isolate: true, quotaScope: 'model', retryAfterMs: 1000 })
  })
})
