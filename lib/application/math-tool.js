import { randomUUID } from 'node:crypto';
import { calculate } from '../math/operators.js';
import { getCalculateOptions, getMathAvailability } from '../math/config.js';
import { getTaskContextBinding, isTaskVersionCurrent } from '../task-model.js';
import { SwarmError } from '../util/errors.js';
/**
 * Pure math execution use case. It reserves the hard work ceiling before the
 * synchronous kernel and only publishes context after settlement succeeds.
 */
export const createMathToolUseCase = (deps) => {
    const Calculate = async (raw, exec) => {
        if (exec.signal.aborted)
            throw new SwarmError('RECOVERY_REQUIRED', '计算已取消，未预占预算或发布证据');
        if (!deps.getConfig().math.enabled)
            throw new SwarmError('SERVICE_UNAVAILABLE', '数学算子已关闭');
        const resolved = await deps.getToolTask(raw, exec);
        return resolved.session.taskLock.run(async () => {
            if (exec.signal.aborted)
                throw new SwarmError('RECOVERY_REQUIRED', '等待期间计算已取消，未预占预算或发布证据');
            const context = { ...resolved, task: deps.refreshTask(resolved, resolved.task.taskId) };
            const { session, features, task, binding } = context;
            if (binding !== undefined) {
                features.bindings.requireActive(binding.agentId, 'pure-calc');
                if (!isTaskVersionCurrent(task, binding))
                    throw new SwarmError('STALE_EVIDENCE', '计算绑定的是旧任务版本');
            }
            const math = deps.getConfig().math;
            if (!math.enabled)
                throw new SwarmError('SERVICE_UNAVAILABLE', '数学算子已关闭');
            const { task_id: _task, ...request } = (raw ?? {});
            const denied = getMathAvailability(request, math);
            if (denied !== undefined)
                return { ...denied, task_id: task.taskId };
            const budget = features.budgetFor(task);
            const remaining = budget.remainingMathWork();
            if (remaining !== undefined && remaining <= 0)
                throw new SwarmError('BUDGET_EXHAUSTED', '本任务数学计算工作量已用尽');
            const options = getCalculateOptions(math, remaining);
            const id = exec.callId ?? `calc-${randomUUID()}`;
            if (budget.getReservation(id) !== undefined)
                throw new SwarmError('INVALID_ARGS', '计算请求ID已使用，读取原有计算证据后再决定');
            budget.reserve({ id, source: 'math', estimatedWorkUnits: options.limits.maxWorkUnits });
            budget.start(id);
            const result = calculate(request, options);
            budget.settle(id, { workUnits: result.workUnits });
            const artifact = features.addContext({
                binding: getTaskContextBinding(task, features.workspaceId),
                layer: 'L2', kind: 'evidence',
                text: JSON.stringify(result.ok ? { input: request, result } : { input: { op: request.op, mode: request.mode }, inputOmitted: 'Rejected input is not persisted; no replay digest is claimed', result })
            });
            session.store.UpdateTask(task.taskId, { contextRefs: [...(task.contextRefs ?? []), { ref: artifact.ref, digest: artifact.digest, layer: artifact.layer, kind: artifact.kind }] });
            session.ledger.AddLedgerEvent({ type: 'math/computed', taskId: task.taskId, data: { evidenceKind: 'computed', ref: artifact.ref, ok: result.ok, workUnits: result.workUnits } });
            await features.persist('math/computed', session.store, session.threads);
            return { ...result, artifactRef: artifact.ref, task_id: task.taskId };
        });
    };
    return { Calculate };
};
//# sourceMappingURL=math-tool.js.map