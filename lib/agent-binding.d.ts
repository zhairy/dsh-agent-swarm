import type { DurableStateStore } from './state-store.js';
export interface AgentBinding {
    agentId: string;
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    nodeId: string;
    attemptId: string;
    threadId: string;
    role: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    permissions: string[];
    generation: number;
    leaseEpoch: number;
    state: 'active' | 'suspended' | 'revoked';
    blindReview?: boolean;
    revocationReason?: 'completed' | 'superseded' | 'cancelled' | 'untrusted';
}
export interface BindingState {
    bindings: Record<string, AgentBinding>;
    bindingHistory: Record<string, AgentBinding>;
}
export type BindingInput = Omit<AgentBinding, 'generation' | 'leaseEpoch' | 'state' | 'revocationReason'>;
export declare class BindingError extends Error {
    readonly code: 'BINDING_INVALID' | 'BINDING_INACTIVE' | 'PERMISSION_DENIED' | 'STALE_BINDING';
    constructor(code: 'BINDING_INVALID' | 'BINDING_INACTIVE' | 'PERMISSION_DENIED' | 'STALE_BINDING', message: string);
}
export declare const bindingKey: (binding: Pick<AgentBinding, 'agentId' | 'generation' | 'leaseEpoch'>) => string;
export declare const validateBinding: (raw: unknown) => raw is AgentBinding;
export interface AgentBindingRegistry {
    bind: (input: BindingInput) => Promise<AgentBinding>;
    get: (agentId: string) => AgentBinding | undefined;
    requireActive: (agentId: string, permission?: string) => AgentBinding;
    getHistorical: (binding: Pick<AgentBinding, 'agentId' | 'generation' | 'leaseEpoch'>) => AgentBinding | undefined;
    revoke: (agentId: string, reason?: AgentBinding['revocationReason'], expectedAttemptId?: string) => Promise<void>;
    suspend: (agentId: string) => Promise<void>;
    completeBlindReview: (agentId: string) => Promise<void>;
}
/** 主状态里每个 agentId 保留的历史绑定条数；更老的条目先写归档再移出状态，分片数因此有界。 */
export declare const MAX_BINDING_HISTORY_PER_AGENT = 4;
/** 归档回调：先落盘成功再提交状态删除，避免崩溃窗口里出现「已从状态移除但未归档」。 */
export interface AgentBindingRegistryOptions {
    maxHistoryPerAgent?: number;
    /** Returning false keeps history in the authoritative state instead of pruning it. */
    archive?: (entries: readonly AgentBinding[]) => Promise<void | boolean>;
}
/** Only host/service lifecycle code calls bind; tool parameters never create identities. */
export declare const createAgentBindingRegistry: <T extends BindingState>(store: DurableStateStore<T>, options?: AgentBindingRegistryOptions) => AgentBindingRegistry;
