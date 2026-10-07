/** Initial resource policies, not measured performance claims. Zero never disables a math limit. */
export interface MathLimits {
  maxInputBytes: number
  maxArrayElements: number
  maxTotalElements: number
  maxIntegerInputBits: number
  maxIntegerOutputBits: number
  maxIntermediateBits: number
  maxBinomialN: number
  maxMatrixDimension: number
  maxMultiplyAdds: number
  maxPolynomialDegree: number
  maxWorkUnits: number
}

export const DEFAULT_MATH_LIMITS: Readonly<MathLimits> = Object.freeze({
  maxInputBytes: 128 * 1024,
  maxArrayElements: 4096,
  maxTotalElements: 8192,
  maxIntegerInputBits: 4096,
  maxIntegerOutputBits: 4096,
  maxIntermediateBits: 8192,
  maxBinomialN: 1000,
  maxMatrixDimension: 32,
  maxMultiplyAdds: 32768,
  maxPolynomialDegree: 1024,
  maxWorkUnits: 2_000_000
})

export const getMathLimits = (overrides: Partial<MathLimits> = {}): MathLimits => {
  const limits = { ...DEFAULT_MATH_LIMITS, ...overrides }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid math limit: ' + key)
  }
  return limits
}

export const getIntegerBits = (value: bigint): number => {
  const absolute = value < 0n ? -value : value
  return absolute === 0n ? 0 : absolute.toString(2).length
}
