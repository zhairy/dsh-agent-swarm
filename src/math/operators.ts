import { createHash } from 'node:crypto'
import { getIntegerBits, getMathLimits, type MathLimits } from './limits.js'
import { CALC_OPERATORS, canonicalMathJson, isRecord, type CalcErrorCode, type CalcOperator, type CalcRequest, type CalcResult, type RationalValue } from './schema.js'

export interface CalculateOptions { limits?: Partial<MathLimits>; enableExtended?: boolean }
class CalcFailure extends Error {
  constructor (readonly code: CalcErrorCode, message: string) { super(message) }
}
const fail = (code: CalcErrorCode, message: string): never => { throw new CalcFailure(code, message) }
const finite = (value: unknown): number => {
  if (typeof value !== 'number') return fail('INVALID_INPUT', 'Expected a number without coercion')
  if (!Number.isFinite(value)) return fail('NON_FINITE', 'Numbers and arithmetic results must be finite')
  return Object.is(value, -0) ? 0 : value
}
const only = (value: Record<string, unknown>, keys: string[]): void => {
  if (Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_INPUT', 'Unexpected operator argument')
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')
const EXTENDED: CalcOperator[] = ['poly_eval', 'matmul']

interface Rational { n: bigint; d: bigint }
interface Context {
  limits: MathLimits
  extended?: boolean
  work: number
  charge: (units: number) => void
  integer: (value: unknown) => bigint
  intermediate: (value: bigint) => bigint
  output: (value: bigint) => string
  gcd: (a: bigint, b: bigint) => bigint
  rational: (value: unknown) => Rational
  fraction: (n: bigint, d: bigint) => Rational
  rationalOutput: (value: Rational) => RationalValue
}

const makeContext = (limits: MathLimits): Context => {
  const ctx: Context = {
    limits, work: 0,
    charge: (units) => {
      if (ctx.work + units > limits.maxWorkUnits) fail('OPERATION_LIMIT', 'Computation work limit exceeded')
      ctx.work += units
    },
    integer: (value) => {
      if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return fail('INVALID_INPUT', 'Exact integers must be decimal strings')
      if (value.length > Math.ceil(limits.maxIntegerInputBits * Math.LOG10E * Math.LN2) + 2) return fail('INPUT_LIMIT', 'Integer input is too long')
      const n = BigInt(value)
      if (getIntegerBits(n) > limits.maxIntegerInputBits) return fail('INPUT_LIMIT', 'Integer input bit limit exceeded')
      ctx.charge(Math.max(1, Math.ceil(getIntegerBits(n) / 32)))
      return n
    },
    intermediate: (value) => {
      const bits = getIntegerBits(value)
      if (bits > limits.maxIntermediateBits) fail('OPERATION_LIMIT', 'Intermediate integer bit limit exceeded')
      ctx.charge(Math.max(1, Math.ceil(bits / 32)))
      return value
    },
    output: (value) => {
      if (getIntegerBits(value) > limits.maxIntegerOutputBits) fail('OPERATION_LIMIT', 'Integer output bit limit exceeded')
      return value.toString()
    },
    gcd: (a, b) => {
      a = a < 0n ? -a : a
      b = b < 0n ? -b : b
      while (b !== 0n) { ctx.charge(Math.max(1, Math.ceil(getIntegerBits(a) / 32))); [a, b] = [b, a % b] }
      return a
    },
    fraction: (n, d) => {
      ctx.intermediate(n); ctx.intermediate(d)
      if (d === 0n) return fail('DIV_ZERO', 'Rational denominator is zero')
      if (n === 0n) return { n: 0n, d: 1n }
      if (d < 0n) { n = -n; d = -d }
      const g = ctx.gcd(n, d)
      return { n: n / g, d: d / g }
    },
    rational: (value) => {
      if (!isRecord(value)) return fail('INVALID_INPUT', 'Expected numerator/denominator decimal strings')
      only(value, ['numerator', 'denominator'])
      return ctx.fraction(ctx.integer(value.numerator), ctx.integer(value.denominator))
    },
    rationalOutput: (value) => ({ numerator: ctx.output(value.n), denominator: ctx.output(value.d) })
  }
  return ctx
}

/** Validate JSON shape without invoking accessors or allowing cyclic/deep inputs. */
const validateTree = (value: unknown, limits: MathLimits): number => {
  const ancestors = new Set<object>()
  let count = 0
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > limits.maxTotalElements + 256 || depth > 24) fail('INPUT_LIMIT', 'Input nesting or node limit exceeded')
    if (typeof item === 'number') { finite(item); count++; return }
    if (typeof item === 'string') { if (/^-?\d+$/.test(item)) count++; return }
    if (typeof item === 'boolean' || item === null) return
    if (!Array.isArray(item) && !isRecord(item)) fail('INVALID_INPUT', 'Only finite JSON data is allowed')
    const object = item as object
    if (ancestors.has(object)) fail('INVALID_INPUT', 'Cyclic input is not allowed')
    ancestors.add(object)
    if (Array.isArray(item) && item.length > limits.maxArrayElements) fail('INPUT_LIMIT', 'Array element limit exceeded')
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key, index) => key !== String(index)))) fail('INVALID_INPUT', 'Sparse arrays and non-index array properties are forbidden')
    for (const key of Object.keys(object)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('INVALID_INPUT', 'Unsafe input property')
      const desc = Object.getOwnPropertyDescriptor(object, key)
      if (desc === undefined || !('value' in desc)) return fail('INVALID_INPUT', 'Input accessors are not allowed')
      visit(desc.value, depth + 1)
    }
    ancestors.delete(object)
  }
  visit(value, 0)
  if (count > limits.maxTotalElements) fail('INPUT_LIMIT', 'Total scalar limit exceeded')
  if (Buffer.byteLength(canonicalMathJson(value), 'utf8') > limits.maxInputBytes) fail('INPUT_LIMIT', 'Request byte limit exceeded')
  return count
}

