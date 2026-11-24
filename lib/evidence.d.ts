import type { EvidenceItem } from './contracts.js';
import type { FindingResolution, GateDelegationView, GateRequirement, TaskCard, TriageAnswers } from './policy.js';
import type { RouteInfo } from './domain/routing/routes.js';
import type { OrchestrationPlan } from './orchestration.js';
import type { PromptStyle } from './model-family.js';
import type { WorkflowDefinition, WorkflowStateInfo } from './workflow.js';
import type { PlanningReviewRecord } from './planning-review.js';
import type { ArtifactSnapshot } from './artifacts.js';
import type { CheckpointInfo } from './checkpoint.js';
import type { VerificationReceipt } from './verification-receipt.js';
export type DelegationStatus = GateDelegationView['status'];
export type BackendKind = 'spawn' | 'codex' | 'codex-edit' | 'claude-plan' | 'claude-edit';
/** 一次路由尝试的记录 */
export interface RouteAttempt {
    route: string;
    backend: BackendKind;
    outcome: 'skipped' | 'failed' | 'used' | 'fallback';
    reason?: string;
}
/** 衡鉴复评：交付完成后由 Jev 给出的置信度评分；它衡量判断的集中程度，不等于正确性，不作为硬门槛 */
export interface AssessmentInfo {
    status: 'ok' | 'unavailable';
    failureKind?: import('./jev.js').JevFailureKind;
    /** 未执行的原因（例如 missing-api-key、disabled、http-503） */
    reason?: string;
    /** 可信 / 需核实 / 存疑 */
    verdict?: 'trusted' | 'review' | 'doubtful';
    /** 整体可信度，0–1（四档评分的期望值归一化） */
    reliability?: number;
    /** Jev 对该评分的置信度（分布集中程度） */
    confidence?: number;
    /** 各项是/否检查为「成立」的概率 */
    checks?: Record<string, number>;
    model?: string;
}
/** 一次委派的完整记录 */
export interface DelegationRecord extends GateDelegationView {
    requestRevision?: number;
    /** Model completion is provisional until outer evidence/version finalization. */
    finalization?: 'processing' | 'ready' | 'cancelled' | 'failed';
    taskId: string;
    roleName: string;
    gate?: string;
    summary: string;
    evidence: EvidenceItem[];
    route?: RouteInfo;
    backend?: BackendKind;
    attempts: RouteAttempt[];
    hardIsolation: boolean;
    changedFiles?: string[];
    changeTracking?: 'git' | 'unavailable';
    unresolved: string[];
    childId?: string;
    error?: string;
    startedAt: number;
    /** Last observed host activity for the active assignment. */
    lastHeartbeatAt?: number;
    durationMs?: number;
    /** 本次委派触发了容灾升级：原因与升级模型链 */
    upgrade?: {
        reasons: string[];
        chain: string[];
    };
    /** 衡鉴复评 */
    assessment?: AssessmentInfo;
    /** 会话方式：一次性，或连续会话（threadId 为子会话 ID，round 为该会话的第几轮） */
    session?: DelegationSessionInfo;
    /** 自动重试：未执行、中断、出错或交付不合格时的重试记录 */
    retries?: DelegationRetryInfo[];
    /** 按所用模型家族选定的提示风格（claude / gpt / generic） */
    promptStyle?: PromptStyle;
    artifactBefore?: string;
    artifactAfter?: string;
    staleReason?: string;
    reviewPhase?: 'blind' | 'response';
    /** Trusted original bounded arguments used only for an explicit, validated manual continuation. */
    continuationInput?: import('./delegate.js').DelegateInput;
    evidenceAssessment?: import('./evidence-assessment.js').EvidenceAssessment;
    /** Immutable execution envelope frozen at worker dispatch. */
    assignment?: import('./router-worker.js').AssignmentEnvelope;
}
/** 一次委派的会话方式 */
export interface DelegationSessionInfo {
    kind: 'oneshot' | 'continuable';
    /** 连续会话的子会话 ID */
    threadId?: string;
    /** 连续会话的第几轮（从 1 开始） */
    round?: number;
    /** 是否追加到了已有会话 */
    appended: boolean;
    /** 决定来源：衡鉴、规则、天枢指定或配置 */
    source: string;
    reason: string;
}
/** 一次自动重试 */
export interface DelegationRetryInfo {
    attempt: number;
    reason: string;
    /** continue：在同一会话里续跑或修正；restart：重新启动一次性子智能体；fallback：退回一次性调用 */
    action: 'continue' | 'restart' | 'fallback';
}
/** 衡鉴分流记录 */
export interface TriageRecord {
    source: 'rules' | 'rules+jev' | 'rules+jev-fallback';
    answers?: TriageAnswers;
    fallbackReason?: string;
    rulesApplied: string[];
}
/** 验收记录 */
export interface AcceptanceRecord {
    decision: 'accept' | 'reject' | 'incomplete';
    status: 'accepted' | 'blocked' | 'recorded';
    summary: string;
    missing: string[];
    unresolved: string[];
    stopReason: string;
    resolutions: FindingResolution[];
    at: number;
    /** 仅服务端在当前独立证据校验与 accepted 同一事务中生成；旧验收缺失时仅为历史。 */
    verificationReceipt?: VerificationReceipt;
    assessment?: AssessmentInfo;
}
/** 任务记录 */
export interface TaskRecord {
    /** Host 读取项目硬限制的规划事实，不是模型声明的授权。 */
    workspacePlan?: import('./workspace-policy.js').WorkspacePlan;
    workspacePlanUnavailable?: boolean;
    /** Stable Host goal owner; revisions remain separately bound by receipts. */
    runtimeGoalId?: string;
    /** Immutable idempotency key for a Source/Outbox materialized Ticket. */
    sourceEffectId?: string;
    taskId: string;
    sessionId: string;
    card: TaskCard;
    gates: GateRequirement[];
    triage: TriageRecord;
    delegationIds: string[];
    rounds: number;
    acceptance?: AcceptanceRecord;
    createdAt: number;
    updatedAt: number;
    cardRevision?: number;
    workflowRevision?: number;
    requestRevision?: number;
    intentText?: string;
    /** 真实逐条消息出处；旧记录缺失时只能作为明确标注的聚合材料恢复。 */
    intentRefs?: Array<{
        source: string;
        text: string;
    }>;
    intentSource?: 'host' | 'declared';
    intentSourceRef?: string;
    intentLastDigest?: string;
    intentHistoryNote?: string;
    intentHistoryUnavailable?: boolean;
    intentHistoryIncomplete?: boolean;
    workflowDefinition?: WorkflowDefinition;
    workflowState?: WorkflowStateInfo;
    workflowDigest?: string;
    planningReview?: PlanningReviewRecord;
    /** 执行前的编排方案（复杂度、拆分维度、子任务与并行组）；旧状态没有这个字段。 */
    orchestration?: OrchestrationPlan;
    planningFixRounds?: number;
    /** Automatic review admission per human request revision; contract edits never consume execution budget. */
    planningAutoReviewRuns?: number;
    artifactSnapshot?: ArtifactSnapshot;
    checkpoint?: CheckpointInfo;
    workspaceId?: string;
    requestIds?: Record<string, string>;
    requestInputs?: Record<string, string>;
    recovered?: boolean;
    contextRefs?: Array<{
        ref: string;
        digest: string;
        layer: string;
        kind: string;
    }>;
    contextDelegations?: Record<string, string>;
}
/**
 * 委派状态是否允许从 from 迁移到 to（终态不可再变）
 * @param {DelegationStatus} from - 当前状态
 * @param {DelegationStatus} to - 目标状态
 * @returns {boolean} 是否允许
 */
