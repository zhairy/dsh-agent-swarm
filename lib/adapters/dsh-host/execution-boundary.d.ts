import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentLike, PluginContextLike } from '../../host-contract.js';
export declare const EXECUTION_BOUNDARY_KEY: unique symbol;
export declare const EXECUTION_BOUNDARY_CAPS: unique symbol;
export declare const WRITER_EPOCH: (agentId: string, attemptId: string) => string;
export interface ExecutionBoundaryPolicy {
    taskId?: string;
    agentId: string;
    attemptId: string;
    mode: 'write' | 'read-only' | 'host-worktree';
    operation: 'shell' | 'file' | 'host';
    cwd: string;
    repositoryRoot: string;
    writeScopes: readonly string[];
    /** 主仓库元数据始终只读；Git 保存使用独立的固定命令入口。 */
    protectedRoots?: readonly string[];
    expectedGitIdentity?: string;
    expectedWritableIdentities?: readonly {
        path: string;
        identity: string;
    }[];
    readOnlyIdentities?: readonly {
        path: string;
        identity: string;
    }[];
    expectedDirectoryIdentity?: string;
    /** 仅受控 create/restore/bind 可同步 alpha2 随 CWD 改变的 workspaceRoot。 */
    allowWorkspaceRootTransition?: boolean;
    assertCurrent: () => void;
}
interface Identity {
    path: string;
    identity: string;
}
interface Epoch {
    active: number;
    unknown: boolean;
    sealed: boolean;
}
interface SpawnSpec {
    argv: readonly string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    [key: string]: unknown;
}
interface ProcessHandle {
    done: Promise<unknown>;
    waitForExit: () => Promise<boolean>;
}
interface Scope extends ExecutionBoundaryPolicy {
    epoch: Epoch;
    roots: readonly Identity[];
    protectedAnchors: readonly Identity[];
    readOnlyAnchors: readonly Identity[];
    anchor: Identity;
    bwrap?: string;
    launcher: string;
    onSettled: (agentId: string) => void;
}
interface Carrier {
    primaryProtectionVersion: 2;
    version: 1;
    storage: AsyncLocalStorage<Scope>;
    epochs: Map<string, Epoch>;
    prepareSpawn: (spec: SpawnSpec) => {
        spec: SpawnSpec;
        assertContainment: (mode: string) => void;
        started: (handle: ProcessHandle) => void;
    } | undefined;
    assertFilePath: (path: string) => void;
    assertWorkingDirectory: (agent: AgentLike, current: string, exists?: boolean) => void;
    assertTerminal: () => void;
}
/**
 * 只读 bind 保护的是路径，无法阻断事先存在于 writable bind 中的同 inode alias。
 * verifier 输出域采用 reject-all：任何 hardlink/symlink 都不可信；主树仍只对
 * protected Git inode 求交，避免把普通源码硬链接误判成 Git 写入。
 */
export declare const assertWritableHardlinkBoundary: (writableRoots: readonly {
    path: string;
    identity: string;
}[], protectedRoots: readonly {
    path: string;
    identity: string;
}[], policy?: 'protected-only' | 'reject-all') => void;
/** Process-persistent carrier: old async callbacks remain fenced across plugin reload. */
export declare const getExecutionBoundaryCarrier: () => Carrier;
export declare const createExecutionBoundary: (ctx: PluginContextLike, onSettled: (agentId: string) => void) => {
    available: () => boolean;
    begin: (agentId: string, attemptId: string) => void;
    seal: (agentId: string, attemptId: string) => boolean;
    quiescent: (agentId: string, attemptId: string) => boolean;
    run: <T>(policy: ExecutionBoundaryPolicy | undefined, next: () => Promise<T>) => Promise<T>;
};
export {};
