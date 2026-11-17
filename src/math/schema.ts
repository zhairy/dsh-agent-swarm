import type { JsonSchemaObject } from '../util/json-schema.js'

export const CALC_OPERATORS = ['add', 'sub', 'mul', 'div', 'compare', 'compare_close', 'gcd', 'lcm', 'binomial', 'sum', 'mean', 'variance', 'dot', 'norm2', 'poly_eval', 'matmul', 'residual_norm'] as const
export type CalcOperator = typeof CALC_OPERATORS[number]
export type NumericMode = 'float64' | 'bigint' | 'rational'
export interface RationalValue { numerator: string; denominator: string }
export interface CalcRequest {
  op: CalcOperator
  version?: 1
  mode: NumericMode
  args: Record<string, unknown>
  tolerance?: { abs: number; rel: number }
}
export type CalcErrorCode = 'DOMAIN' | 'DIMENSION' | 'NON_FINITE' | 'INPUT_LIMIT' | 'OPERATION_LIMIT' | 'DIV_ZERO' | 'UNSUPPORTED' | 'INVALID_INPUT'
export type CalcResult =
  | { ok: true; value: unknown; exact: boolean; evidenceKind: 'computed'; numericMode: NumericMode;
      semantics: string; operatorVersion: string; inputDigest: string; reproducibleDigest: string;
      inputSummary: { scalarCount: number; shape?: number[] }; diagnostics: string[]; workUnits: number }
  | { ok: false; code: CalcErrorCode; message: string; workUnits: number }

export const CALCULATE_PARAMETERS: JsonSchemaObject = {
  type: 'object', additionalProperties: false,
  properties: {
    task_id: { type: 'string', description: 'Current task; permissions and cumulative computation budgets are checked by the service.' },
    op: { type: 'string', enum: CALC_OPERATORS },
    version: { type: 'number' },
    mode: { type: 'string', enum: ['float64', 'bigint', 'rational'] },
    args: { type: 'object', additionalProperties: true, description: 'Operator-specific typed arguments; expressions, code, paths and callbacks are rejected.' },
    tolerance: { type: 'object', properties: { abs: { type: 'number' }, rel: { type: 'number' } }, required: ['abs', 'rel'], additionalProperties: false }
  }, required: ['op', 'mode', 'args']
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** Canonical JSON for mathematical values; callers validate finite JSON before hashing. */
export const canonicalMathJson = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonicalMathJson).join(',') + ']'
  if (isRecord(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalMathJson(value[key])).join(',') + '}'
  return JSON.stringify(Object.is(value, -0) ? 0 : value) as string
}
