import { statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
/**
 * rc3 的公开扩展事件入口只接受 `plugin:` 前缀，并由 SDK 自动写入
 * `ignorable:true`。该名称是本项目对逻辑事实 `swarm/notebook-task-binding`
 * 的持久化映射。
 */
export const NOTEBOOK_TASK_BINDING_EVENT = 'plugin:swarm/notebook-task-binding';
export const NOTEBOOK_TASK_BINDING_SCHEMA_VERSION = 1;
/** 只回看尾部固定数量的子会话事件；更老 marker 缺失时按普通会话拒绝托管恢复。 */
export const MAX_NOTEBOOK_MARKER_SCAN_EVENTS = 4096;
/** observe/inspect 的正常并发增长只允许有限次 fresh-cut 重观测。 */
export const MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS = 3;
const MAX_IDENTITY_CHARS = 1024;
const SESSION_SDK_SPECIFIER = '@deepseek-ai/dsh-session';
export class NotebookContextError extends Error {
    code;
    cause;
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'NotebookContextError';
        this.code = code;
        if ('cause' in options)
            this.cause = options.cause;
    }
}
const errorCode = (error) => {
    const code = error?.code;
    return typeof code === 'string' ? code : undefined;
};
const isRecord = (value) => value !== null
    && typeof value === 'object'
    && !Array.isArray(value);
const requireText = (name, value) => {
    if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_IDENTITY_CHARS || value.includes('\0')) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', `${name} 必须是非空可信文本`);
    }
    return value;
};
const requireNonNegativeInteger = (name, value) => {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', `${name} 必须是非负安全整数`);
    }
    return Number(value);
};
const getService = (host, name, validate) => {
    const value = host.get(name);
    if (!validate(value)) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', `Notebook Host context 缺少 ${name} 服务`);
    }
    return value;
};
const isSessionQuery = (value) => isRecord(value)
    && (typeof value.readSession === 'function'
        || typeof value.observeSession === 'function' && typeof value.inspectSession === 'function');
const isSessions = (value) => isRecord(value)
    && typeof value.get === 'function'
    && typeof value.flush === 'function';
const isWorkingDirectory = (value) => isRecord(value)
    && typeof value.get === 'function';
const isFs = (value) => isRecord(value)
    && typeof value.lstat === 'function'
    && typeof value.resolve === 'function'
    && typeof value.stat === 'function'
    && typeof value.processPath === 'function'
    && typeof value.processPathFromHostPath === 'function';
const isNotFound = (error) => errorCode(error) === 'SESSION_QUERY_SESSION_NOT_FOUND'
    || error?.name === 'SessionPersistenceNotFoundError';
