import { type GateId, type GateRequirement, type TaskCard } from './policy.js';
import { type DelegableRoleId, type SuanHengMode } from './role-registry.js';
export declare const WORKFLOW_GENERATOR_VERSION = "1";
export declare const MERMAID_PARSER_VERSION: string;
export declare const WORKFLOW_LIMITS: Readonly<{
    nodes: 32;
    edges: 64;
    labelChars: 120;
    sourceBytes: 32768;
}>;
export type WorkflowMode = 'quick' | 'standard' | 'algorithm';
export type WorkflowNodeOperation = 'delegate' | 'checkpoint' | 'accept';
export type WorkflowNodeStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped';
export interface WorkflowNodeInfo {
    id: string;
    label: string;
    operation: WorkflowNodeOperation;
    role?: DelegableRoleId;
    mathMode?: SuanHengMode;
    dependsOn: string[];
    gates: GateId[];
    outputContractVersion: string;
}
export interface WorkflowDefinition {
    schemaVersion: 1;
    mode: WorkflowMode;
    nodes: WorkflowNodeInfo[];
}
export interface WorkflowNodeStateInfo {
    status: WorkflowNodeStatus;
    attemptId?: string;
    reason?: string;
    evidenceRefs?: string[];
}
export interface WorkflowStateInfo {
    round: number;
    nodes: Record<string, WorkflowNodeStateInfo>;
}
export interface WorkflowParserResultInfo {
    parserVersion: string;
    parseVerdict: 'pass' | 'fail' | 'unavailable';
    projectionVerdict: 'pass' | 'fail';
    sourceDigest: string;
    generatorVersion: string;
    errors: string[];
}
export type MermaidParserLike = (source: string) => Promise<{
    version: string;
    ok: boolean;
    error?: string;
}>;
/** 稳定 JSON：对象键排序，数组保留语义顺序，拒绝非 JSON 值。 */
export declare const getCanonicalJson: (value: unknown) => string;
export declare const getValueDigest: (value: unknown) => string;
/** 节点列表、无序依赖/门禁的重排属于展示变化，不改变执行语义摘要。 */
export declare const getCanonicalWorkflow: (definition: WorkflowDefinition) => WorkflowDefinition;
export declare const getWorkflowDigest: (definition: WorkflowDefinition) => string;
export declare const getWorkflowMode: (card: TaskCard) => WorkflowMode;
/** 从有效门禁生成小流程。没有代码改动时不强拉修改或运行角色。 */
export declare const getDefaultWorkflow: (card: TaskCard, gates: readonly GateRequirement[]) => WorkflowDefinition;
/** 规范化并检查 DAG、角色、门禁、验收路径与实现前研算。 */
export declare const ValidateWorkflow: (raw: unknown, card: TaskCard, gates: readonly GateRequirement[]) => {
    definition?: WorkflowDefinition;
    errors: string[];
};
/**
 * 宽松读取天枢给出的流程：补齐可推导字段（mode、schemaVersion、label、outputContractVersion），丢弃未知字段，
 * 把放错节点的门禁移走（算衡节点按门禁推断模式）。缺失的必需门禁、检查点与验收随后由 ReconcileWorkflow 补齐。
 * 只放宽写法，不放宽语义：DAG、角色与门禁仍由 ValidateWorkflow 严格校验，必需门禁只会补入、不会删除。
 */
export declare const getLenientWorkflow: (raw: unknown, card: TaskCard, gates: readonly GateRequirement[]) => WorkflowDefinition;
/** 新门禁只能补入结构，保持已有业务节点 ID；返回变更摘要供调用方递增版本。 */
export declare const ReconcileWorkflow: (definition: WorkflowDefinition, card: TaskCard, gates: readonly GateRequirement[]) => {
    definition: WorkflowDefinition;
    changed: boolean;
    errors: string[];
};
/** 标签永远只是文字；数值实体防止引号、HTML 与 Mermaid 指令注入。 */
export declare const getMermaidLabel: (value: string) => string;
export declare const getWorkflowMermaid: (definition: WorkflowDefinition) => string;
/** 规划审核状态的说明文字：观察模式不自动审核，没有记录时说明「未运行」而不是「待审核」 */
export declare const getPlanningStatusText: (status: string | undefined, mode: string) => string;
/** 同一合同和图生成可复制任务说明，展示与执行状态共用唯一数据源。 */
export declare const getTaskCardMarkdown: (card: TaskCard, definition: WorkflowDefinition, options: {
    taskId: string;
    cardRevision?: number;
    workflowRevision?: number;
    state?: WorkflowStateInfo;
    planningStatus?: string;
    delegationLimit?: number;
}) => string;
/** 受限生成器投影必须精确一致，语法正确也不能篡改标签或箭头。 */
export declare const ValidateMermaidProjection: (definition: WorkflowDefinition, source: string) => string[];
/** 官方 parser 在独立 worker 的 DOM 适配里运行，不污染宿主 globalThis。 */
export declare const intOfficialMermaidParser: (timeoutMs?: number) => MermaidParserLike;
export declare const ParseWorkflowMermaid: (definition: WorkflowDefinition, source?: string, parser?: MermaidParserLike) => Promise<WorkflowParserResultInfo>;
export declare const intWorkflowState: (definition: WorkflowDefinition, round?: number) => WorkflowStateInfo;
/**
 * Reconcile a new graph version without discarding unchanged node evidence.
 * A changed node keeps only a historical skip/blocked marker; it is never
 * silently replayed as a fresh completion.
 */
export declare const ReconcileWorkflowState: (previousDefinition: WorkflowDefinition | undefined, previousState: WorkflowStateInfo | undefined, definition: WorkflowDefinition, round?: number) => WorkflowStateInfo;
export declare const getReadyNodes: (definition: WorkflowDefinition, state: WorkflowStateInfo) => WorkflowNodeInfo[];
export declare const getMatchingNode: (definition: WorkflowDefinition, state: WorkflowStateInfo, input: {
    role: DelegableRoleId;
    mode?: SuanHengMode;
    gate?: GateId;
    nodeId?: string;
}, options?: {
    deterministicFallback?: boolean;
}) => {
    node?: WorkflowNodeInfo;
    reason?: string;
};
/** 更新显式节点状态。attempt 旧结果不能覆盖新结果；终态只能由新修复轮重建。 */
export declare const UpdateWorkflowNode: (state: WorkflowStateInfo, nodeId: string, status: WorkflowNodeStatus, patch?: Omit<Partial<WorkflowNodeStateInfo>, 'status'>) => WorkflowStateInfo;
