import { type MathLimits } from './limits.js';
import { type CalcOperator, type CalcResult, type NumericMode } from './schema.js';
export declare const MATH_GROUP_OPERATORS: {
    readonly arithmetic: readonly ["add", "sub", "mul", "div", "compare", "compare_close"];
    readonly integer: readonly ["gcd", "lcm", "binomial"];
    readonly statistics: readonly ["sum", "mean", "variance"];
    readonly vector: readonly ["dot", "norm2"];
    readonly matrix: readonly ["matmul"];
    readonly polynomial: readonly ["poly_eval"];
    readonly verification: readonly ["residual_norm"];
};
export type MathGroup = keyof typeof MATH_GROUP_OPERATORS;
export declare const MATH_NUMERIC_MODES: readonly NumericMode[];
/** Synchronous kernels have fixed safety ceilings; settings can tighten them. */
export declare const MATH_LIMIT_MAXIMA: Readonly<MathLimits>;
export declare const MAX_MATH_WORK_PER_TASK = 10000000;
export declare const MAX_MATH_CALLS_PER_TASK = 1000000;
export interface MathConfigInfo {
    enabled: boolean;
    /** Read compatibility only: explicit groups take precedence. */
    enableExtended: boolean;
    maxCallsPerTask: number;
    maxWorkUnitsPerTask: number;
    groups: Record<MathGroup, boolean>;
    operators: Record<CalcOperator, boolean>;
    numericModes: Record<NumericMode, boolean>;
    limits: MathLimits;
    configurationError?: string;
}
export declare const DEFAULT_MATH_CONFIG: Readonly<MathConfigInfo>;
/** Known authorization keys are strict; unrelated top-level settings remain forward compatible. */
export declare const getMathConfig: (raw: unknown) => MathConfigInfo;
/** No operand traversal or computation; callers run this before reserving task budget. */
export declare const getMathAvailability: (raw: unknown, config: MathConfigInfo) => CalcResult | undefined;
/** Clamp single-call work to the remaining task allowance; zero remaining is rejected by the service. */
export declare const getCalculateOptions: (config: MathConfigInfo, remaining?: number) => {
    policy: MathConfigInfo;
    limits: MathLimits;
    enableExtended: boolean;
};
