/**
 * Notebook 到现有 DSH execution-boundary 的内部桥。
 *
 * 这里不定义新的公开服务：只把 Notebook 工具分类、路径断言、内层 bwrap
 * 参数和真实进程停净证书集中在一个可测试边界。main 负责把工具调用接入
 * `executionBoundary.run`，插件只消费当前活动 scope。
 */
export declare const EXECUTION_BOUNDARY_KEY: unique symbol;
export declare const EXECUTION_BOUNDARY_CAPS_KEY: unique symbol;
export declare const EXECUTION_TOOLS: readonly string[];
export declare const FILE_READ_TOOLS: readonly string[];
export declare const FILE_WRITE_TOOLS: readonly string[];
export declare const SIDECAR_FILE_TOOLS: readonly string[];
export type NotebookToolClass = 'execution' | 'file-read' | 'file-write' | 'control';
export type NotebookPathAccess = 'read' | 'write';
export type NotebookKernelLifecycle = 'persistent' | 'ephemeral';
export interface NotebookEpoch {
    active: number;
    unknown: boolean;
    sealed: boolean;
}
export interface NotebookBoundaryScope {
    /** 当前任务身份；托管 Notebook 快照必须保留该值，避免跨任务串用视图。 */
    taskId?: string;
    agentId: string;
    attemptId: string;
    mode: 'write' | 'read-only' | 'host-worktree';
    operation: 'shell' | 'file' | 'host';
    cwd: string;
    repositoryRoot: string;
    writeScopes: readonly string[];
    expectedDirectoryIdentity?: string;
    assertCurrent: () => void;
    epoch: NotebookEpoch;
    anchor?: {
        path: string;
        identity: string;
    };
    roots?: readonly {
        path: string;
        identity: string;
    }[];
    launcher?: string;
    bwrap?: string;
    onSettled?: (agentId: string) => void;
}
export interface NotebookBoundaryCarrier {
    storage: {
        getStore: () => NotebookBoundaryScope | undefined;
        run: <T>(scope: NotebookBoundaryScope, next: () => T) => T;
    };
    epochs: Map<string, NotebookEpoch>;
    assertFilePath: (path: string) => void;
    prepareSpawn?: (spec: NotebookSubprocessSpec) => {
        spec: NotebookSubprocessSpec;
        assertContainment: (mode: string) => void;
        started: (handle: NotebookSubprocessHandle) => void;
    };
}
export interface NotebookSubprocessSpec {
    argv: readonly string[];
    cwd: string;
    stdio: {
        stdin: 'pipe';
        stdout: 'pipe';
        stderr: 'pipe';
    };
    graceMs: number;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
}
export interface NotebookSubprocessHandle {
    stdin: NodeJS.WritableStream | undefined;
    stdout: NodeJS.ReadableStream | undefined;
    stderr: NodeJS.ReadableStream | undefined;
    done: Promise<{
        exitCode: number | null;
        signal: string | null;
    }>;
    terminate: () => void;
    waitForExit: (signal?: AbortSignal) => Promise<boolean>;
}
export interface NotebookSubprocessRuntime {
    spawn: (spec: NotebookSubprocessSpec) => NotebookSubprocessHandle;
}
export interface NotebookResourceLimits {
    addressSpaceBytes: number;
    nofile: number;
    nproc: number;
    fileSizeBytes: number;
    rootTmpfsBytes: number;
    privateTmpfsBytes: number;
    runtimeTmpfsBytes: number;
}
export interface NotebookSandboxPlan {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    network: 'deny';
    rootMode: 'allowlist';
    readRoots: string[];
    writeRoots: string[];
    resourceLimits: NotebookResourceLimits;
}
export interface NotebookRuntimeRecord {
    handle: NotebookSubprocessHandle;
    lifecycle: NotebookKernelLifecycle;
    epoch?: NotebookEpoch;
    epochKey?: string;
    syntheticEpoch: boolean;
    ownership: {
        active: number;
        unknown: boolean;
    };
}
export interface NotebookStopCertificate {
    stopped: boolean;
    quiescent: boolean;
    ownershipQuiescent: boolean;
    epochQuiescent: boolean | null;
    sharedEpochActive?: number;
    exitCode: number | null;
    signal: string | null;
    error?: string;
}
export declare const MAX_NOTEBOOK_EXECUTION_SECONDS = 180;
export declare const DEFAULT_NOTEBOOK_RESOURCE_LIMITS: Readonly<NotebookResourceLimits>;
export declare const resolveNotebookResourceLimits: (input?: Partial<NotebookResourceLimits>) => NotebookResourceLimits;
export declare const getNotebookExecutionTimeout: (requested?: unknown) => number;
export declare const getNotebookBoundaryScope: (carrier?: NotebookBoundaryCarrier | undefined) => NotebookBoundaryScope;
export declare const getNotebookToolClass: (name: string) => NotebookToolClass | undefined;
/** These file tools launch the bounded Python sidecar and therefore need shell containment. */
export declare const requiresNotebookSidecar: (name: string) => boolean;
export declare const getNotebookBoundaryCarrier: (target?: typeof globalThis) => NotebookBoundaryCarrier | undefined;
export declare const assertNotebookToolScope: (name: string, carrier?: NotebookBoundaryCarrier | undefined) => NotebookBoundaryScope;
export declare const assertNotebookPath: (path: string, access: NotebookPathAccess, carrier?: NotebookBoundaryCarrier | undefined) => string;
export declare const getNotebookComputeScopeKey: (scope: NotebookBoundaryScope) => string;
export declare const buildNotebookSandboxPlan: (input: {
    scope: NotebookBoundaryScope;
    bwrap: string;
    pythonExecutable: string;
    driverPath: string;
    pluginRoot: string;
    runtimePrefix: string;
    kernelRuntimePrefix?: string;
    resourceLimits?: Partial<NotebookResourceLimits>;
}) => NotebookSandboxPlan;
export declare const getNotebookKernelLifecycle: (scope: NotebookBoundaryScope) => NotebookKernelLifecycle;
export declare const spawnNotebookRuntime: (input: {
    carrier: NotebookBoundaryCarrier;
    subprocess: NotebookSubprocessRuntime;
    plan: Pick<NotebookSandboxPlan, 'argv' | 'cwd' | 'env' | 'network'>;
    lifecycle: NotebookKernelLifecycle;
    signal?: AbortSignal;
}) => NotebookRuntimeRecord;
export declare const stopNotebookRuntime: (record: NotebookRuntimeRecord, options?: {
    carrier?: NotebookBoundaryCarrier;
    timeoutMs?: number;
}) => Promise<NotebookStopCertificate>;
