import { describe, expect, it } from 'vitest'
import { DEFAULT_MATH_CONFIG, getCalculateOptions, getMathAvailability, getMathConfig, MATH_LIMIT_MAXIMA } from '../../src/math/config.js'
import { calculate } from '../../src/math/operators.js'

const add = { op: 'add', mode: 'float64', args: { a: 1, b: 2 } }
const matrix = { op: 'matmul', mode: 'float64', args: { a: [[2]], b: [[3]] } }
const run = (request: unknown, raw: unknown) => calculate(request, getCalculateOptions(getMathConfig(raw)))

describe('mathematical operator authorization and resource configuration', () => {
  it('defaults to finite basic/exact modes while matrix and polynomial require opt-in', () => {
    expect(getMathConfig(undefined)).toEqual(DEFAULT_MATH_CONFIG)
    expect(run(add, undefined)).toMatchObject({ ok: true, value: 3, operatorVersion: '2' })
    expect(run(matrix, undefined)).toMatchObject({ ok: false, code: 'UNSUPPORTED', workUnits: 0 })
    expect(run(matrix, { groups: { matrix: true } })).toMatchObject({ ok: true, value: [[6]] })
    expect(run({ op: 'poly_eval', mode: 'float64', args: { coefficients: [], x: 2 } }, { groups: { polynomial: true } })).toMatchObject({ ok: true, value: 0 })
  })

  it('requires the group, operator and numeric mode together, with legacy opt-in migration', () => {
    expect(run(matrix, { enableExtended: true })).toMatchObject({ ok: true })
    expect(run(matrix, { enableExtended: true, groups: { matrix: false } })).toMatchObject({ ok: false, code: 'UNSUPPORTED', workUnits: 0 })
    for (const raw of [{ enabled: false }, { groups: { arithmetic: false } }, { operators: { add: false } }, { numericModes: { float64: false } }]) expect(run(add, raw)).toMatchObject({ ok: false, code: 'UNSUPPORTED', workUnits: 0 })
    expect(run(matrix, { groups: { matrix: true }, operators: { matmul: false } })).toMatchObject({ ok: false, code: 'UNSUPPORTED', workUnits: 0 })
    expect(run({ op: 'add', mode: 'bigint', args: { a: '2', b: '3' } }, { numericModes: { float64: false } })).toMatchObject({ ok: true, value: '5', exact: true })
  })

  it('does not grant matrix capability through residual_norm', () => {
    const residual = { op: 'residual_norm', mode: 'float64', args: { a: [[2]], x: [3], b: [6] } }
    expect(run({ ...residual, args: { residual: [3, 4] } }, undefined)).toMatchObject({ ok: true, value: 5 })
    for (const raw of [undefined, { groups: { matrix: true }, operators: { matmul: false } }, { groups: { matrix: true, verification: false } }]) expect(run(residual, raw)).toMatchObject({ ok: false, code: 'UNSUPPORTED', workUnits: 0 })
    expect(run(residual, { groups: { matrix: true } })).toMatchObject({ ok: true, value: 0 })
  })

  it('rejects malformed authorization and size policy instead of granting defaults', () => {
    for (const raw of [null, [], 'bad', { groups: [] }, { groups: { unknown: true } }, { operators: { eval: true } }, { numericModes: { decimal: true } }, { limits: { maxArrayElements: 0 } }, { limits: { maxInputBytes: MATH_LIMIT_MAXIMA.maxInputBytes + 1 } }, { maxWorkUnitsPerTask: 0 }, { maxCallsPerTask: -1 }, { limits: { maxWorkUnits: NaN } }]) {
      const config = getMathConfig(raw)
      expect(config.configurationError).toBeDefined()
      expect(getMathAvailability(add, config)).toMatchObject({ ok: false, code: 'INVALID_INPUT', workUnits: 0 })
    }
    expect(getMathConfig({ futureUnrelatedSetting: { retain: true }, maxCallsPerTask: 0 }).configurationError).toBeUndefined()
    expect(getMathConfig({ maxCallsPerTask: 0 }).maxCallsPerTask).toBe(0)
  })

  it('never invokes request accessors while checking permissions', () => {
    let invoked = false
    const getter = () => { invoked = true; return 'add' }
    const request = Object.defineProperty({ mode: 'float64', args: { a: 1, b: 2 } }, 'op', { enumerable: true, get: getter })
    expect(run(request, undefined)).toMatchObject({ ok: false, code: 'INVALID_INPUT', workUnits: 0 })
    const args = Object.defineProperty({}, 'residual', { enumerable: true, get: getter })
    expect(run({ op: 'residual_norm', mode: 'float64', args }, undefined)).toMatchObject({ ok: false, code: 'INVALID_INPUT', workUnits: 0 })
    expect(invoked).toBe(false)
  })

  it('clamps per-call work to the smaller configuration and task allowance', () => {
    const config = getMathConfig({ limits: { maxWorkUnits: 20 } })
    expect(getCalculateOptions(config, 100).limits.maxWorkUnits).toBe(20)
    expect(getCalculateOptions(config, 5).limits.maxWorkUnits).toBe(5)
    expect(getCalculateOptions(config, 0).limits.maxWorkUnits).toBe(0)
  })
})
