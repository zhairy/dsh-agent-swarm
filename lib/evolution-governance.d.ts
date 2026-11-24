export declare const EVOLUTION_POLICY_VERSION = "swarm-evolution/3.1.4-v1";
export declare const EVOLUTION_SCHEMA_VERSION = 1;
export declare const EVOLUTION_MAX_GROUPS = 256;
export declare const EVOLUTION_MAX_STEPS = 2048;
export declare const EVOLUTION_MAX_REQUEST_HISTORY = 32;
export type EvolutionDecision = 'continue' | 'wait' | 'stop';
export type EvolutionExpected = 'continue' | 'wait' | 'stop' | 'unknown';
export type EvolutionSeverity = 'normal' | 'severe';
export type EvolutionPhase = 'candidate' | 'evaluating' | 'validated' | 'released' | 'shadow' | 'canary' | 'active' | 'failed' | 'stopped' | 'revoked' | 'reconcile-required';
export interface EvolutionTokenUsage {
    actual: number;
    estimated: number;
    unknown: number;
}
export interface EvolutionWaitHandleObservation {
    id: string;
    kind: 'tool' | 'user' | 'authorization' | 'goal';
    state: 'open' | 'settled' | 'unknown';
}
export interface EvolutionReplayStep {
    id: string;
    projectionDigest: string;
    artifactDigest: string;
    baselineDecision: EvolutionDecision;
    expected: EvolutionExpected;
    severity: EvolutionSeverity;
    waitHandle?: EvolutionWaitHandleObservation;
    novelEvidence: boolean;
    userResume?: boolean;
    operationalTokens: EvolutionTokenUsage;
    evaluationTokens: EvolutionTokenUsage;
}
export interface EvolutionReplayGroup {
    id: string;
    lineageId: string;
    evidenceSequenceDigest: string;
    steps: EvolutionReplayStep[];
}
export interface EvolutionReplayTrace {
    schemaVersion: 1;
    split: 'development' | 'calibration' | 'acceptance';
    baselineDigest: string;
    candidateDigest: string;
    engineVersion: string;
    policyVersion: string;
    seed: number;
    groups: EvolutionReplayGroup[];
}
export interface EvolutionDecisionPolicy {
    schemaVersion: 1;
    id: string;
    repeatThreshold: number;
    respectOpenWait: boolean;
    resetOnNewEvidence: boolean;
}
export interface EvolutionMetricCounts {
    expectedDecisions: number;
    falseStops: number;
    legitimateWaitFalseStops: number;
    falsePasses: number;
    severeFalsePasses: number;
    trueStops: number;
    validWaits: number;
    unknown: number;
}
export interface EvolutionMetricSummary extends EvolutionMetricCounts {
    groupCount: number;
    stepCount: number;
    falseStopGroups: number;
    falsePassGroups: number;
    falseStopUpper95: number;
    falsePassUpper95: number;
}
export interface EvolutionEvaluationResult {
    schemaVersion: 1;
    policyVersion: string;
    engineVersion: string;
    traceDigest: string;
    policyDigest: string;
    split: EvolutionReplayTrace['split'];
    seed: number;
    baselineDigest: string;
    candidateDigest: string;
    groupCount: number;
    stepCount: number;
    replayDigests: [string, string, string];
    deterministic: boolean;
    sideEffects: 0;
    networkCalls: 0;
    operationalTokens: EvolutionTokenUsage;
    evaluationTokens: EvolutionTokenUsage;
    metrics: {
        candidate: EvolutionMetricSummary;
        baseline: EvolutionMetricSummary;
    };
    statisticalClaim: 'not-zero-risk' | 'insufficient-independent-groups';
    outcome: 'passed' | 'failed' | 'unavailable';
    recommendation: 'manual-canary-review' | 'blocked';
    reasons: string[];
    digest: string;
}
export interface EvolutionEvaluationState {
    state: 'missing' | 'pending' | 'passed' | 'failed' | 'unavailable';
    resultDigest?: string;
    traceDigest?: string;
    baselineDigest?: string;
    candidateDigest?: string;
    split?: EvolutionReplayTrace['split'];
    groupCount?: number;
    stepCount?: number;
    falseStops?: number;
    legitimateWaitFalseStops?: number;
    falsePasses?: number;
    severeFalsePasses?: number;
    unknown?: number;
    falseStopUpper95?: number;
    falsePassUpper95?: number;
    operationalTokens?: EvolutionTokenUsage;
    evaluationTokens?: EvolutionTokenUsage;
    observedAt?: number;
}
export interface EvolutionReleaseRef {
    releaseId: string;
    version: string;
    gitCommit: string;
    artifactSha256: string;
    manifestDigest: string;
    policyVersion: string;
    previousVersion?: string;
    registeredAt: number;
}
export interface EvolutionShadowState {
    state: 'not_started' | 'observing' | 'stopped';
    samples: number;
    recommendation: 'unknown' | 'continue' | 'stop';
    changedExecution: false;
    startedAt?: number;
    updatedAt?: number;
}
export interface EvolutionCanaryScope {
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    lineageId: string;
}
export interface EvolutionCanaryState {
    state: 'not_requested' | 'awaiting_user' | 'authorized' | 'active' | 'stopped' | 'complete';
    safetyViolations: number;
    stopPolicyDigest?: string;
    scope?: EvolutionCanaryScope;
    authorizationRef?: string;
    startedAt?: number;
    updatedAt?: number;
    reason?: string;
}
export interface EvolutionRevokeState {
    state: 'none' | 'requested' | 'pending_inflight' | 'complete' | 'blocked';
    unresolvedHandles: number;
    reason?: string;
    requestedAt?: number;
    updatedAt?: number;
}
export interface EvolutionGovernance {
    schemaVersion: 1;
    revision: number;
    phase: EvolutionPhase;
    evaluation: EvolutionEvaluationState;
    shadow: EvolutionShadowState;
    canary: EvolutionCanaryState;
    revoke: EvolutionRevokeState;
    release?: EvolutionReleaseRef;
    requestIndex: Record<string, string>;
    updatedAt: number;
}
export type EvolutionGovernanceEvent = {
    type: 'begin-evaluation';
    traceDigest: string;
    baselineDigest: string;
    candidateDigest: string;
} | {
    type: 'record-evaluation';
    result: EvolutionEvaluationResult;
} | {
    type: 'register-release';
    release: EvolutionReleaseRef;
} | {
    type: 'start-shadow';
    at: number;
} | {
    type: 'record-shadow';
    at: number;
    recommendation: 'continue' | 'stop';
} | {
    type: 'request-canary';
    scope: EvolutionCanaryScope;
    stopPolicyDigest: string;
    at: number;
} | {
    type: 'authorize-canary';
    scope: EvolutionCanaryScope;
    authorizationRef: string;
    stopPolicyDigest: string;
    at: number;
} | {
    type: 'activate-canary';
    at: number;
} | {
    type: 'stop-canary';
    at: number;
    reason: string;
    safetyViolation: boolean;
} | {
    type: 'promote';
    at: number;
    reason?: string;
} | {
    type: 'revoke';
    at: number;
    reason: string;
    unresolvedHandles: number;
} | {
    type: 'reconcile';
    at: number;
    reason: string;
};
export declare const ValidateEvolutionTokenUsage: (value: unknown) => value is EvolutionTokenUsage;
export declare const ValidateEvolutionDecisionPolicy: (value: unknown) => value is EvolutionDecisionPolicy;
export declare const ValidateEvolutionReplayTrace: (value: unknown) => value is EvolutionReplayTrace;
/** One-sided Clopper-Pearson upper bound; 0/n remains an interval, never a claim of zero risk. */
export declare const getEvolutionUpper95: (events: number, trials: number) => number;
/** Pure decision replay. It accepts no tool, filesystem, network, clock or random source. */
export declare const runEvolutionEvaluation: (trace: EvolutionReplayTrace, policy: EvolutionDecisionPolicy) => EvolutionEvaluationResult;
export declare const ValidateEvolutionEvaluationResult: (value: unknown) => value is EvolutionEvaluationResult;
export declare const getInitialEvolutionGovernance: (at: number) => EvolutionGovernance;
export declare const ValidateEvolutionGovernance: (value: unknown) => value is EvolutionGovernance;
export declare const transitionEvolutionGovernance: (record: EvolutionGovernance, event: EvolutionGovernanceEvent, options: {
    expectedRevision: number;
    requestId: string;
    at: number;
}) => EvolutionGovernance;
export declare const isEvolutionActiveForRecall: (governance: EvolutionGovernance | undefined) => boolean;
export declare const getEvolutionCanaryOperationDigest: (input: {
    experienceId: string;
    evaluationResultDigest: string;
    releaseManifestDigest: string;
    stopPolicyDigest: string;
}) => string;
export declare const getEvolutionCanaryScopeDigest: (scope: EvolutionCanaryScope, artifactSha256: string) => string;
/** Restart cannot infer that an old process's in-flight evaluation/Canary is safe. */
export declare const recoverEvolutionGovernance: (governance: EvolutionGovernance, at: number) => EvolutionGovernance;
