import type { AgentBinding } from '../agent-binding.js';
import type { DelegationRecord, TaskRecord, TaskStore } from '../evidence.js';
import type { EvidenceAssessment, EvidenceAssessmentBinding } from '../evidence-assessment.js';
import type { FeatureSession } from '../feature-session.js';
import { type AgentLike } from '../host-contract.js';
import type { ToolExecLike } from '../tool-shape.js';
import type { SwarmService } from './service-api.js';
import type { WorktreeRegistry } from '../worktree-binding.js';
export interface ContextQuerySessionPort {
    rootAgent?: AgentLike;
    store: Pick<TaskStore, 'getDelegation' | 'getTaskDelegations'>;
    worktrees?: Pick<WorktreeRegistry, 'project'>;
}
export interface ContextQueryTaskContext {
    session: ContextQuerySessionPort;
    features: FeatureSession;
    task: TaskRecord;
    projectedTask: TaskRecord;
    agent: AgentLike;
    binding?: AgentBinding;
}
export interface ContextQueryToolDeps {
    getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<ContextQueryTaskContext>;
    getBoundEvidenceAssessment: (record: DelegationRecord | undefined) => EvidenceAssessment | undefined;
    evidenceBinding: (task: TaskRecord, features: FeatureSession) => EvidenceAssessmentBinding;
    evidencePrivatePaths: () => readonly string[];
    now: () => number;
}
export type ContextQueryToolUseCases = Pick<SwarmService, 'ReadContext'>;
/** Paginated, revision-bound private context reads; file paths cannot bypass the authorization index. */
export declare const createContextQueryToolUseCase: (deps: ContextQueryToolDeps) => ContextQueryToolUseCases;
