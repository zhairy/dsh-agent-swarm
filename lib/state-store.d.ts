import { type FileHandle } from 'node:fs/promises';
import { type SegmentSpecs, type StatePatch } from './state-chunks.js';
export { StateStoreError, canonicalStateJson } from './state-core.js';
export interface DurableStateStore<T> {
    readonly directory: string;
    /** Local StateStore snapshots/journal are enabled. */
    readonly durable: boolean;
    /** State has at least one durable recovery authority (local StateStore or EventJournal). */
    readonly recoveryDurable: boolean;
    readonly journalOnly: boolean;
    /** Strict durable mode fsyncs directory entries; Windows uses the explicit best-effort fallback described below. */
    readonly directoryDurability: DirectoryDurability;
    /** 完整状态的编码字节上限；内存态与持久化态取值不同，由调用方按模式决定。 */
    readonly maxStateBytes: number;
    /** 最近一次成功提交（或恢复装载）状态的编码字节数；提交失败不改变该读数。 */
    getStateBytes: () => number;
    /** 当前状态的根校验和（分片哈希的规范组合）；用于链校验与诊断。 */
    getRootChecksum: () => string;
    read: () => T;
    readPath?: <R = unknown>(path: readonly (string | number)[]) => R | undefined;
    readFields?: <K extends keyof T>(keys: readonly K[]) => Pick<T, K>;
    getSequence: () => number;
    commit: (type: string, mutate: (draft: T) => T | void | Promise<T | void>) => Promise<T>;
    /**
     * 分片增量提交：只编码/校验/哈希本次变更的分片，日志只写增量。
     * 调用方必须保证补丁覆盖了全部变更（未声明的分片保持已提交内容不变）。
     * 传入函数时在互斥区内以冻结的当前状态求值，使“读取-判断-写补丁”与提交之间没有其它写入者。
     * 返回提交元信息而不是状态快照：增量路径不应为返回值再复制一份完整状态。
     * `changed === false` 表示补丁与已提交内容逐字节一致，未写入日志也未消耗序列号。
     */
    update: (type: string, write: StateWrite<T>) => Promise<{
        readonly sequence: number;
        readonly changed: boolean;
    }>;
    dispose: () => Promise<void>;
}
export type DirectoryDurability = 'strict' | 'windows-best-effort';
export interface DirectorySyncResult {
    status: 'synced' | 'unsupported';
    code?: string;
}
export declare const getDirectoryDurability: (platform?: NodeJS.Platform) => DirectoryDurability;
/**
 * 增量写入的两种形式：直接给补丁，或在互斥区内按冻结基线求值补丁。
 * `build` 形式让“读取-判断-写补丁”与提交同处一个事务，避免读-改-写竞态。
 */
export type StateWrite<T> = {
    readonly patch: unknown;
} | {
    readonly build: (state: T) => unknown | Promise<unknown>;
};
export interface StateValidationIssue {
    path: string;
    code: string;
}
export interface StateValidationReport {
    ok: boolean;
    issues?: readonly StateValidationIssue[];
}
export type StateValidationResult = boolean | StateValidationReport;
export interface StateChunkTouch {
    readonly segment: string;
    readonly key: string;
}
export interface DurableStateOptions<T> {
    directory: string;
    initialState: T;
    validate?: (value: unknown) => StateValidationResult;
    /** 增量提交的按分片校验：只收到本次触碰的分片；未提供时增量提交回退全量 validate。 */
    validateIncremental?: (state: T, changed: readonly StateChunkTouch[]) => StateValidationResult;
    recover?: (state: T) => T;
    /** 顶层段的分片规格；未声明的段按 whole 处理（每次提交整段替换）。 */
    segments?: SegmentSpecs;
    /**
     * 旧布局回放规格：日志行声明的布局不等于 `layoutVersion` 时按它回放。
     * 缺省与 `segments` 相同（不存在布局迁移）。旧目录在这种情形下会在下一次写入时
     * 自动补一条当前布局的全量行，之后的写入才是增量行。
     */
    legacySegments?: SegmentSpecs;
    /** 明确的旧版本规格，逐版本复核旧指纹与根哈希，不能把不同旧布局混作同一规格。 */
    legacyLayouts?: Readonly<Record<number, SegmentSpecs>>;
    /** 当前布局版本；日志行的 `layout` 必须等于它才能直接续写增量行。默认 1。 */
    layoutVersion?: number;
    enabled?: boolean;
    maxStateBytes?: number;
    maxJournalBytes?: number;
    snapshotEvery?: number;
    /** Journal-only stores keep this value as a disposable materialization and never read or write their own snapshot/log. */
    journalOnly?: boolean;
    /** Initial materialized sequence when a journal-only store is hydrated from an external event stream. */
    initialSequence?: number;
    /**
     * Called inside the commit mutex after the next state is validated and before it becomes observable.
     * A rejecting observer aborts the commit, which lets the EventJournal remain the authoritative source.
     */
    beforeCommit?: (observation: StateCommitObservation<T>) => void | Promise<void>;
}
export interface StateCommitObservation<T> {
    kind: 'snapshot' | 'patch';
    type: string;
    sequence: number;
    previousChecksum: string;
    checksum: string;
    state?: T;
    patch?: StatePatch;
    changes?: Record<string, unknown>;
}
/**
 * Persist a directory entry after rename. Windows rejects fsync on a directory
 * handle with EPERM even though the already-fsynced file and same-volume rename
 * succeeded. Report that known Node platform limitation explicitly instead of
 * hiding every permission error or claiming Linux-style directory durability.
 */
export declare const syncDirectory: (directory: string, options?: {
    platform?: NodeJS.Platform;
    openDirectory?: (path: string, flags: string) => Promise<Pick<FileHandle, 'sync' | 'close'>>;
}) => Promise<DirectorySyncResult>;
export declare const atomicStateFile: (directory: string, name: string, content: string) => Promise<void>;
/** Conservative local stopped-owner handshake; remote/NFS owners and reused live PIDs are never stolen. */
export declare const reconcileStoppedStateOwner: (directory: string) => Promise<boolean>;
/** Complete committed states form the journal. Auditing/redacted ledgers are never recovery inputs. */
export declare const createDurableStateStore: <T>(options: DurableStateOptions<T>) => Promise<DurableStateStore<T>>;
