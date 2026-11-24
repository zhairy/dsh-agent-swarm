import type { AgentLike, PluginContextLike } from '../../host-contract.js';
export type WorkspaceGitMutationOperation = 'add' | 'commit';
export type WorkspaceGitErrorCode = 'WORKSPACE_GIT_INVALID' | 'WORKSPACE_GIT_BOUNDARY_REQUIRED' | 'WORKSPACE_GIT_POLICY_DENIED' | 'WORKSPACE_GIT_STATE_REJECTED' | 'WORKSPACE_GIT_PATH_REJECTED' | 'WORKSPACE_GIT_FILTER_DENIED' | 'WORKSPACE_GIT_CANCELLED' | 'WORKSPACE_GIT_FAILED' | 'WORKSPACE_GIT_UNCERTAIN';
export interface WorkspaceGitSaveInput {
    repositoryRoot: string;
    path: string;
    branch: string;
    expectedHead: string;
    paths: readonly string[];
    message: string;
    writeScopes: readonly string[];
}
export interface WorkspaceGitSaveResult {
    head: string;
    previousHead: string;
    paths: readonly string[];
}
export interface WorkspaceGitPort {
    save: (agent: AgentLike, input: WorkspaceGitSaveInput, signal: AbortSignal) => Promise<WorkspaceGitSaveResult>;
}
interface WorkspaceGitErrorOptions {
    cause?: unknown;
    uncertain?: boolean;
    operation?: WorkspaceGitMutationOperation;
    previousHead?: string;
    head?: string;
    paths?: readonly string[];
}
export declare class WorkspaceGitError extends Error {
    readonly code: WorkspaceGitErrorCode;
    readonly uncertain: boolean;
    readonly operation?: WorkspaceGitMutationOperation;
    readonly previousHead?: string;
    readonly head?: string;
    readonly paths: readonly string[];
    constructor(code: WorkspaceGitErrorCode, message: string, options?: WorkspaceGitErrorOptions);
}
export declare const createWorkspaceGitPort: (ctx: PluginContextLike) => WorkspaceGitPort;
export {};