export declare const ValidateTransition: (from: DelegationStatus, to: DelegationStatus) => boolean;
/** 单个根会话内的任务与委派存储 */
export interface TaskStore {
    AddTask: (task: TaskRecord) => void;
    /** Restore an already validated durable snapshot into an empty store without replaying lifecycle transitions. */
    RestoreSnapshot?: (tasks: readonly TaskRecord[], delegations: readonly DelegationRecord[]) => void;
    getTask: (taskId: string) => TaskRecord | undefined;
    UpdateTask: (taskId: string, patch: Partial<TaskRecord>) => TaskRecord;
    AddDelegation: (record: DelegationRecord) => void;
    UpdateDelegation: (delegationId: string, patch: Partial<DelegationRecord>) => DelegationRecord;
    getDelegation: (delegationId: string) => DelegationRecord | undefined;
    getTaskDelegations: (taskId: string) => DelegationRecord[];
    getTasks: () => TaskRecord[];
    /**
     * 取走并清空自上次确认以来的写入口脏键；缺失时调用方回退全量快照提交。
     * 取走即清空是关键：提交是异步的，清空若不与取走原子，await 期间的新写入会被误清而永不落盘。
     */
    takeDirty?: () => TaskStoreDirty;
    /** 提交失败时把取走的脏键放回，保证重试会再次携带同一批键；成功路径不需要调用。 */
    restoreDirty?: (dirty: TaskStoreDirty) => void;
    /** Internal card transaction rollback; preserves independently added delegation associations. */
    RollbackTask?: (taskId: string, previous: TaskRecord | undefined, expected: {
        cardRevision: number;
        workflowRevision: number;
        requestRevision: number;
    }) => boolean;
}
/** 任务存储的增量脏键：set 对应新增/替换，removed 对应删除。 */
export interface TaskStoreDirty {
    readonly tasks: readonly string[];
    readonly delegations: readonly string[];
    readonly removedTasks: readonly string[];
}
/**
 * 创建内存存储；更新总是替换为新对象，旧引用保持不变
 * @returns {TaskStore} 存储
 */