const array = (value: unknown, ctx: Context): number[] => {
  if (!Array.isArray(value)) return fail('INVALID_INPUT', 'Expected an array of numbers')
  if (value.length > ctx.limits.maxArrayElements) return fail('INPUT_LIMIT', 'Array element limit exceeded')
  ctx.charge(value.length)
  return value.map(finite)
}
const matrix = (value: unknown, ctx: Context): number[][] => {
  if (!Array.isArray(value) || value.length === 0) return fail('DIMENSION', 'Matrix must be nonempty and rectangular')
  if (value.length > ctx.limits.maxMatrixDimension) return fail('INPUT_LIMIT', 'Matrix dimension limit exceeded')
  const rows = value.map((row) => array(row, ctx))
  const columns = rows[0]?.length ?? 0
  if (columns < 1 || columns > ctx.limits.maxMatrixDimension || rows.some((row) => row.length !== columns)) return fail('DIMENSION', 'Matrix must be nonempty and rectangular within dimension limits')
  if (rows.length * columns > ctx.limits.maxArrayElements) return fail('INPUT_LIMIT', 'Matrix scalar limit exceeded')
  return rows
}

/** Neumaier summation also handles the large-small-large cancellation case. */
const sum = (values: number[], ctx: Context): number => {
  let total = 0
  let compensation = 0
  for (const x of values) {
    ctx.charge(1)
    const next = finite(total + x)
    compensation = finite(compensation + (Math.abs(total) >= Math.abs(x) ? (total - next) + x : (x - next) + total))
    total = next
  }
  return finite(total + compensation)
}
const dot = (a: number[], b: number[], ctx: Context): number => {
  if (a.length !== b.length) return fail('DIMENSION', 'Vector lengths differ')
  ctx.charge(a.length)
  return sum(a.map((x, i) => finite(x * (b[i] as number))), ctx)
}
const norm = (values: number[], ctx: Context): number => {
  let scale = 0
  let squares = 1
  for (const x of values) {
    ctx.charge(1)
    const a = Math.abs(x)
    if (a === 0) continue
    if (a > scale) { squares = 1 + squares * (scale / a) ** 2; scale = a } else squares += (a / scale) ** 2
  }
  return finite(scale === 0 ? 0 : scale * Math.sqrt(squares))
}

