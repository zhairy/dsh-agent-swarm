import { DEFAULT_MATH_LIMITS } from './limits.js';
import { CALC_OPERATORS, isRecord } from './schema.js';
export const MATH_GROUP_OPERATORS = {
    arithmetic: ['add', 'sub', 'mul', 'div', 'compare', 'compare_close'],
    integer: ['gcd', 'lcm', 'binomial'],
    statistics: ['sum', 'mean', 'variance'],
    vector: ['dot', 'norm2'],
    matrix: ['matmul'],
    polynomial: ['poly_eval'],
    verification: ['residual_norm']
};
export const MATH_NUMERIC_MODES = ['float64', 'bigint', 'rational'];
/** Synchronous kernels have fixed safety ceilings; settings can tighten them. */
export const MATH_LIMIT_MAXIMA = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_MATH_LIMITS).map(([key, value]) => [key, value * 4])));
export const MAX_MATH_WORK_PER_TASK = 10_000_000;
export const MAX_MATH_CALLS_PER_TASK = 1_000_000;
export const DEFAULT_MATH_CONFIG = Object.freeze({
    enabled: true, enableExtended: false, maxCallsPerTask: 64, maxWorkUnitsPerTask: 1_000_000,
    groups: Object.freeze({ arithmetic: true, integer: true, statistics: true, vector: true, matrix: false, polynomial: false, verification: true }),
    operators: Object.freeze(Object.fromEntries(CALC_OPERATORS.map((op) => [op, true]))),
    numericModes: Object.freeze({ float64: true, bigint: true, rational: true }),
    limits: DEFAULT_MATH_LIMITS
});
const record = (raw) => isRecord(raw) ? raw : {};
/** Known authorization keys are strict; unrelated top-level settings remain forward compatible. */
export const getMathConfig = (raw) => {
    const source = record(raw);
    let configurationError = typeof source.configurationError === 'string' ? source.configurationError : raw !== undefined && !isRecord(raw) ? 'Invalid math configuration' : undefined;
    const booleans = (key, defaults) => {
        const value = record(source[key]);
        if ((source[key] !== undefined && !isRecord(source[key])) || Object.keys(value).some((name) => !Object.hasOwn(defaults, name) || typeof value[name] !== 'boolean'))
            configurationError = `Invalid math ${key}`;
        return Object.fromEntries(Object.entries(defaults).map(([name, fallback]) => [name, typeof value[name] === 'boolean' ? value[name] : fallback]));
    };
    const positive = (value, fallback, maximum, minimum = 1) => {
        if (value === undefined)
            return fallback;
        if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
            configurationError = 'Invalid math resource limit';
            return fallback;
        }
        return value;
    };
    const groups = booleans('groups', { ...DEFAULT_MATH_CONFIG.groups,
        ...(source.enableExtended === true ? { matrix: true, polynomial: true } : {}) });
    const rawLimits = record(source.limits);
    if ((source.limits !== undefined && !isRecord(source.limits)) || Object.keys(rawLimits).some((key) => !Object.hasOwn(DEFAULT_MATH_LIMITS, key)))
        configurationError = 'Invalid math limits';
    const limits = Object.fromEntries(Object.entries(DEFAULT_MATH_LIMITS).map(([key, fallback]) => [key,
        positive(rawLimits[key], fallback, MATH_LIMIT_MAXIMA[key])]));
    for (const key of ['enabled', 'enableExtended'])
        if (source[key] !== undefined && typeof source[key] !== 'boolean')
            configurationError = 'Invalid math switch';
    return {
        enabled: source.enabled === undefined ? true : source.enabled === true,
        enableExtended: source.enableExtended === true,
        maxCallsPerTask: positive(source.maxCallsPerTask, DEFAULT_MATH_CONFIG.maxCallsPerTask, MAX_MATH_CALLS_PER_TASK, 0),
        maxWorkUnitsPerTask: positive(source.maxWorkUnitsPerTask, DEFAULT_MATH_CONFIG.maxWorkUnitsPerTask, MAX_MATH_WORK_PER_TASK),
        groups, operators: booleans('operators', DEFAULT_MATH_CONFIG.operators), numericModes: booleans('numericModes', DEFAULT_MATH_CONFIG.numericModes), limits,
        ...(configurationError === undefined ? {} : { configurationError })
    };
};
const denied = (message, code = 'UNSUPPORTED') => ({ ok: false, code, message, workUnits: 0 });
/** No operand traversal or computation; callers run this before reserving task budget. */
export const getMathAvailability = (raw, config) => {
    if (config.configurationError !== undefined)
        return denied(config.configurationError, 'INVALID_INPUT');
    if (!config.enabled)
        return denied('Mathematical operators are disabled');
    if (!isRecord(raw))
        return denied('Calculation must be an object', 'INVALID_INPUT');
    const fields = ['op', 'mode', 'args'].map((key) => Object.getOwnPropertyDescriptor(raw, key));
    if (fields.some((field) => field === undefined || !('value' in field)))
        return denied('Operator, mode and args must be JSON data properties', 'INVALID_INPUT');
    const [operator, mode, args] = fields.map((field) => field.value);
    if (!CALC_OPERATORS.includes(operator) || !MATH_NUMERIC_MODES.includes(mode) || !isRecord(args))
        return denied('Unknown operator, numeric mode or arguments', 'INVALID_INPUT');
    const op = operator;
    const group = Object.keys(MATH_GROUP_OPERATORS).find((key) => MATH_GROUP_OPERATORS[key].includes(op));
    if (!config.groups[group] || !config.operators[op] || !config.numericModes[mode])
        return denied(`Operator ${op} or numeric mode ${String(mode)} is disabled`);
    const residual = Object.getOwnPropertyDescriptor(args, 'residual');
    if (residual !== undefined && !('value' in residual))
        return denied('Residual must be a JSON data property', 'INVALID_INPUT');
    if (op === 'residual_norm' && residual?.value === undefined && (!config.groups.matrix || !config.operators.matmul))
        return denied('Matrix residuals require the matrix group and matmul operator');
    return undefined;
};
/** Clamp single-call work to the remaining task allowance; zero remaining is rejected by the service. */
export const getCalculateOptions = (config, remaining) => ({
    policy: config,
    enableExtended: config.groups.matrix || config.groups.polynomial,
    limits: { ...config.limits, maxWorkUnits: remaining === undefined ? config.limits.maxWorkUnits : Math.min(config.limits.maxWorkUnits, Math.max(0, remaining)) }
});
//# sourceMappingURL=config.js.map