export declare const intTaskStore: () => TaskStore;
export type LedgerEventType = 'agent/manual-continue' | 'task/card' | 'delegation/queued' | 'delegation/running' | 'delegation/completed' | 'delegation/failed' | 'delegation/blocked' | 'route/skipped' | 'route/fallback' | 'route/upgrade' | 'route/recovery-probe' | 'route/recovered' | 'jev/call' | 'review/assessment' | 'native/call' | 'accept/decision' | 'session/plan' | 'delegation/retry' | 'workflow/review' | 'workflow/checkpoint' | 'workflow/stale' | 'math/computed' | 'message/send' | 'message/ack' | 'state/recovered' | 'experience/candidate' | 'worktree/created';
/** 账本事件（一行 JSON） */
export interface LedgerEvent {
    ts: string;
    type: LedgerEventType;
    sessionId: string;
    taskId?: string;
    delegationId?: string;
    data: Record<string, unknown>;
}
/**
 * 深度脱敏：字符串去除密钥样式内容并截断
 * @param {unknown} value - 任意值
 * @returns {unknown} 脱敏后的新值
 */
export declare const getRedactedValue: (value: unknown) => unknown;
/**
 * 账本文件路径：会话 id 中的非安全字符替换为下划线
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @returns {string} 文件路径
 */
export declare const getLedgerPath: (dir: string, sessionId: string) => string;
/** 账本句柄 */
export interface Ledger {
    path: string;
    AddLedgerEvent: (event: Omit<LedgerEvent, 'ts' | 'sessionId'>) => void;
}
/**
 * 创建追加写入的 JSONL 账本；写入失败只回调 onError，不影响任务执行
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @param {(error: unknown) => void} [onError] - 写入失败回调
 * @returns {Ledger} 账本
 */
export declare const intLedger: (dir: string, sessionId: string, onError?: (error: unknown) => void) => Ledger;
/**
 * 读回账本事件，跳过无法解析的行
 * @param {string} path - 账本文件
 * @returns {LedgerEvent[]} 事件列表
 */
export declare const getLedgerEvents: (path: string) => LedgerEvent[];
