import type { DurableStateStore } from './state-store.js';
import { type MemoryQuery } from './memory.js';
import { type ToolCandidateMetadata } from './tool-candidate.js';
import { type EvolutionCanaryScope, type EvolutionEvaluationResult, type EvolutionGovernance, type EvolutionReleaseRef } from './evolution-governance.js';
export interface ExperienceSource {
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    artifactDigest: string;
    authorId?: string;
}
export interface ExperienceEntry {
    id: string;
    problemClass: string;
    appliesWhen: string[];
    doesNotApplyWhen: string[];
    conclusion: string;
    source: ExperienceSource;
    verification: string[];
    counterexamples: string[];
    operatorVersions: string[];
    status: 'candidate' | 'validated' | 'deprecated';
    createdAt: number;
    expiresAt: number;
    reviewer?: string;
    reviewArtifactDigest?: string;
    deprecationReason?: string;
    toolCandidate?: ToolCandidateMetadata;
    governance?: EvolutionGovernance;
}
export interface ExperienceState {
    experiences: Record<string, ExperienceEntry>;
}
export interface ExperienceReview {
    reviewer: string;
    author: string;
    reviewArtifactDigest: string;
    sourceArtifactDigest: string;
    evidenceComplete: boolean;
    unresolvedSevere: number;
    applicabilityConfirmed: boolean;
}
export declare class ExperienceError extends Error {
    readonly code: 'EXPERIENCE_INVALID' | 'EXPERIENCE_REVIEW_REQUIRED' | 'EXPERIENCE_CONFLICT';
    constructor(code: 'EXPERIENCE_INVALID' | 'EXPERIENCE_REVIEW_REQUIRED' | 'EXPERIENCE_CONFLICT', message: string);
}
export interface EvolutionTransitionRequest {
    expectedRevision: number;
    requestId: string;
}
export declare const createExperienceRepository: <T extends ExperienceState>(store: DurableStateStore<T>, options?: {
    now?: () => number;
    maxEntries?: number;
    verifyReview?: (entry: ExperienceEntry, review: ExperienceReview) => boolean | Promise<boolean>;
    verifyEvaluation?: (entry: ExperienceEntry, result: EvolutionEvaluationResult) => boolean | Promise<boolean>;
    verifyRelease?: (entry: ExperienceEntry, release: EvolutionReleaseRef) => boolean | Promise<boolean>;
    verifyCanary?: (entry: ExperienceEntry, scope: EvolutionCanaryScope, authorizationRef: string, stopPolicyDigest: string) => boolean | Promise<boolean>;
}) => {
    getExperienceDigest: (id: string) => string | undefined;
    get: (id: string) => ExperienceEntry | undefined;
    addCandidate: (input: Omit<ExperienceEntry, 'id' | 'status' | 'createdAt' | 'reviewer' | 'reviewArtifactDigest' | 'deprecationReason' | 'governance'>) => Promise<ExperienceEntry>;
    promote: (id: string, review: ExperienceReview) => Promise<ExperienceEntry>;
    deprecate: (id: string, reason: string) => Promise<void>;
    beginEvaluation: (id: string, input: EvolutionTransitionRequest & {
        traceDigest: string;
        baselineDigest: string;
        candidateDigest: string;
    }) => Promise<ExperienceEntry>;
    recordEvaluation: (id: string, result: EvolutionEvaluationResult, review: ExperienceReview, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    registerRelease: (id: string, release: EvolutionReleaseRef, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    startShadow: (id: string, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    recordShadow: (id: string, recommendation: 'continue' | 'stop', input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    requestCanary: (id: string, scope: EvolutionCanaryScope, stopPolicyDigest: string, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    authorizeCanary: (id: string, scope: EvolutionCanaryScope, authorizationRef: string, stopPolicyDigest: string, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    activateCanary: (id: string, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    stopCanary: (id: string, reason: string, safetyViolation: boolean, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    promoteCanary: (id: string, reason: string | undefined, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    revoke: (id: string, reason: string, unresolvedHandles: number, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    reconcile: (id: string, reason: string, input: EvolutionTransitionRequest) => Promise<ExperienceEntry>;
    /** Restart recovery is deliberately separate from an operator transition. */
    recover: (id: string) => Promise<ExperienceEntry | undefined>;
    listForTask: (taskId: string) => ExperienceEntry[];
    query: (query: MemoryQuery) => import("./memory.js").MemoryQueryResult;
    list: (problemClass?: string, includeCandidates?: boolean) => ExperienceEntry[];
};
