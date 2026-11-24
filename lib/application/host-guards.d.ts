import type { AgentBinding } from '../agent-binding.js';
import type { SwarmConfigInfo } from '../config.js';
import type { TaskRecord } from '../evidence.js';
import type { AgentControlRecord } from '../agent-control.js';
import type { TicketRepository } from '../domain/tickets/repository.js';
import type { WorktreeRegistry } from '../worktree-binding.js';
import { type WorktreeBindingInfo } from '../worktree-binding.js';
import { type AgentLike, type ToolExecutionLike } from '../host-contract.js';
import { type RoleId } from '../role-registry.js';
export interface GuardSessionPort {
    rootAgent?: AgentLike;
    rootEditAt: number;
    store: Pick<TicketRepository, 'getTask' | 'getTasks'>;
    features?: {
        bindings: {
            get: (agentId: string) => AgentBinding | undefined;
        };
    };
    worktrees: Pick<WorktreeRegistry, 'canCreate' | 'findByAgent' | 'findByTask' | 'isRestoring'>;
}
export interface HostGuardDeps {
    getConfig: () => SwarmConfigInfo;
    now: () => number;
    isRootTianShu: (agent: AgentLike) => boolean;
    getGoalCompletionReason: (agent: AgentLike) => string | undefined;
    getAgentControl: (agentId: string) => AgentControlRecord | undefined;
    hasManagedChildPreset: (agent: AgentLike) => boolean;
    hasChildOwner: (agentId: string) => boolean;
    isStartingChild: (agentId: string) => boolean;
    isClosing: () => boolean;
    isManagedAgent: (agent: AgentLike | undefined) => boolean;
    getRoleForAgent: (agent: AgentLike | undefined) => RoleId | undefined;
    getSession: (sessionId: string) => GuardSessionPort;
    getChildOwner: (agentId: string) => string | undefined;
    getChildSignal: (agentId: string) => AbortSignal | undefined;
    getTaskSchemaNames: (agent: AgentLike) => readonly {
        name: string;
    }[];
    isQuarantined: (taskId: string, rootSessionId: string) => boolean;
    isBindingCurrent: (session: GuardSessionPort, binding: AgentBinding, agent: AgentLike, task: TaskRecord) => boolean;
    privateStateRoots: () => readonly string[];
    recoveryStateRoots?: () => readonly string[];
    isWorkspaceMutationUnknown: (cwd: string) => boolean;
    getCurrentCwd?: (agent: AgentLike) => string;
    isWorktreeWriter?: (agent: AgentLike, binding: AgentBinding, worktree: WorktreeBindingInfo) => boolean;
}
export interface HostGuardUseCases {
    AddRootEdit: (agent: AgentLike | undefined, role: RoleId | undefined) => void;
    getGuardReason: (execution: ToolExecutionLike) => string | undefined;
}
/** Pure application guard. Host approval remains authoritative and is consumed through a callback-safe adapter. */
export declare const createHostGuardUseCases: (deps: HostGuardDeps) => HostGuardUseCases;
