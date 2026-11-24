import type { AgentLike } from '../host-contract.js';
import type { SwarmEventJournal } from '../event-journal.js';
import { type CreatedWorktreeInfo, type WorktreeRegistry, type WorktreeOwner, type WorktreeBindingInfo } from '../worktree-binding.js';
import type { WorktreeHostPort } from '../adapters/dsh-host/worktree.js';
import type { WorkspaceLease, WorkspaceLeaseManager } from '../util/workspace-lease.js';
import { type WorkspacePlan } from '../workspace-policy.js';
/** 主树沿用当前 attempt 已取得的路径排他租约，不能为同一路径再申请第二份租约。 */
export declare const bindPrimaryWorkspace: (input: {
    record: CreatedWorktreeInfo;
    expectedHead: string;
    agent: AgentLike;
    owner: WorktreeOwner;
    signal: AbortSignal;
    workspacePlan: WorkspacePlan;
    registry: WorktreeRegistry;
    journal: SwarmEventJournal;
    host: WorktreeHostPort;
    leases: WorkspaceLeaseManager;
    lease: WorkspaceLease;
    lock: {
        run: <T>(next: () => Promise<T>) => Promise<T>;
    };
    assertCurrent: () => void;
    retainLease: (lease: WorkspaceLease, record: WorktreeBindingInfo) => void;
}) => Promise<WorktreeBindingInfo>;
