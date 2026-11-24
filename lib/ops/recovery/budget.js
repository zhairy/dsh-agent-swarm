import { emptyBudget, nonnegative, validateBudget } from './schema.js';
export const DEFAULT_REPAIR_BUDGET = Object.freeze({ wallMs: 900_000, toolCalls: 60, writes: 20, writeBytes: 5 * 1024 * 1024, concurrentProcesses: 2, actionRetries: 3, maxDepth: 0 });
export class RepairBudgetError extends Error {
    code;
    constructor(code) {
        super(code === 'PROCESS_CONCURRENCY' || code === 'ACTION_RETRIES' ? code : `manual_required: ${code}`);
        this.code = code;
    }
}
/** 额度先扣后执行；未知副作用不退款。Token/费用仅观察，不参与任何限额分支。 */
export const createRepairBudget = (options = {}) => {
    const now = options.now ?? Date.now, started = now(), consumed = validateBudget(options.initial ?? emptyBudget()), previousWall = consumed.wall_ms;
    const policy = { ...DEFAULT_REPAIR_BUDGET, ...options.policy };
    if (Object.values(policy).some(v => !Number.isSafeInteger(v) || v < 0) || policy.maxDepth !== 0)
        throw new RepairBudgetError('INVALID_POLICY');
    const calls = new Map((options.initialModelCalls ?? []).map(row => [row.callId, structuredClone(row)])), retries = new Map(Object.entries(options.initialRetryCounts ?? {}));
    if ([...retries].some(([key, value]) => key.length > 256 || !Number.isSafeInteger(value) || value < 0 || value > policy.actionRetries))
        throw new RepairBudgetError('INVALID_RETRY_LEDGER');
    const coveredRetries = [...retries.values()].reduce((sum, value) => sum + value, 0);
    if (coveredRetries > consumed.retries)
        throw new RepairBudgetError('INVALID_RETRY_LEDGER');
    const unknownRetryKeys = coveredRetries < consumed.retries;
    let active = 0, reservedTools = 0, lastClock = started;
    const check = () => {
        const currentClock = now(), elapsed = currentClock - started;
        if (currentClock < lastClock)
            throw new RepairBudgetError('CLOCK_REGRESSION');
        lastClock = currentClock;
        consumed.wall_ms = Math.max(consumed.wall_ms, previousWall + elapsed);
        if (consumed.wall_ms >= policy.wallMs || consumed.tool_calls > policy.toolCalls || consumed.writes > policy.writes || consumed.write_bytes > policy.writeBytes)
            throw new RepairBudgetError('BUDGET_EXHAUSTED');
    };
    const bounded = (key, delta, maximum) => {
        check();
        if (!Number.isSafeInteger(delta) || delta < 0 || consumed[key] + delta > maximum)
            throw new RepairBudgetError(key);
        consumed[key] += delta;
    };
    const retry = (key) => {
        check();
        const used = retries.get(key) ?? 0;
        if (unknownRetryKeys || used >= policy.actionRetries)
            throw new RepairBudgetError('ACTION_RETRIES');
        retries.set(key, used + 1);
        consumed.retries++;
    };
    return {
        policy,
        check,
        reserveTool: () => bounded('tool_calls', 1, policy.toolCalls - reservedTools),
        admitPlan: (calls) => {
            check();
            if (!Number.isSafeInteger(calls) || calls < 1 || consumed.tool_calls + calls + reservedTools > policy.toolCalls)
                throw new RepairBudgetError('PLAN_TOOL_BUDGET');
        },
        reserveValidation: () => {
            check();
            if (consumed.tool_calls + reservedTools + 1 > policy.toolCalls)
                throw new RepairBudgetError('VALIDATION_TOOL_BUDGET');
            reservedTools++;
            let released = false;
            return () => { if (!released) {
                released = true;
                reservedTools--;
            } };
        },
        reserveWrite: (bytes) => {
            check();
            if (!Number.isSafeInteger(bytes) || bytes < 0 || consumed.writes + 1 > policy.writes || consumed.write_bytes + bytes > policy.writeBytes)
                throw new RepairBudgetError('WRITES');
            consumed.writes++;
            consumed.write_bytes += bytes;
        },
        acquireProcess: () => {
            check();
            if (active >= policy.concurrentProcesses)
                throw new RepairBudgetError('PROCESS_CONCURRENCY');
            active++;
            let released = false;
            return () => { if (!released) {
                released = true;
                active--;
            } };
        },
        retry,
        beginAction: (key) => {
            check();
            if (unknownRetryKeys)
                throw new RepairBudgetError('ACTION_RETRIES');
            if (retries.has(key))
                retry(key);
            else
                retries.set(key, 0);
        },
        observeModel: (usage) => {
            const old = calls.get(usage.callId), entry = { ...old, callId: usage.callId, provider: usage.provider, model: usage.model };
            // 坏统计只留下未知字段，不能把计费遥测故障升级成任务中止。
            for (const [key, target] of [['tokensIn', 'tokens_in'], ['tokensOut', 'tokens_out'], ['costUsd', 'cost_usd']]) {
                const value = usage[key];
                if (!nonnegative(value))
                    continue;
                consumed[target] = Math.min(Number.MAX_VALUE, Math.max(0, consumed[target] - (old?.[key] ?? 0)) + value);
                Object.assign(entry, { [key]: value });
            }
            calls.set(usage.callId, entry);
        },
        modelCalls: () => structuredClone([...calls.values()]),
        retryCounts: () => Object.fromEntries(retries),
        snapshot: () => { consumed.wall_ms = Math.max(consumed.wall_ms, previousWall + Math.max(0, now() - started)); return { ...consumed }; }
    };
};
//# sourceMappingURL=budget.js.map