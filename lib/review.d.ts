import type { AssessmentInfo, DelegationRecord, TaskRecord } from './evidence.js';
import type { DelegableRoleId, SuanHengMode } from './role-registry.js';
export type PeerReviewPhase = 'blind' | 'response';
export type PeerReviewRole = 'yu_shi' | 'suan_heng';
export type PeerReviewMismatch = 'status' | 'finalization' | 'stale' | 'card' | 'workflow' | 'request' | 'artifact-missing' | 'artifact-changed' | 'artifact-unavailable' | 'artifact';
export interface PeerReviewCurrentInfo {
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
    artifactDigest?: string;
}
export interface PeerReviewFrozenInfo extends PeerReviewCurrentInfo {
    delegationId: string;
    artifactDigest: string;
    hardIsolation: boolean;
}
export interface PeerReviewPriorInfo {
    delegationId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
    artifactDigest?: string;
    mismatches: PeerReviewMismatch[];
}
export interface PeerReviewRecoveryInfo {
    current: PeerReviewCurrentInfo;
    availablePhases: readonly PeerReviewPhase[];
    frozenBlind?: PeerReviewFrozenInfo;
    priorBlind?: PeerReviewPriorInfo;
    hasResponseOnly: boolean;
    hasUnclassifiedReview: boolean;
    /** A prior explicit blind exists, but its frozen artifact no longer matches current evidence. */
    staleEvidence: boolean;
}
/**
 * 从持久委派记录恢复独立初审状态，只认可绑定当前 task/card/workflow/request/artifact 的
 * 已完成 blind 记录。summary、对话历史和其他模型叙述不参与判断。
 *
 * @param task 当前任务
 * @param records 当前任务的全部持久委派记录
 * @param role 独立审查角色
 * @param mode 算衡模式；御史传 undefined
 * @param currentArtifactDigest 恢复时重新核验的当前产物摘要；缺省时读取任务快照
 * @returns 当前可用的评审阶段与精确冻结绑定
 */
export declare const getPeerReviewRecovery: (task: TaskRecord, records: readonly DelegationRecord[], role: PeerReviewRole, mode?: SuanHengMode, currentArtifactDigest?: string | undefined) => PeerReviewRecoveryInfo;
/**
 * 生成给 Agent 的准确评审阶段说明；不把用户提示、摘要或历史叙述当作冻结证据。
 *
 * @param info 持久记录恢复出的评审状态
 * @returns 可直接进入委派提示的说明
 */
export declare const getPeerReviewRecoveryText: (info: PeerReviewRecoveryInfo) => string;
/**
 * 衡鉴复评：每位专家交付后、以及天枢验收时，把交付的结构化摘要交给 Jev，
 * 回答「结论有依据吗」「回应完整吗」「角色专项要求达到了吗」并给出四档可信度。
 * Jev 的置信度是判断的集中程度，不等于正确性，所以复评只作提示与升级触发，不作硬门槛。
 */
/** 复评阈值 */
export interface ReviewThresholdsInfo {
    /** 可信度不低于此值且证据支撑不低于 0.6 时判为「可信」 */
    trustedAbove: number;
    /** 可信度低于此值，或证据支撑低于 0.35 时判为「存疑」 */
    doubtfulBelow: number;
}
export declare const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholdsInfo;
/** 四档可信度（低 → 高） */
export declare const RELIABILITY_LEVELS: readonly ['不可靠：结论与证据矛盾，或基本没有依据', '存疑：关键结论缺少证据，或推导有明显跳跃', '基本可信：结论有依据，存在次要缺口', '可信：结论与证据一致，覆盖完整'];
/**
 * 专家交付的复评题目：三道通用题 + 一道角色专项题
 * @param {DelegableRoleId} role - 角色
 * @param {SuanHengMode} [mode] - 算衡模式
 * @returns {Record<string, unknown>} Jev 题目
 */
export declare const getReviewQuestions: (role: DelegableRoleId, mode?: SuanHengMode) => Record<string, unknown>;
/**
 * 专家交付的复评状态：任务目标与验收标准、委派要求、交付摘要、结构化结果与证据（全部脱敏截断）
 * @param {TaskRecord} task - 任务
 * @param {DelegationRecord} record - 委派记录
 * @param {string} [request] - 天枢给专家的任务说明
 * @returns {object} state
 */
