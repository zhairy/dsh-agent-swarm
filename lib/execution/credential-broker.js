import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ExecutionError } from './runtime.js';
const MAX_GRANT_TTL_MS = 5 * 60 * 1000;
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const DEFAULT_RESPONSE_BODY_BYTES = 1024 * 1024;
const HARD_MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_TIMEOUT_MS = 60_000;
const DEFAULT_METHODS = ['GET'];
const DEFAULT_PATH_PREFIXES = ['/'];
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const getScope = (value) => {
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
const getOrigin = (origin) => {
    let parsed;
    try {
        parsed = new URL(origin);
    }
    catch {
        throw new ExecutionError('INVALID_REQUEST', '凭据 origin 不是有效 URL');
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
        throw new ExecutionError('INVALID_REQUEST', '凭据 origin 必须不带凭据、路径、查询或片段');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new ExecutionError('INVALID_REQUEST', '凭据 origin 只支持 http/https');
    }
    return parsed.origin;
};
const normalizeCredential = (config) => {
    if (!config.name || config.name.length > 128 || /[\0\r\n]/.test(config.name)) {
        throw new ExecutionError('INVALID_REQUEST', '凭据 name 无效');
    }
    if (!config.secret || config.secret.length > 16 * 1024 || /[\0\r\n]/.test(config.secret)) {
        throw new ExecutionError('INVALID_REQUEST', `凭据 ${config.name} 的 secret 无效`);
    }
    const methods = (config.allowedMethods ?? [...DEFAULT_METHODS]).map(method => method.toUpperCase());
    if (methods.length < 1 || methods.some(method => !/^[A-Z]+$/.test(method))) {
        throw new ExecutionError('INVALID_REQUEST', `凭据 ${config.name} 的 allowedMethods 无效`);
    }
    const prefixes = config.allowedPathPrefixes ?? [...DEFAULT_PATH_PREFIXES];
    if (prefixes.length < 1 || prefixes.some(prefix => !prefix.startsWith('/') || prefix.startsWith('//') || prefix.includes('\\'))) {
        throw new ExecutionError('INVALID_REQUEST', `凭据 ${config.name} 的 allowedPathPrefixes 无效`);
    }
    return { ...config, origin: getOrigin(config.origin), allowedMethods: [...new Set(methods)], allowedPathPrefixes: [...new Set(prefixes)] };
};
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const getSafeResponseHeaders = (headers) => {
    const result = {};
    for (const name of ['content-type', 'request-id', 'x-request-id']) {
        const value = headers.get(name);
        if (value)
            result[name] = value;
    }
    return result;
};
const runUntilAbort = async (operation, signal, timeoutError) => {
    if (signal.aborted)
        throw timeoutError;
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback) => {
            if (settled)
                return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            callback();
        };
        const onAbort = () => finish(() => reject(timeoutError));
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    });
};
const cancelWithin = async (operation, timeoutMs = 25) => {
    let timer;
    await Promise.race([
        operation.catch(() => undefined),
        new Promise(resolve => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref();
        })
    ]);
    if (timer !== undefined)
        clearTimeout(timer);
};
const readBoundedResponse = async (response, signal, timeoutError, maxResponseBytes) => {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        if (response.body !== null)
            await cancelWithin(response.body.cancel('response body exceeds limit'));
        throw new ExecutionError('LIMIT_EXCEEDED', `上游响应体超过限制 ${maxResponseBytes} 字节`);
    }
    if (response.body === null)
        return new Uint8Array();
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await runUntilAbort(reader.read(), signal, timeoutError);
            if (done)
                break;
            if (value === undefined)
                continue;
            if (totalBytes + value.byteLength > maxResponseBytes) {
                await cancelWithin(reader.cancel('response body exceeds limit'));
                throw new ExecutionError('LIMIT_EXCEEDED', `上游响应体超过限制 ${maxResponseBytes} 字节`);
            }
            chunks.push(value);
            totalBytes += value.byteLength;
        }
    }
    catch (error) {
        await cancelWithin(reader.cancel('response stream failed'));
        if (error === timeoutError || signal.aborted)
            throw timeoutError;
        if (error instanceof ExecutionError)
            throw error;
        throw new ExecutionError('UPSTREAM_UNAVAILABLE', '上游响应流读取失败');
    }
    finally {
        try {
            reader.releaseLock();
        }
        catch {
            // 已取消的 reader 可能仍处于关闭过渡态，不影响本 cell 的失败映射。
        }
    }
    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
};
export class CredentialBroker {
    clock;
    fetchImpl;
    credentials = new Map();
    grantsByTokenHash = new Map();
    grantsById = new Map();
    upstreamTimeoutMs;
    maxResponseBytes;
    constructor(options) {
        this.clock = options.clock;
        this.fetchImpl = options.fetchImpl;
        this.upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
        this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_BODY_BYTES;
        if (!Number.isSafeInteger(this.upstreamTimeoutMs) || this.upstreamTimeoutMs < 1 || this.upstreamTimeoutMs > MAX_UPSTREAM_TIMEOUT_MS) {
            throw new ExecutionError('INVALID_REQUEST', `upstreamTimeoutMs 必须在 1-${MAX_UPSTREAM_TIMEOUT_MS} 之间`);
        }
        if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > HARD_MAX_RESPONSE_BODY_BYTES) {
            throw new ExecutionError('INVALID_REQUEST', `maxResponseBytes 必须在 1-${HARD_MAX_RESPONSE_BODY_BYTES} 之间`);
        }
        for (const config of options.grants) {
            const normalized = normalizeCredential(config);
            if (this.credentials.has(normalized.name))
                throw new ExecutionError('INVALID_REQUEST', `凭据 ${normalized.name} 重复`);
            this.credentials.set(normalized.name, normalized);
        }
    }
    async issue(input) {
        const scope = getScope(input.scope);
        const credential = this.credentials.get(input.credentialName);
        if (credential === undefined)
            throw new ExecutionError('CREDENTIAL_REJECTED', '请求的凭据未注册');
        if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > MAX_GRANT_TTL_MS) {
            throw new ExecutionError('LIMIT_EXCEEDED', `ttlMs 必须在 1-${MAX_GRANT_TTL_MS} 之间`);
        }
        const now = this.clock();
        const token = randomBytes(32).toString('base64url');
        const stored = {
            grantId: randomUUID(),
            tokenHash: hashToken(token),
            credentialName: credential.name,
            scope,
            allowedOrigin: credential.origin,
            expiresAt: now + input.ttlMs,
            isRevoked: false
        };
        this.grantsByTokenHash.set(stored.tokenHash, stored);
        this.grantsById.set(stored.grantId, stored);
        return {
            grantId: stored.grantId,
            token,
            credentialName: credential.name,
            allowedOrigin: stored.allowedOrigin,
            expiresAt: stored.expiresAt
        };
    }
    async proxy(input) {
        const scope = getScope(input.scope);
        if (typeof input.token !== 'string' || input.token.length < 32 || input.token.length > 512) {
            throw new ExecutionError('CREDENTIAL_REJECTED', 'grant token 无效');
        }
        const grant = this.grantsByTokenHash.get(hashToken(input.token));
        if (grant === undefined)
            throw new ExecutionError('CREDENTIAL_REJECTED', 'grant token 无效');
        if (grant.scope.projectId !== scope.projectId || grant.scope.ownerId !== scope.ownerId) {
            throw new ExecutionError('SCOPE_MISMATCH', 'grant 不属于请求的 project/owner');
        }
        if (grant.isRevoked)
            throw new ExecutionError('GRANT_REVOKED', 'grant 已撤销');
        if (this.clock() >= grant.expiresAt)
            throw new ExecutionError('GRANT_EXPIRED', 'grant 已过期');
        const credential = this.credentials.get(grant.credentialName);
        if (credential === undefined)
            throw new ExecutionError('CREDENTIAL_REJECTED', 'grant 对应凭据已移除');
        const method = input.method.toUpperCase();
        if (!credential.allowedMethods.includes(method))
            throw new ExecutionError('CREDENTIAL_REJECTED', '请求方法不在 grant 白名单');
        if (typeof input.path !== 'string' || input.path.length > 8192 || !input.path.startsWith('/') || input.path.startsWith('//') || /[\\\0\r\n]/.test(input.path)) {
            throw new ExecutionError('CREDENTIAL_REJECTED', '只接受同 origin 的绝对路径，不接受任意 URL');
        }
        let target;
        try {
            target = new URL(input.path, grant.allowedOrigin);
        }
        catch {
            throw new ExecutionError('CREDENTIAL_REJECTED', '请求 path 无效');
        }
        if (target.origin !== grant.allowedOrigin)
            throw new ExecutionError('CREDENTIAL_REJECTED', '请求 path 越出允许 origin');
        if (!credential.allowedPathPrefixes.some(prefix => target.pathname.startsWith(prefix))) {
            throw new ExecutionError('CREDENTIAL_REJECTED', '请求 path 不在 grant 白名单');
        }
        if (input.body !== undefined && Buffer.byteLength(input.body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
            throw new ExecutionError('LIMIT_EXCEEDED', '上游请求体超过限制');
        }
        const headers = {
            authorization: `Bearer ${credential.secret}`,
            accept: 'application/json'
        };
        if (input.body !== undefined)
            headers['content-type'] = input.contentType ?? 'application/json';
        const controller = new AbortController();
        const timeoutError = new ExecutionError('UPSTREAM_UNAVAILABLE', '凭据代理上游超时');
        const timeout = setTimeout(() => controller.abort(timeoutError), this.upstreamTimeoutMs);
        timeout.unref();
        let bodyBytes;
        try {
            let response;
            try {
                const request = Promise.resolve(this.fetchImpl(target, {
                    method,
                    headers,
                    ...(input.body === undefined ? {} : { body: input.body }),
                    redirect: 'manual',
                    signal: controller.signal
                }));
                response = await runUntilAbort(request, controller.signal, timeoutError);
            }
            catch (error) {
                if (error === timeoutError || controller.signal.aborted)
                    throw timeoutError;
                throw new ExecutionError('UPSTREAM_UNAVAILABLE', '凭据代理上游请求失败');
            }
            bodyBytes = await readBoundedResponse(response, controller.signal, timeoutError, this.maxResponseBytes);
            const text = new TextDecoder().decode(bodyBytes);
            const contentType = response.headers.get('content-type') ?? '';
            let body = text;
            if (contentType.includes('application/json') && text) {
                try {
                    body = JSON.parse(text);
                }
                catch {
                    body = text;
                }
            }
            return { status: response.status, headers: getSafeResponseHeaders(response.headers), body };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async revoke(input) {
        const scope = getScope(input.scope);
        const grant = this.grantsById.get(input.grantId);
        if (grant === undefined)
            throw new ExecutionError('CREDENTIAL_REJECTED', 'grant 不存在');
        if (grant.scope.projectId !== scope.projectId || grant.scope.ownerId !== scope.ownerId) {
            throw new ExecutionError('SCOPE_MISMATCH', 'grant 不属于请求的 project/owner');
        }
        grant.isRevoked = true;
    }
}
//# sourceMappingURL=credential-broker.js.map