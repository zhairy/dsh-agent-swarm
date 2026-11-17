import { describe, expect, it } from 'vitest'
import { calculate } from '../../src/math/operators.js'

const value = (op: string, args: Record<string, unknown>, mode = 'float64', extra: Record<string, unknown> = {}) => {
  const result = calculate({ op, args, mode, ...extra })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

describe('bounded pure mathematical operators', () => {
  it('uses exact canonical integer and rational inputs without silent truncation', () => {
    expect(value('add', { a: '9007199254740993', b: '1' }, 'bigint')).toBe('9007199254740994')
    expect(value('div', { a: '6', b: '3' }, 'bigint')).toBe('2')
    expect(calculate({ op: 'div', mode: 'bigint', args: { a: '1', b: '2' } })).toMatchObject({ ok: false, code: 'DOMAIN' })
    expect(value('add', { a: { numerator: '2', denominator: '-6' }, b: { numerator: '1', denominator: '3' } }, 'rational')).toEqual({ numerator: '0', denominator: '1' })
    expect(value('div', { a: { numerator: '1', denominator: '2' }, b: { numerator: '3', denominator: '4' } }, 'rational')).toEqual({ numerator: '2', denominator: '3' })
    expect(calculate({ op: 'div', mode: 'rational', args: { a: { numerator: '1', denominator: '2' }, b: { numerator: '0', denominator: '1' } } })).toMatchObject({ ok: false, code: 'DIV_ZERO' })
  })

  it('agrees with independent small-integer arithmetic and Pascal reference', () => {
    for (let a = -15; a <= 15; a++) for (let b = -10; b <= 10; b++) {
      expect(value('mul', { a: String(a), b: String(b) }, 'bigint')).toBe(String(a * b))
      const g = Number(value('gcd', { a: String(a), b: String(b) }, 'bigint'))
      if (g !== 0) { expect(a % g).toBeCloseTo(0); expect(b % g).toBeCloseTo(0) }
      expect(g).toBeGreaterThanOrEqual(0)
    }
    let row = [1n]
    for (let n = 0; n <= 24; n++) {
      for (let k = 0; k <= n; k++) expect(value('binomial', { n, k }, 'bigint')).toBe(String(row[k]))
      row = [1n, ...row.slice(1).map((x, i) => x + (row[i] as bigint)), 1n]
    }
    expect(value('gcd', { a: '0', b: '0' }, 'bigint')).toBe('0')
    expect(value('lcm', { a: '0', b: '0' }, 'bigint')).toBe('0')
  })

  it('handles cancellation, stable variance and scaled norms', () => {
    expect(value('sum', { values: [1e16, 1, -1e16] })).toBe(1)
    expect(value('variance', { values: [1e12, 1e12 + 1, 1e12 + 2], ddof: 0 })).toBeCloseTo(2 / 3)
    expect(value('variance', { values: [1, 2, 3], ddof: 1 })).toBe(1)
    expect(value('norm2', { values: [1e200, 1e200] })).toBeCloseTo(Math.hypot(1e200, 1e200), -180)
    expect(value('sum', { values: [] })).toBe(0)
    expect(value('dot', { a: [], b: [] })).toBe(0)
    expect(calculate({ op: 'mean', mode: 'float64', args: { values: [] } })).toMatchObject({ ok: false, code: 'DOMAIN' })
    expect(calculate({ op: 'variance', mode: 'float64', args: { values: [1] } })).toMatchObject({ ok: true, value: 0 })
  })

  it('preserves finite extreme means and variances without overflowing intermediates', () => {
    expect(value('mean', { values: [1e308, 1e308] })).toBe(1e308)
    expect(value('mean', { values: [1e308, 1e-15, -1e308] })).toBe(1e-15 / 3)
    expect(Number(value('mean', { values: [1e308, 1e308, -1e308] })) / 1e308).toBeCloseTo(1 / 3, 14)
    expect(Number(value('variance', { values: [1e154, -1e154], ddof: 0 })) / 1e308).toBeCloseTo(1, 14)
    expect(value('variance', { values: [1e-160, -1e-160], ddof: 0 })).toBe(1e-320)
    expect(value('variance', { values: [1e12, 1e12 + 1, 1e12 + 2], ddof: 0 })).toBeCloseTo(2 / 3, 14)
    expect(Number(value('norm2', { values: [1e308, 1e308] })) / 1e308).toBeCloseTo(Math.SQRT2, 14)
    expect(calculate({ op: 'variance', mode: 'float64', args: { values: [1e154, -1e154], ddof: 1 } })).toMatchObject({ ok: false, code: 'NON_FINITE' })
  })

  it('compares represented finite values without overflow or guessed tolerances', () => {
    expect(value('compare_close', { a: 1e308, b: -1e308 }, 'float64', { tolerance: { abs: 0, rel: 0.1 } })).toBe(false)
    expect(value('compare_close', { a: 1e308, b: -1e308 }, 'float64', { tolerance: { abs: 0, rel: 2 } })).toBe(true)
    expect(value('compare_close', { a: Number.MIN_VALUE, b: 0 }, 'float64', { tolerance: { abs: Number.MIN_VALUE, rel: 0 } })).toBe(true)
    expect(calculate({ op: 'compare_close', mode: 'float64', args: { a: 1, b: 1 } })).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(calculate({ op: 'compare_close', mode: 'float64', args: { a: 1, b: 1 }, tolerance: { abs: -1, rel: 0 } })).toMatchObject({ ok: false, code: 'DOMAIN' })
  })

  it('has canonical digests and never mutates supplied arrays', () => {
    const values = Object.freeze([1, 2, 3])
    const a = calculate({ op: 'sum', args: { values }, mode: 'float64' })
    const b = calculate({ mode: 'float64', version: 1, args: { values: [1, 2, 3] }, op: 'sum' })
    expect(a).toMatchObject({ ok: true, inputSummary: { scalarCount: 3 } })
    expect(b).toMatchObject({ ok: true, inputSummary: { scalarCount: 4 } })
    if (!a.ok || !b.ok) throw new Error('Expected successful calculations')
    expect(a.value).toEqual(b.value)
    expect(a.inputDigest).toBe(b.inputDigest)
    expect(a.reproducibleDigest).toBe(b.reproducibleDigest)
    const integerA = calculate({ op: 'add', mode: 'bigint', args: { a: '001', b: '-0' } })
    const integerB = calculate({ op: 'add', mode: 'bigint', args: { a: '1', b: '0' } })
    expect(integerA).toEqual(integerB)
    expect(a).toMatchObject({ ok: true, exact: false, evidenceKind: 'computed' })
  })

  it('rejects unsupported, malformed, non-finite and oversized operations', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'a', { enumerable: true, get: () => { throw new Error('must not execute') } })
    for (const raw of [cyclic, { op: 'add', mode: 'float64', args: accessor }, { op: 'eval', mode: 'float64', args: { expression: '1+1' } }]) expect(calculate(raw).ok).toBe(false)
    expect(calculate({ op: 'add', mode: 'float64', args: { a: NaN, b: 1 } })).toMatchObject({ ok: false, code: 'NON_FINITE' })
    expect(calculate({ op: 'mul', mode: 'float64', args: { a: 1e308, b: 1e308 } })).toMatchObject({ ok: false, code: 'NON_FINITE' })
    expect(calculate({ op: 'sum', mode: 'float64', args: { values: [1, 2, 3] } }, { limits: { maxArrayElements: 2 } })).toMatchObject({ ok: false, code: 'INPUT_LIMIT' })
    expect(calculate({ op: 'mul', mode: 'bigint', args: { a: '255', b: '255' } }, { limits: { maxIntegerOutputBits: 8 } })).toMatchObject({ ok: false, code: 'OPERATION_LIMIT' })
  })

  it('gates extended operators and checks shapes and work before allocation', () => {
    const request = { op: 'matmul', mode: 'float64', args: { a: [[1, 2], [3, 4]], b: [[1, 0], [0, 1]] } }
    expect(calculate(request)).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    expect(calculate(request, { enableExtended: true })).toMatchObject({ ok: true, value: [[1, 2], [3, 4]] })
    expect(calculate(request, { enableExtended: true, limits: { maxMultiplyAdds: 4 } })).toMatchObject({ ok: false, code: 'OPERATION_LIMIT' })
    expect(calculate({ op: 'poly_eval', mode: 'float64', args: { coefficients: [1, 2, 3], x: 2 } }, { enableExtended: true })).toMatchObject({ ok: true, value: 17 })
    expect(calculate({ op: 'residual_norm', mode: 'float64', args: { a: [[2, 0], [0, 2]], x: [3, 4], b: [6, 8] } }, { enableExtended: true })).toMatchObject({ ok: true, value: 0 })
  })

  it('charges all matrix kernel work before computing any output', () => {
    const request = { op: 'matmul', mode: 'float64', args: { a: [[1, 2], [3, 4]], b: [[1, 0], [0, 1]] } }
    expect(calculate(request, { enableExtended: true, limits: { maxWorkUnits: 23 } })).toEqual({ ok: false, code: 'OPERATION_LIMIT', message: 'Computation work limit exceeded', workUnits: 8 })
    expect(calculate(request, { enableExtended: true, limits: { maxWorkUnits: 24 } })).toMatchObject({ ok: true, value: [[1, 2], [3, 4]], workUnits: 24 })
    const residual = { op: 'residual_norm', mode: 'float64', args: { a: [[2, 0], [0, 2]], x: [3, 4], b: [6, 8] } }
    expect(calculate(residual, { enableExtended: true, limits: { maxWorkUnits: 19 } })).toMatchObject({ ok: false, code: 'OPERATION_LIMIT', workUnits: 8 })
    expect(calculate(residual, { enableExtended: true, limits: { maxWorkUnits: 20 } })).toMatchObject({ ok: true, value: 0, workUnits: 20 })
  })

  it('applies scalar caps to actual input before execution without charging normalized defaults twice', () => {
    const omitted = { op: 'variance', mode: 'float64', args: { values: [3] } }
    expect(calculate(omitted, { limits: { maxTotalElements: 1 } })).toMatchObject({ ok: true, value: 0, operatorVersion: '2', inputSummary: { scalarCount: 1 } })
    const explicit = { ...omitted, args: { values: [3], ddof: 0 } }
    expect(calculate(explicit, { limits: { maxTotalElements: 1 } })).toMatchObject({ ok: false, code: 'INPUT_LIMIT', workUnits: 0 })
    expect(calculate(explicit, { limits: { maxTotalElements: 2 } })).toMatchObject({ ok: true, value: 0, inputSummary: { scalarCount: 2 } })
    expect(calculate(omitted, { limits: { maxInputBytes: Buffer.byteLength(JSON.stringify(omitted)) } })).toMatchObject({ ok: true, value: 0 })
  })

  it('agrees with independent two-pass statistics and direct dot on small exact inputs', () => {
    for (let n = 2; n <= 24; n++) {
      const a = Array.from({ length: n }, (_, i) => ((i * 7 + n) % 19) - 9)
      const b = a.slice().reverse()
      const mean = a.reduce((s, x) => s + x, 0) / n
      const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / n
      expect(value('variance', { values: a, ddof: 0 })).toBeCloseTo(variance, 10)
      expect(value('dot', { a, b })).toBe(a.reduce((s, x, i) => s + x * (b[i] as number), 0))
      expect(value('dot', { a, b })).toBe(value('dot', { a: b, b: a }))
    }
  })
})
