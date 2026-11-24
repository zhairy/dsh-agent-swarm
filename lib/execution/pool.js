import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { intMutex } from '../util/mutex.js';
import { EXECUTION_LANGUAGES, ExecutionError } from './runtime.js';
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CODE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_OPERATION_RECORDS = 10_000;
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const getIdentifier = (value, field) => {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_IDENTIFIER_LENGTH || /[\0\r\n]/.test(value)) {
        throw new ExecutionError('INVALID_REQUEST', `${field} 必须是 1-${MAX_IDENTIFIER_LENGTH} 个字符的稳定标识`);
    }
    return value;
};
const getScope = (value) => {
    if (!isRecord(value))
        throw new ExecutionError('INVALID_REQUEST', 'scope 必须是对象');
    return {
        projectId: getIdentifier(value.projectId, 'scope.projectId'),
        ownerId: getIdentifier(value.ownerId, 'scope.ownerId')
    };
};
const getLanguage = (value) => {
    if (!EXECUTION_LANGUAGES.includes(value)) {
        throw new ExecutionError('INVALID_REQUEST', `language 只支持 ${EXECUTION_LANGUAGES.join('/')}`);
    }
    return value;
};
const getPositiveInteger = (value, field) => {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new ExecutionError('INVALID_REQUEST', `${field} 必须是正整数`);
    }
    return value;
};
const getLeaseMilliseconds = (value, fallback, maximum) => {
    if (value === undefined)
        return fallback;
    const milliseconds = getPositiveInteger(value, 'leaseMs');
    if (milliseconds > maximum)
        throw new ExecutionError('LIMIT_EXCEEDED', `leaseMs 不能超过 ${maximum}`);
    return milliseconds;
};
const getScopeKey = (scope) => `${scope.projectId}\0${scope.ownerId}`;
const getContainerName = (scope, kernelId) => {
    const scopeHash = createHash('sha256').update(getScopeKey(scope)).digest('hex').slice(0, 16);
    return `swarm-exec-${scopeHash}-${kernelId.replaceAll('-', '').slice(0, 16)}`;
};
const getHandle = (record) => ({
    containerName: record.containerName,
    language: record.language,
    ownerPid: process.pid
});
const toLease = (record) => {
    if (record.state !== 'claimed' || record.leaseId === undefined || record.leaseExpiresAt === undefined) {
        throw new ExecutionError('KERNEL_BROKEN', `kernel ${record.kernelId} 没有有效租约`);
    }
    return {
        kernelId: record.kernelId,
        containerName: record.containerName,
        language: record.language,
        leaseId: record.leaseId,
        fence: record.fence,
        leaseExpiresAt: record.leaseExpiresAt,
        isDirty: record.isDirty
    };
};
const toSummary = (record) => ({
    kernelId: record.kernelId,
    containerName: record.containerName,
    language: record.language,
    leaseId: record.leaseId ?? '',
    fence: record.fence,
    leaseExpiresAt: record.leaseExpiresAt ?? 0,
    isDirty: record.isDirty,
    projectId: record.projectId,
    ownerId: record.ownerId,
    state: record.state
});
const validatePersistedState = (value) => {
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.kernels) || !Array.isArray(value.operations) || !Array.isArray(value.blockedProjects)) {
        throw new ExecutionError('PROTOCOL_ERROR', '执行池仅接受 v2 状态文件；v1 无操作账本，禁止隐式迁移');
    }
    const kernels = value.kernels.map((entry, index) => {
        if (!isRecord(entry))
            throw new ExecutionError('PROTOCOL_ERROR', `执行池状态 kernels[${index}] 无效`);
        const language = getLanguage(entry.language);
        const state = entry.state;
        if (state !== 'warm' && state !== 'claimed' && state !== 'broken') {
            throw new ExecutionError('PROTOCOL_ERROR', `执行池状态 kernels[${index}].state 无效`);
        }
        return {
            kernelId: getIdentifier(entry.kernelId, `kernels[${index}].kernelId`),
            containerName: getIdentifier(entry.containerName, `kernels[${index}].containerName`),
            language,
            projectId: getIdentifier(entry.projectId, `kernels[${index}].projectId`),
            ownerId: getIdentifier(entry.ownerId, `kernels[${index}].ownerId`),
            isDirty: entry.isDirty === true,
            state,
            stopped: entry.stopped === true,
            fence: entry.fence === 0 ? 0 : getPositiveInteger(entry.fence, `kernels[${index}].fence`),
            ...(typeof entry.leaseId === 'string' ? { leaseId: getIdentifier(entry.leaseId, `kernels[${index}].leaseId`) } : {}),
            ...(typeof entry.leaseExpiresAt === 'number' ? { leaseExpiresAt: entry.leaseExpiresAt } : {}),
            createdAt: getPositiveInteger(entry.createdAt, `kernels[${index}].createdAt`),
            lastUsedAt: getPositiveInteger(entry.lastUsedAt, `kernels[${index}].lastUsedAt`)
        };
    });
    if (value.operations.length > MAX_OPERATION_RECORDS)
        throw new ExecutionError('PROTOCOL_ERROR', '操作账本超过上限');
    const operations = value.operations.map((entry) => {
        if (!isRecord(entry) || !['running', 'succeeded', 'failed', 'unknown', 'cancelled'].includes(String(entry.status))) {
            throw new ExecutionError('PROTOCOL_ERROR', '操作账本格式无效');
        }
        if (entry.result !== undefined && Buffer.byteLength(JSON.stringify(entry.result)) > MAX_RESULT_BYTES) {
            throw new ExecutionError('PROTOCOL_ERROR', '操作结果超过持久化上限');
        }
        if (entry.requestDigest !== undefined && (typeof entry.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.requestDigest))) {
            throw new ExecutionError('PROTOCOL_ERROR', '操作请求摘要无效');
        }
        return {
            ...entry,
            ...getScope(entry),
            operationId: getIdentifier(entry.operationId, 'operationId'),
            kernelId: getIdentifier(entry.kernelId, 'kernelId')
        };
    });
    const operationKeys = operations.map(operation => JSON.stringify([operation.projectId, operation.ownerId, operation.operationId]));
    if (new Set(operationKeys).size !== operationKeys.length || new Set(kernels.map(kernel => kernel.kernelId)).size !== kernels.length) {
        throw new ExecutionError('PROTOCOL_ERROR', '执行池包含重复身份');
    }
    if (operations.some(operation => !kernels.some(kernel => kernel.kernelId === operation.kernelId && kernel.projectId === operation.projectId && kernel.ownerId === operation.ownerId))) {
        throw new ExecutionError('PROTOCOL_ERROR', '操作账本的 kernel/scope 对应关系无效');
    }
    return { version: 2, kernels, operations, blockedProjects: value.blockedProjects.map(project => getIdentifier(project, 'blockedProjects')) };
};
const writeStateAtomically = async (statePath, state) => {
    const directory = dirname(statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'w', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporaryPath, statePath);
    const directoryHandle = await open(directory, 'r');
    try {
        await directoryHandle.sync();
    }
    finally {
        await directoryHandle.close();
    }
};
const loadState = async (statePath) => {
    try {
        const raw = await readFile(statePath, 'utf8');
        return validatePersistedState(JSON.parse(raw));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return { version: 2, kernels: [], operations: [], blockedProjects: [] };
        if (error instanceof SyntaxError)
            throw new ExecutionError('PROTOCOL_ERROR', '执行池状态文件不是有效 JSON');
        throw error;
    }
};
export const createExecutionPool = async (options) => {
    if (!Number.isSafeInteger(options.totalCapacity) || options.totalCapacity < 1) {
        throw new ExecutionError('INVALID_REQUEST', 'totalCapacity 必须是正整数');
    }
    if (!Number.isSafeInteger(options.perScopeCapacity) || options.perScopeCapacity < 1) {
        throw new ExecutionError('INVALID_REQUEST', 'perScopeCapacity 必须是正整数');
    }
    if (options.defaultLeaseMs < 1 || options.maxLeaseMs < options.defaultLeaseMs) {
        throw new ExecutionError('INVALID_REQUEST', '租约时间配置无效');
    }
    const defaultWallClockMs = options.defaultWallClockMs ?? 5_000;
    const maxWallClockMs = options.maxWallClockMs ?? 30_000;
    if (defaultWallClockMs < 1 || maxWallClockMs < defaultWallClockMs) {
        throw new ExecutionError('INVALID_REQUEST', '执行墙钟配置无效');
    }
    const limits = {
        cpuCount: options.limits?.cpuCount ?? 0.5,
        memoryBytes: options.limits?.memoryBytes ?? 256 * 1024 * 1024,
        pidsLimit: options.limits?.pidsLimit ?? 64,
        maxCodeBytes: options.limits?.maxCodeBytes ?? MAX_CODE_BYTES,
        maxOutputBytes: options.limits?.maxOutputBytes ?? MAX_OUTPUT_BYTES
    };
    if (limits.cpuCount <= 0 || limits.memoryBytes < 32 * 1024 * 1024 || limits.pidsLimit < 16) {
        throw new ExecutionError('INVALID_REQUEST', 'CPU、内存或 PID 限制过小');
    }
    const state = await loadState(options.statePath);
    const mutex = intMutex();
    const stopping = new Map();
    const interrupted = new Map();
    const save = async () => writeStateAtomically(options.statePath, state);
    const saveBeforeStop = async (record) => {
        try {
            await save();
        }
        catch (error) {
            // 状态盘故障不能阻止物理隔离；后续停止核验和回执落盘仍会把失败返回调用方。
            console.error('[swarm-execution] quarantine persist failed', record.projectId, record.kernelId, error.code ?? 'unknown');
        }
    };
    const getOperation = (scope, operationId) => state.operations.find(operation => operation.projectId === scope.projectId && operation.ownerId === scope.ownerId && operation.operationId === operationId);
    const getScopedRecord = (scope, kernelId) => {
        const record = state.kernels.find(candidate => candidate.kernelId === kernelId);
        if (record === undefined)
            throw new ExecutionError('KERNEL_NOT_FOUND', `kernel ${kernelId} 不存在`);
        if (record.projectId !== scope.projectId || record.ownerId !== scope.ownerId) {
            throw new ExecutionError('SCOPE_MISMATCH', 'kernel 不属于请求的 project/owner');
        }
        return record;
    };
    const assertProjectAvailable = (scope) => {
        if (state.blockedProjects.includes(scope.projectId)) {
            throw new ExecutionError('OUTCOME_UNKNOWN', 'project 存在未确认停止的 kernel，禁止新执行或分配');
        }
    };
    const assertIdle = (record) => {
        const operations = state.operations.filter(operation => operation.kernelId === record.kernelId);
        if (operations.some(operation => operation.status === 'unknown'))
            throw new ExecutionError('OUTCOME_UNKNOWN', 'kernel 存在结果未知的操作');
        if (operations.some(operation => operation.status === 'running'))
            throw new ExecutionError('EXECUTION_IN_PROGRESS', 'kernel 正在执行操作');
        if (record.state === 'broken')
            throw new ExecutionError('KERNEL_BROKEN', `kernel ${record.kernelId} 已隔离`);
    };
    const validateLease = (record, leaseId, fence, now) => {
        if (record.state === 'broken')
            throw new ExecutionError('KERNEL_BROKEN', `kernel ${record.kernelId} 已隔离`);
        if (record.state !== 'claimed' || record.leaseExpiresAt === undefined || record.leaseExpiresAt <= now) {
            throw new ExecutionError('LEASE_EXPIRED', `kernel ${record.kernelId} 租约已过期`);
        }
        if (record.leaseId !== leaseId || record.fence !== fence)
            throw new ExecutionError('FENCING_REJECTED', 'leaseId 或 fence 已失效');
    };
    const markClaimed = (record, now, leaseMs) => {
        record.state = 'claimed';
        record.fence += 1;
        record.leaseId = randomUUID();
        record.leaseExpiresAt = now + leaseMs;
        record.lastUsedAt = now;
    };
    const quarantine = (record) => {
        record.state = 'broken';
        delete record.leaseId;
        delete record.leaseExpiresAt;
        if (record.stopped !== true && !state.blockedProjects.includes(record.projectId))
            state.blockedProjects.push(record.projectId);
    };
    const confirmStopped = async (record) => {
        let removalError = '';
        try {
            await options.runtime.remove(getHandle(record));
        }
        catch (error) {
            // 删除命令失败不等于容器还在运行，仍以独立 inspect 的停止证据为准。
            removalError = error instanceof Error ? error.message.slice(0, 512) : 'runtime.remove 失败';
        }
        try {
            const status = await options.runtime.inspect(getHandle(record));
            if (status === 'stopped' || status === 'missing')
                return;
        }
        catch (error) {
            throw new ExecutionError('OUTCOME_UNKNOWN', `停止核验失败: ${error instanceof Error ? error.message.slice(0, 512) : 'inspect 失败'}${removalError ? `；${removalError}` : ''}`);
        }
        throw new ExecutionError('OUTCOME_UNKNOWN', `kernel 仍在运行${removalError ? `；${removalError}` : ''}`);
    };
    const markStopped = (record) => {
        record.stopped = true;
        for (const operation of state.operations.filter(candidate => candidate.kernelId === record.kernelId))
            operation.stopped = true;
        if (!state.kernels.some(candidate => candidate.projectId === record.projectId && candidate.state === 'broken' && candidate.stopped !== true)) {
            state.blockedProjects = state.blockedProjects.filter(project => project !== record.projectId);
        }
    };
    const stopKernel = (record) => {
        const existing = stopping.get(record.kernelId);
        if (existing)
            return existing;
        // 迟到 cancel 可发生在错误清理的 promise 已移除之后；已核验停止就不能再删除一次。
        if (record.stopped === true)
            return Promise.resolve();
        // 不把 runtime 的等待放进 execute 的全局锁，cancel 才能先落 tombstone 并打断等待。
        const task = (async () => {
            await confirmStopped(record);
            await mutex.run(async () => {
                markStopped(record);
                try {
                    await save();
                }
                catch {
                    throw new ExecutionError('OUTCOME_UNKNOWN', '容器已停止，但停止回执落盘失败');
                }
            });
        })();
        stopping.set(record.kernelId, task);
        void task.finally(() => stopping.delete(record.kernelId)).catch(() => undefined);
        return task;
    };
    const reserveOperation = () => {
        // 去重墓碑不能按 LRU 删除，否则旧请求能再次执行；账本满时选择拒绝新操作。
        if (state.operations.length >= MAX_OPERATION_RECORDS)
            throw new ExecutionError('CAPACITY_EXCEEDED', '操作账本已满，禁止丢弃去重记录后继续执行');
    };
    const replayOperation = (operation) => {
        if (operation.status === 'running')
            throw new ExecutionError('EXECUTION_IN_PROGRESS', 'operation 正在执行，禁止重跑');
        if (operation.status === 'unknown')
            throw new ExecutionError('OUTCOME_UNKNOWN', 'operation 结果未知，禁止重跑');
        if (operation.status === 'cancelled')
            throw new ExecutionError('CANCELLED', 'operation 已取消，禁止重跑');
        if (!operation.result)
            throw new ExecutionError('OUTCOME_UNKNOWN', 'operation 没有可回读的终态结果');
        return structuredClone(operation.result);
    };
    const cacheResult = (operation, result) => {
        const serialized = JSON.stringify(result);
        operation.resultDigest = createHash('sha256').update(serialized).digest('hex');
        if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES) {
            operation.result = JSON.parse(serialized);
        }
        else {
            operation.resultTruncated = true;
            // JSON 控制字符最多膨胀为六字节，预览按最坏转义量预留空间；原始摘要和截断标记仍保留。
            operation.result = {
                ok: result.ok,
                stdout: Buffer.from(result.stdout).subarray(0, 4 * 1024).toString('utf8'),
                stderr: Buffer.from(result.stderr).subarray(0, 4 * 1024).toString('utf8'),
                durationMs: result.durationMs,
                ...(result.error ? { error: { type: result.error.type.slice(0, 128), message: result.error.message.slice(0, 1024) } } : {}),
                resultTruncated: true
            };
        }
        return structuredClone(operation.result);
    };
    const createKernel = async (scope, language, now) => {
        const kernelId = randomUUID();
        const record = {
            kernelId, containerName: getContainerName(scope, kernelId), language,
            projectId: scope.projectId, ownerId: scope.ownerId,
            isDirty: false, state: 'broken', fence: 0, createdAt: now, lastUsedAt: now
        };
        // 启动前登记确定性的容器名，崩溃于 docker run 和完成落盘之间也能找到并停止容器。
        state.kernels.push(record);
        quarantine(record);
        await save();
        try {
            const handle = await options.runtime.start({ scope, language, kernelId, limits });
            record.containerName = handle.containerName;
            markStopped(record);
            record.stopped = false;
            record.state = 'warm';
            await save();
            return record;
        }
        catch (error) {
            quarantine(record);
            await saveBeforeStop(record);
            await confirmStopped(record);
            markStopped(record);
            await save();
            throw error;
        }
    };
    const ensureCapacity = async (scope, additional) => {
        if (additional > options.totalCapacity || additional > options.perScopeCapacity)
            throw new ExecutionError('CAPACITY_EXCEEDED', '申请数量超过执行池容量');
        while (true) {
            const live = state.kernels.filter(record => record.stopped !== true);
            const scopedCount = live.filter(record => record.projectId === scope.projectId && record.ownerId === scope.ownerId).length;
            const scopeFull = scopedCount + additional > options.perScopeCapacity;
            if (!scopeFull && live.length + additional <= options.totalCapacity)
                return;
            const victim = live.filter(record => record.state === 'warm' &&
                (!scopeFull || (record.projectId === scope.projectId && record.ownerId === scope.ownerId)) &&
                !state.operations.some(operation => operation.kernelId === record.kernelId && (operation.status === 'running' || operation.status === 'unknown'))).sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
            if (!victim)
                throw new ExecutionError('CAPACITY_EXCEEDED', '容量已满，没有可安全逐出的 warm kernel');
            quarantine(victim);
            await saveBeforeStop(victim);
            await confirmStopped(victim);
            markStopped(victim);
            await save();
        }
    };
    // 只恢复经 runtime 核验的活 kernel。旧 running 账本不能证明完成，先隔离并停止，绝不重放。
    for (const record of state.kernels) {
        for (const operation of state.operations.filter(candidate => candidate.kernelId === record.kernelId && candidate.status === 'running')) {
            operation.status = 'unknown';
            operation.error = { code: 'OUTCOME_UNKNOWN', message: 'daemon 中断时操作尚未记录终态' };
        }
        if (record.stopped === true)
            continue;
        let runtimeState = 'unknown';
        try {
            runtimeState = await options.runtime.inspect(getHandle(record));
        }
        catch {
            quarantine(record);
        }
        const uncertain = state.operations.some(operation => operation.kernelId === record.kernelId && (operation.status === 'unknown' || operation.status === 'cancelled'));
        if (runtimeState === 'running' && record.state !== 'broken' && !uncertain)
            continue;
        quarantine(record);
        await saveBeforeStop(record);
        if (runtimeState === 'stopped' || runtimeState === 'missing')
            markStopped(record);
        else {
            try {
                await confirmStopped(record);
                markStopped(record);
            }
            catch (error) {
                // 保持持久 project block，同时报告停止失败，不能把启动成功理解为该项目可执行。
                console.error('[swarm-execution] startup quarantine', record.projectId, record.kernelId, error instanceof Error ? error.message : 'unknown stop error');
            }
        }
    }
    await save();
    return {
        claim: input => mutex.run(async () => {
            const scope = getScope(input.scope);
            const language = getLanguage(input.language);
            const leaseMs = getLeaseMilliseconds(input.leaseMs, options.defaultLeaseMs, options.maxLeaseMs);
            assertProjectAvailable(scope);
            const now = options.clock();
            let record = state.kernels.find(candidate => candidate.projectId === scope.projectId && candidate.ownerId === scope.ownerId && candidate.language === language && candidate.state === 'warm');
            if (record === undefined) {
                await ensureCapacity(scope, 1);
                record = await createKernel(scope, language, now);
            }
            assertIdle(record);
            markClaimed(record, now, leaseMs);
            await save();
            return toLease(record);
        }),
        warm: input => mutex.run(async () => {
            const scope = getScope(input.scope);
            const language = getLanguage(input.language);
            const count = getPositiveInteger(input.count, 'count');
            if (count > options.perScopeCapacity)
                throw new ExecutionError('LIMIT_EXCEEDED', '预热数量超过单 scope 容量');
            assertProjectAvailable(scope);
            await ensureCapacity(scope, count);
            const created = [];
            for (let index = 0; index < count; index += 1)
                created.push(await createKernel(scope, language, options.clock()));
            await save();
            return created.map(toSummary);
        }),
        execute: async (input) => {
            const scope = getScope(input.scope);
            const operationId = getIdentifier(input.operationId, 'operationId');
            const language = getLanguage(input.language);
            if (typeof input.code !== 'string' || Buffer.byteLength(input.code, 'utf8') > limits.maxCodeBytes) {
                throw new ExecutionError('LIMIT_EXCEEDED', `code 不能超过 ${limits.maxCodeBytes} 字节`);
            }
            const timeoutMs = input.timeoutMs === undefined ? defaultWallClockMs : getPositiveInteger(input.timeoutMs, 'timeoutMs');
            if (timeoutMs > maxWallClockMs)
                throw new ExecutionError('LIMIT_EXCEEDED', `timeoutMs 不能超过 ${maxWallClockMs}`);
            const requestDigest = createHash('sha256').update(JSON.stringify([input.kernelId, language, input.code, timeoutMs])).digest('hex');
            const prepared = await mutex.run(async () => {
                const previous = getOperation(scope, operationId);
                if (previous) {
                    if (previous.kernelId !== input.kernelId || (previous.requestDigest && previous.requestDigest !== requestDigest)) {
                        throw new ExecutionError('INVALID_REQUEST', 'operationId 已绑定不同请求');
                    }
                    return { cached: replayOperation(previous) };
                }
                const record = getScopedRecord(scope, input.kernelId);
                assertProjectAvailable(scope);
                assertIdle(record);
                if (record.language !== language)
                    throw new ExecutionError('INVALID_REQUEST', 'language 与 kernel 不匹配');
                validateLease(record, input.leaseId, input.fence, options.clock());
                reserveOperation();
                const operation = { ...scope, operationId, kernelId: record.kernelId, requestDigest, status: 'running', startedAt: options.clock() };
                state.operations.push(operation);
                record.isDirty = true;
                record.lastUsedAt = options.clock();
                await save();
                let cancel;
                const cancelled = new Promise(resolve => { cancel = () => resolve({ error: new ExecutionError('CANCELLED', 'operation 已取消') }); });
                interrupted.set(record.kernelId, cancel);
                // 在落盘后的同一临界区启动，但不等待执行，保证 tombstone 和启动有确定的先后顺序。
                const task = Promise.resolve().then(() => options.runtime.execute(getHandle(record), { code: input.code, timeoutMs, maxOutputBytes: limits.maxOutputBytes }))
                    .then(result => ({ result }), (error) => ({ error }));
                return { record, operation, task: Promise.race([task, cancelled]) };
            });
            if ('cached' in prepared)
                return prepared.cached;
            const { record, operation } = prepared;
            const outcome = await prepared.task;
            let failure;
            try {
                const finished = await mutex.run(async () => {
                    interrupted.delete(record.kernelId);
                    if (operation.status === 'cancelled')
                        return { error: new ExecutionError('CANCELLED', 'operation 已取消') };
                    if ('error' in outcome)
                        return { error: outcome.error };
                    if (outcome.result.timedOut === true)
                        return { error: new ExecutionError('EXECUTION_TIMEOUT', 'kernel cell 超过墙钟限制') };
                    const result = cacheResult(operation, outcome.result);
                    operation.status = result.ok ? 'succeeded' : 'failed';
                    if (!result.ok)
                        operation.error = { code: 'INTERNAL_ERROR', message: `${result.error?.type ?? 'CellError'}: ${result.error?.message ?? 'cell 失败'}`.slice(0, 1024) };
                    operation.completedAt = options.clock();
                    record.lastUsedAt = options.clock();
                    await save();
                    return { result };
                });
                if ('result' in finished)
                    return finished.result;
                failure = finished.error;
            }
            catch (error) {
                failure = error;
            }
            await mutex.run(async () => {
                if (operation.status !== 'cancelled')
                    operation.status = 'unknown';
                operation.error = { code: failure instanceof ExecutionError ? failure.code : 'OUTCOME_UNKNOWN', message: failure instanceof ExecutionError ? failure.message.slice(0, 1024) : '执行通道结果未知' };
                quarantine(record);
                await saveBeforeStop(record);
            });
            await stopKernel(record);
            if (failure instanceof ExecutionError)
                throw failure;
            throw new ExecutionError('OUTCOME_UNKNOWN', '执行通道结果未知，kernel 已停止且操作不会重跑');
        },
        operationStatus: input => mutex.run(async () => {
            const scope = getScope(input.scope);
            const operationId = getIdentifier(input.operationId, 'operationId');
            const operation = getOperation(scope, operationId);
            if (!operation)
                return { operationId, state: 'unknown', found: false };
            const { projectId: _projectId, ownerId: _ownerId, requestDigest: _requestDigest, status, ...detail } = operation;
            const resultExpired = (status === 'succeeded' || status === 'failed') && operation.result === undefined;
            return structuredClone({ ...detail, state: resultExpired ? 'unknown' : status, found: true, ...(resultExpired ? { resultExpired: true } : {}) });
        }),
        cancel: async (input) => {
            const scope = getScope(input.scope);
            const operationId = getIdentifier(input.operationId, 'operationId');
            const record = await mutex.run(async () => {
                const kernel = getScopedRecord(scope, input.kernelId);
                let operation = getOperation(scope, operationId);
                if (operation && operation.kernelId !== kernel.kernelId)
                    throw new ExecutionError('INVALID_REQUEST', 'operationId 属于另一个 kernel');
                if (state.operations.some(candidate => candidate.kernelId === kernel.kernelId && candidate.operationId !== operationId && candidate.status === 'running')) {
                    throw new ExecutionError('EXECUTION_IN_PROGRESS', '不能以旧 operation 取消另一个运行中的操作');
                }
                if (!operation) {
                    reserveOperation();
                    operation = { ...scope, kernelId: kernel.kernelId, operationId, status: 'cancelled', completedAt: options.clock() };
                    state.operations.push(operation);
                }
                else if (operation.status === 'running') {
                    operation.status = 'cancelled';
                    operation.completedAt = options.clock();
                }
                quarantine(kernel);
                await saveBeforeStop(kernel);
                interrupted.get(kernel.kernelId)?.();
                return kernel;
            });
            await stopKernel(record);
            return { stopped: true };
        },
        release: input => mutex.run(async () => {
            const scope = getScope(input.scope);
            const record = getScopedRecord(scope, input.kernelId);
            assertProjectAvailable(scope);
            assertIdle(record);
            validateLease(record, input.leaseId, input.fence, options.clock());
            const released = toLease(record);
            record.state = 'warm';
            record.lastUsedAt = options.clock();
            delete record.leaseId;
            delete record.leaseExpiresAt;
            await save();
            return released;
        }),
        reconnect: input => mutex.run(async () => {
            const scope = getScope(input.scope);
            const leaseMs = getLeaseMilliseconds(input.leaseMs, options.defaultLeaseMs, options.maxLeaseMs);
            const record = getScopedRecord(scope, input.kernelId);
            assertProjectAvailable(scope);
            assertIdle(record);
            markClaimed(record, options.clock(), leaseMs);
            await save();
            return toLease(record);
        }),
        list: scopeValue => mutex.run(async () => {
            const scope = getScope(scopeValue);
            return state.kernels.filter(record => record.projectId === scope.projectId && record.ownerId === scope.ownerId).map(toSummary);
        }),
        shutdown: async (shutdownOptions) => {
            if (shutdownOptions?.removeKernels !== true)
                return;
            const records = await mutex.run(async () => {
                const live = state.kernels.filter(record => record.stopped !== true);
                for (const record of live)
                    quarantine(record);
                for (const operation of state.operations.filter(operation => operation.status === 'running'))
                    operation.status = 'cancelled';
                if (live[0])
                    await saveBeforeStop(live[0]);
                for (const record of live)
                    interrupted.get(record.kernelId)?.();
                return live;
            });
            for (const record of records)
                await stopKernel(record);
        }
    };
};
//# sourceMappingURL=pool.js.map