let sessionSdkCache;
const getHostEntry = () => {
    const hostEntry = process.argv[1];
    if (typeof hostEntry !== 'string' || hostEntry.trim() === '' || hostEntry.includes('\0') || !isAbsolute(hostEntry)) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', '无法定位真实 Host process.argv[1] 原生入口；拒绝从 Swarm 自身依赖树解析 Session SDK');
    }
    try {
        if (!statSync(hostEntry).isFile())
            throw new Error('not a regular file');
    }
    catch (error) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', '真实 Host process.argv[1] 原生入口不可访问', { cause: error });
    }
    return hostEntry;
};
const loadSessionSdk = async () => {
    const hostEntry = getHostEntry();
    if (sessionSdkCache?.hostEntry === hostEntry)
        return await sessionSdkCache.promise;
    const requireFromHost = createRequire(hostEntry);
    const promise = (async () => {
        let resolved;
        try {
            resolved = requireFromHost.resolve(SESSION_SDK_SPECIFIER);
        }
        catch (error) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', '真实 Host 原生入口无法解析 @deepseek-ai/dsh-session', { cause: error });
        }
        let module;
        try {
            module = await import(pathToFileURL(resolved).href);
        }
        catch (error) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', '真实 Host 解析到的 @deepseek-ai/dsh-session 无法作为 ESM 加载', { cause: error });
        }
        if (!isRecord(module) || typeof module.appendPluginRecord !== 'function') {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', '真实 Host @deepseek-ai/dsh-session 未导出 appendPluginRecord');
        }
        return module;
    })();
    const cache = { hostEntry, promise };
    sessionSdkCache = cache;
    try {
        return await promise;
    }
    catch (error) {
        if (sessionSdkCache === cache)
            sessionSdkCache = undefined;
        throw error;
    }
};
const getAppendPluginRecord = async (host) => {
    return host.appendPluginRecord ?? (await loadSessionSdk()).appendPluginRecord;
};
const parseMarker = (event, sessionId, rootSessionId, minimumSeq, maximumSeq) => {
    if (rootSessionId === undefined || !isRecord(event))
        return undefined;
    if (event.type !== NOTEBOOK_TASK_BINDING_EVENT
        || event.ignorable !== true
        || !Number.isSafeInteger(event.seq)
        || Number(event.seq) < minimumSeq
        || Number(event.seq) > maximumSeq
        || !isRecord(event.data)
        || event.data.schemaVersion !== NOTEBOOK_TASK_BINDING_SCHEMA_VERSION
        || event.data.sessionId !== sessionId
        || event.data.rootSessionId !== rootSessionId
        || typeof event.data.taskId !== 'string'
        || event.data.taskId.trim() === ''
        || typeof event.data.attemptId !== 'string'
        || event.data.attemptId.trim() === '') {
        return undefined;
    }
    return {
        schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
        sessionId,
        managed: true,
        taskId: event.data.taskId,
        agentId: sessionId,
        attemptId: event.data.attemptId,
        rootSessionId,
        cwd: '',
        directoryIdentity: '',
        source: 'swarm-marker'
    };
};
const getVerifiedHostDirectoryIdentity = async (fs, cwd, signal) => {
    if (!isAbsolute(cwd)) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook Host cwd 必须是绝对路径');
    }
    signal?.throwIfAborted();
    const pathInfo = await fs.lstat(cwd, undefined, signal);
    signal?.throwIfAborted();
    if (pathInfo?.type !== 'directory') {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook cwd 不是 Host 目录');
    }
    const target = await fs.resolve(cwd, { signal });
    const targetInfo = await fs.stat(target, signal);
    signal?.throwIfAborted();
    if (targetInfo?.type !== 'directory') {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook Host fs target 不是目录');
    }
    const mapped = fs.processPathFromHostPath(cwd);
    if (mapped === undefined) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook fs 不能映射当前 Host 物理目录');
    }
    const processPath = fs.processPath(target);
    let canonicalHost;
    let canonicalMapped;
    let canonicalProcess;
    try {
        canonicalHost = await realpath(cwd);
        canonicalMapped = await realpath(mapped);
        canonicalProcess = await realpath(processPath);
    }
    catch (error) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook Host 目录身份解析失败', { cause: error });
    }
    if (canonicalMapped !== canonicalHost || canonicalProcess !== canonicalHost) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook fs 执行世界不是当前 Host 物理目录');
    }
    const stat = await lstat(canonicalHost, { bigint: true });
    signal?.throwIfAborted();
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_HOST_FS', 'Notebook Host cwd 不是稳定物理目录');
    }
    return [stat.dev, stat.ino, stat.birthtimeNs].join(':');
};
/**
 * 创建 Swarm 主入口挂载到 Notebook runtime 的 Host context 端口。
 * `record` 只接受真实 live Agent；`read` 只走 sessionQuery 公共冷读接口。
 */
