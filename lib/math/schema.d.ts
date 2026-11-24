import type { JsonSchemaObject } from '../util/json-schema.js';
export declare const CALC_OPERATORS: readonly ['add', 'sub', 'mul', 'div', 'compare', 'compare_close', 'gcd', 'lcm', 'binomial', 'sum', 'mean', 'variance', 'dot', 'norm2', 'poly_eval', 'matmul', 'residual_norm'];
export type CalcOperator = typeof CALC_OPERATORS[number];
export type NumericMode = 'float64' | 'bigint' | 'rational';
export interface RationalValue {
    numerator: string;
    denominator: string;
}
export interface CalcRequest {
    op: CalcOperator;
    version?: 1;
    mode: NumericMode;
    args: Record<string, unknown>;
    tolerance?: {
        abs: number;
        rel: number;
    };
}
export type CalcErrorCode = 'DOMAIN' | 'DIMENSION' | 'NON_FINITE' | 'INPUT_LIMIT' | 'OPERATION_LIMIT' | 'DIV_ZERO' | 'UNSUPPORTED' | 'INVALID_INPUT';
export type CalcResult = {
    ok: true;
    value: unknown;
    exact: boolean;
    evidenceKind: 'computed';
    numericMode: NumericMode;
    semantics: string;
    operatorVersion: string;
    inputDigest: string;
    reproducibleDigest: string;
    inputSummary: {
        scalarCount: number;
        shape?: number[];
    };
    diagnostics: string[];
    workUnits: number;
} | {
    ok: false;
    code: CalcErrorCode;
    message: string;
    workUnits: number;
};
export declare const CALCULATE_PARAMETERS: JsonSchemaObject;
export declare const isRecord: (value: unknown) => value is Record<string, unknown>;
/** Canonical JSON for mathematical values; callers validate finite JSON before hashing. */
export declare const canonicalMathJson: (value: unknown) => string;
