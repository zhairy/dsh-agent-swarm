import { type AgentBinding, type AgentBindingRegistry, type BindingState } from './agent-binding.js';
import { type DurableStateStore } from './state-store.js';
export declare const MESSAGE_KINDS: readonly ['question', 'answer', 'finding', 'review-response'];
export interface ExpertMessage {
    schemaVersion: 1;
    id: string;
    taskId: string;
    rootSessionId: string;
    workspaceId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    fromAgentId: string;
    toAgentId: string;
    fromThreadId: string;
    toThreadId: string;
    senderAttemptId: string;
    senderGeneration: number;
    senderLeaseEpoch: number;
    recipientGeneration: number;
    recipientLeaseEpoch: number;
    nodeId: string;
    kind: typeof MESSAGE_KINDS[number];
    correlationId?: string;
    createdAt: number;
    expiresAt: number;
    summary: string;
    artifactRefs: string[];
    payloadDigest: string;
}
export interface MessageAck {
    messageId: string;
    recipientBinding: string;
    acknowledgedAt: number;
}
export interface MessageState extends BindingState {
    messages: Record<string, ExpertMessage>;
    messageAcks: Record<string, Record<string, MessageAck>>;
}
export interface SendMessageInput {
    toAgentId: string;
    taskId: string;
    kind: ExpertMessage['kind'];
    summary: string;
    artifactRefs?: string[];
    correlationId?: string;
    ttlMs?: number;
    messageId?: string;
}
export interface MessageBusOptions<T extends MessageState> {
    store: DurableStateStore<T>;
    bindings: AgentBindingRegistry;
    now?: () => number;
    maxPendingPerTask?: number;
    maxRetainedMessages?: number;
    maxSummaryBytes?: number;
    maxEnvelopeBytes?: number;
    maxTtlMs?: number;
    validateArtifactRef?: (ref: string, binding: AgentBinding) => boolean;
}
export declare class MessageBusError extends Error {
    readonly code: 'MESSAGE_INVALID' | 'RECEIVER_UNAVAILABLE' | 'IDENTITY_DENIED' | 'MESSAGE_LIMIT' | 'MESSAGE_CORRUPT' | 'PERSISTENCE_REQUIRED' | 'MESSAGE_CONFLICT';
    constructor(code: 'MESSAGE_INVALID' | 'RECEIVER_UNAVAILABLE' | 'IDENTITY_DENIED' | 'MESSAGE_LIMIT' | 'MESSAGE_CORRUPT' | 'PERSISTENCE_REQUIRED' | 'MESSAGE_CONFLICT', message: string);
}
export interface MessageBus {
    send: (agentId: string, input: SendMessageInput) => Promise<ExpertMessage>;
    pull: (agentId: string, input?: {
        limit?: number;
    }) => Promise<{
        messages: ExpertMessage[];
        stale: string[];
    }>;
    ack: (agentId: string, input: {
        messageIds: string[];
    }) => Promise<{
        acknowledged: string[];
    }>;
}
/** Private immutable files plus durable index/ACK transactions; delivery is pull and at-least-once. */
export declare const createMessageBus: <T extends MessageState>(options: MessageBusOptions<T>) => MessageBus;
