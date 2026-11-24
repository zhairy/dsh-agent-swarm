import type { AgentLike, PluginContextLike } from '../../host-contract.js';
import type { CreatedWorktreeInfo, WorktreeObservation } from '../../worktree-binding.js';
import { type WorkspacePlan } from '../../workspace-policy.js';
export interface WorktreeHostPort {
    cwd: (agent: AgentLike) => string;
    setCwd: (agent: AgentLike, path: string, signal: AbortSignal) => Promise<string>;
    createLinkedWorktree?: (agent: AgentLike, request: {
        name?: string;
        from: string;
    }, signal: AbortSignal) => Promise<CreatedWorktreeInfo>;
    inspect: (agent: AgentLike, record: CreatedWorktreeInfo, signal: AbortSignal) => Promise<WorktreeObservation>;
    inspectWorkspace?: (agent: AgentLike, signal: AbortSignal, ruleRoot?: string) => Promise<{
        record: CreatedWorktreeInfo;
        plan: WorkspacePlan;
    }>;
}
/** No direct process/file access: all inspection is confined by the calling Host policy. */
export declare const createHostWorktreePort: (ctx: PluginContextLike) => WorktreeHostPort;
