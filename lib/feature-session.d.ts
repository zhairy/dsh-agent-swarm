import type { SwarmConfigInfo } from './config.js';
import type { DelegationRecord, TaskRecord, TaskStore } from './evidence.js';
import type { ThreadInfo, ThreadRegistry } from './threads.js';
import { type DurableStateStore, type StateValidationReport } from './state-store.js';
import { type AgentBindingRegistry } from './agent-binding.js';
import { type MessageBus, type MessageState } from './message-bus.js';
import { createExperienceRepository, type ExperienceEntry, type ExperienceState } from './experience.js';
import { type ExecutionBudget, type ExecutionBudgetSnapshot } from './execution-budget.js';
import { type ContextArtifactInfo, type ContextStore, type PreparedTaskContextReplacement } from './context-store.js';
import { getArtifactSnapshot } from './artifacts.js';
import { validateRouteHealthSnapshot, type RouteHealthEntry, type RouteHealthSnapshot } from './domain/routing/health.js';
import { type AgentControlRecord } from './agent-control.js';
import { createAuthorizationRepository, type AuthorizationState } from './authorization-wait.js';
import { createProgressGuard, type ProgressGuardState } from './progress-guard.js';
import type { SwarmEventJournal } from './event-journal.js';
export interface FeatureRuntimeSnapshot {
    rootEditAt: number;
    taskSequence: number;
    counters: {
        native: number;
        jev: number;
        review: number;
        session: number;
    };
    rootUpgradeExplicit: string[];
}
interface FeatureState extends MessageState, ExperienceState, AuthorizationState, ProgressGuardState {
    runtime?: FeatureRuntimeSnapshot;
    schemaVersion: 1 | 2;
    tasks: TaskRecord[];
    delegations: DelegationRecord[];
    threads: ThreadInfo[];
    budgets: Record<string, ExecutionBudgetSnapshot>;
    planningBudgets?: Record<string, ExecutionBudgetSnapshot>;
    agentControls?: AgentControlRecord[];
    contexts: ContextArtifactInfo[];
    routeHealth?: RouteHealthEntry[] | RouteHealthSnapshot;
}
export interface FeatureSession {
    workspaceId: string;
    store: DurableStateStore<FeatureState>;
    bindings: AgentBindingRegistry;
    bus?: MessageBus;
    contexts: ContextStore;
    experiences: ReturnType<typeof createExperienceRepository<FeatureState>>;
    authorizations: ReturnType<typeof createAuthorizationRepository<FeatureState>>;
    progress: ReturnType<typeof createProgressGuard<FeatureState>>;
    budgetFor: (task: TaskRecord) => ExecutionBudget;
    planningBudgetFor: (task: TaskRecord) => ExecutionBudget;
    getRestoredAgentControls: () => AgentControlRecord[];
    getRestoredRuntime: () => FeatureRuntimeSnapshot | undefined;
    commitRecovery: () => Promise<void>;
    /** Existing attempts and exempt Jev observations keep their original accounting handle during hot changes. */
    finishBudgetFor: (task: TaskRecord) => ExecutionBudget;
    persist: (type: string, tasks: TaskStore, threads: ThreadRegistry) => Promise<void>;
    /** Route health uses the same durable authority as FeatureState; legacy local sidecars are read only during migration. */
    persistRouteHealth: (snapshot: RouteHealthEntry[] | RouteHealthSnapshot) => Promise<void>;
    /** Read committed state first, with a legacy local sidecar as one-time migration fallback. */
    readRouteHealth: () => Promise<RouteHealthEntry[] | RouteHealthSnapshot | undefined>;
    addContext: (input: Parameters<ContextStore['Add']>[0]) => ContextArtifactInfo;
    prepareTaskContexts: (...args: Parameters<ContextStore['PrepareTaskReplace']>) => PreparedTaskContextReplacement;
    /** Trusted lifecycle API: all author/reviewer/verification facts are derived from current runtime evidence. */
    promoteCandidateWithEvidence: (id: string) => Promise<ExperienceEntry>;
    dispose: () => Promise<void>;
}
/** Stable task lineage: presentation labels/revisions and model-selected UUIDs do not reset history. */
export declare const getTaskRuntimeLineage: (input: {
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
}) => string;
/** Only stable quarantine facts are durable. A process-local half-open claimant is never resumed. */
export declare const validatePersistedRouteHealth: typeof validateRouteHealthSnapshot;
/** Verify complete runtime contracts before exposing or replaying any saved state. */
export declare const inspectFeatureState: (raw: unknown, expected: {
    rootSessionId: string;
    workspaceId: string;
}) => StateValidationReport;
/** Compatibility wrapper over the same single-pass validation implementation. */
export declare const validateFeatureState: (raw: unknown, expected: {
    rootSessionId: string;
    workspaceId: string;
}) => boolean;
export declare const createFeatureSession: (input: {
    rootSessionId: string;
    cwd: string;
    dshHome: string;
    config: SwarmConfigInfo;
    getTaskArtifactSnapshot?: (task: TaskRecord, paths: readonly string[]) => ReturnType<typeof getArtifactSnapshot>;
    journal?: SwarmEventJournal;
    getConfig?: () => SwarmConfigInfo;
    getAgentControls?: () => AgentControlRecord[];
    getRuntime?: () => FeatureRuntimeSnapshot;
    verifyEvolutionEvaluation?: (entry: ExperienceEntry, result: import('./evolution-governance.js').EvolutionEvaluationResult) => boolean | Promise<boolean>;
    verifyEvolutionRelease?: (entry: ExperienceEntry, release: import('./evolution-governance.js').EvolutionReleaseRef) => boolean | Promise<boolean>;
    tasks: TaskStore;
    threads: ThreadRegistry;
    now: () => number;
}) => Promise<FeatureSession>;
export {};
