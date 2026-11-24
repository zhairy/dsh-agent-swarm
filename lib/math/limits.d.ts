/** Initial resource policies, not measured performance claims. Zero never disables a math limit. */
export interface MathLimits {
    maxInputBytes: number;
    maxArrayElements: number;
    maxTotalElements: number;
    maxIntegerInputBits: number;
    maxIntegerOutputBits: number;
    maxIntermediateBits: number;
    maxBinomialN: number;
    maxMatrixDimension: number;
    maxMultiplyAdds: number;
    maxPolynomialDegree: number;
    maxWorkUnits: number;
}
export declare const DEFAULT_MATH_LIMITS: Readonly<MathLimits>;
export declare const getMathLimits: (overrides?: Partial<MathLimits>) => MathLimits;
export declare const getIntegerBits: (value: bigint) => number;
