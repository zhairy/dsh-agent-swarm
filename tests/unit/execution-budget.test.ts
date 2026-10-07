import { describe, expect, it } from 'vitest'
import { createExecutionBudget } from '../../src/execution-budget.js'

describe('non-Jev execution budgets', () => {
  it('reserves atomically, isolates math from delegations and treats zero as unlimited', async () => {
    const budget = createExecutionBudget({ maxDelegations: 1, maxMathCalls: 2 })
    const results = await Promise.allSettled(['a', 'b'].map((id) => Promise.resolve().then(() => budget.reserve({ id, source: 'delegate' }))))
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    budget.reserve({ id: 'math-a', source: 'math' }); budget.reserve({ id: 'math-b', source: 'math' })
    expect(() => budget.reserve({ id: 'math-c', source: 'math' })).toThrow('maxMathCalls')
    const unlimited = createExecutionBudget({ maxDelegations: 0 })
    for (let i = 0; i < 100; i++) unlimited.reserve({ id: String(i), source: 'delegate' })
  })

  it('refunds only unsent reservations and never refunds started or recovered work', () => {
    const budget = createExecutionBudget({ maxModelAttempts: 1 })
    budget.reserve({ id: 'unused', source: 'model' }); budget.cancel('unused')
    budget.reserve({ id: 'sent', source: 'model' }); budget.start('sent'); budget.cancel('sent')
    expect(() => budget.reserve({ id: 'retry', source: 'model' })).toThrow('maxModelAttempts')
    const restored = createExecutionBudget({ maxModelAttempts: 1 }, budget.getSnapshot())
    restored.cancel('sent')
    expect(() => restored.reserve({ id: 'again', source: 'native' })).toThrow('maxModelAttempts')
  })

  it('charges actual usage, preserves unknown observations and prevents request-id conflicts', () => {
    const budget = createExecutionBudget({ maxTokens: 10, maxMathWorkUnits: 100 })
    budget.reserve({ id: 'model', source: 'model', estimatedTokens: 2 }); budget.start('model')
    budget.settle('model', { inputTokens: 8, outputTokens: 3, costUsd: 0.01 })
    expect(() => budget.reserve({ id: 'new', source: 'delegate' })).toThrow('maxTokens')
    expect(() => budget.reserve({ id: 'model', source: 'math' })).toThrow('different budget arguments')
    const math = createExecutionBudget({ maxMathWorkUnits: 10 })
    math.reserve({ id: 'calc', source: 'math', estimatedWorkUnits: 5 }); math.start('calc'); math.settle('calc', { workUnits: 7 })
    expect(math.remainingMathWork()).toBe(3)
    expect(() => math.reserve({ id: 'calc2', source: 'math', estimatedWorkUnits: 4 })).toThrow('maxMathWorkUnits')
    expect(math.getSnapshot().reservations[0]?.usageUnknown).toBe(true)
  })

  it('always excludes Jev from count/token/cost rejection while observing its usage', () => {
    const budget = createExecutionBudget({ maxDelegations: 1, maxTokens: 1, maxCostUsd: 0.001 })
    budget.reserve({ id: 'full', source: 'delegate', estimatedTokens: 1, estimatedCostUsd: 0.001 })
    for (let i = 0; i < 10; i++) {
      budget.reserve({ id: 'jev-' + i, source: 'jev', estimatedTokens: 1000, estimatedCostUsd: 10 })
      budget.start('jev-' + i); budget.settle('jev-' + i, { inputTokens: 1000, outputTokens: 3, costUsd: 10 })
    }
    budget.observeJev(undefined, 2)
    expect(budget.getSnapshot().jev).toEqual({ attempts: 12, inputTokens: 10000, outputTokens: 30, costUsd: 100, unknownUsage: 2, unknownCost: 2 })
    expect(() => budget.reserve({ id: 'nonjev', source: 'delegate' })).toThrow('maxDelegations')
  })

  it('accepts late usage without refunding cancelled requests or double-counting attempts', () => {
    const budget = createExecutionBudget({ maxModelAttempts: 1, maxTokens: 10 })
    budget.reserve({ id: 'sent', source: 'model', estimatedTokens: 1 }); budget.start('sent'); budget.cancel('sent')
    budget.settle('sent', { inputTokens: 8, outputTokens: 4 })
    expect(budget.getSnapshot().reservations[0]).toMatchObject({ usageUnknown: false, usage: { inputTokens: 8, outputTokens: 4 } })
    expect(() => budget.reserve({ id: 'another', source: 'model' })).toThrow('maxModelAttempts')
    budget.reserve({ id: 'jev', source: 'jev' }); budget.start('jev'); budget.cancel('jev')
    budget.settle('jev', { inputTokens: 2, outputTokens: 3, costUsd: 0.5 }); budget.settle('jev', { inputTokens: 2, outputTokens: 3, costUsd: 0.5 })
    expect(budget.getSnapshot().jev).toEqual({ attempts: 1, inputTokens: 2, outputTokens: 3, costUsd: 0.5, unknownUsage: 0, unknownCost: 0 })
  })

  it('fails closed for positive token/cost caps without estimates while leaving Jev and math exempt', () => {
    const budget = createExecutionBudget({ maxTokens: 100, maxCostUsd: 1, maxMathCalls: 1 })
    expect(() => budget.reserve({ id: 'unknown-tokens', source: 'delegate' })).toThrow('maxTokens requires')
    expect(() => budget.reserve({ id: 'unknown-cost', source: 'model', estimatedTokens: 10 })).toThrow('maxCostUsd requires')
    expect(budget.getSnapshot().reservations).toHaveLength(0)
    budget.reserve({ id: 'covered', source: 'delegate', estimatedTokens: 10, estimatedCostUsd: 0.1 })
    budget.reserve({ id: 'math', source: 'math' })
    budget.reserve({ id: 'jev', source: 'jev' })
    expect(() => budget.reserve({ id: 'math-again', source: 'math' })).toThrow('maxMathCalls')
    const counted = createExecutionBudget({ maxDelegations: 1, maxTokens: 100 })
    counted.reserve({ id: 'first', source: 'delegate', estimatedTokens: 10 })
    expect(() => counted.reserve({ id: 'count-priority', source: 'delegate' })).toThrow('maxDelegations exhausted')
    const disabled = createExecutionBudget({ maxTokens: 0, maxCostUsd: 0 })
    disabled.reserve({ id: 'unlimited', source: 'native' })
  })

  it('does not treat restored unknown zero usage as covered when a positive cap is enabled', () => {
    const legacy = createExecutionBudget()
    legacy.reserve({ id: 'legacy-sent', source: 'model' }); legacy.start('legacy-sent'); legacy.settle('legacy-sent')
    const restored = createExecutionBudget({ maxTokens: 100, maxCostUsd: 1 }, legacy.getSnapshot())
    expect(() => restored.reserve({ id: 'new', source: 'model', estimatedTokens: 10, estimatedCostUsd: 0.1 })).toThrow('unknown is not zero')
    restored.settle('legacy-sent', { inputTokens: 2, outputTokens: 2, costUsd: 0.01 })
    expect(() => restored.reserve({ id: 'new', source: 'model', estimatedTokens: 10, estimatedCostUsd: 0.1 })).not.toThrow()
  })

  it('reports unknown Jev cost independently of known tokens and conservatively restores legacy cost coverage', () => {
    const budget = createExecutionBudget({ maxTokens: 1, maxCostUsd: 0.001 })
    budget.observeJev({ inputTokens: 20, outputTokens: 5 })
    expect(budget.getSnapshot().jev).toEqual({ attempts: 1, inputTokens: 20, outputTokens: 5, costUsd: 0, unknownUsage: 0, unknownCost: 1 })
    budget.observeJev(undefined, 2)
    expect(budget.getSnapshot().jev).toMatchObject({ attempts: 3, unknownUsage: 2, unknownCost: 3 })
    const legacy = budget.getSnapshot()
    delete legacy.jev.unknownCost
    expect(createExecutionBudget({}, legacy).getSnapshot().jev.unknownCost).toBe(3)
  })

  it('refines late Jev cost without spending another attempt or clearing unrelated unknown token observations', () => {
    const budget = createExecutionBudget({ maxCostUsd: 0.001 })
    budget.reserve({ id: 'known-tokens', source: 'jev' }); budget.start('known-tokens')
    budget.settle('known-tokens', { inputTokens: 2, outputTokens: 3 })
    budget.observeJev()
    budget.settle('known-tokens', { costUsd: 0.5 })
    budget.settle('known-tokens', { costUsd: 0.5 })
    expect(budget.getSnapshot().jev).toEqual({ attempts: 2, inputTokens: 2, outputTokens: 3, costUsd: 0.5, unknownUsage: 1, unknownCost: 1 })
    budget.reserve({ id: 'late-free-price', source: 'jev' }); budget.start('late-free-price'); budget.settle('late-free-price')
    budget.settle('late-free-price', { costUsd: 0 })
    expect(budget.getSnapshot().jev).toMatchObject({ attempts: 3, unknownUsage: 2, unknownCost: 1 })
    budget.settle('late-free-price', { inputTokens: 1, outputTokens: 1 })
    expect(budget.getSnapshot().jev).toEqual({ attempts: 3, inputTokens: 3, outputTokens: 4, costUsd: 0.5, unknownUsage: 1, unknownCost: 1 })
  })
})
