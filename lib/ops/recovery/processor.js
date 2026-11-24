import { getValueDigest } from '../../workflow.js';
import { createRepairBudget, RepairBudgetError } from './budget.js';
import { validateFailureEvent, validateRepairPlan, validateReviewReport } from './schema.js';
const bounded = (work, signal) => new Promise((accept, reject) => {
    const aborted = () => reject(signal.reason ?? new Error('repair aborted'));
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted)
        aborted();
    work.then(value => { signal.removeEventListener('abort', aborted); accept(value); }, error => { signal.removeEventListener('abort', aborted); reject(error); });
});
const safeReason = (error) => (error instanceof Error ? error.message : 'repair failed')
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer <redacted>').replace(/\b(token|password|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>').slice(0, 2048);
/** 执行器与订阅入口分离；所有 Host 能力由可信闭包提供，模型只能提出待验证动作。 */
export const createRepairProcessor = (options) => {
    const now = options.now ?? Date.now;
    const notifyReport = async (report) => {
        try {
            await options.onReport?.(structuredClone(report));
        }
        catch (error) {
            const message = `recovery report observer failed fingerprint=${report.fingerprint} error=${error instanceof Error ? error.name : 'unknown'}`;
            try {
                (options.log ?? console.warn)(message);
            }
            catch {
                console.warn(message);
            }
        }
    };
    const drain = async (event, signal = AbortSignal.timeout(30_000)) => {
        options.assertCurrent(event);
        const store = options.getStore(event);
        for (const pending of store.pendingHandoffs()) {
            options.assertCurrent(event);
            const receipt = await bounded(options.handoff(pending.report, pending.key), signal);
            if (receipt?.key !== pending.key || receipt.persisted !== true)
                throw new Error('RECOVERY_HANDOFF_RECEIPT_MISSING');
            store.acknowledgeHandoff(pending.fingerprint, pending.key, now());
        }
    };
    return {
        drainHandoffs: drain,
        process: async (input) => {
            const event = validateFailureEvent(input);
            if (event.repairDepth !== 0)
                throw new Error('NESTED_REPAIR');
            options.assertCurrent(event);
            const { getFailureFingerprint } = await import('./fingerprint.js');
            const info = getFailureFingerprint(event), store = options.getStore(event);
            store.expireStaleClaims(now());
            store.observe({ ...info, failureKind: event.failureKind }, now());
            const claim = store.claim(info.fingerprint, now());
            if (claim === undefined)
                return { status: 'deduped' };
            const previousReport = store.lastReport(info.fingerprint);
            const budget = createRepairBudget({ now, policy: options.budgetPolicy, initialModelCalls: previousReport?.modelCalls, initialRetryCounts: store.retryCounts(info.fingerprint), ...(claim.budget_consumed_json === null ? {} : { initial: JSON.parse(claim.budget_consumed_json) }) });
            const timeout = AbortSignal.timeout(Math.max(1, budget.policy.wallMs - budget.snapshot().wall_ms));
            const external = options.signal?.(event), signal = external === undefined ? timeout : AbortSignal.any([timeout, external]);
            const actions = structuredClone(previousReport?.actions ?? []);
            const current = () => { options.assertCurrent(event); store.assertClaim(info.fingerprint, claim.claim_token); signal.throwIfAborted(); };
            const checkpoint = () => { current(); store.checkpoint(info.fingerprint, claim.claim_token, budget.snapshot(), now(), budget.retryCounts()); };
            let releaseVerification = () => { };
            const report = (status, reason) => validateReviewReport({ fingerprint: info.fingerprint, status, failureKind: event.failureKind,
                binding: { rootSessionId: event.rootSessionId, taskId: event.taskId, nodeId: event.nodeId, attemptId: event.attemptId, contractRevision: event.contractRevision },
                occurrences: store.get(info.fingerprint).occurrence_count, attempts: claim.attempt_count, consumed: budget.snapshot(), actions, modelCalls: budget.modelCalls(), reason,
                recommendations: status === 'succeeded' ? ['原主 Agent 按原验收规则继续；此报告不验收原目标'] : ['人工核对原失败和已执行动作；未知副作用不得重放'] });
            try {
                current();
                checkpoint();
                if (event.sideEffectState === 'unknown' && !await bounded(options.reconcile(event, signal), signal))
                    throw new Error('manual_required: unknown side effects not reconciled');
                current();
                const route = options.getRoute();
                if (route === undefined)
                    throw new Error('manual_required: no repair model configured');
                const plan = validateRepairPlan(await bounded(options.plan(event, route, signal, usage => budget.observeModel(usage)), signal));
                current();
                checkpoint();
                budget.admitPlan(plan.actions.length + 1);
                releaseVerification = budget.reserveValidation();
                const runner = options.runner(event, budget, checkpoint, current);
                const execute = async (action) => {
                    const retryKey = getValueDigest([action.tool, action.kind, action.arguments]);
                    let invoked = false;
                    for (;;) {
                        current();
                        try {
                            budget.beginAction(retryKey);
                            checkpoint();
                        }
                        catch (error) {
                            if (!(error instanceof RepairBudgetError) || error.code !== 'ACTION_RETRIES')
                                throw error;
                            throw new Error(invoked ? 'REPAIR_ACTION_FAILED: retry budget exhausted' : 'manual_required: previous action retries exhausted');
                        }
                        const result = await bounded(runner.run(action, signal), signal);
                        invoked = true;
                        actions.push({ id: action.id, tool: action.tool, status: result.ok ? 'succeeded' : 'failed' });
                        if (result.sideEffectState === 'unknown')
                            throw new Error('manual_required: action side effects unknown');
                        if (result.ok)
                            return;
                        if (action.kind !== 'read' || !action.idempotent || result.sideEffectState !== 'none')
                            throw new Error('manual_required: failed action cannot be safely retried');
                    }
                };
                for (const action of plan.actions)
                    await execute(action);
                current();
                releaseVerification();
                const validation = await bounded(runner.run(plan.verification, signal), signal);
                actions.push({ id: plan.verification.id, tool: plan.verification.tool, status: validation.ok ? 'validated' : 'validation_failed' });
                if (validation.sideEffectState === 'unknown')
                    throw new Error('manual_required: verification side effects unknown');
                if (!validation.ok)
                    throw new Error('REPAIR_VALIDATION_FAILED');
                if (!options.validateResult(event, plan.verification, validation))
                    throw new Error('manual_required: original validation evidence unavailable');
                current();
                const result = report('succeeded', 'repair verified; original acceptance unchanged');
                store.succeed(info.fingerprint, claim.claim_token, budget.snapshot(), result.reason, now(), result);
                await notifyReport(result);
                try {
                    await drain(event, signal);
                    return { status: 'succeeded', report: result, delivery: 'delivered', repairTaskId: claim.last_repair_task_id };
                }
                catch {
                    return { status: 'succeeded', report: result, delivery: 'pending', repairTaskId: claim.last_repair_task_id };
                }
            }
            catch (error) {
                const reason = safeReason(error), retryable = reason.startsWith('REPAIR_ACTION_FAILED') || reason === 'REPAIR_VALIDATION_FAILED';
                const status = retryable && claim.attempt_count < 5 ? 'failed' : 'manual_required';
                const result = report(status, signal.aborted ? `manual_required: ${external?.aborted ? 'cancelled' : 'repair wall deadline'}` : reason);
                const row = store.get(info.fingerprint);
                if (row?.status === 'claimed' && row.claim_token === claim.claim_token) {
                    if (status === 'failed')
                        store.fail(info.fingerprint, claim.claim_token, budget.snapshot(), result.reason, now(), result);
                    else
                        store.manual(info.fingerprint, claim.claim_token, budget.snapshot(), result.reason, now(), result);
                }
                await notifyReport(result);
                return { status, report: result, repairTaskId: claim.last_repair_task_id };
            }
            finally {
                releaseVerification();
            }
        }
    };
};
//# sourceMappingURL=processor.js.map