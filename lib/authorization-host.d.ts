import type { AgentLike, GoalsLike, SessionProjectionsLike, ToolExecutionLike, UserQuestionsLike } from './host-contract.js';
import { type AuthorizationAnswer, type AuthorizationAnswerOrigin, type AuthorizationDecision, type AuthorizationQuestion } from './authorization-wait.js';
export interface AuthorizationHostCall {
    callId: string;
    rootSessionId: string;
    questions: AuthorizationQuestion[];
    questionDigest: string;
    /** The task service supplies this from the actual matching workflow node, not ask arguments. */
    nodeId?: string;
}
export type AuthorizationHostObservation = {
    kind: 'answer';
    callId: string;
    answers: AuthorizationAnswer[];
    origin: AuthorizationAnswerOrigin;
} | {
    kind: 'pending';
    callId: string;
} | {
    kind: 'unavailable' | 'cancelled' | 'unknown';
    callId: string;
    reason: string;
};
export interface AuthorizationGoalHold {
    holdId: string;
    rootSessionId: string;
    goalId?: string;
    goalRevision?: number;
    ownedDisarm: boolean;
}
export type AuthorizationGoalResult = {
    supported: true;
    hold: AuthorizationGoalHold;
} | {
    supported: false;
    reason: string;
};
export interface AuthorizationHostQuestionView {
    supported: boolean;
    active: Array<{
        callId: string;
        state: 'open' | 'continued';
        questionDigest: string;
    }>;
    settledCallIds: string[];
    partial?: boolean;
    reason?: string;
}
export interface AuthorizationHostOptions {
    goals?: GoalsLike;
    projections?: SessionProjectionsLike;
    userQuestions?: UserQuestionsLike;
    /** The Host must confirm the exact live instance and live root ownership. */
    isLiveRoot: (agent: AgentLike) => boolean;
    logger?: {
        warn: (message: string) => void;
    };
}
export interface AuthorizationPendingInput extends Extract<AuthorizationHostObservation, {
    kind: 'answer';
}> {
    messageId: string;
    answerDigest: string;
}
/** Observations are server-only. No method issues a question or grants Host tool approval. */
export declare const createAuthorizationHostAdapter: (options: AuthorizationHostOptions) => {
    observeCall: (execution: ToolExecutionLike, nodeId?: string) => AuthorizationHostCall | undefined;
    /** Use the final tools/result observer. Around-dispatch results may still be denied by post-policy. */
    observeResult: (decision: AuthorizationDecision, execution: ToolExecutionLike, result: unknown) => AuthorizationHostObservation;
    observeReply: (decision: AuthorizationDecision, raw: unknown) => AuthorizationPendingInput | undefined;
    /** Allows input consumption once; it does not approve the decision before Session admission. */
    observePendingReply: (agent: AgentLike, decision: AuthorizationDecision, messages: readonly unknown[]) => AuthorizationPendingInput | undefined;
    /** A failed admission can be retried only after the service reconciles the same Host message. */
    releasePendingReply: (decisionId: string, messageId: string) => boolean;
    getQuestions: (agent: AgentLike) => AuthorizationHostQuestionView;
    disarmForWait: (agent: AgentLike) => AuthorizationGoalResult;
    /** Call on user cancellation, aborted lifecycle, goal replacement, or disposal. */
    invalidateHeldGoal: (rootSessionId: string) => void;
    /** Root calls only after authentic answer consumption; never resume a user-paused/blocked goal. */
    resumeAfterAnswer: (agent: AgentLike, hold: AuthorizationGoalHold, decision: AuthorizationDecision) => {
        resumed: boolean;
        reason: string;
    };
};
