import { type AgentLike } from '../host-contract.js';
import type { DelegationRecord, TaskRecord } from '../evidence.js';
import type { FeatureSession } from '../feature-session.js';
import type { SwarmService } from './service-api.js';
import type { ToolExecLike } from '../tool-shape.js';
import { type EvidenceAssessment, type EvidenceAssessmentBinding } from '../evidence-assessment.js';
export interface QueryBindingPort {
    agentId: string;
    blindReview?: boolean;
}
export interface QuerySessionPort {
    rootAgent?: AgentLike;
    store: {
        getDelegation: (delegationId: string) => DelegationRecord | undefined;
    };
}
export interface QueryTaskContext {
    session: QuerySessionPort;
    features: FeatureSession;
    task: TaskRecord;
    agent: AgentLike;
    binding?: QueryBindingPort;
}
export interface QueryToolDeps {
    getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<QueryTaskContext>;
    privateStateRoots: () => readonly string[];
    getCurrentCwd?: (agent: AgentLike) => string;
    evidencePrivatePaths: () => readonly string[];
    getBoundEvidenceAssessment: (record: DelegationRecord | undefined) => EvidenceAssessment | undefined;
    evidenceBinding: (task: TaskRecord, features: FeatureSession) => EvidenceAssessmentBinding;
    now: () => number;
    isMessageBusEnabled: () => boolean;
}
export type QueryToolUseCases = Pick<SwarmService, 'ProjectFiles' | 'MessageSend' | 'MessageRead' | 'MessageAck'>;
/** Read-only project discovery and expert mailbox use cases. */
export declare const createQueryToolUseCases: (deps: QueryToolDeps) => QueryToolUseCases;
