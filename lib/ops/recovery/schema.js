/** 补阙内部合同：数据验证不构成 Host 授权，执行来源由闭包能力另外核验。 */
import { isAbsolute, relative, resolve } from 'node:path';
export const emptyBudget = () => ({ wall_ms: 0, tool_calls: 0, writes: 0, write_bytes: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, retries: 0 });
export const record = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('RECOVERY_SCHEMA: expected object');
    return raw;
};
export const text = (value, name, max = 4096) => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0'))
        throw new Error(`RECOVERY_SCHEMA: ${name}`);
    return value;
};
export const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const count = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`RECOVERY_SCHEMA: ${name}`);
    return value;
};
export const relativeFile = (root, raw) => {
    const file = text(raw, 'affectedFile'), resolved = resolve(root, file), result = relative(root, resolved);
    if (result === '' || result === '..' || result.startsWith('../') || isAbsolute(result))
        throw new Error('RECOVERY_SCHEMA: file outside project');
    return result.replaceAll('\\', '/');
};
export const validateFailureEvent = (raw) => {
    const r = record(raw), projectRoot = text(r.projectRoot, 'projectRoot');
    if (r.source !== 'host-failure' || !isAbsolute(projectRoot) || !Array.isArray(r.affectedFiles) || r.affectedFiles.length > 128)
        throw new Error('RECOVERY_SCHEMA: failure source/root/files');
    if (!['none', 'confirmed', 'unknown'].includes(String(r.sideEffectState)))
        throw new Error('RECOVERY_SCHEMA: sideEffectState');
    const revision = count(r.contractRevision, 'contractRevision');
    if (revision < 1)
        throw new Error('RECOVERY_SCHEMA: contractRevision');
    return { source: 'host-failure', failureKind: text(r.failureKind, 'failureKind', 256), exceptionType: text(r.exceptionType, 'exceptionType', 256),
        message: text(r.message, 'message', 16384), projectRoot: resolve(projectRoot), taskType: text(r.taskType, 'taskType', 256), toolName: text(r.toolName, 'toolName', 256),
        affectedFiles: r.affectedFiles.map(f => relativeFile(projectRoot, f)), rootSessionId: text(r.rootSessionId, 'rootSessionId', 256), taskId: text(r.taskId, 'taskId', 256),
        nodeId: text(r.nodeId, 'nodeId', 256), attemptId: text(r.attemptId, 'attemptId', 256), contractRevision: revision,
        sideEffectState: r.sideEffectState, repairDepth: count(r.repairDepth, 'repairDepth') };
};
export const validateBudget = (raw) => {
    const r = record(raw), result = emptyBudget();
    for (const key of Object.keys(result)) {
        if (!nonnegative(r[key]))
            throw new Error(`RECOVERY_SCHEMA: consumed.${key}`);
        result[key] = r[key];
    }
    return result;
};
export const validateAction = (raw) => {
    const r = record(raw);
    if (!['read', 'write', 'process', 'rollback'].includes(String(r.kind)) || !Array.isArray(r.paths) || r.paths.length > 128 || r.paths.some(p => typeof p !== 'string')
        || typeof r.idempotent !== 'boolean' || typeof r.reversibleConfirmed !== 'boolean')
        throw new Error('RECOVERY_SCHEMA: action');
    return { id: text(r.id, 'action.id', 256), tool: text(r.tool, 'action.tool', 256), kind: r.kind, arguments: structuredClone(record(r.arguments)),
        paths: r.paths, writeBytes: count(r.writeBytes, 'writeBytes'), idempotent: r.idempotent, reversibleConfirmed: r.reversibleConfirmed };
};
export const validateRepairPlan = (raw) => {
    const r = record(raw);
    if (!Array.isArray(r.actions) || r.actions.length > 60)
        throw new Error('RECOVERY_SCHEMA: actions');
    const verification = validateAction(r.verification);
    if (verification.kind !== 'read')
        throw new Error('RECOVERY_SCHEMA: verification must be read-only');
    const actions = r.actions.map(validateAction);
    if (new Set(actions.map(a => a.id)).size !== actions.length || actions.some(a => a.id === verification.id))
        throw new Error('RECOVERY_SCHEMA: duplicate action id');
    return { summary: text(r.summary, 'summary'), actions, verification };
};
export const validateReviewReport = (raw) => {
    const r = record(raw);
    if (typeof r.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.fingerprint) || !['succeeded', 'failed', 'manual_required'].includes(String(r.status))
        || !Array.isArray(r.actions) || !Array.isArray(r.modelCalls) || !Array.isArray(r.recommendations) || r.recommendations.some(v => typeof v !== 'string'))
        throw new Error('RECOVERY_SCHEMA: report');
    for (const row of r.actions) {
        const a = record(row);
        text(a.id, 'action.id');
        text(a.tool, 'action.tool');
        text(a.status, 'action.status');
    }
    for (const row of r.modelCalls) {
        const c = record(row);
        text(c.callId, 'callId');
        text(c.provider, 'provider');
        text(c.model, 'model');
        for (const key of ['tokensIn', 'tokensOut', 'costUsd'])
            if (c[key] !== undefined && !nonnegative(c[key]))
                throw new Error('RECOVERY_SCHEMA: usage');
    }
    const binding = r.binding === undefined ? undefined : record(r.binding);
    if (binding !== undefined) {
        for (const key of ['rootSessionId', 'taskId', 'nodeId', 'attemptId'])
            text(binding[key], `binding.${key}`, 256);
        if (count(binding.contractRevision, 'binding.contractRevision') < 1)
            throw new Error('RECOVERY_SCHEMA: binding revision');
    }
    return { fingerprint: r.fingerprint, ...(r.failureKind === undefined ? {} : { failureKind: text(r.failureKind, 'failureKind', 256) }), ...(binding === undefined ? {} : { binding: structuredClone(binding) }),
        status: r.status, occurrences: count(r.occurrences, 'occurrences'), attempts: count(r.attempts, 'attempts'),
        consumed: validateBudget(r.consumed), actions: structuredClone(r.actions), modelCalls: structuredClone(r.modelCalls),
        usageCoverage: { tokensComplete: r.modelCalls.every(value => { const row = record(value); return row.tokensIn !== undefined && row.tokensOut !== undefined; })
                && Number.isFinite(r.modelCalls.reduce((sum, value) => sum + Number(record(value).tokensIn ?? 0) + Number(record(value).tokensOut ?? 0), 0)),
            costComplete: r.modelCalls.every(value => record(value).costUsd !== undefined) && Number.isFinite(r.modelCalls.reduce((sum, value) => sum + Number(record(value).costUsd ?? 0), 0)) },
        reason: text(r.reason, 'reason'), recommendations: r.recommendations };
};
//# sourceMappingURL=schema.js.map