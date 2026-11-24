export interface CheckpointInputInfo {
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    roundId: string;
    evidenceRefs: string[];
    unresolved: string[];
    resolvedFindingRefs?: string[];
    allowedPaths?: string[];
    changedPaths?: string[];
    pendingMessages?: number;
    conflicts?: string[];
    resource?: {
        delegations?: number;
        tokens?: number | null;
        cost?: number | null;
        elapsedMs?: number;
        remainingFixRounds?: number;
        exhausted?: boolean;
    };
    progress?: string;
    nextAction?: string;
    acceptanceReady?: boolean;
}
export interface CheckpointInfo {
    id: string;
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    roundId: string;
    evidenceRefs: string[];
    /** 同一语义版本累计已见的证据；旧检查点恢复时可省略。 */
    knownEvidenceRefs?: string[];
    review: {
        newEvidence: string[];
        resolvedFindings: string[];
    };
    convergence: {
        unresolvedDelta: number;
        repeatedWithoutProgress: number;
        blocked: boolean;
    };
    scope: {
        outsidePaths: string[];
    };
    collaboration: {
        pendingMessages: number;
        conflicts: string[];
    };
    resource: NonNullable<CheckpointInputInfo['resource']>;
    unresolved: string[];
    nextAction: 'continue' | 'revise-plan' | 'escalate' | 'accept-ready' | 'incomplete';
    progress?: string;
}
/** 委派边界的五项短差量，不把底层工具调用变成长反思轮。 */
export declare const getCheckpoint: (input: CheckpointInputInfo, previous?: CheckpointInfo, noProgressLimit?: number) => CheckpointInfo;
