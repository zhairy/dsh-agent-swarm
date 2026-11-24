import type { DurableStateStore } from './state-store.js';
export declare const AUTHORIZATION_POLICY_VERSION = 1;
export type AuthorizationPhase = 'prepared' | 'waiting' | 'reconcile-required' | 'answered' | 'approved' | 'declined' | 'cancelled' | 'invalidated' | 'unavailable';
export interface AuthorizationBinding {
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    lineageId: string;
    requestRevision: number;
    cardRevision: number;
    workflowRevision: number;
    nodeId?: string;
}
export interface AuthorizationQuestion {
    id: string;
    question: string;
    header?: string;
    options?: Array<{
        label: string;
        description?: string;
    }>;
    multiSelect?: boolean;
}
export interface AuthorizationApprovalRule {
    questionId: string;
    approveLabels: string[];
    declineLabels: string[];
}
export interface AuthorizationAnswer {
    id: string;
    selected: string[];
    custom?: string;
}
export interface AuthorizationQuestionIdentity {
    id: string;
    optionDigests: string[];
    multiSelect: boolean;
}
export interface AuthorizationRecordedAnswer {
    id: string;
    selectedIndices: number[];
    customDigest?: string;
}
export interface AuthorizationStoredRule {
    questionId: string;
    approveIndices: number[];
    declineIndices: number[];
}
export interface AuthorizationAnswerOrigin {
    kind: 'tool-result' | 'user-question-reply';
    callId: string;
    messageId?: string;
}
export interface AuthorizationDecision {
    id: string;
    policyVersion: 1;
    dedupKey: string;
    questionBinding: AuthorizationBinding;
    operationDigest: string;
    scopeDigest: string;
    questions: AuthorizationQuestionIdentity[];
    questionDigest: string;
    approvalRules: AuthorizationStoredRule[];
    phase: AuthorizationPhase;
    decisionRevision: number;
    createdAt: number;
    updatedAt: number;
    hostCallId?: string;
    answerDigest?: string;
    answers?: AuthorizationRecordedAnswer[];
    answerOrigin?: AuthorizationAnswerOrigin;
    appliesToBinding?: AuthorizationBinding;
    reason?: string;
}
export interface AuthorizationState {
    authorizationDecisions?: Record<string, AuthorizationDecision>;
}
export interface PrepareAuthorizationInput {
    binding: AuthorizationBinding;
    operationDigest: string;
    scopeDigest: string;
    questions: AuthorizationQuestion[];
    /** Rules come from the server-owned operation policy, never from model claims of approval. */
    approvalRules?: AuthorizationApprovalRule[];
    requiresUserDecision: true;
}
export interface ConsumeAuthorizationAnswer {
    callId: string;
    answers: AuthorizationAnswer[];
    origin: AuthorizationAnswerOrigin;
    binding: AuthorizationBinding;
    operationDigest: string;
    scopeDigest: string;
}
export type AuthorizationEvent = {
    type: 'dispatch-known';
    callId: string;
    questionDigest: string;
} | {
    type: 'dispatch-unknown' | 'unavailable' | 'invalidate' | 'cancel';
    reason: string;
} | {
    type: 'answer';
    input: ConsumeAuthorizationAnswer;
};
export declare const ValidateAuthorizationBinding: (raw: unknown) => raw is AuthorizationBinding;
/** Normalize only the public ask-user schema fields; untrusted extra fields never become policy. */
export declare const getAuthorizationQuestions: (raw: unknown) => AuthorizationQuestion[] | undefined;
export declare const getAuthorizationQuestionIdentities: (questions: readonly AuthorizationQuestion[]) => AuthorizationQuestionIdentity[];
export declare const getAuthorizationDedupKey: (input: Pick<PrepareAuthorizationInput, 'binding' | 'operationDigest' | 'scopeDigest'>) => string;
export declare const isAuthorizationWaiting: (decision: AuthorizationDecision) => boolean;
export declare const isAuthorizationApplicable: (decision: AuthorizationDecision, binding: AuthorizationBinding, operationDigest: string, scopeDigest: string) => boolean;
/** Strict persisted-record validation; the outer FeatureState validator also checks task ownership. */
export declare const ValidateAuthorizationDecision: (raw: unknown) => raw is AuthorizationDecision;
/** Pure reducer: only verified host observations may be supplied by the server adapter. */
export declare const reduceAuthorizationDecision: (record: AuthorizationDecision, event: AuthorizationEvent, at: number) => AuthorizationDecision;
export declare const createAuthorizationRepository: <T extends AuthorizationState>(store: DurableStateStore<T>, options?: {
    now?: () => number;
    maxEntries?: number;
    maxPerTask?: number;
    id?: () => string;
    /** 容量满时哪些终态决定可以回收；缺省不回收。调用方必须保证回收不会改变任何现有验收凭证绑定的决定集合。 */
    canReclaim?: (decision: AuthorizationDecision) => boolean;
}) => {
    get: (decisionId: string) => AuthorizationDecision | undefined;
    forTask: (taskId: string, rootSessionId?: string) => AuthorizationDecision[];
    prepare: (input: PrepareAuthorizationInput) => Promise<{
        decision: AuthorizationDecision;
        reused: boolean;
    }>;
    dispatchKnown: (decisionId: string, input: {
        callId: string;
        questionDigest: string;
    }) => Promise<AuthorizationDecision>;
    dispatchUnknown: (decisionId: string, reason: string) => Promise<AuthorizationDecision>;
    consumeAnswer: (decisionId: string, input: ConsumeAuthorizationAnswer) => Promise<AuthorizationDecision>;
    unavailable: (decisionId: string, reason: string) => Promise<AuthorizationDecision>;
    invalidate: (decisionId: string, reason: string) => Promise<AuthorizationDecision>;
    cancel: (decisionId: string, reason: string) => Promise<AuthorizationDecision>;
};
