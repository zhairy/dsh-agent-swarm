/**
 * rc3 的公开扩展事件入口只接受 `plugin:` 前缀，并由 SDK 自动写入
 * `ignorable:true`。该名称是本项目对逻辑事实 `swarm/notebook-task-binding`
 * 的持久化映射。
 */
export declare const NOTEBOOK_TASK_BINDING_EVENT: 'plugin:swarm/notebook-task-binding';
export declare const NOTEBOOK_TASK_BINDING_SCHEMA_VERSION: 1;
/** 只回看尾部固定数量的子会话事件；更老 marker 缺失时按普通会话拒绝托管恢复。 */
export declare const MAX_NOTEBOOK_MARKER_SCAN_EVENTS = 4096;
/** observe/inspect 的正常并发增长只允许有限次 fresh-cut 重观测。 */
export declare const MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS = 3;
export type NotebookContextErrorCode = 'NOTEBOOK_CONTEXT_INVALID' | 'NOTEBOOK_CONTEXT_UNAVAILABLE' | 'NOTEBOOK_CONTEXT_SESSION_NOT_FOUND' | 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH' | 'NOTEBOOK_CONTEXT_NOT_HOST_FS' | 'NOTEBOOK_CONTEXT_NOT_DURABLE' | 'NOTEBOOK_CONTEXT_APPEND_FAILED' | 'NOTEBOOK_CONTEXT_FLUSH_FAILED';
export declare class NotebookContextError extends Error {
    readonly code: NotebookContextErrorCode;
    readonly cause?: unknown;
    constructor(code: NotebookContextErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export interface NotebookContextBinding {
    taskId: string;
    rootSessionId: string;
    attemptId: string;
}
export interface NotebookResolvedReadContext {
    schemaVersion: typeof NOTEBOOK_TASK_BINDING_SCHEMA_VERSION;
    sessionId: string;
    managed: boolean;
    /** RootRouter 的纯内存草稿豁免；只能由主入口 closure 按当前真实角色增补。 */
    routerDraft?: true;
    taskId: string | null;
    agentId: string;
    attemptId: string | null;
    rootSessionId: string | null;
    cwd: string;
    directoryIdentity: string;
    source: 'swarm-marker' | 'host-session';
}
export interface NotebookContextSession {
    readonly id: string;
    readonly header: {
        readonly id: string;
        readonly cwd?: string;
        readonly parentSession?: string;
    };
    readonly seq: number;
    readonly firstLiveSeq: number;
}
export interface NotebookContextAgent {
    readonly id: string;
    readonly session: NotebookContextSession;
}
export interface NotebookContextObservation {
    readonly source: 'live' | 'prepared';
    readonly header: NotebookContextSession['header'];
    readonly inheritedEventCount: number;
    readonly events: readonly unknown[];
    readonly cursor: number;
    retain?: () => NotebookContextObservation;
    [Symbol.dispose]?: () => void;
}
interface NotebookSessionSdk {
    appendPluginRecord: (session: NotebookContextSession, type: typeof NOTEBOOK_TASK_BINDING_EVENT, data: {
        schemaVersion: typeof NOTEBOOK_TASK_BINDING_SCHEMA_VERSION;
        sessionId: string;
        rootSessionId: string;
        taskId: string;
        attemptId: string;
    }) => number;
}
export interface NotebookContextHost {
    get(name: string): unknown;
    appendPluginRecord?: NotebookSessionSdk['appendPluginRecord'];
}
export interface NotebookContextPort {
    record(agent: NotebookContextAgent, binding: NotebookContextBinding, signal?: AbortSignal): Promise<{
        sessionId: string;
        eventType: typeof NOTEBOOK_TASK_BINDING_EVENT;
        seq: number;
        flushed: true;
    }>;
    read(sessionId: string, signal?: AbortSignal): Promise<NotebookResolvedReadContext | undefined>;
}
/**
 * 创建 Swarm 主入口挂载到 Notebook runtime 的 Host context 端口。
 * `record` 只接受真实 live Agent；`read` 只走 sessionQuery 公共冷读接口。
 */
export declare const createNotebookContextPort: (input: {
    host: NotebookContextHost;
}) => NotebookContextPort;
/** main 接线兜底：从 Cordis context 的 `get` 能力构造 host port。 */
export declare const createNotebookContextPortFromContext: (ctx: {
    get: (name: string) => unknown;
}) => NotebookContextPort;
/**
 * 主入口只对真实 RootRouter 的 Host session 增补该标记。
 * marker/Worker context 或任何带 task 身份的 context 一律拒绝，避免把
 * Root 草稿豁免扩散成绕过 managed scope 的通用后门。
 */
export declare const withNotebookRouterDraft: (resolved: NotebookResolvedReadContext) => NotebookResolvedReadContext;
export declare const assertNotebookReadContextMatches: (resolved: NotebookResolvedReadContext, trusted: {
    agentId?: string;
    taskId?: string;
    cwd?: string;
}) => NotebookResolvedReadContext;
export {};
