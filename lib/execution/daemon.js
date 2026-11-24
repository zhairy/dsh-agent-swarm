import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ExecutionError } from './runtime.js';
const MAX_REQUEST_BYTES = 1024 * 1024;
const PROTOCOL_VERSION = 1;
const MAX_SERVER_CONNECTIONS = 32;
const serverSockets = new WeakMap();
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const getOperationScope = (value) => {
    if (!isRecord(value))
        throw new ExecutionError('INVALID_REQUEST', 'scope 必须是对象');
    const projectId = value.projectId;
    const ownerId = value.ownerId;
    if (typeof projectId !== 'string' || !projectId || projectId.length > 128 || /[\0\r\n]/.test(projectId)) {
        throw new ExecutionError('INVALID_REQUEST', 'scope.projectId 无效');
    }
    if (typeof ownerId !== 'string' || !ownerId || ownerId.length > 128 || /[\0\r\n]/.test(ownerId)) {
        throw new ExecutionError('INVALID_REQUEST', 'scope.ownerId 无效');
    }
    return { projectId, ownerId };
};
const getOperationId = (value) => {
    if (typeof value !== 'string' || !value || value.length > 128 || /[\0\r\n]/.test(value)) {
        throw new ExecutionError('INVALID_REQUEST', 'operationId 必须是 1-128 个字符的稳定标识');
    }
    return value;
};
const getKernelId = (value) => {
    if (typeof value !== 'string' || !value || value.length > 128 || /[\0\r\n]/.test(value)) {
        throw new ExecutionError('INVALID_REQUEST', 'kernelId 必须是 1-128 个字符的稳定标识');
    }
    return value;
};
const ensurePrivateDirectory = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new ExecutionError('INVALID_REQUEST', `运行时路径不是普通目录: ${directory}`);
    }
    await chmod(directory, 0o700);
};
const isSocketAlive = async (socketPath) => new Promise(resolve => {
    const socket = connect(socketPath);
    let settled = false;
    const done = (value) => {
        if (settled)
            return;
        settled = true;
        socket.destroy();
        resolve(value);
    };
    socket.setTimeout(300, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
});
const prepareSocketPath = async (socketPath) => {
    try {
        const info = await lstat(socketPath);
        if (!info.isSocket() || info.isSymbolicLink()) {
            throw new ExecutionError('INVALID_REQUEST', `拒绝覆盖非 socket 路径: ${socketPath}`);
        }
        if (await isSocketAlive(socketPath)) {
            throw new ExecutionError('RUNTIME_UNAVAILABLE', `execution daemon socket 已被占用: ${socketPath}`);
        }
        await unlink(socketPath);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        throw error;
    }
};
const listen = async (socketPath, handler) => {
    await prepareSocketPath(socketPath);
    // 请求以换行界定；允许半关闭可确保慢操作在客户端停止写入后仍能返回响应。
    const server = createServer({ allowHalfOpen: true }, handler);
    server.maxConnections = MAX_SERVER_CONNECTIONS;
    const sockets = new Set();
    serverSockets.set(server, sockets);
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        const onError = (error) => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(socketPath);
    });
    await chmod(socketPath, 0o600);
    return server;
};
const closeServer = async (server, socketPath) => {
    for (const socket of serverSockets.get(server) ?? [])
        socket.destroy();
    await new Promise(resolve => server.close(() => resolve()));
    await unlink(socketPath).catch(error => {
        if (error.code !== 'ENOENT')
            throw error;
    });
};
const sendResponse = (socket, response) => {
    if (socket.destroyed)
        return;
    socket.end(`${JSON.stringify(response)}\n`, () => socket.destroy());
};
const toErrorResponse = (error) => {
    if (error instanceof ExecutionError) {
        return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'execution daemon 内部错误' } };
};
const readRequest = async (socket) => new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let input = '';
    let inputBytes = 0;
    let settled = false;
    const ignorePostRequestError = () => undefined;
    const cleanup = () => {
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('timeout', onTimeout);
        socket.off('error', onError);
        socket.setTimeout(0);
        socket.pause();
        socket.on('error', ignorePostRequestError);
        input = '';
    };
    const finish = (request, error, destroy = false) => {
        if (settled)
            return;
        settled = true;
        cleanup();
        if (destroy)
            socket.destroy();
        if (error) {
            reject(error);
            return;
        }
        if (request === undefined)
            reject(new ExecutionError('PROTOCOL_ERROR', 'execution daemon 请求为空'));
        else
            resolve(request);
    };
    const onData = (chunk) => {
        if (settled)
            return;
        inputBytes += chunk.byteLength;
        if (inputBytes > MAX_REQUEST_BYTES) {
            finish(undefined, new ExecutionError('LIMIT_EXCEEDED', 'execution daemon 请求超过限制'), true);
            return;
        }
        input += decoder.write(chunk);
        const newline = input.indexOf('\n');
        if (newline < 0)
            return;
        const frame = input.slice(0, newline);
        const remainder = input.slice(newline + 1);
        if (remainder.trim() !== '') {
            finish(undefined, new ExecutionError('PROTOCOL_ERROR', '一个连接只允许一个请求帧'), true);
            return;
        }
        try {
            const decoded = JSON.parse(frame.trim());
            if (!isRecord(decoded))
                throw new Error('请求必须是对象');
            finish(decoded);
        }
        catch {
            finish(undefined, new ExecutionError('PROTOCOL_ERROR', 'execution daemon 请求不是有效 JSON 对象'));
        }
    };
    const onEnd = () => finish();
    const onTimeout = () => finish(undefined, new ExecutionError('PROTOCOL_ERROR', 'execution daemon 请求读取超时'));
    const onError = (error) => finish(undefined, error);
    socket.setTimeout(30_000);
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('timeout', onTimeout);
    socket.on('error', onError);
});
export const createExecutionDaemon = (options) => {
    const controlSocketPath = join(options.runtimeDirectory, 'control.sock');
    const proxyDirectory = join(options.runtimeDirectory, 'proxy');
    const proxySocketPath = join(proxyDirectory, 'credential.sock');
    let controlServer;
    let proxyServer;
    let isStarted = false;
    const operationPool = options.pool;
    const getPayload = (request) => {
        if (request.payload === undefined)
            return {};
        if (!isRecord(request.payload))
            throw new ExecutionError('INVALID_REQUEST', 'payload 必须是对象');
        return request.payload;
    };
    const dispatchControl = async (request) => {
        if (typeof request.operation !== 'string' || !request.operation) {
            throw new ExecutionError('INVALID_REQUEST', 'operation 不能为空');
        }
        const payload = getPayload(request);
        switch (request.operation) {
            case 'health':
                return { status: 'ok', protocolVersion: PROTOCOL_VERSION, pid: process.pid };
            case 'capabilities':
                return {
                    protocolVersion: PROTOCOL_VERSION,
                    languages: ['python', 'node'],
                    credentialProxy: options.credentialBroker !== undefined,
                    ...(options.capabilities === undefined ? {} : { runtime: await options.capabilities() })
                };
            case 'warm':
                return options.pool.warm(payload);
            case 'claim':
                return options.pool.claim(payload);
            case 'execute': {
                const scope = getOperationScope(payload.scope);
                const operationId = getOperationId(payload.operationId);
                return options.pool.execute({ ...payload, scope, operationId });
            }
            case 'execute.cancel': {
                const scope = getOperationScope(payload.scope);
                const kernelId = getKernelId(payload.kernelId);
                const operationId = getOperationId(payload.operationId);
                const result = await operationPool.cancel({ scope, kernelId, operationId });
                if (!isRecord(result) || typeof result.stopped !== 'boolean') {
                    throw new ExecutionError('PROTOCOL_ERROR', 'execution pool cancel 返回缺少 stopped');
                }
                return { stopped: result.stopped, operationId, kernelId };
            }
            case 'operation.status': {
                const scope = getOperationScope(payload.scope);
                const operationId = getOperationId(payload.operationId);
                return operationPool.operationStatus({ scope, operationId });
            }
            case 'release':
                return options.pool.release(payload);
            case 'reconnect':
                return options.pool.reconnect(payload);
            case 'kernel.list': {
                if (!isRecord(payload.scope))
                    throw new ExecutionError('INVALID_REQUEST', 'kernel.list 需要 {scope}');
                return options.pool.list(payload.scope);
            }
            case 'credentials.issue':
                if (options.credentialBroker === undefined)
                    throw new ExecutionError('RUNTIME_UNAVAILABLE', '凭据代理未配置');
                return options.credentialBroker.issue(payload);
            case 'credentials.revoke':
                if (options.credentialBroker === undefined)
                    throw new ExecutionError('RUNTIME_UNAVAILABLE', '凭据代理未配置');
                return options.credentialBroker.revoke(payload);
            default:
                throw new ExecutionError('PROTOCOL_ERROR', `不支持的控制面 operation: ${request.operation}`);
        }
    };
    const dispatchProxy = async (request) => {
        if (request.operation !== 'credentials.proxy') {
            throw new ExecutionError('PROTOCOL_ERROR', '容器代理 socket 只接受 credentials.proxy');
        }
        if (options.credentialBroker === undefined)
            throw new ExecutionError('RUNTIME_UNAVAILABLE', '凭据代理未配置');
        return options.credentialBroker.proxy(getPayload(request));
    };
    const createHandler = (dispatch) => (socket) => {
        void readRequest(socket)
            .then(dispatch)
            .then(result => sendResponse(socket, { ok: true, result }))
            .catch(error => {
            options.logger?.error('execution daemon 请求失败', {
                code: error instanceof ExecutionError ? error.code : 'INTERNAL_ERROR',
                message: error instanceof Error ? error.message : String(error)
            });
            sendResponse(socket, toErrorResponse(error));
        });
    };
    return {
        start: async () => {
            if (isStarted)
                throw new ExecutionError('INVALID_REQUEST', 'execution daemon 已启动');
            await ensurePrivateDirectory(options.runtimeDirectory);
            await ensurePrivateDirectory(proxyDirectory);
            try {
                controlServer = await listen(controlSocketPath, createHandler(dispatchControl));
                proxyServer = await listen(proxySocketPath, createHandler(dispatchProxy));
                isStarted = true;
                options.logger?.info('execution daemon listening', { controlSocketPath, proxySocketPath });
                return { runtimeDirectory: options.runtimeDirectory, controlSocketPath, proxySocketPath };
            }
            catch (error) {
                if (proxyServer)
                    await closeServer(proxyServer, proxySocketPath).catch(() => undefined);
                if (controlServer)
                    await closeServer(controlServer, controlSocketPath).catch(() => undefined);
                throw error;
            }
        },
        close: async (closeOptions) => {
            const errors = [];
            if (proxyServer)
                await closeServer(proxyServer, proxySocketPath).catch(error => errors.push(error));
            if (controlServer)
                await closeServer(controlServer, controlSocketPath).catch(error => errors.push(error));
            proxyServer = undefined;
            controlServer = undefined;
            isStarted = false;
            if (options.shutdownRuntime !== undefined || closeOptions?.removeKernels === true) {
                await (options.shutdownRuntime ?? (shutdown => options.pool.shutdown(shutdown)))({
                    removeKernels: closeOptions?.removeKernels === true
                }).catch(error => errors.push(error));
            }
            if (errors.length > 0)
                throw new AggregateError(errors, 'execution daemon 关闭失败');
        }
    };
};
//# sourceMappingURL=daemon.js.map