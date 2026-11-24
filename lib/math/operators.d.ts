import { type MathLimits } from './limits.js';
import { type CalcResult } from './schema.js';
import { type MathConfigInfo } from './config.js';
export interface CalculateOptions {
    limits?: Partial<MathLimits>;
    enableExtended?: boolean;
    policy?: MathConfigInfo;
}
/** Bounded pure numerical kernel: no I/O, clock, environment, randomness, eval or mutation. */
export declare const calculate: (raw: unknown, options?: CalculateOptions) => CalcResult;
