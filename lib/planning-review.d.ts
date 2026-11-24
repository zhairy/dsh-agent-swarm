import type { GateRequirement, TaskCard } from './policy.js';
import { type DelegableRoleId } from './role-registry.js';
import { type JsonSchemaObject } from './util/json-schema.js';
import { type MermaidParserLike, type WorkflowDefinition, type WorkflowParserResultInfo } from './workflow.js';
export declare const PLANNING_REVIEW_POLICY_VERSION = "3";
export declare const PLANNING_REVIEW_QUESTION_VERSION = "5";
export type PlanningReviewVerdict = 'pass' | 'changes_requested' | 'unknown' | 'needs-clarification';
export type PlanningReviewStatus = 'pending' | 'reviewing' | 'pass' | 'pass_with_degradation' | 'changes_requested' | 'unknown' | 'needs-clarification' | 'review_required' | 'unavailable' | 'stale';
export interface RequirementMapInfo {
    id: string;
    text: string;
    required: boolean;
    acceptanceIds: string[];
    nodeIds: string[];
}
export interface PlanningExecutionPolicyInfo {
    maxAutoFixRounds?: number;
    maxPlanningReviewFixRounds?: number;
    planningReviewTimeoutMs?: number;
    workflowMode?: 'off' | 'advisory' | 'enforced';
    profile?: 'legacy' | 'bounded';
    maxCalls?: number;
    delegationLimit?: number;
}
export interface ReviewSnapshotInputInfo {
    workspacePlan?: import('./workspace-policy.js').WorkspacePlan;
    workspacePlanUnavailable?: boolean;
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    requestRevision: number;
    requestText: string;
    requestSource?: 'host' | 'declared';
    requestHistoryUnavailable?: boolean;
    requestHistoryNote?: string;
    requestRefs?: Array<{
        source: string;
        span?: string;
        text: string;
    }>;
    cardRevision: number;
    workflowRevision: number;
    card: TaskCard;
    workflow: WorkflowDefinition;
    gates: GateRequirement[];
    requirements?: RequirementMapInfo[];
    policyVersion?: string;
    parserVersion?: string;
    reviewPolicy?: PlanningReviewPolicyInfo;
    executionPolicy?: PlanningExecutionPolicyInfo;
    mermaid?: string;
}
export interface ReviewSnapshot extends ReviewSnapshotInputInfo {
    requestDigest: string;
    workflowDigest: string;
    mermaidDigest: string;
    effectiveGatesDigest: string;
    requirementMapDigest: string;
    snapshotDigest: string;
    policyVersion: string;
    questionVersion: string;
    parserVersion: string;
    reviewPolicy: {
        requireJev: boolean;
        reviewAbove: number;
    };
    generatorVersion: string;
    mermaid: string;
    requirements: RequirementMapInfo[];
    acceptances: Array<{
        id: string;
        text: string;
    }>;
    permissions: Array<{
        role: DelegableRoleId;
        permission: string;
        capabilities: readonly string[];
        concurrencySafe: boolean;
    }>;
    runtimeRules: typeof PLANNING_RUNTIME_RULES;
}
declare const PLANNING_RUNTIME_RULES: {
    readonly quota: 'legacy 模式下 maxCalls=0 表示不限；bounded 模式下 0 使用 quick/standard/algorithm 的默认委派上限 6/16/20；delegationLimit 为 0 表示不限；Jev 不受生成模型预算限制。';
    readonly admission: 'enforced 模式必须当前规划通过且节点依赖满足才派发；规划通过不能替代实现后的验证门禁。';
    readonly independence: '独立规划审核总是新建只读会话；执行阶段御史初审和算衡验算由宿主强制 session=new，显式回应阶段另行校验冻结初审。相同角色名不代表复用同一初审上下文。';
    readonly failure: '审核超时或取消不授予执行权限；同一明确负结论不重新抽样。修正实质合同后才能复审；修复轮次上限以 executionPolicy 为准，无法满足则记录未完成。';
    readonly evidence: '执行前只检查产出与验证计划，实际测试结果须在执行后提交。阶段验收仅覆盖阶段交付，延期项不表示完成。';
    readonly workspace: '项目硬限制由 Host 读取并绑定摘要；primary 禁止第二工作树，linked 沿用隔离工作树；blocked 必须先澄清。衡鉴规划不能授予写权限，写入仍需当前任务、角色、Host 策略和排他租约。';
};
export interface ReviewDimensionInfo {
    verdict: PlanningReviewVerdict;
    summary: string;
    evidenceRefs: string[];
}
export interface PlanningReviewFindingInfo {
    severity: 'critical' | 'high' | 'medium' | 'low';
    requirementId?: string;
    acceptanceId?: string;
    nodeId?: string;
    issue: string;
    evidence: string;
    suggestion: string;
}
export interface PlanningReviewResult {
    snapshotDigest: string;
    verdict: PlanningReviewVerdict;
    goalReview: ReviewDimensionInfo;
    designReview: ReviewDimensionInfo;
    mermaidReview: ReviewDimensionInfo;
    requirementCoverage: Array<{
        requirementId: string;
        covered: boolean;
        evidence: string;
    }>;
    findings: PlanningReviewFindingInfo[];
    assumptions: Array<{
        statement: string;
        evidence: string;
    }>;
    unresolved: string[];
}
export interface PlanningReviewerInfo {
    agentId: string;
    role: DelegableRoleId;
    provider?: string;
    model?: string;
    reasoningEffort?: string;
    fresh: boolean;
    readOnly: boolean;
    authorAgentIds?: string[];
}
export interface PlanningAgentAssessmentInfo {
    result?: unknown;
    reviewer?: PlanningReviewerInfo;
    reason?: string;
}
export interface PlanningJevAssessmentInfo {
    status: 'ok' | 'unavailable' | 'unknown';
    answers?: Record<string, unknown>;
    reason?: string;
    model?: string;
}
export interface PlanningReviewPolicyInfo {
    requireJev?: boolean;
    reviewAbove?: number;
}
export interface PlanningReviewRecord {
    snapshotDigest: string;
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    requestRevision: number;
    cardRevision: number;
    workflowRevision: number;
    policyVersion: string;
    questionVersion: string;
    reviewPolicy: {
        requireJev: boolean;
        reviewAbove: number;
    };
    status: PlanningReviewStatus;
    goalReview: ReviewDimensionInfo;
    designReview: ReviewDimensionInfo;
    mermaidReview: WorkflowParserResultInfo & {
        semanticVerdict: PlanningReviewVerdict;
    };
    agent: PlanningAgentAssessmentInfo;
    jev: PlanningJevAssessmentInfo;
    questions?: Record<string, unknown>;
    errors: string[];
    at: number;
}
export declare const getPlanningEvidenceRefs: (snapshot: ReviewSnapshot) => string[];
/** 宿主验证与模型输出约束使用同一引用目录，避免模型猜测 JSONPath 后被拒绝。 */
export declare const getPlanningReviewSchema: (snapshot?: ReviewSnapshot) => JsonSchemaObject;
/** 需求原文、合同与图共同冻结；作者提出的映射必须由独立专家实质检查。 */
export declare const getReviewSnapshot: (input: ReviewSnapshotInputInfo) => ReviewSnapshot;
export declare const ValidateReviewSnapshot: (snapshot: ReviewSnapshot) => string[];
export declare const ValidatePlanningReviewResult: (snapshot: ReviewSnapshot, raw: unknown) => string[];
/** 只移除完全相同的重复原文，用显式引用无损表示；不截断需求或更改批准摘要。 */
export declare const getPlanningReviewState: (snapshot: ReviewSnapshot) => {
    workspacePlan?: import('./workspace-policy.js').WorkspacePlan;
    workspacePlanUnavailable?: boolean;
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    requestRevision: number;
    requestText: string;
    requestSource?: 'host' | 'declared';
    requestHistoryUnavailable?: boolean;
    requestHistoryNote?: string;
    cardRevision: number;
    workflowRevision: number;
    workflow: WorkflowDefinition;
    gates: GateRequirement[];
    executionPolicy?: PlanningExecutionPolicyInfo;
    requestDigest: string;
    workflowDigest: string;
    mermaidDigest: string;
    effectiveGatesDigest: string;
    requirementMapDigest: string;
    snapshotDigest: string;
    policyVersion: string;
    questionVersion: string;
    parserVersion: string;
    reviewPolicy: {
        requireJev: boolean;
        reviewAbove: number;
    };
    generatorVersion: string;
    mermaid: string;
    acceptances: Array<{
        id: string;
        text: string;
    }>;
    permissions: Array<{
        role: DelegableRoleId;
        permission: string;
        capabilities: readonly string[];
        concurrencySafe: boolean;
    }>;
    runtimeRules: typeof PLANNING_RUNTIME_RULES;
    textReferenceFormat: string;
    card: {
        title: string;
        goal: string;
        acceptance: string[];
        scope: string[];
        constraints?: {
            apiCompat?: string;
            environment?: string;
            resourceLimits?: string;
        };
        perf?: import("./policy.js").PerfInfo;
        flags: import("./policy.js").TaskFlags;
        workflow?: WorkflowDefinition | {
            ref: string;
        } | undefined;
        intent?: {
            text: string;
            sourceRef?: string;
        };
        planningScope?: import("./policy.js").PlanningScopeInfo;
    };
    requestRefs: ({
        source: string;
        span?: string;
        textRef: string;
    } | {
        source: string;
        span?: string;
        text: string;
    })[] | undefined;
    requirements: RequirementMapInfo[];
};
export declare const getPlanningReviewPrompt: (snapshot: ReviewSnapshot) => string;
/** 独立语义问题一次批量提出；初次 state 不含 Agent 结论。 */
export declare const getPlanningReviewQuestions: (snapshot?: ReviewSnapshot) => Record<string, unknown>;
/** 只服务不可用可以降级；低概率、缺答案与模型反对绝不当作服务不可用。 */
export declare const getPlanningReviewRecord: (snapshot: ReviewSnapshot, input: {
    structure: WorkflowParserResultInfo;
    structuralErrors?: string[];
    agent: PlanningAgentAssessmentInfo;
    jev: PlanningJevAssessmentInfo;
    policy?: PlanningReviewPolicyInfo;
    at?: number;
}) => PlanningReviewRecord;
/** 先做确定性检查；通过后 Agent/Jev 并行读取同一快照，互不看初次结论。 */
export declare const RunPlanningReview: (snapshot: ReviewSnapshot, deps: {
    reviewAgent: (snapshot: ReviewSnapshot, schema: JsonSchemaObject, prompt: string) => Promise<PlanningAgentAssessmentInfo>;
    reviewJev: (snapshot: ReviewSnapshot, questions: Record<string, unknown>) => Promise<PlanningJevAssessmentInfo>;
    parser?: MermaidParserLike;
    policy?: PlanningReviewPolicyInfo;
    now?: () => number;
    signal?: AbortSignal;
}) => Promise<PlanningReviewRecord>;
/** 身份、题目与政策属于批准边界；单独递增题目版本也必须使旧批准失效。 */
export declare const isPlanningReviewBound: (record: PlanningReviewRecord | undefined, snapshot: ReviewSnapshot) => record is PlanningReviewRecord;
export declare const isPlanningReviewCurrent: (record: PlanningReviewRecord | undefined, snapshot: ReviewSnapshot) => boolean;
/** 确定的反对意见也是有效结论；服务故障/缺材料允许恢复后重试。 */
export declare const isPlanningReviewReusable: (record: PlanningReviewRecord | undefined, snapshot: ReviewSnapshot) => boolean;
export declare const getPlanningReviewDiagnostics: (record: PlanningReviewRecord) => Array<{
    dimension: string;
    probability: number | null;
    threshold: number;
    question: unknown;
}>;
export {};