export const createNotebookContextPort = (input) => {
    const { host } = input;
    const record = async (agent, binding, signal) => {
        signal?.throwIfAborted();
        const sessionId = requireText('agent.session.id', agent.session.id);
        if (agent.id !== sessionId || agent.session.header.id !== sessionId) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook Agent 与 Session 身份不一致');
        }
        const rootSessionId = requireText('binding.rootSessionId', binding.rootSessionId);
        if (agent.session.header.parentSession !== rootSessionId) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook marker root 与 child parentSession 不一致');
        }
        const taskId = requireText('binding.taskId', binding.taskId);
        const attemptId = requireText('binding.attemptId', binding.attemptId);
        const appendPluginRecord = await getAppendPluginRecord(host);
        let seq;
        try {
            seq = appendPluginRecord(agent.session, NOTEBOOK_TASK_BINDING_EVENT, {
                schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
                sessionId,
                rootSessionId,
                taskId,
                attemptId
            });
        }
        catch (error) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_APPEND_FAILED', 'Notebook task binding 写入失败', { cause: error });
        }
        if (!Number.isSafeInteger(seq) || seq < 0) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_APPEND_FAILED', 'Notebook task binding 返回无效 seq');
        }
        const sessions = getService(host, 'sessions', isSessions);
        let flushed;
        try {
            flushed = await sessions.flush(agent.session);
        }
        catch (error) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_FLUSH_FAILED', 'Notebook task binding durable flush 失败', { cause: error });
        }
        if (!flushed) {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_NOT_DURABLE', 'Notebook task binding 没有持久化 listener 确认');
        }
        return {
            sessionId,
            eventType: NOTEBOOK_TASK_BINDING_EVENT,
            seq,
            flushed: true
        };
    };
    const read = async (rawSessionId, signal) => {
        const sessionId = requireText('sessionId', rawSessionId);
        const sessionQuery = getService(host, 'sessionQuery', isSessionQuery);
        const sessions = getService(host, 'sessions', isSessions);
        const workingDirectory = getService(host, 'workingDirectory', isWorkingDirectory);
        const fs = getService(host, 'fs', isFs);
        if (typeof sessionQuery.readSession === 'function') {
            signal?.throwIfAborted();
            let snapshot;
            try {
                snapshot = await sessionQuery.readSession(sessionId);
            }
            catch (error) {
                if (isNotFound(error))
                    return undefined;
                throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', 'Notebook Host session readSession 失败', { cause: error });
            }
            signal?.throwIfAborted();
            if (!isRecord(snapshot) || !isRecord(snapshot.session) || !Array.isArray(snapshot.events)
                || snapshot.session.id !== sessionId) {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook readSession 返回无效快照');
            }
            const inheritedEventCount = requireNonNegativeInteger('readSession.inheritedEventCount', snapshot.inheritedEventCount);
            const lastEvent = snapshot.events.at(-1);
            const observationCursor = lastEvent === undefined ? -1 : Number(lastEvent.seq);
            if (lastEvent !== undefined && (!isRecord(lastEvent) || !Number.isSafeInteger(observationCursor) || observationCursor < 0)) {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook readSession 末事件 seq 无效');
            }
            // alpha2 只让 Host 的 workspace-root/change 移动 Session cwd；旧 working-directory/change 不得生效。
            let cwd = snapshot.session.cwd ?? workingDirectory.defaultDirectory;
            for (const event of snapshot.events) {
                if (!isRecord(event) || event.type !== 'workspace-root/change')
                    continue;
                if (!isRecord(event.data)) {
                    throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook workspace-root/change 数据无效');
                }
                cwd = event.data.cwd;
            }
            const resolvedCwd = requireText('workingDirectory', cwd);
            const directoryIdentity = await getVerifiedHostDirectoryIdentity(fs, resolvedCwd, signal);
            const minimumSeq = Math.max(inheritedEventCount, observationCursor - MAX_NOTEBOOK_MARKER_SCAN_EVENTS + 1);
            const scanStart = Math.max(0, snapshot.events.length - MAX_NOTEBOOK_MARKER_SCAN_EVENTS);
            let marker;
            for (let index = snapshot.events.length - 1; index >= scanStart; index -= 1) {
                const candidate = snapshot.events[index];
                if (!isRecord(candidate) || !Number.isSafeInteger(candidate.seq) || Number(candidate.seq) < minimumSeq)
                    continue;
                marker = parseMarker(candidate, sessionId, snapshot.session.parentSession, minimumSeq, observationCursor);
                if (marker !== undefined)
                    break;
            }
            if (marker !== undefined)
                return { ...marker, cwd: resolvedCwd, directoryIdentity };
            return {
                schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
                sessionId,
                managed: false,
                taskId: null,
                agentId: sessionId,
                attemptId: null,
                rootSessionId: snapshot.session.parentSession ?? null,
                cwd: resolvedCwd,
                directoryIdentity,
                source: 'host-session'
            };
        }
        const observeSession = sessionQuery.observeSession;
        const inspectSession = sessionQuery.inspectSession;
        if (typeof observeSession !== 'function' || typeof inspectSession !== 'function') {
            throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', 'Notebook sessionQuery 既不支持 readSession，也不支持 rc3 冷读接口');
        }
        const readCut = async (observation) => {
            signal?.throwIfAborted();
            if (observation.header.id !== sessionId) {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook observeSession 返回错误 Session');
            }
            if (observation.source !== 'live' && observation.source !== 'prepared') {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook observation source 无效');
            }
            const observationCursor = Number(observation.cursor);
            const inheritedEventCount = requireNonNegativeInteger('observation.inheritedEventCount', observation.inheritedEventCount);
            if (!Number.isSafeInteger(observationCursor) || observationCursor < -1) {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook observation cursor 无效');
            }
            const inspected = await inspectSession(sessionId, session => {
                const live = sessions.get(sessionId) === session;
                return {
                    header: session.header,
                    cwd: workingDirectory.get(session),
                    source: live ? 'live' : 'prepared',
                    cursor: Number(live ? session.seq : session.firstLiveSeq) - 1
                };
            }, signal);
            signal?.throwIfAborted();
            if (inspected.header.id !== sessionId
                || inspected.source !== observation.source
                || inspected.cursor !== observationCursor
                || inspected.header.parentSession !== observation.header.parentSession) {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_CURSOR_MISMATCH', 'Notebook session 在 observe 与 inspect 间发生变化');
            }
            const cwd = requireText('workingDirectory', inspected.cwd);
            const directoryIdentity = await getVerifiedHostDirectoryIdentity(fs, cwd, signal);
            const minimumSeq = Math.max(inheritedEventCount, observationCursor - MAX_NOTEBOOK_MARKER_SCAN_EVENTS + 1);
            const scanStart = Math.max(0, observation.events.length - MAX_NOTEBOOK_MARKER_SCAN_EVENTS);
            let marker;
            for (let index = observation.events.length - 1; index >= scanStart; index -= 1) {
                const candidate = observation.events[index];
                if (!isRecord(candidate) || !Number.isSafeInteger(candidate.seq) || Number(candidate.seq) < minimumSeq)
                    continue;
                marker = parseMarker(candidate, sessionId, inspected.header.parentSession, minimumSeq, observationCursor);
                if (marker !== undefined)
                    break;
            }
            if (marker !== undefined)
                return { ...marker, cwd, directoryIdentity };
            return {
                schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
                sessionId,
                managed: false,
                taskId: null,
                agentId: sessionId,
                attemptId: null,
                rootSessionId: inspected.header.parentSession ?? null,
                cwd,
                directoryIdentity,
                source: 'host-session'
            };
        };
        for (let attempt = 1; attempt <= MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS; attempt += 1) {
            signal?.throwIfAborted();
            let observation;
            try {
                observation = await observeSession(sessionId, {
                    projectionMode: 'none',
                    ...(signal === undefined ? {} : { signal })
                });
            }
            catch (error) {
                if (isNotFound(error))
                    return undefined;
                throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', 'Notebook Host session 冷读失败', { cause: error });
            }
            let result;
            let cutFailure;
            try {
                result = await readCut(observation);
            }
            catch (error) {
                cutFailure = error;
            }
            let disposeFailure;
            try {
                observation[Symbol.dispose]?.();
            }
            catch (error) {
                disposeFailure = error;
            }
            if (disposeFailure !== undefined) {
                if (cutFailure !== undefined) {
                    throw new AggregateError([cutFailure, disposeFailure], 'Notebook session 读取和 observation dispose 均失败');
                }
                throw new NotebookContextError('NOTEBOOK_CONTEXT_UNAVAILABLE', 'Notebook session observation dispose 失败', { cause: disposeFailure });
            }
            if (cutFailure === undefined)
                return result;
            const cursorChanged = cutFailure instanceof NotebookContextError
                && cutFailure.code === 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH';
            if (cursorChanged && attempt < MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS)
                continue;
            if (cursorChanged) {
                throw new NotebookContextError('NOTEBOOK_CONTEXT_CURSOR_MISMATCH', `Notebook session 连续 ${MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS} 次 fresh cut 仍不稳定；拒绝旧 marker`, { cause: cutFailure });
            }
            throw cutFailure;
        }
        throw new NotebookContextError('NOTEBOOK_CONTEXT_CURSOR_MISMATCH', 'Notebook session context 未能取得稳定 fresh cut');
    };
    return Object.freeze({ record, read });
};
/** main 接线兜底：从 Cordis context 的 `get` 能力构造 host port。 */
export const createNotebookContextPortFromContext = (ctx) => createNotebookContextPort({
    host: { get: name => ctx.get(name) }
});
/**
 * 主入口只对真实 RootRouter 的 Host session 增补该标记。
 * marker/Worker context 或任何带 task 身份的 context 一律拒绝，避免把
 * Root 草稿豁免扩散成绕过 managed scope 的通用后门。
 */
export const withNotebookRouterDraft = (resolved) => {
    if (resolved.managed !== false
        || resolved.source !== 'host-session'
        || resolved.taskId !== null
        || resolved.attemptId !== null
        || resolved.rootSessionId !== null) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'routerDraft 只能标记无 task 的普通 Host root session');
    }
    return Object.freeze({ ...resolved, routerDraft: true });
};
export const assertNotebookReadContextMatches = (resolved, trusted) => {
    if (trusted.agentId !== undefined && trusted.agentId !== resolved.agentId) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook resolver agent 与执行 scope 不一致');
    }
    if (trusted.taskId !== undefined && trusted.taskId !== resolved.taskId) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook resolver task 与执行 scope 不一致');
    }
    if (trusted.cwd !== undefined && resolve(trusted.cwd) !== resolve(resolved.cwd)) {
        throw new NotebookContextError('NOTEBOOK_CONTEXT_INVALID', 'Notebook resolver cwd 与执行 scope 不一致');
    }
    return resolved;
};
//# sourceMappingURL=notebook-context.js.map