import type { SwarmConfigInfo } from '../config.js';
import type { DelegationRecord, TaskRecord } from '../evidence.js';
import type { GateRequirement, TaskCard } from '../policy.js';
import type { ThreadInfo, ThreadRegistry } from '../threads.js';
import type { RequestRecoveryState } from './routing/engine.js';
import type { WorktreeBindingInfo } from '../worktree-binding.js';
import type { FeatureSession } from '../feature-session.js';
import type { RootUpgradeView } from './api.js';
import { suggestRolesByCapabilities } from '../role-registry.js';
export interface StatusSessionInfo {
    rootUpgrade?: RootUpgradeView;
    store: {
        getTasks: () => TaskRecord[];
    };
    threads: Pick<ThreadRegistry, 'list'>;
    ledger: {
        path: string;
    };
    counters: {
        native: number;
        jev: number;
        review: number;
        session: number;
    };
    features?: Pick<FeatureSession, 'store' | 'contexts'>;
}
export declare const getGateView: (gate: GateRequirement) => {
    gate: "G_BENCH" | "G_DIFF_TEST" | "G_MATH_RESEARCH" | "G_MATH_VERIFY" | "G_REVIEW" | "G_VERIFY" | "G_VISION";
    role: import("../role-registry.js").DelegableRoleId;
    roleName: string;
    mode?: import("../role-registry.js").SuanHengMode | undefined;
    label: string;
    reason: string;
    source: import("../policy.js").GateSource;
};
export declare const getTaskCardResult: (task: TaskRecord, card: TaskCard, config: SwarmConfigInfo, ledgerPath: string, rootUpgrade: RootUpgradeView | undefined) => {
    task_id: string;
    rootUpgrade: RootUpgradeView | null;
    title: string;
    goal: string;
    acceptance: string[];
    scope: string[];
    perf: import("../policy.js").PerfInfo | null;
    planningScope: import("../policy.js").PlanningScopeInfo | null;
    workspacePlan: import("../workspace-policy.js").WorkspacePlan | null;
    workspacePlanUnavailable: boolean;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
    contextRefs: string[];
    contextArtifacts: {
        ref: string;
        digest: string;
        layer: string;
        kind: string;
    }[];
    planningReview: import("../planning-review.js").PlanningReviewRecord | null;
    workflowMode: "advisory" | "enforced" | "off";
    planningRecovery: import("../planning-recovery.js").PlanningRecoveryInfo;
    flow: {
        definition: import("../workflow.js").WorkflowDefinition;
        state: import("../workflow.js").WorkflowStateInfo | undefined;
        digest: string | undefined;
        mermaid: string;
        nextReadyNodes: string[];
    } | null;
    requiredGates: {
        gate: "G_BENCH" | "G_DIFF_TEST" | "G_MATH_RESEARCH" | "G_MATH_VERIFY" | "G_REVIEW" | "G_VERIFY" | "G_VISION";
        role: import("../role-registry.js").DelegableRoleId;
        roleName: string;
        mode?: import("../role-registry.js").SuanHengMode | undefined;
        label: string;
        reason: string;
        source: import("../policy.js").GateSource;
    }[];
    suggestedRoles: {
        role: import("../role-registry.js").DelegableRoleId;
        reason: string;
        roleName: string;
    }[];
    triage: import("../evidence.js").TriageRecord;
    budgets: import("../policy.js").BudgetInfo;
    ledgerPath: string;
};
export declare const getThreadView: (thread: ThreadInfo) => {
    threadId: string;
    role: import("../role-registry.js").DelegableRoleId;
    roleName: string;
    mode?: import("../role-registry.js").SuanHengMode | undefined;
    rounds: number;
    busy: boolean;
    closed: boolean;
    taskIds: string[];
    lastSummary: string | null;
};
export declare const getDelegationView: (d: DelegationRecord, verbose: boolean) => {
    delegationId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
    role: import("../role-registry.js").DelegableRoleId;
    roleName: string;
    mode?: import("../role-registry.js").SuanHengMode | undefined;
    status: "blocked" | "completed" | "failed" | "queued" | "running";
    finalization: "cancelled" | "failed" | "processing" | "ready" | null;
    staleReason: string | null;
    summary: string;
    route: string | null;
    backend: import("../evidence.js").BackendKind | null;
    independence: "achieved" | "n/a" | "not-achieved";
    hardIsolation: boolean;
    durationMs: number | null;
    error: string | null;
    assessment: import("../evidence.js").AssessmentInfo | null;
    evidenceAssessment: {
        status: "ok" | "partial" | "unknown";
        disposition: import("../evidence-assessment.js").EvidenceDisposition;
        confidenceMeaning: "distribution-concentration-not-correctness";
        items: {
            id: string;
            credibility: import("../evidence-assessment.js").EvidenceAxis;
            relevance: import("../evidence-assessment.js").EvidenceAxis;
            support: {
                relation: 'supports' | 'contradicts' | 'insufficient' | 'unknown';
                confidence?: number;
            };
            disposition: import("../evidence-assessment.js").EvidenceDisposition;
            reasons: string[];
            model: string | undefined;
        }[];
    } | null;
    session: import("../evidence.js").DelegationSessionInfo | null;
    retries: import("../evidence.js").DelegationRetryInfo[];
    unresolved: string[];
    changedFiles: string[];
    structured?: unknown;
    evidence?: import("../contracts.js").EvidenceItem[] | undefined;
    attempts?: import("../evidence.js").RouteAttempt[] | undefined;
    evidenceAssessmentDetails?: import("../evidence-assessment.js").EvidenceAssessment | undefined;
};
export declare const getTaskView: (task: TaskRecord, delegations: DelegationRecord[], config: SwarmConfigInfo, verbose: boolean, externalEditAt: number, recovery?: RequestRecoveryState | null, delegationBindingTask?: TaskRecord, includeDiagrams?: boolean, worktrees?: WorktreeBindingInfo[]) => {
    task_id: string;
    ticket: import("../domain/tickets/lifecycle.js").TicketProjection;
    worktrees: WorktreeBindingInfo[];
    workspacePlan: import("../workspace-policy.js").WorkspacePlan | null;
    workspacePlanUnavailable: boolean;
    title: string;
    goal: string;
    card: TaskCard;
    cardRevision: number;
    workflowRevision: number;
    stateRefreshRequired: boolean;
    publishedRevisions: {
        taskId: string;
        cardRevision: number;
        workflowRevision: number;
        requestRevision: number;
    };
    requestRevision: number;
    intentSource: "declared" | "host";
    intentHistoryNote: string | null;
    planningReview: import("../planning-review.js").PlanningReviewRecord | null;
    checkpoint: import("../checkpoint.js").CheckpointInfo | null;
    workflowMode: "advisory" | "enforced" | "off";
    planningRecovery: import("../planning-recovery.js").PlanningRecoveryInfo;
    blockedRecovery: import("../blocked-recovery.js").BlockedRecoveryView;
    recovered: boolean;
    contextRefs: string[];
    contextArtifacts: {
        ref: string;
        digest: string;
        layer: string;
        kind: string;
    }[];
    diagrams: import("../task-diagrams.js").TaskDiagrams | null;
    orchestration: import("../orchestration.js").OrchestrationPlan | null;
    flow: {
        definition: import("../workflow.js").WorkflowDefinition;
        state: import("../workflow.js").WorkflowStateInfo | undefined;
        digest: string | undefined;
        mermaid: string;
    } | null;
    markdown: string;
    rounds: number;
    triage: import("../evidence.js").TriageRecord;
    acceptance: import("../evidence.js").AcceptanceRecord | null;
    gates: {
        gate: import("../policy.js").GateId;
        satisfied: boolean;
        by?: string;
        missing?: string;
        notes: string[];
        label: string;
    }[];
    delegations: {
        delegationId: string;
        cardRevision: number;
        workflowRevision: number;
        requestRevision: number;
        role: import("../role-registry.js").DelegableRoleId;
        roleName: string;
        mode?: import("../role-registry.js").SuanHengMode | undefined;
        status: "blocked" | "completed" | "failed" | "queued" | "running";
        finalization: "cancelled" | "failed" | "processing" | "ready" | null;
        staleReason: string | null;
        summary: string;
        route: string | null;
        backend: import("../evidence.js").BackendKind | null;
        independence: "achieved" | "n/a" | "not-achieved";
        hardIsolation: boolean;
        durationMs: number | null;
        error: string | null;
        assessment: import("../evidence.js").AssessmentInfo | null;
        evidenceAssessment: {
            status: "ok" | "partial" | "unknown";
            disposition: import("../evidence-assessment.js").EvidenceDisposition;
            confidenceMeaning: "distribution-concentration-not-correctness";
            items: {
                id: string;
                credibility: import("../evidence-assessment.js").EvidenceAxis;
                relevance: import("../evidence-assessment.js").EvidenceAxis;
                support: {
                    relation: 'supports' | 'contradicts' | 'insufficient' | 'unknown';
                    confidence?: number;
                };
                disposition: import("../evidence-assessment.js").EvidenceDisposition;
                reasons: string[];
                model: string | undefined;
            }[];
        } | null;
        session: import("../evidence.js").DelegationSessionInfo | null;
        retries: import("../evidence.js").DelegationRetryInfo[];
        unresolved: string[];
        changedFiles: string[];
        structured?: unknown;
        evidence?: import("../contracts.js").EvidenceItem[] | undefined;
        attempts?: import("../evidence.js").RouteAttempt[] | undefined;
        evidenceAssessmentDetails?: import("../evidence-assessment.js").EvidenceAssessment | undefined;
        isCurrent: boolean;
    }[];
    budget: {
        used: number;
        max: number;
    };
};
export declare const getStatusResult: (tasks: ReturnType<typeof getTaskView>[], session: StatusSessionInfo, diagnostics: string[]) => {
    tasks: {
        task_id: string;
        ticket: import("../domain/tickets/lifecycle.js").TicketProjection;
        worktrees: WorktreeBindingInfo[];
        workspacePlan: import("../workspace-policy.js").WorkspacePlan | null;
        workspacePlanUnavailable: boolean;
        title: string;
        goal: string;
        card: TaskCard;
        cardRevision: number;
        workflowRevision: number;
        stateRefreshRequired: boolean;
        publishedRevisions: {
            taskId: string;
            cardRevision: number;
            workflowRevision: number;
            requestRevision: number;
        };
        requestRevision: number;
        intentSource: "declared" | "host";
        intentHistoryNote: string | null;
        planningReview: import("../planning-review.js").PlanningReviewRecord | null;
        checkpoint: import("../checkpoint.js").CheckpointInfo | null;
        workflowMode: "advisory" | "enforced" | "off";
        planningRecovery: import("../planning-recovery.js").PlanningRecoveryInfo;
        blockedRecovery: import("../blocked-recovery.js").BlockedRecoveryView;
        recovered: boolean;
        contextRefs: string[];
        contextArtifacts: {
            ref: string;
            digest: string;
            layer: string;
            kind: string;
        }[];
        diagrams: import("../task-diagrams.js").TaskDiagrams | null;
        orchestration: import("../orchestration.js").OrchestrationPlan | null;
        flow: {
            definition: import("../workflow.js").WorkflowDefinition;
            state: import("../workflow.js").WorkflowStateInfo | undefined;
            digest: string | undefined;
            mermaid: string;
        } | null;
        markdown: string;
        rounds: number;
        triage: import("../evidence.js").TriageRecord;
        acceptance: import("../evidence.js").AcceptanceRecord | null;
        gates: {
            gate: import("../policy.js").GateId;
            satisfied: boolean;
            by?: string;
            missing?: string;
            notes: string[];
            label: string;
        }[];
        delegations: {
            delegationId: string;
            cardRevision: number;
            workflowRevision: number;
            requestRevision: number;
            role: import("../role-registry.js").DelegableRoleId;
            roleName: string;
            mode?: import("../role-registry.js").SuanHengMode | undefined;
            status: "blocked" | "completed" | "failed" | "queued" | "running";
            finalization: "cancelled" | "failed" | "processing" | "ready" | null;
            staleReason: string | null;
            summary: string;
            route: string | null;
            backend: import("../evidence.js").BackendKind | null;
            independence: "achieved" | "n/a" | "not-achieved";
            hardIsolation: boolean;
            durationMs: number | null;
            error: string | null;
            assessment: import("../evidence.js").AssessmentInfo | null;
            evidenceAssessment: {
                status: "ok" | "partial" | "unknown";
                disposition: import("../evidence-assessment.js").EvidenceDisposition;
                confidenceMeaning: "distribution-concentration-not-correctness";
                items: {
                    id: string;
                    credibility: import("../evidence-assessment.js").EvidenceAxis;
                    relevance: import("../evidence-assessment.js").EvidenceAxis;
                    support: {
                        relation: 'supports' | 'contradicts' | 'insufficient' | 'unknown';
                        confidence?: number;
                    };
                    disposition: import("../evidence-assessment.js").EvidenceDisposition;
                    reasons: string[];
                    model: string | undefined;
                }[];
            } | null;
            session: import("../evidence.js").DelegationSessionInfo | null;
            retries: import("../evidence.js").DelegationRetryInfo[];
            unresolved: string[];
            changedFiles: string[];
            structured?: unknown;
            evidence?: import("../contracts.js").EvidenceItem[] | undefined;
            attempts?: import("../evidence.js").RouteAttempt[] | undefined;
            evidenceAssessmentDetails?: import("../evidence-assessment.js").EvidenceAssessment | undefined;
            isCurrent: boolean;
        }[];
        budget: {
            used: number;
            max: number;
        };
    }[];
    roleSuggestions: ReturnType<typeof suggestRolesByCapabilities>;
    rootUpgrade: RootUpgradeView | null;
    threads: {
        threadId: string;
        role: import("../role-registry.js").DelegableRoleId;
        roleName: string;
        mode?: import("../role-registry.js").SuanHengMode | undefined;
        rounds: number;
        busy: boolean;
        closed: boolean;
        taskIds: string[];
        lastSummary: string | null;
    }[];
    ledgerPath: string;
    usage: {
        nativeCalls: number;
        jevCalls: number;
        reviewCalls: number;
        sessionCalls: number;
    };
    diagnostics: string[];
    persistence: {
        durable: boolean;
        stateBytes?: number | undefined;
        stateLimitBytes?: number | undefined;
        contextBytes?: number | undefined;
        recovery: string;
    };
};
/**
 * 未知任务的统一诊断。
 * 只给「未知任务：T-1」时，无法判断是 ID 拼错、DSH 重启后内存态任务丢失，还是切了会话；
 * 这里补上当前会话已知任务与任务卡的隔离语义，让调用方一步定位而不是继续猜。
 */
export declare const describeUnknownTask: (session: StatusSessionInfo, taskId: string) => string;
