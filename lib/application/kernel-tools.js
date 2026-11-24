import { createHash } from 'node:crypto';
import { SwarmError } from '../util/errors.js';
const getDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** scope 只从 Host 当前身份生成；新 attempt 不自动接管旧变量或旧执行权。 */
export const createKernelToolUseCase = (deps) => async (raw, exec) => {
    exec.signal.throwIfAborted();
    if (typeof exec.callId !== 'string' || exec.callId.length === 0 || exec.callId.length > 512 || /[\0\r\n]/.test(exec.callId)) {
        throw new SwarmError('SERVICE_UNAVAILABLE', '独立内核缺少可信 Host callId，未提交代码');
    }
    const input = raw;
    if (input === null || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some(key => key !== 'language' && key !== 'code')
        || !['python', 'node'].includes(String(input.language)) || typeof input.code !== 'string'
        || input.code.length === 0 || Buffer.byteLength(input.code, 'utf8') > 256 * 1024) {
        throw new SwarmError('INVALID_ARGS', '内核参数仅接受 language: python/node 和 1-256KiB code');
    }
    const context = await deps.getContext(exec);
    if (exec.agent === undefined || context.agentId !== exec.agent.id || context.agentId === context.rootSessionId || !context.canCalculate) {
        throw new SwarmError('PERMISSION_DENIED', '仅当前绑定且具有计算权限的 Worker 可运行独立内核');
    }
    if (deps.execute === undefined)
        throw new SwarmError('SERVICE_UNAVAILABLE', '独立执行服务尚未接入，未执行代码');
    const authorize = async () => {
        const current = await deps.getContext(exec);
        exec.signal.throwIfAborted();
        if (getDigest(current) !== getDigest(context))
            throw new SwarmError('STALE_EVIDENCE', '内核执行前任务绑定已变化，未执行代码');
    };
    await authorize();
    const scope = { projectId: getDigest(context.cwd), ownerId: getDigest([context.rootSessionId, context.taskId, context.agentId, context.attemptId, context.contractVersion]) };
    const operationId = getDigest([scope, exec.callId]);
    const result = await deps.execute(scope, { ...input, operationId }, exec.signal, authorize);
    await authorize();
    return result;
};
//# sourceMappingURL=kernel-tools.js.map