/** Compare a dyadic binary64 number exactly, avoiding Infinity <= Infinity bugs. */
const dyadic = (x: number): Rational => {
  if (x === 0) return { n: 0n, d: 1n }
  const data = new DataView(new ArrayBuffer(8))
  data.setFloat64(0, x)
  const bits = data.getBigUint64(0)
  const exponent = Number((bits >> 52n) & 2047n)
  const fraction = bits & ((1n << 52n) - 1n)
  let n = exponent === 0 ? fraction : fraction | (1n << 52n)
  if (bits >> 63n) n = -n
  const shift = (exponent === 0 ? -1022 : exponent - 1023) - 52
  return shift >= 0 ? { n: n << BigInt(shift), d: 1n } : { n, d: 1n << BigInt(-shift) }
}
const compareClose = (a: number, b: number, abs: number, rel: number, ctx: Context): boolean => {
  if (abs < 0 || rel < 0) return fail('DOMAIN', 'Tolerances must be finite and nonnegative')
  ctx.charge(1000)
  const left = dyadic(a); const right = dyadic(b)
  const absFraction = dyadic(abs); const relFraction = dyadic(rel)
  const maxFraction = dyadic(Math.max(Math.abs(a), Math.abs(b)))
  const difference = left.n * right.d - right.n * left.d
  const delta = difference < 0n ? -difference : difference
  const rhsN = absFraction.n * relFraction.d * maxFraction.d + relFraction.n * maxFraction.n * absFraction.d
  const rhsD = absFraction.d * relFraction.d * maxFraction.d
  return delta * rhsD <= rhsN * left.d * right.d
}

