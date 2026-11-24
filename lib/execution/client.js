import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { ExecutionError } from './runtime.js';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 65_000;
export class ExecutionUncertainError extends ExecutionError {
    operationId;
    kernelId;
    sideEffectState;
    stopState;
    cause;
    constructor(options) {
        super('PROTOCOL_ERROR', options.stopState === 'stopped'
            ? `operation ${options.operationId} result is unknown; kernel stop was confirmed`
            : `operation ${options.operationId} result and stop state are unknown; project execution is blocked`);
        this.name = 'ExecutionUncertainError';
        this.operationId = options.operationId;
        this.kernelId = options.kernelId;
        this.sideEffectState = 'unknown';
        this.stopState = options.stopState;
        if ('cause' in options)
            this.cause = options.cause;
    }
}
export class ExecutionScopeBlockedError extends ExecutionError {
    projectId;
    operationId;
    blockedOperationId;
    sideEffectState = 'unknown';
    constructor(options) {
        super('FENCING_REJECTED', `project execution is blocked until operation ${options.blockedOperationId} is confirmed stopped`);
        this.name = 'ExecutionScopeBlockedError';
        this.projectId = options.projectId;
        this.operationId = options.operationId;
        this.blockedOperationId = options.blockedOperationId;
    }
}
class ExecutionDaemonWireError extends ExecutionError {
}
const blockedProjects = new Map();
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const normalizeScope = (scope) => {
    if (!isRecord(scope))
        throw new ExecutionError('INVALID_REQUEST', 'scope 必须是对象');
    const projectId = scope.projectId;
    const ownerId = scope.ownerId;
    if (typeof projectId !== 'string' || !projectId || projectId.length > 128 || /[\0\r\n]/.test(projectId)) {
        throw new ExecutionError('INVALID_REQUEST', 'scope.projectId 无效');
    }
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 || /[\0\r\n]/.test(ownerId)) {
        throw new ExecutionError('INVALID_REQUEST', 'scope.ownerId 无效');
    }
    return Object.freeze({ projectId, ownerId });
};
const normalizeOperationId = (operationId) => {
    if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 128 || /[\0\r\n]/.test(operationId)) {
        throw new ExecutionError('INVALID_REQUEST', 'operationId 必须是 1-128 个字符的稳定标识');
    }
    return operationId;
};
const normalizeCancelResult = (value, operationId, kernelId) => {
    if (!isRecord(value) || typeof value.stopped !== 'boolean') {
        throw new ExecutionError('PROTOCOL_ERROR', 'execution daemon cancel 返回缺少 stopped');
    }
    return {
        stopped: value.stopped,
        operationId: typeof value.operationId === 'string' ? value.operationId : operationId,
        kernelId: typeof value.kernelId === 'string' ? value.kernelId : kernelId
    };
};
const normalizeOperationStatus = (value) => {
    if (!isRecord(value) || typeof value.operationId !== 'string'
        || !['unknown', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(value.state))) {
        throw new ExecutionError('PROTOCOL_ERROR', 'execution daemon operation.status 返回状态无效');
    }
    if (value.state === 'succeeded') {
        if (value.result !== undefined
            && (!isRecord(value.result) || typeof value.result.ok !== 'boolean' || typeof value.result.durationMs !== 'number')) {
            throw new ExecutionError('PROTOCOL_ERROR', 'operation.status succeeded 结果无效');
        }
    }
    if (value.state === 'failed') {
        if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') {
            throw new ExecutionError('PROTOCOL_ERROR', 'operation.status failed 错误无效');
        }
    }
    if (value.state === 'cancelled' && value.result !== undefined) {
        if (!isRecord(value.result) || typeof value.result.ok !== 'boolean' || typeof value.result.durationMs !== 'number') {
            throw new ExecutionError('PROTOCOL_ERROR', 'operation.status cancelled 结果无效');
        }
    }
    return structuredClone(value);
};
const getLease = (value) => {
    if (!isRecord(value))
        throw new ExecutionError('INVALID_REQUEST', 'kernel lease 必须是对象');
    const lease = value;
    if (typeof lease.kernelId !== 'string' || typeof lease.containerName !== 'string' || typeof lease.leaseId !== 'string' ||
        (lease.language !== 'python' && lease.language !== 'node') || !Number.isSafeInteger(lease.fence) || lease.fence < 1) {
        throw new ExecutionError('INVALID_REQUEST', 'kernel lease 字段无效');
    }
    return lease;
};
export class ExecutionDaemonTransport {
    socketPath;
    requestTimeoutMs;
    constructor(options) {
        const normalized = typeof options === 'string' ? { socketPath: options } : options;
        if (!normalized.socketPath)
            throw new ExecutionError('INVALID_REQUEST', 'socketPath 不能为空');
        this.socketPath = normalized.socketPath;
        this.requestTimeoutMs = normalized.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }
    async request(operation, payload, options = {}) {
        const { signal, onCommitted } = options;
        signal?.throwIfAborted();
        const response = await new Promise((resolve, reject) => {
            const socket = connect(this.socketPath);
            let input = '';
            let settled = false;
            const onAbort = () => {
                finish(() => reject(signal?.reason instanceof Error
                    ? signal.reason
                    : new ExecutionError('PROTOCOL_ERROR', 'execution daemon 请求已取消')));
            };
            const finish = (callback) => {
                if (settled)
                    return;
                settled = true;
                signal?.removeEventListener('abort', onAbort);
                socket.destroy();
                callback();
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) {
                onAbort();
                return;
            }
            socket.setTimeout(this.requestTimeoutMs, () => {
                finish(() => reject(new ExecutionError('PROTOCOL_ERROR', 'execution daemon 请求超时')));
            });
            socket.on('connect', () => {
                if (signal?.aborted) {
                    onAbort();
                    return;
                }
                try {
                    socket.write(`${JSON.stringify({ operation, payload })}\n`);
                    onCommitted?.();
                }
                catch (error) {
                    finish(() => reject(new ExecutionError('RUNTIME_UNAVAILABLE', `无法发送 execution daemon 请求: ${error instanceof Error ? error.message : String(error)}`)));
                }
            });
            socket.on('data', chunk => {
                input += chunk.toString('utf8');
                if (Buffer.byteLength(input, 'utf8') > MAX_RESPONSE_BYTES) {
                    finish(() => reject(new ExecutionError('LIMIT_EXCEEDED', 'execution daemon 响应超过限制')));
                    return;
                }
                const newline = input.indexOf('\n');
                if (newline < 0)
                    return;
                try {
                    const decoded = JSON.parse(input.slice(0, newline));
                    finish(() => resolve(decoded));
                }
                catch {
                    finish(() => reject(new ExecutionError('PROTOCOL_ERROR', 'execution daemon 返回无效 JSON')));
                }
            });
            socket.on('error', error => {
                finish(() => reject(new ExecutionError('RUNTIME_UNAVAILABLE', `无法连接 execution daemon: ${error.message}`)));
            });
            socket.on('end', () => {
                if (!settled && input.trim()) {
                    try {
                        finish(() => resolve(JSON.parse(input.trim())));
                    }
                    catch {
                        finish(() => reject(new ExecutionError('PROTOCOL_ERROR', 'execution daemon 返回不完整响应')));
                    }
                }
                else if (!settled) {
                    finish(() => reject(new ExecutionError('PROTOCOL_ERROR', 'execution daemon 未返回响应')));
                }
            });
        });
        if (!response.ok) {
            const code = response.error?.code;
            throw new ExecutionDaemonWireError(code ?? 'PROTOCOL_ERROR', response.error?.message ?? 'execution daemon 请求失败');
        }
        return response.result;
    }
}
export class ExecutionDaemonClient {
    socketPath;
    scope;
    transport;
    constructor(options) {
        this.scope = normalizeScope(options.scope);
        this.socketPath = options.socketPath;
        this.transport = new ExecutionDaemonTransport(options);
    }
    async health() {
        return this.transport.request('health', {});
    }
    async capabilities() {
        return this.transport.request('capabilities', {});
    }
    async acquire(input) {
        if (input.language !== 'python' && input.language !== 'node')
            throw new ExecutionError('INVALID_REQUEST', 'language 只支持 python/node');
        const lease = input.reuseKernelId === undefined
            ? await this.transport.request('claim', {
                scope: this.scope,
                language: input.language,
                ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs })
            })
            : await this.transport.request('reconnect', {
                scope: this.scope,
                kernelId: input.reuseKernelId,
                ...(input.leaseMs === undefined ? {} : { leaseMs: input.leaseMs })
            });
        if (lease.language !== input.language)
            throw new ExecutionError('SCOPE_MISMATCH', 'kernel language 与 acquire 请求不匹配');
        return lease;
    }
    cancelInternal(lease, operationId) {
        return this.transport.request('execute.cancel', {
            scope: this.scope,
            kernelId: lease.kernelId,
            operationId
        }).then(value => normalizeCancelResult(value, operationId, lease.kernelId));
    }
    async execute(leaseValue, input) {
        const lease = getLease(leaseValue);
        const operationId = normalizeOperationId(input.operationId ?? randomUUID());
        input.signal?.throwIfAborted();
        const blocked = blockedProjects.get(this.scope.projectId);
        const blockedOperationId = blocked?.keys().next().value;
        if (blockedOperationId !== undefined) {
            throw new ExecutionScopeBlockedError({
                projectId: this.scope.projectId,
                operationId,
                blockedOperationId
            });
        }
        let committed = false;
        try {
            const result = await this.transport.request('execute', {
                scope: this.scope,
                kernelId: lease.kernelId,
                leaseId: lease.leaseId,
                fence: lease.fence,
                language: lease.language,
                operationId,
                code: input.code,
                ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
            }, {
                ...(input.signal === undefined ? {} : { signal: input.signal }),
                onCommitted: () => { committed = true; }
            });
            return { ...result, operationId };
        }
        catch (error) {
            if (!committed)
                throw error;
            if (error instanceof ExecutionDaemonWireError) {
                Object.defineProperty(error, 'operationId', { value: operationId, enumerable: true });
                throw error;
            }
            let stopState = 'unknown';
            try {
                const cancelled = await this.cancelInternal(lease, operationId);
                if (cancelled.stopped)
                    stopState = 'stopped';
            }
            catch {
                // Cancellation is an independent control request. A failed stop probe keeps the project fenced.
            }
            if (stopState !== 'stopped') {
                let operations = blockedProjects.get(this.scope.projectId);
                if (operations === undefined) {
                    operations = new Map();
                    blockedProjects.set(this.scope.projectId, operations);
                }
                operations.set(operationId, lease.kernelId);
            }
            throw new ExecutionUncertainError({
                operationId,
                kernelId: lease.kernelId,
                stopState,
                cause: error
            });
        }
    }
    async cancel(leaseValue, input) {
        const lease = getLease(leaseValue);
        const operationId = normalizeOperationId(input.operationId);
        const result = await this.cancelInternal(lease, operationId);
        if (result.stopped) {
            const operations = blockedProjects.get(this.scope.projectId);
            operations?.delete(operationId);
            if (operations?.size === 0)
                blockedProjects.delete(this.scope.projectId);
        }
        return result;
    }
    async operationStatus(operationIdValue) {
        const operationId = normalizeOperationId(operationIdValue);
        const result = await this.transport.request('operation.status', {
            scope: this.scope,
            operationId
        });
        return normalizeOperationStatus(result);
    }
    async inspect(kernelId) {
        const kernels = await this.listKernels();
        const kernel = kernels.find(candidate => candidate.kernelId === kernelId);
        if (kernel === undefined)
            throw new ExecutionError('KERNEL_NOT_FOUND', `kernel ${kernelId} 不存在或不属于当前 scope`);
        return kernel;
    }
    async release(leaseValue) {
        const lease = getLease(leaseValue);
        return this.transport.request('release', {
            scope: this.scope,
            kernelId: lease.kernelId,
            leaseId: lease.leaseId,
            fence: lease.fence
        });
    }
    async listKernels() {
        return this.transport.request('kernel.list', { scope: this.scope });
    }
    async issueCredential(input) {
        return this.transport.request('credentials.issue', { scope: this.scope, credentialName: input.credentialName, ttlMs: input.ttlMs });
    }
    async revokeCredential(grantId) {
        await this.transport.request('credentials.revoke', { scope: this.scope, grantId });
    }
}
//# sourceMappingURL=client.js.map