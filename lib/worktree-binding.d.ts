import type { LedgerEvent } from './evidence.js';
import type { SwarmEvent } from './event-journal.js';
/** 百工的 create-only 模型合同；alpha2 通过 Host create API 实现，不透传隐式 enter。 */
export declare const WORKTREE_TOOL = "create_worktree";
export declare const RESTORE_WORKTREE_TOOL = "swarm_restore_worktree";
export declare const PRIMARY_WORKSPACE_TOOL = "swarm_bind_primary_workspace";
export declare const WORKSPACE_GIT_SAVE_TOOL = "swarm_git_save";
export declare const VERIFICATION_OUTPUT_TOOL = "swarm_prepare_verification";
export declare const isWorktreeMutationTool: (name: string) => boolean;
export interface WorktreeAuthorization {
    attemptId: string;
    nodeId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
    generation: number;
    leaseEpoch: number;
}
export interface WorktreeObservation {
    repositoryIdentity: string;
    directoryIdentity: string;
    gitIdentity: string;
    commonIdentity: string;
    gitDirectory: string;
    commonDirectory: string;
    head: string;
}
export interface WorktreeOwner {
    agentId: string;
    taskId: string;
    delegationId: string;
    execution?: WorktreeAuthorization;
}
export interface CreatedWorktreeInfo {
    /** 缺省值保留旧 linked 记录；primary 只能由可信 Host 绑定入口产生。 */
    kind?: 'linked' | 'primary';
    path: string;
    branch: string;
    baseCommit: string;
    repositoryRoot: string;
}
export interface WorktreeBindingInfo extends CreatedWorktreeInfo, WorktreeOwner {
    worktreeId: string;
    taskId: string;
    delegationId: string;
    agentId: string;
    state: 'active' | 'recovery-required';
    retention: 'manual-only';
    createdAt: number;
    ownershipRevision: number;
    observation?: WorktreeObservation;
}
export declare const getWorktreeOwnerKey: (owner: WorktreeOwner) => string;
export declare const isSameWorktreeIdentity: (left: WorktreeObservation, right: WorktreeObservation) => boolean;
/** 只接受 DSH 官方工具声明的四个结果字段；同时兼容直接结果和文本渲染结果。 */
export declare const ParseCreatedWorktree: (value: unknown) => CreatedWorktreeInfo | undefined;
export interface WorktreeRegistry {
    canCreate: (input: {
        agentId: string;
        taskId: string;
    }) => string | undefined;
    bind: (input: CreatedWorktreeInfo & WorktreeOwner & {
        observation?: WorktreeObservation;
    }) => WorktreeBindingInfo;
    findById: (id: string) => WorktreeBindingInfo | undefined;
    reserve: (id: string) => () => void;
    isRestoring: (id: string) => boolean;
    suspend: (id: string) => void;
    prepareRestore: (id: string, expected: WorktreeBindingInfo, owner: WorktreeOwner, observation: WorktreeObservation) => WorktreeBindingInfo;
    publishRestore: (expected: WorktreeBindingInfo, next: WorktreeBindingInfo) => void;
    activate: (id: string, ownerKey: string, observation?: WorktreeObservation) => WorktreeBindingInfo;
    findByAgent: (agentId: string) => WorktreeBindingInfo | undefined;
    findByTask: (taskId: string) => WorktreeBindingInfo[];
    findByPath: (path: string) => WorktreeBindingInfo | undefined;
    project: (taskId?: string) => WorktreeBindingInfo[];
    hydrate: (events: readonly LedgerEvent[]) => void;
    hydrateJournal: (events: readonly SwarmEvent[]) => void;
}
/** Per-root registry. A retained worktree is never reused across tickets or assignments. */
export declare const intWorktreeRegistry: (deps?: {
    now?: () => number;
}) => WorktreeRegistry;
