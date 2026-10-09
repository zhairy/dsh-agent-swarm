import { DEFAULT_MATH_LIMITS, type MathLimits } from './limits.js'
import { CALC_OPERATORS, isRecord, type CalcOperator, type CalcResult, type NumericMode } from './schema.js'

export const MATH_GROUP_OPERATORS = {
  arithmetic: ['add', 'sub', 'mul', 'div', 'compare', 'compare_close'],
  integer: ['gcd', 'lcm', 'binomial'],
  statistics: ['sum', 'mean', 'variance'],
  vector: ['dot', 'norm2'],
  matrix: ['matmul'],
  polynomial: ['poly_eval'],
  verification: ['residual_norm']
} as const satisfies Record<string, readonly CalcOperator[]>
export type MathGroup = keyof typeof MATH_GROUP_OPERATORS
export const MATH_NUMERIC_MODES: readonly NumericMode[] = ['float64', 'bigint', 'rational']
/** Synchronous kernels have fixed safety ceilings; settings can tighten them. */
export const MATH_LIMIT_MAXIMA = Object.freeze(Object.fromEntries(
  Object.entries(DEFAULT_MATH_LIMITS).map(([key, value]) => [key, value * 4])
) as unknown as MathLimits)
export const MAX_MATH_WORK_PER_TASK = 10_000_000
export const MAX_MATH_CALLS_PER_TASK = 1_000_000
export interface MathConfigInfo {
  enabled: boolean
  /** Read compatibility only: explicit groups take precedence. */
  enableExtended: boolean
  maxCallsPerTask: number
  maxWorkUnitsPerTask: number
  groups: Record<MathGroup, boolean>
  operators: Record<CalcOperator, boolean>
  numericModes: Record<NumericMode, boolean>
  limits: MathLimits
  configurationError?: string
}
export const DEFAULT_MATH_CONFIG: Readonly<MathConfigInfo> = Object.freeze({
  enabled: true, enableExtended: false, maxCallsPerTask: 64, maxWorkUnitsPerTask: 1_000_000,
  groups: Object.freeze({ arithmetic: true, integer: true, statistics: true, vector: true, matrix: false, polynomial: false, verification: true }),
  operators: Object.freeze(Object.fromEntries(CALC_OPERATORS.map((op) => [op, true])) as Record<CalcOperator, boolean>),
  numericModes: Object.freeze({ float64: true, bigint: true, rational: true }),
  limits: DEFAULT_MATH_LIMITS
})
const record = (raw: unknown): Record<string, unknown> => isRecord(raw) ? raw : {}
/** Known authorization keys are strict; unrelated top-level settings remain forward compatible. */
export const getMathConfig = (raw: unknown): MathConfigInfo => {
  const source = record(raw)
  let configurationError = typeof source.configurationError === 'string' ? source.configurationError : raw !== undefined && !isRecord(raw) ? 'Invalid math configuration' : undefined
  const booleans = <T extends string>(key: string, defaults: Record<T, boolean>): Record<T, boolean> => {
    const value = record(source[key])
    if ((source[key] !== undefined && !isRecord(source[key])) || Object.keys(value).some((name) => !Object.hasOwn(defaults, name) || typeof value[name] !== 'boolean')) configurationError = `Invalid math ${key}`
    return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, typeof value[name] === 'boolean' ? value[name] : fallback])) as Record<T, boolean>
  }
  const positive = (value: unknown, fallback: number, maximum: number, minimum = 1): number => {
    if (value === undefined) return fallback
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) { configurationError = 'Invalid math resource limit'; return fallback }
    return value as number
  }
  const groups = booleans('groups', { ...DEFAULT_MATH_CONFIG.groups,
    ...(source.enableExtended === true ? { matrix: true, polynomial: true } : {}) })
  const rawLimits = record(source.limits)
  if ((source.limits !== undefined && !isRecord(source.limits)) || Object.keys(rawLimits).some((key) => !Object.hasOwn(DEFAULT_MATH_LIMITS, key))) configurationError = 'Invalid math limits'
  const limits = Object.fromEntries(Object.entries(DEFAULT_MATH_LIMITS).map(([key, fallback]) => [key,
    positive(rawLimits[key], fallback, MATH_LIMIT_MAXIMA[key as keyof MathLimits])])) as unknown as MathLimits
  for (const key of ['enabled', 'enableExtended']) if (source[key] !== undefined && typeof source[key] !== 'boolean') configurationError = 'Invalid math switch'
  return {
    enabled: source.enabled === undefined ? true : source.enabled === true,
    enableExtended: source.enableExtended === true,
    maxCallsPerTask: positive(source.maxCallsPerTask, DEFAULT_MATH_CONFIG.maxCallsPerTask, MAX_MATH_CALLS_PER_TASK, 0),
    maxWorkUnitsPerTask: positive(source.maxWorkUnitsPerTask, DEFAULT_MATH_CONFIG.maxWorkUnitsPerTask, MAX_MATH_WORK_PER_TASK),
    groups, operators: booleans('operators', DEFAULT_MATH_CONFIG.operators), numericModes: booleans('numericModes', DEFAULT_MATH_CONFIG.numericModes), limits,
    ...(configurationError === undefined ? {} : { configurationError })
  }
}
const denied = (message: string, code: 'UNSUPPORTED' | 'INVALID_INPUT' = 'UNSUPPORTED'): CalcResult => ({ ok: false, code, message, workUnits: 0 })
/** No operand traversal or computation; callers run this before reserving task budget. */
export const getMathAvailability = (raw: unknown, config: MathConfigInfo): CalcResult | undefined => {
  if (config.configurationError !== undefined) return denied(config.configurationError, 'INVALID_INPUT')
  if (!config.enabled) return denied('Mathematical operators are disabled')
  if (!isRecord(raw)) return denied('Calculation must be an object', 'INVALID_INPUT')
  const fields = ['op', 'mode', 'args'].map((key) => Object.getOwnPropertyDescriptor(raw, key))
  if (fields.some((field) => field === undefined || !('value' in field))) return denied('Operator, mode and args must be JSON data properties', 'INVALID_INPUT')
  const [operator, mode, args] = fields.map((field) => field!.value)
  if (!(CALC_OPERATORS as readonly unknown[]).includes(operator) || !(MATH_NUMERIC_MODES as readonly unknown[]).includes(mode) || !isRecord(args)) return denied('Unknown operator, numeric mode or arguments', 'INVALID_INPUT')
  const op = operator as CalcOperator
  const group = (Object.keys(MATH_GROUP_OPERATORS) as MathGroup[]).find((key) => (MATH_GROUP_OPERATORS[key] as readonly string[]).includes(op))!
  if (!config.groups[group] || !config.operators[op] || !config.numericModes[mode as NumericMode]) return denied(`Operator ${op} or numeric mode ${String(mode)} is disabled`)
  const residual = Object.getOwnPropertyDescriptor(args, 'residual')
  if (residual !== undefined && !('value' in residual)) return denied('Residual must be a JSON data property', 'INVALID_INPUT')
  if (op === 'residual_norm' && residual?.value === undefined && (!config.groups.matrix || !config.operators.matmul)) return denied('Matrix residuals require the matrix group and matmul operator')
  return undefined
}
/** Clamp single-call work to the remaining task allowance; zero remaining is rejected by the service. */
export const getCalculateOptions = (config: MathConfigInfo, remaining?: number): { policy: MathConfigInfo; limits: MathLimits; enableExtended: boolean } => ({
  policy: config,
  enableExtended: config.groups.matrix || config.groups.polynomial,
  limits: { ...config.limits, maxWorkUnits: remaining === undefined ? config.limits.maxWorkUnits : Math.min(config.limits.maxWorkUnits, Math.max(0, remaining)) }
})
