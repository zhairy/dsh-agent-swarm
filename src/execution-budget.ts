export type BudgetSource = 'delegate' | 'model' | 'native' | 'math' | 'jev'
export interface ExecutionBudgetLimits {
  maxDelegations?: number
  maxModelAttempts?: number
  maxMathCalls?: number
  maxMathWorkUnits?: number
  maxTokens?: number
  maxCostUsd?: number
}
export interface UsageObservation { inputTokens?: number; outputTokens?: number; costUsd?: number; workUnits?: number }
export interface BudgetReservation {
  id: string
  source: BudgetSource
  state: 'reserved' | 'started' | 'settled' | 'cancelled'
  estimatedTokens: number
  estimatedCostUsd: number
  estimatedWorkUnits: number
  tokenEstimateKnown?: boolean
  costEstimateKnown?: boolean
  usage?: UsageObservation
  usageUnknown?: boolean
  exempt: boolean
}
export interface ExecutionBudgetSnapshot {
  schemaVersion: 1
  limits: ExecutionBudgetLimits
  reservations: BudgetReservation[]
  jev: { attempts: number; inputTokens: number; outputTokens: number; costUsd: number; unknownUsage: number; unknownCost?: number }
  coverage: string[]
}
export class ExecutionBudgetError extends Error {
  constructor (readonly code: 'BUDGET_EXHAUSTED' | 'BUDGET_INVALID' | 'BUDGET_TRANSITION' | 'BUDGET_UNSUPPORTED' | 'REQUEST_CONFLICT', message: string) { super(message); this.name = 'ExecutionBudgetError' }
}
export interface ExecutionBudget {
  reserve: (input: { id: string; source: BudgetSource; estimatedTokens?: number; estimatedCostUsd?: number; estimatedWorkUnits?: number }) => BudgetReservation
  start: (id: string) => BudgetReservation
  settle: (id: string, usage?: UsageObservation) => BudgetReservation
  cancel: (id: string) => BudgetReservation
  observeJev: (usage?: UsageObservation, attempts?: number) => void
  getSnapshot: () => ExecutionBudgetSnapshot
  remainingMathWork: () => number | undefined
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Synchronous reservation makes check-and-consume atomic within one JS isolate; Jev never enters limits. */
export const createExecutionBudget = (limits: ExecutionBudgetLimits = {}, restored?: ExecutionBudgetSnapshot, coverage: string[] = ['delegations', 'math-tool-calls']): ExecutionBudget => {
  if (Object.values(limits).some((value) => !nonnegative(value))) throw new ExecutionBudgetError('BUDGET_INVALID', 'Budget limits must be finite and nonnegative; zero means unlimited')
  for (const key of ['maxDelegations', 'maxModelAttempts', 'maxMathCalls', 'maxMathWorkUnits', 'maxTokens'] as const) if (limits[key] !== undefined && !Number.isSafeInteger(limits[key])) throw new ExecutionBudgetError('BUDGET_INVALID', 'Count/token limits must be safe integers')
  const reservations = new Map<string, BudgetReservation>()
  let jev = { attempts: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unknownUsage: 0, unknownCost: 0 }
  if (restored !== undefined) {
    if (restored.schemaVersion !== 1 || !Array.isArray(restored.reservations) || !Object.values(restored.jev).every(nonnegative)) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid budget snapshot')
    // Legacy subtotal alone cannot establish which requests had observed prices.
    jev = { ...structuredClone(restored.jev), unknownCost: restored.jev.unknownCost ?? restored.jev.attempts }
    for (const record of restored.reservations) {
      if (!['delegate', 'model', 'native', 'math', 'jev'].includes(record.source) || !['reserved', 'started', 'settled', 'cancelled'].includes(record.state) || typeof record.id !== 'string' || reservations.has(record.id)) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid reservation snapshot')
      if (![record.estimatedTokens, record.estimatedCostUsd, record.estimatedWorkUnits].every(nonnegative) || record.exempt !== (record.source === 'jev')) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid reservation usage')
      if (record.usage !== undefined && Object.values(record.usage).some((value) => !nonnegative(value))) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid restored usage')
      if ((record.tokenEstimateKnown !== undefined && typeof record.tokenEstimateKnown !== 'boolean') || (record.costEstimateKnown !== undefined && typeof record.costEstimateKnown !== 'boolean')) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid estimate coverage markers')
      // Never refund started work on restart. Unknown sent attempts remain charged.
      reservations.set(record.id, { ...structuredClone(record), tokenEstimateKnown: record.tokenEstimateKnown ?? record.estimatedTokens > 0, costEstimateKnown: record.costEstimateKnown ?? record.estimatedCostUsd > 0, ...(record.state === 'started' ? { state: 'settled' as const, usageUnknown: true } : {}) })
    }
  }
  const used = () => [...reservations.values()].filter((record) => !record.exempt && record.state !== 'cancelled')
  const check = (key: keyof ExecutionBudgetLimits, actual: number): void => {
    const maximum = limits[key]
    if (maximum !== undefined && maximum > 0 && actual > maximum) throw new ExecutionBudgetError('BUDGET_EXHAUSTED', key + ' exhausted')
  }
  const budget: ExecutionBudget = {
    reserve: (input) => {
      if (typeof input.id !== 'string' || input.id.length === 0 || input.id.length > 256 || !['delegate', 'model', 'native', 'math', 'jev'].includes(input.source)) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid request identity/source')
      const estimatedTokens = input.estimatedTokens ?? 0
      const estimatedCostUsd = input.estimatedCostUsd ?? 0
      const estimatedWorkUnits = input.estimatedWorkUnits ?? 0
      if (![estimatedTokens, estimatedCostUsd, estimatedWorkUnits].every(nonnegative)) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid request estimates')
      const existing = reservations.get(input.id)
      if (existing !== undefined) {
        if (existing.source !== input.source || existing.estimatedTokens !== estimatedTokens || existing.estimatedCostUsd !== estimatedCostUsd || existing.estimatedWorkUnits !== estimatedWorkUnits) throw new ExecutionBudgetError('REQUEST_CONFLICT', 'Request id already has different budget arguments')
        return structuredClone(existing)
      }
      const records = used()
      if (input.source !== 'jev') {
        if (input.source === 'delegate') check('maxDelegations', records.filter((r) => r.source === 'delegate').length + 1)
        if (input.source === 'model' || input.source === 'native') check('maxModelAttempts', records.filter((r) => r.source === 'model' || r.source === 'native').length + 1)
        if (input.source === 'math') {
          check('maxMathCalls', records.filter((r) => r.source === 'math').length + 1)
          check('maxMathWorkUnits', records.reduce((sum, r) => sum + (r.usage?.workUnits ?? r.estimatedWorkUnits), 0) + estimatedWorkUnits)
        }
        if (input.source !== 'math') {
          const generation = records.filter((record) => record.source !== 'math')
          check('maxTokens', generation.reduce((sum, r) => sum + (r.usage === undefined ? r.estimatedTokens : r.usageUnknown ? Math.max(r.estimatedTokens, (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)) : (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0)), 0) + estimatedTokens)
          check('maxCostUsd', generation.reduce((sum, r) => sum + (r.usage?.costUsd ?? r.estimatedCostUsd), 0) + estimatedCostUsd)
          if ((limits.maxTokens ?? 0) > 0 && (input.estimatedTokens === undefined || generation.some((record) => !record.tokenEstimateKnown && (record.usage?.inputTokens === undefined || record.usage?.outputTokens === undefined)))) throw new ExecutionBudgetError('BUDGET_UNSUPPORTED', 'maxTokens requires a token estimate and covered prior usage; unknown is not zero')
          if ((limits.maxCostUsd ?? 0) > 0 && (input.estimatedCostUsd === undefined || generation.some((record) => !record.costEstimateKnown && record.usage?.costUsd === undefined))) throw new ExecutionBudgetError('BUDGET_UNSUPPORTED', 'maxCostUsd requires a cost estimate and covered prior usage; unknown is not zero')
        }
      }
      const record: BudgetReservation = { id: input.id, source: input.source, state: 'reserved', estimatedTokens, estimatedCostUsd, estimatedWorkUnits, tokenEstimateKnown: input.estimatedTokens !== undefined, costEstimateKnown: input.estimatedCostUsd !== undefined, exempt: input.source === 'jev' }
      reservations.set(input.id, record)
      return structuredClone(record)
    },
    start: (id) => {
      const record = reservations.get(id)
      if (record === undefined || record.state === 'cancelled' || record.state === 'settled') throw new ExecutionBudgetError('BUDGET_TRANSITION', 'Only a reserved/started request can start')
      record.state = 'started'
      return structuredClone(record)
    },
    settle: (id, usage) => {
      const record = reservations.get(id)
      if (record === undefined || record.state === 'cancelled' || record.state === 'reserved') throw new ExecutionBudgetError('BUDGET_TRANSITION', 'Only sent work may settle')
      if (usage !== undefined && Object.values(usage).some((value) => !nonnegative(value))) throw new ExecutionBudgetError('BUDGET_INVALID', 'Usage must be finite and nonnegative')
      if (record.state === 'settled') {
        // Late provider usage after cancellation refines observation, without refunding or spending a second attempt.
        if (usage !== undefined && (record.usageUnknown || (record.exempt && record.usage?.costUsd === undefined))) {
          const previous = record.usage
          const merged = { ...previous, ...usage }
          const complete = merged.inputTokens !== undefined && merged.outputTokens !== undefined
          if (record.exempt) {
            jev.inputTokens += (merged.inputTokens ?? 0) - (previous?.inputTokens ?? 0)
            jev.outputTokens += (merged.outputTokens ?? 0) - (previous?.outputTokens ?? 0)
            jev.costUsd += (merged.costUsd ?? 0) - (previous?.costUsd ?? 0)
            if (record.usageUnknown && complete) jev.unknownUsage = Math.max(0, jev.unknownUsage - 1)
            if (previous?.costUsd === undefined && merged.costUsd !== undefined) jev.unknownCost = Math.max(0, jev.unknownCost - 1)
          }
          record.usage = merged; record.usageUnknown = !complete
        }
        return structuredClone(record)
      }
      record.state = 'settled'
      if (usage !== undefined) record.usage = structuredClone(usage)
      record.usageUnknown = usage === undefined || usage.inputTokens === undefined || usage.outputTokens === undefined
      if (record.exempt) budget.observeJev(usage)
      return structuredClone(record)
    },
    cancel: (id) => {
      const record = reservations.get(id)
      if (record === undefined) throw new ExecutionBudgetError('BUDGET_TRANSITION', 'Unknown reservation')
      if (record.state === 'reserved') record.state = 'cancelled'
      else if (record.state === 'started') { record.state = 'settled'; record.usageUnknown = true; if (record.exempt) budget.observeJev() }
      return structuredClone(record)
    },
    observeJev: (usage, attempts = 1) => {
      if (!Number.isSafeInteger(attempts) || attempts < 0 || (usage !== undefined && Object.values(usage).some((value) => !nonnegative(value)))) throw new ExecutionBudgetError('BUDGET_INVALID', 'Invalid Jev observation')
      jev.attempts += attempts
      jev.inputTokens += usage?.inputTokens ?? 0; jev.outputTokens += usage?.outputTokens ?? 0; jev.costUsd += usage?.costUsd ?? 0
      if (usage === undefined || usage.inputTokens === undefined || usage.outputTokens === undefined) jev.unknownUsage += attempts
      if (usage?.costUsd === undefined) jev.unknownCost += attempts
    },
    getSnapshot: () => ({ schemaVersion: 1, limits: { ...limits }, reservations: structuredClone([...reservations.values()]), jev: { ...jev }, coverage: [...coverage] }),
    remainingMathWork: () => limits.maxMathWorkUnits !== undefined && limits.maxMathWorkUnits > 0 ? Math.max(0, limits.maxMathWorkUnits - used().reduce((sum, r) => sum + (r.usage?.workUnits ?? r.estimatedWorkUnits), 0)) : undefined
  }
  return budget
}
