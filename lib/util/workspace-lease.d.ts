export type WorkspaceLeaseKind = 'write' | 'edit' | 'verify';
export declare class WorkspaceLeaseError extends Error {
    readonly code: 'WORKSPACE_BUSY' | 'MUTATION_UNKNOWN' | 'LEASE_INVALID' | 'ABORTED';
    constructor(code: 'WORKSPACE_BUSY' | 'MUTATION_UNKNOWN' | 'LEASE_INVALID' | 'ABORTED', message: string);
}
export interface WorkspaceLease {
    workspaceId: string;
    cwd: string;
    owner: string;
    kind: WorkspaceLeaseKind;
    leaseEpoch: number;
    leaseId: string;
    release: (options?: {
        confirmedStopped?: boolean;
    }) => Promise<void>;
}
export interface WorkspaceLeaseManager {
    acquire: (cwd: string, owner: string, kind: WorkspaceLeaseKind, signal?: AbortSignal, options?: {
        wait?: boolean;
    }) => Promise<WorkspaceLease>;
    getStatus: (cwd: string) => Promise<{
        workspaceId: string;
        busy: boolean;
        mutationUnknown: boolean;
        owner?: string;
        leaseEpoch: number;
    }>;
    peekStatus: (cwd: string) => {
        workspaceId: string;
        busy: boolean;
        mutationUnknown: boolean;
        owner?: string;
        leaseEpoch: number;
    } | undefined;
    isCurrent: (lease: WorkspaceLease) => boolean;
    reconcile: (cwd: string, owner: string, confirmedStopped: boolean) => Promise<void>;
    reconcileStoppedProcess: (cwd: string) => Promise<boolean>;
}
export declare const createWorkspaceLeaseManager: (options?: {
    ownerDirectory?: string;
}) => WorkspaceLeaseManager;
