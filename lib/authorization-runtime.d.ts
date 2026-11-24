import type { AgentLike, GoalsLike, PreStepDecisionLike, SessionProjectionsLike, ToolExecutionLike, UserQuestionsLike } from './host-contract.js';
import type { TaskRecord } from './evidence.js';
import { createAuthorizationRepository, type AuthorizationBinding, type AuthorizationDecision, type AuthorizationState } from './authorization-wait.js';
type Repository = ReturnType<typeof createAuthorizationRepository<AuthorizationState>>;
export interface AuthorizationRuntimeContext {
    features: {
        workspaceId: string;
        authorizations: Repository;
    };
    task?: TaskRecord;
    binding: AuthorizationBinding;
}
export interface AuthorizationRuntimeDeps {
    getContext: (agent: AgentLike) => Promise<AuthorizationRuntimeContext>;
    /** Must enumerate this root's complete bounded collection, including the pre-task @root record. */
    listDecisions: (context: AuthorizationRuntimeContext) => readonly AuthorizationDecision[] | Promise<readonly AuthorizationDecision[]>;
    /** The service owns taskLock, real intent refresh and persistence before returning the new binding. */
    refreshBinding: (context: AuthorizationRuntimeContext, agent: AgentLike) => Promise<AuthorizationBinding>;
    getGoals: () => GoalsLike | undefined;
    getProjections?: () => SessionProjectionsLike | undefined;
    getUserQuestions?: () => UserQuestionsLike | undefined;
    isLiveRoot: (agent: AgentLike) => boolean;
    hasIndependentReadyWork?: (agent: AgentLike) => boolean | Promise<boolean>;
    /** Local outer wait-owner pump only; never call getContext or this coordinator recursively. */
    afterDecisionSettled?: (agent: AgentLike) => void | Promise<void>;
    /** A boolean ready queue alone cannot prove that this particular tool is independent. */
    isIndependentTool?: (execution: ToolExecutionLike, decisions: readonly AuthorizationDecision[]) => boolean | Promise<boolean>;
    logger?: {
        warn: (message: string) => void;
    };
}
/** Coordinates existing tool/Session hooks. It never asks, approves tools, or edits Host goal state privately. */
export declare const createAuthorizationRuntime: (deps: AuthorizationRuntimeDeps) => {
    beforeTool: (execution: ToolExecutionLike) => Promise<void>;
    /** Synchronous registration is essential: the Host does not await final-result observer promises. */
    observeFinalResult: (execution: ToolExecutionLike, result: unknown) => void;
    beforeStep: (agent: AgentLike, decision: PreStepDecisionLike) => Promise<PreStepDecisionLike>;
    beforeRequest: (agent: AgentLike) => Promise<void>;
    onUserMessage: (agent: AgentLike, message: unknown) => void;
    onToolResult: (agent: AgentLike, message: unknown) => void;
    onTurnEnd: (agent: AgentLike, reason: {
        kind?: string;
    } | undefined) => void;
    onDisposed: (agent: AgentLike) => Promise<void>;
    getDiagnostics: (rootSessionId: string) => {
        outcome: string;
        reason?: string | undefined;
        waitingForInputAdmission: boolean;
    };
};
export {};
