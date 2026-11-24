import type { AgentLike } from '../host-contract.js';
import type { SwarmEventJournal } from '../event-journal.js';
import { type WorktreeBindingInfo, type WorktreeOwner, type WorktreeRegistry } from '../worktree-binding.js';
import type { WorktreeHostPort } from '../adapters/dsh-host/worktree.js';
import type { WorkspaceLease, WorkspaceLeaseManager } from '../util/workspace-lease.js';
import { type WorkspacePlan } from '../workspace-policy.js';
export interface RestoreWorktreeInput {
    id: string;
    agent: AgentLike;
    owner: WorktreeOwner;
    signal: AbortSignal;
    registry: WorktreeRegistry;
    journal: SwarmEventJournal;
    host: WorktreeHostPort;
    leases: WorkspaceLeaseManager;
    lock: {
        run: <T>(operation: () => Promise<T>) => Promise<T>;
    };
    assertCurrent: () => void;
    confirmStopped: (previous: WorktreeBindingInfo) => Promise<void>;
    assertStopped: (previous: WorktreeBindingInfo) => void;
    getLease: (record: WorktreeBindingInfo) => WorkspaceLease | undefined;
    /** 新 attempt 已在根路径排队取得的租约；仅 primary 可复用，避免对同一路径自锁。 */
    primaryLease?: WorkspaceLease;
    expectedHead?: string;
    workspacePlan?: WorkspacePlan;
    retainLease: (lease: WorkspaceLease, record: WorktreeBindingInfo) => void;
    warn: (message: string) => void;
}
/** The only ownership publication path; durable commit and activation are separate boundaries. */
export declare const restoreRetainedWorktree: (input: RestoreWorktreeInput) => Promise<WorktreeBindingInfo>;
