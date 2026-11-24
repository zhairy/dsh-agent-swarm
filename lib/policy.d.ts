import { type DelegableRoleId, type SuanHengMode } from './role-registry.js';
import type { WorkflowDefinition } from './workflow.js';
export declare const GATE_IDS: readonly ['G_VERIFY', 'G_REVIEW', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_DIFF_TEST', 'G_BENCH', 'G_VISION'];
export type GateId = typeof GATE_IDS[number];
export declare const FLAG_KEYS: readonly ['changesCode', 'changesAlgorithm', 'touchesFinancialLogic', 'timeSeriesOrBacktest', 'stateMachine', 'numericPrecision', 'sharedStateConcurrency', 'crossModuleArchitecture', 'securitySensitive', 'hasVisualInput', 'uiCopy', 'hasExecSteps', 'needsExternalFacts', 'ambiguousRequirements'];
export type FlagKey = typeof FLAG_KEYS[number];
export type TaskFlags = Record<FlagKey, boolean>;
/** 性能预算；未知参数写「待测」 */
export interface PerfInfo {
    p95Ms?: number | string;
    p99Ms?: number | string;
    throughput?: string;
    dataScale?: string;
    targets?: PerfTarget[];
}
export interface PerfTarget {
    metric: 'p95' | 'p99' | 'throughput' | 'peakMemory' | 'numericError';
    operator: '<=' | '>=';
    value: number;
    unit: 'ms' | 'ops/s' | 'bytes' | 'absolute';
    minSamples?: number;
}
export interface BenchmarkMeasurement {
    metric: PerfTarget['metric'];
    value: number;
    unit: PerfTarget['unit'];
    sampleCount: number;
    dataScale: string;
    inputDigest: string;
    environment: string;
    commandRef: string;
    rawArtifactRef: string;
}
export declare const PLANNING_SCOPE_MAX_ITEMS = 32;
export declare const PLANNING_SCOPE_MAX_TEXT_LENGTH = 4096;
export interface PlanningCoverageInfo {
    /** 对应 deliverables 的 1-based 序号，不允许把必需交付降为可选。 */
    deliverable: number;
    acceptanceIds: string[];
    nodeIds: string[];
}
/** 阶段合同保留整体需求，只说明当前交付及仍欠缺的工作；不是执行或总体验收豁免。 */
export interface PlanningScopeInfo {
    kind: 'phase';
    deliverables: string[];
    deferred: string[];
    rationale: string;
    coverage?: PlanningCoverageInfo[];
}
/** 经校验的任务卡 */
export interface TaskCard {
    title: string;
    goal: string;
    acceptance: string[];
    scope: string[];
    constraints?: {
        apiCompat?: string;
        environment?: string;
        resourceLimits?: string;
    };
    perf?: PerfInfo;
    flags: TaskFlags;
    workflow?: WorkflowDefinition;
    intent?: {
        text: string;
        sourceRef?: string;
    };
    planningScope?: PlanningScopeInfo;
}
export type GateSource = 'rule' | 'jev' | 'jev-fallback';
/** 一条必需门禁 */
export interface GateRequirement {
    gate: GateId;
    role: DelegableRoleId;
    mode?: SuanHengMode;
    reason: string;
    source: GateSource;
}
/** 门禁 → 负责角色 */
export declare const GATE_ROLE: Readonly<Record<GateId, {
    role: DelegableRoleId;
    mode?: SuanHengMode;
    label: string;
}>>;
/**
 * 校验并规范化任务卡输入
 * @param {unknown} input - swarm_task_card 的参数
 * @returns {{ card?: TaskCard; errors: string[] }} 规范化后的任务卡或错误列表
 */
export declare const ValidateTaskCard: (input: unknown) => {
    card?: TaskCard;
    errors: string[];
};
/**
 * 是否声明了真实的性能预算（规模描述、空 targets 与「待测」不算）
 * @param {PerfInfo | undefined} perf - 性能预算
 * @returns {boolean} 是否需要基准门禁
 */
export declare const hasPerfBudget: (perf: PerfInfo | undefined) => boolean;
/**
 * 确定性规则给出的强制门禁（先于 Jev，且不能被 Jev 移除）
 * @param {TaskCard} card - 任务卡
 * @returns {GateRequirement[]} 门禁列表
 */
export declare const getRuleGates: (card: TaskCard) => GateRequirement[];
/**
 * 是否值得调用 Jev：只在涉及代码/算法/性能且规则尚未覆盖全部可加门禁时调用
 * @param {TaskCard} card - 任务卡
 * @param {GateRequirement[]} gates - 规则门禁
 * @returns {boolean} 是否调用
 */
export declare const isTriageUseful: (card: TaskCard, gates: GateRequirement[]) => boolean;
/** Jev 答案中本插件读取的字段 */
export interface TriageAnswers {
    workspaceMode?: {
        choice: 'primary' | 'linked' | 'blocked';
        confidence: number;
    };
    mathTask?: {
        choice: string;
        confidence: number;
    };
    needBenchmark?: number;
    novelty?: {
        score: number;
        confidence: number;
    };
}
/** Jev 分流阈值（保守默认值，可按本地标注集校准） */
export interface TriageThresholdsInfo {
    mathConfidence: number;
    benchmarkNoul: number;
    noveltyScore: number;
    noveltyConfidence: number;
}
export declare const DEFAULT_TRIAGE_THRESHOLDS: TriageThresholdsInfo;
/**
 * 按 Jev 答案追加门禁；Jev 失败或置信度低时走严格路径。只增不减
 * @param {GateRequirement[]} gates - 已有门禁
 * @param {TaskCard} card - 任务卡
 * @param {{ answers?: TriageAnswers; failed: boolean; reason?: string }} triage - Jev 结果
 * @param {TriageThresholdsInfo} thresholds - 阈值
 * @returns {GateRequirement[]} 新的门禁列表
 */
export declare const AddTriageGates: (gates: GateRequirement[], card: TaskCard, triage: {
    answers?: TriageAnswers;
    failed: boolean;
    reason?: string;
}, thresholds: TriageThresholdsInfo) => GateRequirement[];
/**
 * 根据任务卡与门禁建议参与的角色（天枢据此决策，不强制）
 * @param {TaskCard} card - 任务卡
 * @param {GateRequirement[]} gates - 门禁
 * @returns {Array<{ role: DelegableRoleId; reason: string }>} 建议
 */
export declare const getSuggestedRoles: (card: TaskCard, gates: GateRequirement[]) => Array<{
    role: DelegableRoleId;
    reason: string;
}>;
/** 门禁判定需要的委派字段 */
export interface GateDelegationView {
    delegationId: string;
    role: DelegableRoleId;
    mode?: SuanHengMode;
    status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked';
    structured?: unknown;
    startedAt?: number;
    finishedAt?: number;
    independence: 'achieved' | 'not-achieved' | 'n/a';
    childId?: string;
    changedFiles?: string[];
    changeTracking?: 'git' | 'unavailable';
    cardRevision?: number;
    workflowRevision?: number;
    artifactDigest?: string;
    nodeId?: string;
    attemptId?: string;
    reviewPhase?: 'blind' | 'response';
}
/** 天枢对御史发现或验算反例的处理说明 */
export interface FindingResolution {
    delegationId: string;
    index: number;
    resolution: string;
}
/** 单个门禁的判定结果 */
export interface GateStatus {
    gate: GateId;
    satisfied: boolean;
    by?: string;
    missing?: string;
    notes: string[];
}
/**
 * 判定单个门禁是否已由证据满足
 * @param {GateId} gate - 门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {FindingResolution[]} resolutions - 天枢对御史发现与验算反例的处理
 * @param {number} [externalEditAt=0] - 委派之外的编辑时刻（天枢自己改文件）
 * @returns {GateStatus} 判定结果
 */
export declare const getGateStatus: (gate: GateId, delegations: GateDelegationView[], resolutions: FindingResolution[], externalEditAt?: number) => GateStatus;
/**
 * 实际生效的门禁：出现过编辑（含天枢自己改文件）时自动补上 G_VERIFY
 * @param {GateRequirement[]} gates - 任务卡门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {number} [externalEditAt=0] - 委派之外的编辑时刻
 * @returns {GateRequirement[]} 生效门禁
 */
export declare const getEffectiveGates: (gates: GateRequirement[], delegations: GateDelegationView[], externalEditAt?: number) => GateRequirement[];
/**
 * 汇总全部门禁的判定结果
 * @param {GateRequirement[]} gates - 生效门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {FindingResolution[]} resolutions - 发现处理
 * @param {number} [externalEditAt=0] - 委派之外的编辑时刻
 * @returns {{ ok: boolean; statuses: GateStatus[]; missing: string[] }} 是否可验收
 */
export declare const getAcceptanceCheck: (gates: GateRequirement[], delegations: GateDelegationView[], resolutions: FindingResolution[], externalEditAt?: number, perf?: PerfInfo) => {
    ok: boolean;
    statuses: GateStatus[];
    missing: string[];
};
export declare const getPerfTargets: (perf?: PerfInfo) => PerfTarget[];
/** 零退出码不等于达到性能预算；测量必须有单位、样本与可复查来源。 */
export declare const ValidatePerformanceEvidence: (perf: PerfInfo, delegations: GateDelegationView[]) => string[];
/** 调用预算；委派次数上限为 0 表示不限（同一大类任务可以反复追加调用同一专家） */
export interface BudgetInfo {
    maxDelegationsPerTask: number;
    maxCallsPerRole: number;
    maxCallsZhuJian: number;
    maxAutoFixRounds: number;
}
export declare const DEFAULT_BUDGETS: BudgetInfo;
/**
 * 检查本次委派是否超出预算；被预算拦下的 blocked 委派不计数
 * @param {GateDelegationView[]} delegations - 本任务已有委派
 * @param {DelegableRoleId} role - 本次角色
 * @param {BudgetInfo} budgets - 预算
 * @returns {string | undefined} 超出原因
 */
export declare const ValidateDelegationBudget: (delegations: GateDelegationView[], role: DelegableRoleId, budgets: BudgetInfo) => string | undefined;
