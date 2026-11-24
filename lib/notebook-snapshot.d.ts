/** Notebook 数据快照格式版本；升级时必须显式迁移，不能猜测旧结构。 */
export declare const NOTEBOOK_SNAPSHOT_SCHEMA_VERSION = 1;
/** 单会话默认最多保存 16 MiB，与现有完成视图内存预算一致。 */
export declare const DEFAULT_NOTEBOOK_SNAPSHOT_MAX_BYTES: number;
/** 即使运维显式放宽，也不允许快照超过 Notebook 单文件上限。 */
export declare const MAX_NOTEBOOK_SNAPSHOT_BYTES: number;
/** Swarm 主入口安装、Notebook 插件消费的进程内端口。 */
export declare const NOTEBOOK_SNAPSHOT_RUNTIME_KEY: unique symbol;
export type NotebookJson = null | boolean | number | string | NotebookJson[] | {
    [key: string]: NotebookJson;
};
export type NotebookSnapshotErrorCode = 'NOTEBOOK_SNAPSHOT_INVALID' | 'NOTEBOOK_SNAPSHOT_PATH_OUTSIDE' | 'NOTEBOOK_SNAPSHOT_NOT_DATA' | 'NOTEBOOK_SNAPSHOT_TOO_LARGE' | 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' | 'NOTEBOOK_SNAPSHOT_CORRUPT' | 'NOTEBOOK_SNAPSHOT_IO';
/** 带稳定错误码的快照错误，便于插件返回固定诊断而不会泄露内部路径内容。 */
export declare class NotebookSnapshotError extends Error {
    readonly code: NotebookSnapshotErrorCode;
    readonly cause?: unknown;
    constructor(code: NotebookSnapshotErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
export interface NotebookSnapshotCleanup {
    close?: () => Promise<void>;
    unlink: () => Promise<void>;
}
/**
 * 保存失败后执行受限清理；只忽略已不存在的临时文件与已关闭句柄。
 * 清理异常不能被吞掉，也不能覆盖原始写入失败，因此统一挂到 AggregateError cause。
 */
export declare const rethrowNotebookSnapshotFailure: (original: unknown, cleanup: NotebookSnapshotCleanup) => Promise<never>;
export interface NotebookSnapshotTask {
    id: string | null;
    agentId: string | null;
    attemptId: string | null;
    managed: boolean;
}
export interface NotebookSnapshotProject {
    cwd: string;
    repositoryRoot: string;
    directoryIdentity: string | null;
}
export interface NotebookSnapshotBoundary {
    mode: 'write' | 'read-only' | 'host-worktree';
    operation: 'shell' | 'file' | 'host';
    writeScopes: string[];
}
export interface NotebookSnapshotNotebook {
    cells: NotebookJson[];
    metadata: NotebookJson;
    nbformat: number;
    nbformat_minor: number;
}
export interface AddNotebookSnapshotInput {
    sessionId: string;
    savedAt: string;
    savedPath: string;
    notebook: {
        cells: readonly unknown[];
        metadata?: unknown;
        nbformat: number;
        nbformat_minor: number;
    };
    cellExtras?: unknown;
    task: NotebookSnapshotTask;
    project: NotebookSnapshotProject;
    boundary: NotebookSnapshotBoundary | null;
}
export interface NotebookSnapshotRecord {
    schemaVersion: typeof NOTEBOOK_SNAPSHOT_SCHEMA_VERSION;
    sessionId: string;
    savedAt: string;
    recordedAt: string;
    savedPath: string;
    task: NotebookSnapshotTask;
    project: NotebookSnapshotProject;
    boundary: NotebookSnapshotBoundary | null;
    notebook: NotebookSnapshotNotebook;
    cellExtras: NotebookJson;
    view: {
        mode: 'read-only';
        kernelAlive: false;
        autoRun: false;
    };
}
export interface NotebookSnapshotReceipt {
    saved: true;
    digest: string;
    bytes: number;
    savedAt: string;
    recordedAt: string;
}
export interface NotebookSnapshotRuntime {
    version: 1;
    /** 只在显式文件保存已成功后登记数据；快照本身从不授予工作区写权限。 */
    save: (input: AddNotebookSnapshotInput) => Promise<NotebookSnapshotReceipt>;
    /** 仅恢复纯数据；调用方仍须用可信 Host 状态完成会话、项目和任务隔离。 */
    load: (sessionId: string, context?: NotebookSnapshotReadContext) => Promise<NotebookSnapshotRecord | undefined>;
    /** Swarm 主入口可挂载的 Host 冷读 resolver；Notebook 桥不得从模型参数补 owner/path。 */
    resolveReadContext?: (sessionId: string, signal?: AbortSignal) => Promise<NotebookSnapshotReadContext | undefined>;
}
export interface NotebookSnapshotReadContext {
    /** 可信 Host 给出的逻辑 Session；存在时必须与 load 的第一个参数一致。 */
    sessionId?: string;
    /**
     * RootRouter 的可信纯内存草稿标记。只能由 runtime resolver 根据实际 Host
     * Agent 与 Swarm 当前角色增补，不能来自 HTTP/模型字段或持久 marker。
     */
    routerDraft?: true;
    /** 旧桥接字段；托管快照不接受它代替精确 cwd 与目录身份。 */
    projectPaths?: readonly string[];
    agentId?: string;
    taskId?: string | null;
    /**
     * 当前已核验执行 attempt。它可以不同于记录中的 producer attempt；
     * 快照只复用同一 task/agent 的纯数据，不恢复旧 attempt 的写授权。
     */
    attemptId?: string | null;
    rootSessionId?: string | null;
    managed?: boolean;
    /** 当前 Host working directory；必须与保存时的 project.cwd 精确相等。 */
    cwd?: string;
    /** 当前目录的 dev:ino:birthtimeNs；同一路径被替换后必须变化并拒绝恢复。 */
    directoryIdentity?: string;
}
export interface NotebookSnapshotStoreOptions {
    dshHome: string;
    maxBytes?: number;
    now?: () => number;
}
export interface NotebookSnapshotStore extends NotebookSnapshotRuntime {
    readonly directory: string;
    readonly maxBytes: number;
}
/**
 * 创建项目隔离的 Notebook 数据快照存储。
 *
 * 快照只接受纯 JSON cell 数据，按 session 覆盖最新一次显式保存；文件名使用
 * session 摘要避免路径注入，目录固定在 DSH_HOME 内并使用 0700/0600 权限。
 */
export declare const createNotebookSnapshotStore: (options: NotebookSnapshotStoreOptions) => NotebookSnapshotStore;
/** 获取当前进程安装的 Notebook 快照端口；缺失时由插件保持原有 .ipynb 保存语义。 */
export declare const getNotebookSnapshotRuntime: () => NotebookSnapshotRuntime | undefined;
/** 安装唯一快照端口；返回幂等卸载器且只删除本实例持有的全局值。 */
export declare const installNotebookSnapshotRuntime: (runtime: NotebookSnapshotRuntime) => (() => void);
