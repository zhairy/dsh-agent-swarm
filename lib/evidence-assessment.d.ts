import type { DelegationRecord } from './evidence.js';
import { type JevAskOutcome, type JevClient } from './jev.js';
export declare const EVIDENCE_QUESTION_VERSION = "exploration-evidence-v1";
export type EvidenceDisposition = 'usable' | 'needs-review' | 'quarantined';
export interface EvidenceAssessmentBinding {
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    artifactDigest: string;
}
export interface EvidenceAxis {
    status: 'known' | 'unknown';
    score?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
    reason?: string;
}
export interface ObservedCodeReference {
    path: string;
    status: 'observed' | 'unknown';
    kind: 'code' | 'manifest';
    digest?: string;
    excerpt?: string;
    excerptDigest?: string;
    startLine?: number;
    endLine?: number;
    truncated?: boolean;
    reason?: string;
}
export interface ObservedExternalSource {
    text: string;
    retrievedAt: number;
    finalUrl?: string;
    publishedAt?: string;
    version?: string;
}
export interface EvidenceAssessmentItem {
    id: string;
    claim: string;
    source: {
        kind: 'code' | 'external' | 'unlocated';
        locator: string;
        status: 'observed' | 'unknown';
        digest?: string;
        supportingText?: string;
        retrievedAt?: number;
        reportedDate?: string;
        reportedVersion?: string;
        observedVersion?: string;
        observedUrl?: string;
        observedPublishedAt?: string;
        truncated?: boolean;
        reason?: string;
    };
    codeReferences: string[];
    credibility: EvidenceAxis;
    relevance: EvidenceAxis;
    support: {
        relation: 'supports' | 'contradicts' | 'insufficient' | 'unknown';
        confidence?: number;
    };
    disposition: EvidenceDisposition;
    reasons: string[];
    model?: string;
    /** A claim may be quarantined while its contrary source facts remain available for review. */
    contraryEvidenceRetained: boolean;
    judgments: {
        credibility: EvidenceAxis;
        relevance: EvidenceAxis;
        support: EvidenceAssessmentItem['support'];
    };
}
export interface EvidenceAssessment {
    schemaVersion: 1;
    questionVersion: string;
    role: 'tan_wei' | 'bo_wen';
    delegationId: string;
    binding: EvidenceAssessmentBinding;
    rawDigest: string;
    projectDigest: string;
    assessedAt: number;
    status: 'ok' | 'partial' | 'unknown';
    disposition: EvidenceDisposition;
    items: EvidenceAssessmentItem[];
    codeReferences: ObservedCodeReference[];
    /** This is the model's distribution concentration, never a measured probability of correctness. */
    confidenceMeaning: 'distribution-concentration-not-correctness';
    rawRetained: true;
}
export interface EvidenceAssessmentPolicy {
    minimumCredibility: number;
    minimumRelevance: number;
    minimumConfidence: number;
    quarantineBelow: number;
    maxAgeMs: number;
    maxSourceBytes: number;
    maxExcerptChars: number;
}
export declare const DEFAULT_EVIDENCE_POLICY: Readonly<EvidenceAssessmentPolicy>;
export interface EvidenceAssessmentInput {
    cwd: string;
    binding: EvidenceAssessmentBinding;
    goal: string;
    acceptance: string[];
    scope: string[];
    /** Server-selected actual artifact paths; never agent self-assigned relevance scores. */
    projectPaths?: string[];
    record: DelegationRecord;
}
export interface EvidenceAssessmentDeps {
    /** 服务端核验目标后的内部路径映射；不得用于改写原始来源或绕过 inside 检查。 */
    mapCodePath?: (path: string) => string;
    ask: JevClient['ask'];
    now?: () => number;
    policy?: Partial<EvidenceAssessmentPolicy>;
    privatePaths?: string[];
    /** Host-observed web content. A URL or the exploring agent's summary is not a fetched source. */
    resolveSource?: (url: string, signal?: AbortSignal) => Promise<ObservedExternalSource | undefined>;
    onJevOutcome?: (outcome: JevAskOutcome, itemId?: string) => void;
}
export declare const EVIDENCE_ASSESSMENT_QUESTIONS: Record<string, unknown>;
/** One independent set of semantic judgments per claim; no local Jev RPS, concurrency, call or fee budget. */
export declare const assessExplorationEvidence: (input: EvidenceAssessmentInput, deps: EvidenceAssessmentDeps, signal?: AbortSignal) => Promise<EvidenceAssessment | undefined>;
export interface EvidenceConsumptionNotice {
    status: 'current' | 'stale' | 'unknown';
    disposition: EvidenceDisposition;
    mayUseForImplementation: boolean;
    requiresVerification: boolean;
    reasons: string[];
    usableItemIds: string[];
    reviewItemIds: string[];
    rawRetained: true;
    confidenceMeaning: EvidenceAssessment['confidenceMeaning'];
}
export declare const getEvidenceConsumptionNotice: (assessment: EvidenceAssessment | undefined, current: EvidenceAssessmentBinding, now: number, policy?: Partial<EvidenceAssessmentPolicy>) => EvidenceConsumptionNotice;
/** Read-time code fingerprints are rechecked even when task scope/card/flow themselves did not change. */
export declare const revalidateEvidenceAssessment: (assessment: EvidenceAssessment | undefined, input: {
    cwd: string;
    binding: EvidenceAssessmentBinding;
}, deps?: Pick<EvidenceAssessmentDeps, 'now' | 'privatePaths' | 'policy'>) => Promise<EvidenceConsumptionNotice>;
export declare const validateEvidenceAssessment: (raw: unknown) => raw is EvidenceAssessment;
