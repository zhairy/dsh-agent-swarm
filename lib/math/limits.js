export const DEFAULT_MATH_LIMITS = Object.freeze({
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
});
export const getMathLimits = (overrides = {}) => {
    const limits = { ...DEFAULT_MATH_LIMITS, ...overrides };
    for (const [key, value] of Object.entries(limits)) {
        if (!Number.isSafeInteger(value) || value < 1)
            throw new Error('Invalid math limit: ' + key);
    }
    return limits;
};
export const getIntegerBits = (value) => {
    const absolute = value < 0n ? -value : value;
    return absolute === 0n ? 0 : absolute.toString(2).length;
};
//# sourceMappingURL=limits.js.map