interface OperationOutput { value: unknown; args: Record<string, unknown>; shape?: number[] }
const operate = (request: CalcRequest, ctx: Context): OperationOutput => {
  const { op, args, mode } = request
  const floatOnly = (): void => { if (mode !== 'float64') fail('UNSUPPORTED', 'This operator requires float64 mode') }
  const integerOnly = (): void => { if (mode !== 'bigint') fail('UNSUPPORTED', 'This operator requires bigint mode') }
  if (op === 'compare') {
    only(args, ['a', 'b'])
    if (mode === 'bigint') {
      const a = ctx.integer(args.a); const b = ctx.integer(args.b)
      return { value: a < b ? -1 : a > b ? 1 : 0, args: { a: a.toString(), b: b.toString() } }
    }
    if (mode === 'rational') {
      const a = ctx.rational(args.a); const b = ctx.rational(args.b)
      const left = ctx.intermediate(a.n * b.d); const right = ctx.intermediate(b.n * a.d)
      return { value: left < right ? -1 : left > right ? 1 : 0, args: { a: ctx.rationalOutput(a), b: ctx.rationalOutput(b) } }
    }
    return fail('UNSUPPORTED', 'Exact compare requires bigint or rational mode; use compare_close for float64')
  }
  if (['add', 'sub', 'mul', 'div'].includes(op)) {
    only(args, ['a', 'b'])
    if (mode === 'float64') {
      const a = finite(args.a); const b = finite(args.b)
      if (op === 'div' && b === 0) fail('DIV_ZERO', 'Division by zero')
      ctx.charge(1)
      return { value: finite(op === 'add' ? a + b : op === 'sub' ? a - b : op === 'mul' ? a * b : a / b), args: { a, b } }
    }
    if (mode === 'bigint') {
      const a = ctx.integer(args.a); const b = ctx.integer(args.b)
      if (op === 'div' && b === 0n) fail('DIV_ZERO', 'Division by zero')
      if (op === 'div' && a % b !== 0n) fail('DOMAIN', 'Bigint division must be exact; use rational mode for fractions')
      const result = ctx.intermediate(op === 'add' ? a + b : op === 'sub' ? a - b : op === 'mul' ? a * b : a / b)
      return { value: ctx.output(result), args: { a: a.toString(), b: b.toString() } }
    }
    const a = ctx.rational(args.a); const b = ctx.rational(args.b)
    let result: Rational
    if (op === 'add' || op === 'sub') result = ctx.fraction(ctx.intermediate(ctx.intermediate(a.n * b.d) + (op === 'add' ? 1n : -1n) * ctx.intermediate(b.n * a.d)), ctx.intermediate(a.d * b.d))
    else result = ctx.fraction(ctx.intermediate(a.n * (op === 'mul' ? b.n : b.d)), ctx.intermediate(a.d * (op === 'mul' ? b.d : b.n)))
    return { value: ctx.rationalOutput(result), args: { a: ctx.rationalOutput(a), b: ctx.rationalOutput(b) } }
  }
  if (op === 'compare_close') {
    floatOnly(); only(args, ['a', 'b'])
    if (!isRecord(request.tolerance)) return fail('INVALID_INPUT', 'compare_close requires explicit abs and rel tolerances')
    only(request.tolerance, ['abs', 'rel'])
    const a = finite(args.a); const b = finite(args.b)
    return { value: compareClose(a, b, finite(request.tolerance.abs), finite(request.tolerance.rel), ctx), args: { a, b } }
  }
  if (op === 'gcd' || op === 'lcm') {
    integerOnly(); only(args, ['a', 'b'])
    const a = ctx.integer(args.a); const b = ctx.integer(args.b)
    const g = ctx.gcd(a, b)
    let result = op === 'gcd' ? g : a === 0n || b === 0n ? 0n : ctx.intermediate((a / g) * b)
    if (result < 0n) result = -result
    return { value: ctx.output(result), args: { a: a.toString(), b: b.toString() } }
  }
  if (op === 'binomial') {
    integerOnly(); only(args, ['n', 'k'])
    const { n, k } = args
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || (n as number) < 0 || (k as number) < 0 || (k as number) > (n as number)) return fail('DOMAIN', 'binomial requires safe integers 0 <= k <= n')
    if ((n as number) > ctx.limits.maxBinomialN) fail('INPUT_LIMIT', 'Binomial n limit exceeded')
    const count = Math.min(k as number, (n as number) - (k as number))
    let result = 1n
    for (let i = 1; i <= count; i++) result = ctx.intermediate(ctx.intermediate(result * BigInt((n as number) - count + i)) / BigInt(i))
    return { value: ctx.output(result), args: { n, k } }
  }
  floatOnly()
  if (op === 'sum' || op === 'mean' || op === 'variance' || op === 'norm2') {
    only(args, op === 'variance' ? ['values', 'ddof'] : ['values'])
    const values = array(args.values, ctx)
    if (op === 'sum') return { value: sum(values, ctx), args: { values } }
    if (op === 'norm2') return { value: norm(values, ctx), args: { values } }
    if (values.length === 0) return fail('DOMAIN', 'Mean and variance require nonempty arrays')
    if (op === 'mean') return { value: finite(sum(values, ctx) / values.length), args: { values } }
    const ddof = args.ddof ?? 0
    if (ddof !== 0 && ddof !== 1) return fail('INVALID_INPUT', 'variance requires explicit ddof 0 or 1')
    if (values.length <= ddof) return fail('DOMAIN', 'variance requires n > ddof')
    let mean = 0; let m2 = 0; let n = 0
    for (const x of values) { ctx.charge(1); n++; const delta = finite(x - mean); mean = finite(mean + delta / n); m2 = finite(m2 + finite(delta * finite(x - mean))) }
    if (m2 < 0) fail('NON_FINITE', 'Negative variance from rounding is unsupported')
    return { value: finite(m2 / (n - ddof)), args: { values, ddof } }
  }
  if (op === 'dot') {
    only(args, ['a', 'b'])
    const a = array(args.a, ctx); const b = array(args.b, ctx)
    return { value: dot(a, b, ctx), args: { a, b } }
  }
  if (op === 'poly_eval') {
    only(args, ['coefficients', 'x'])
    const coefficients = array(args.coefficients, ctx); const x = finite(args.x)
    if (coefficients.length > ctx.limits.maxPolynomialDegree + 1) fail('INPUT_LIMIT', 'Polynomial degree limit exceeded')
    let result = 0
    for (let i = coefficients.length - 1; i >= 0; i--) { ctx.charge(1); result = finite(finite(result * x) + (coefficients[i] as number)) }
    return { value: result, args: { coefficients, x } }
  }
  if (op === 'matmul') {
    only(args, ['a', 'b'])
    const a = matrix(args.a, ctx); const b = matrix(args.b, ctx)
    const m = a.length; const k = a[0]?.length ?? 0; const n = b[0]?.length ?? 0
    if (k !== b.length) fail('DIMENSION', 'Matrix dimensions do not match')
    const work = m * k * n
    if (work > ctx.limits.maxMultiplyAdds || m * n > ctx.limits.maxArrayElements) fail('OPERATION_LIMIT', 'Matrix output or multiply-add limit exceeded')
    ctx.charge(work)
    const result = a.map((row) => Array.from({ length: n }, (_v, column) => sum(row.map((x, index) => finite(x * (b[index]?.[column] as number))), ctx)))
    return { value: result, args: { a, b }, shape: [m, n] }
  }
  if (op === 'residual_norm') {
    only(args, ['a', 'x', 'b', 'residual'])
    if (args.residual !== undefined) {
      if (args.a !== undefined || args.x !== undefined || args.b !== undefined) fail('INVALID_INPUT', 'Supply residual or A,x,b, not both')
      const residual = array(args.residual, ctx)
      return { value: norm(residual, ctx), args: { residual } }
    }
    // The explicit-vector form is available in the first release; matrix residuals are opt-in.
    if (!ctx.extended) return fail('UNSUPPORTED', 'Matrix residuals require extended operators')
    const a = matrix(args.a, ctx); const x = array(args.x, ctx); const b = array(args.b, ctx)
    if (a.length !== b.length || a[0]?.length !== x.length) fail('DIMENSION', 'Residual dimensions do not match')
    if (a.length * x.length > ctx.limits.maxMultiplyAdds) fail('OPERATION_LIMIT', 'Residual work limit exceeded')
    return { value: norm(a.map((row, index) => finite(dot(row, x, ctx) - (b[index] as number))), ctx), args: { a, x, b } }
  }
  return fail('UNSUPPORTED', 'Unsupported operator')
}