export declare const getReviewState: (task: TaskRecord, record: DelegationRecord, request?: string) => {
    completion_scope?: undefined;
    whole_goal_completed?: undefined;
    planning_scope?: undefined;
    role: string;
    mode?: string | undefined;
    task_goal: string;
    acceptance: string[];
    request?: string | undefined;
    result_summary: string;
    unresolved: string[];
    structured: string;
    evidence: {
        kind: "claim" | "command" | "file-change" | "finding" | "observation" | "source" | "step";
        ref: string;
        exitCode?: number | undefined;
        severity?: string | undefined;
        detail?: string | undefined;
    }[];
    changed_files: string[];
} | {
    completion_scope: string;
    whole_goal_completed: boolean;
    planning_scope: {
        rationale: string;
        deliverables: string[];
        deferred: string[];
    };
    role: string;
    mode?: string | undefined;
    task_goal: string;
    acceptance: string[];
    request?: string | undefined;
    result_summary: string;
    unresolved: string[];
    structured: string;
    evidence: {
        kind: "claim" | "command" | "file-change" | "finding" | "observation" | "source" | "step";
        ref: string;
        exitCode?: number | undefined;
        severity?: string | undefined;
        detail?: string | undefined;
    }[];
    changed_files: string[];
};
/** 天枢验收时的复评题目：验收结论是否与专家证据、门禁结果一致 */
export declare const ACCEPTANCE_QUESTIONS: Record<string, unknown>;
/**
 * 天枢验收的复评状态
 * @param {TaskRecord} task - 任务
 * @param {DelegationRecord[]} delegations - 本任务委派
 * @param {{ summary: string; unresolved: string[]; gates: Array<{ gate: string; satisfied: boolean }> }} acceptance - 验收说明与门禁
 * @returns {object} state
 */
export declare const getAcceptanceState: (task: TaskRecord, delegations: DelegationRecord[], acceptance: {
    summary: string;
    unresolved: string[];
    gates: Array<{
        gate: string;
        satisfied: boolean;
    }>;
}) => {
    completion_scope?: undefined;
    whole_goal_completed?: undefined;
    planning_scope?: undefined;
    task_goal: string;
    acceptance_criteria: string[];
    gates: {
        gate: string;
        satisfied: boolean;
    }[];
    delegations: {
        role: string;
        status: "blocked" | "completed" | "failed" | "queued" | "running";
        summary: string;
        review?: "doubtful" | "review" | "trusted" | undefined;
    }[];
    conclusion: string;
    unresolved: string[];
} | {
    completion_scope: string;
    whole_goal_completed: boolean;
    planning_scope: {
        rationale: string;
        deliverables: string[];
        deferred: string[];
    };
    task_goal: string;
    acceptance_criteria: string[];
    gates: {
        gate: string;
        satisfied: boolean;
    }[];
    delegations: {
        role: string;
        status: "blocked" | "completed" | "failed" | "queued" | "running";
        summary: string;
        review?: "doubtful" | "review" | "trusted" | undefined;
    }[];
    conclusion: string;
    unresolved: string[];
};
/**
 * 解析复评答案并给出判定
 * @param {Record<string, unknown>} answers - Jev 原始答案
 * @param {ReviewThresholdsInfo} thresholds - 阈值
 * @param {string} [model] - Jev 模型版本
 * @returns {AssessmentInfo} 复评结果；答案缺少可信度评分时为 unavailable
 */
export declare const ParseAssessment: (answers: Record<string, unknown>, thresholds: ReviewThresholdsInfo, model?: string) => AssessmentInfo;
/** 复评结论的中文标签 */
export declare const VERDICT_LABELS: Readonly<Record<NonNullable<AssessmentInfo['verdict']>, string>>;
/**
 * 复评结果的一行说明
 * @param {AssessmentInfo | undefined} assessment - 复评
 * @returns {string | undefined} 文本；没有复评时为 undefined
 */
export declare const getAssessmentText: (assessment: AssessmentInfo | undefined) => string | undefined;