/** Bounded pure numerical kernel: no I/O, clock, environment, randomness, eval or mutation. */
export const calculate = (raw: unknown, options: CalculateOptions = {}): CalcResult => {
  let ctx: Context | undefined
  try {
    const limits = getMathLimits(options.limits)
    validateTree(raw, limits)
    if (!isRecord(raw)) return fail('INVALID_INPUT', 'Calculation must be an object')
    only(raw, ['op', 'version', 'mode', 'args', 'tolerance'])
    if (!(CALC_OPERATORS as readonly unknown[]).includes(raw.op) || !['float64', 'bigint', 'rational'].includes(String(raw.mode)) || !isRecord(raw.args)) return fail('INVALID_INPUT', 'Unknown operator, numeric mode, or arguments')
    if (raw.version !== undefined && raw.version !== 1) return fail('UNSUPPORTED', 'Unsupported calculation version')
    if (raw.tolerance !== undefined && raw.op !== 'compare_close') fail('INVALID_INPUT', 'Tolerances only apply to compare_close')
    const request = raw as unknown as CalcRequest
    if (EXTENDED.includes(request.op) && options.enableExtended !== true) fail('UNSUPPORTED', 'Extended operators are disabled')
    ctx = makeContext(limits)
    ctx.extended = options.enableExtended === true
    const output = operate(request, ctx)
    const normalized = { op: request.op, version: 1, mode: request.mode, args: output.args, ...(request.tolerance === undefined ? {} : { tolerance: request.tolerance }) }
    const inputDigest = digest(canonicalMathJson(normalized))
    const exact = request.mode !== 'float64' || request.op === 'compare_close'
    return {
      ok: true, value: output.value, exact, evidenceKind: 'computed', numericMode: request.mode,
      semantics: request.op === 'compare_close' ? 'Exact comparison of represented binary64 values and explicit tolerances; not a proof about pre-rounding values' : 'Computed result for supplied inputs; not a general proof',
      operatorVersion: '1', inputDigest,
      reproducibleDigest: digest(canonicalMathJson({ inputDigest, operatorVersion: '1', value: output.value })),
      inputSummary: { scalarCount: validateTree(output.args, limits), ...(output.shape === undefined ? {} : { shape: output.shape }) },
      diagnostics: request.mode === 'float64' ? ['binary64 inputs and arithmetic are approximate; replay requires the same numeric implementation, not cross-engine bit identity'] : [],
      workUnits: ctx.work
    }
  } catch (error) {
    if (error instanceof CalcFailure) return { ok: false, code: error.code, message: error.message, workUnits: ctx?.work ?? 0 }
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid calculation or limits', workUnits: ctx?.work ?? 0 }
  }
}
