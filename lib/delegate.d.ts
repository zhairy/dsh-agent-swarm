import { type OutputLanguage } from './language.js';
import { type SwarmConfigInfo } from './config.js';
import type { BackendKind, DelegationRecord, Ledger, TaskRecord, TaskStore } from './evidence.js';
import { type AgentLike, type AttachmentsLike, type SubagentResultLike, type SubagentsLike, type ToolsLike } from './host-contract.js';
import { type PromptStyle } from './model-family.js';
import { type NetworkMonitorInfo } from './network.js';
import { type GateId } from './policy.js';
import { type PeerReviewRecoveryInfo } from './review.js';
import { type RouteEngine } from './application/routing/engine.js';
import { type DelegableRoleId, type SuanHengMode } from './role-registry.js';
import { type EscalationKind, type ModelFamily, type RouteInfo, type RouteProbe } from './domain/routing/routes.js';
import { type ChildEndHub, type SessionChoice, type SessionPlan, type ThreadInfo, type ThreadRegistry } from './threads.js';
import { SwarmError } from './util/errors.js';
import { type GitStatusInfo } from './util/git.js';
import type { MutexInfo } from './util/mutex.js';
export declare const DELEGATE_BACKENDS: readonly ['auto', 'api', 'codex', 'claude'];
export type DelegateBackend = typeof DELEGATE_BACKENDS[number];
/** swarm_delegate 的参数 */
export interface DelegateInput {
    task_id: string;
    language?: OutputLanguage;
    priority?: number;
    /** Host-only reviewed reference; never exposed by the tool schema. */
    referenceMemory?: string;
    languageExplicit?: boolean;
    /** Host-only: the runtime chooses the language policy after each actual model route is resolved. */
    languageManagedByRuntime?: boolean;
    role: DelegableRoleId;
    mode?: SuanHengMode;
    prompt: string;
    context_paths?: string[];
    image_paths?: string[];
    backend?: DelegateBackend;
    allow_web?: boolean;
    gate?: GateId;
    /** 天枢判断本次需要更强的模型（高风险、高歧义或置信度不足） */
    upgrade?: boolean;
    /** 会话方式：auto 由衡鉴判断；new 新建连续会话；continue 追加到该角色已有的会话；oneshot 一次性调用 */
    session?: SessionChoice;
    node_id?: string;
    request_id?: string;
    expected_workflow_revision?: number;
    /** 仅服务层生成；不公开给模型参数 schema。 */
    attempt_id?: string;
    review_phase?: 'blind' | 'response';
    /** Host-only binding recovered from durable records; never parsed from tool input. */
    reviewRecovery?: PeerReviewRecoveryInfo;
}
/**
 * 校验委派参数（包括角色与参数的组合约束）
 * @param {unknown} raw - 工具参数
 * @returns {{ input?: DelegateInput; errors: string[] }} 规范化参数或错误
 */
export declare const ValidateDelegateInput: (raw: unknown) => {
    input?: DelegateInput;
    errors: string[];
};
/** 允许使用原生后端的只读类角色 */
export declare const NATIVE_READ_ROLES: readonly DelegableRoleId[];
/** 允许使用原生后端的编辑类角色 */
export declare const NATIVE_EDIT_ROLES: readonly DelegableRoleId[];
/**
 * 按角色与选择确定原生后端实例种类；执行/验证/视觉角色不走原生后端
 * @param {DelegableRoleId} role - 角色
 * @param {EscalationKind} choice - codex 或 claude
 * @returns {BackendKind | undefined} 实例种类
 */
export declare const getNativeKind: (role: DelegableRoleId, choice: EscalationKind) => BackendKind | undefined;
export declare const getNativeProviderName: (kind: BackendKind, config: SwarmConfigInfo) => string;
/**
 * 子智能体工具过滤：角色需要的工具 ∩ 父会话实际可见的工具；无交集时隐藏全部可见工具
 * @param {DelegableRoleId} role - 角色
 * @param {string[]} visibleNames - 父会话可见工具名
 * @param {boolean} allowWeb - 本次是否开放 web
 * @returns {{ allow?: string[]; deny?: string[] } | undefined} toolFilter
 */
export declare const getToolFilter: (role: DelegableRoleId, visibleNames: string[], allowWeb: boolean) => {
    allow?: string[];
    deny?: string[];
} | undefined;
/**
 * 生成交给子智能体的任务背景（子智能体看不到天枢对话）
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @returns {string} 背景文本
 */
export declare const getTaskBrief: (task: TaskRecord, input: DelegateInput, delegationId: string) => string;
/**
 * 一次性调用的任务说明（宿主提供结构化提交工具），按模型家族组织
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @param {PromptStyle} [style='generic'] - 提示风格
 * @returns {string} 文本
 */
export declare const getChildPromptText: (task: TaskRecord, input: DelegateInput, delegationId: string, style?: PromptStyle) => string;
/** 连续会话的交付要求正文：宿主不为连续会话提供结构化提交工具，结果以 json 代码块回复 */
export declare const getJsonDeliveryBody: (role: DelegableRoleId) => string;
/** 带标题的连续会话交付要求（用于会话内的重试提示） */
export declare const getJsonDeliveryText: (role: DelegableRoleId) => string;
/** 连续会话的首轮任务 */
export declare const getThreadPromptText: (task: TaskRecord, input: DelegateInput, delegationId: string, style?: PromptStyle) => string;
/**
 * 追加到连续会话的新任务：会话没见过的任务附完整背景，同一任务只附编号
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @param {boolean} knowsTask - 该会话此前处理过这个任务
 * @param {PromptStyle} [style='generic'] - 提示风格（与建会话时的 persona 一致）
 * @returns {string} 文本
 */
export declare const getThreadFollowupText: (task: TaskRecord, input: DelegateInput, delegationId: string, knowsTask: boolean, style?: PromptStyle) => string;
/**
 * 连续会话内的重试提示：中断则续跑，交付不合格则只修正结构化结果
 * @param {DelegableRoleId} role - 角色
 * @param {{ stopReason: string; error?: string; missing: boolean }} failure - 失败情况
 * @returns {string} 文本
 */
export declare const getThreadRetryText: (role: DelegableRoleId, failure: {
    stopReason: string;
    error?: string;
    missing: boolean;
}) => string;
/** 原生后端（Codex / Claude Code 客户端）对应的提示风格 */
export declare const getNativeStyle: (kind: BackendKind) => PromptStyle;
export declare const getNativePromptText: (task: TaskRecord, input: DelegateInput, delegationId: string, mode?: SuanHengMode, style?: PromptStyle, relaxed?: boolean) => string;
/**
 * 从原生后端的文本回答中取结构化结果：最后一个 json 代码块，退化为首尾花括号片段
 * @param {string} text - 回答文本
 * @returns {unknown} 解析结果，失败为 undefined
 */
export declare const ParseNativeOutput: (text: string) => unknown;
export declare const getOutputText: (result: SubagentResultLike) => string;
/**
 * DSH/DeepSeek 在连续会话回放含 thinking 的助手历史时可能要求特定协议签名。
 * 若宿主明确拒绝该历史，继续在同一个子会话里追加只会重复失败；调用方应新建干净子会话。
 */
export declare const isThinkingReplayFailure: (error: string | undefined) => boolean;
/**
 * 独立性要求避开的模型家族：御史避开实现者，验算避开研算
 * @param {DelegableRoleId} role - 本次角色
 * @param {SuanHengMode | undefined} mode - 算衡模式
 * @param {DelegationRecord[]} delegations - 本任务已有委派
 * @returns {ModelFamily[]} 需要避开的家族
 */
export declare const getAvoidFamilies: (role: DelegableRoleId, mode: SuanHengMode | undefined, delegations: DelegationRecord[]) => ModelFamily[];
/** 单个根会话的委派上下文 */
export interface DelegateSessionInfo {
    sessionId: string;
    store: TaskStore;
    ledger: Ledger;
    editLock: MutexInfo;
    counters: {
        native: number;
    };
    /** 该根会话的连续会话 */
    threads: ThreadRegistry;
}
/** 衡鉴判断会话方式的输入 */
export interface PlanSessionInput {
    input: DelegateInput;
    task: TaskRecord;
    /** 可追加的候选会话（同一路由键中最近使用的空闲会话） */
    thread?: ThreadInfo;
    session: DelegateSessionInfo;
    signal: AbortSignal;
}
/** A trusted dispatch refusal must never become a route fallback or replay. */
export declare class DispatchAdmissionError extends SwarmError {
    constructor(message: string, code?: import('./util/errors.js').SwarmErrorCode);
}
export interface DelegateExecInfo {
    agent: AgentLike;
    signal: AbortSignal;
    callId?: string;
    /** Trusted control-plane target; never accepted as a model/tool parameter. */
    controlledThreadId?: string;
    /** Server-owned frozen contract and final publication gate; never parsed from tool input. */
    admission?: {
        task: TaskRecord;
        dispatch: <T>(publish: () => Promise<T>) => Promise<T>;
        assertCurrent?: () => void;
        attemptId?: string;
        leaseEpoch?: number;
        artifactDigest?: string;
    };
}
/** 委派执行依赖（全部可替换，便于测试） */
export interface DelegateDepsInfo {
    getConfig: () => SwarmConfigInfo;
    getSubagents: () => SubagentsLike | undefined;
    getTools: () => ToolsLike | undefined;
    getAttachments: () => AttachmentsLike | undefined;
    probe: RouteProbe;
    probeForChild?: (childId: string, route: RouteInfo, signal?: AbortSignal) => ReturnType<RouteProbe>;
    orderQuotaRoutes?: (routes: readonly RouteInfo[], signal?: AbortSignal, protectedRoutes?: readonly RouteInfo[]) => Promise<readonly RouteInfo[]>;
    routeState: RouteEngine;
    readFile: (path: string) => Promise<Uint8Array>;
    gitStatus: (cwd: string) => Promise<GitStatusInfo | undefined>;
    now: () => number;
    newId: (prefix: string) => string;
    /** 连续会话的子会话 ID */
    newChildId: () => string;
    /** 连续会话的结束事件 */
    hub: ChildEndHub;
    /** 衡鉴判断会话方式；缺省或返回 undefined 时按规则 */
    planSession?: (input: PlanSessionInput) => Promise<SessionPlan | undefined>;
    /** 等待；传入 signal 时调用方取消即提前结束 */
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** 联网探测：出错重试前若已断网，等待网络恢复而不是按固定间隔重试 */
    network?: NetworkMonitorInfo;
    onChildStart?: (info: {
        agentId: string;
        task: TaskRecord;
        record: DelegationRecord;
        role: DelegableRoleId;
        signal: AbortSignal;
        persistent?: boolean;
        input?: DelegateInput;
        parent?: AgentLike;
    }) => void | Promise<void>;
    onChildEnd?: (agentId: string, stopReason?: string, completed?: {
        attemptId: string;
        delegationId: string;
    }) => void | Promise<void>;
    /** 0.2.1-alpha：在启动子智能体前登记角色与 allow_web，供宿主 agent/created 首次装配前限制工具面 */
    noteChildScope?: (request: ChildScopeRequest) => void;
}
/** 启动子智能体前登记的组合意图：宿主 agent/created 早于启动返回，用它决定首次装配的工具面与 persona */
export interface ChildScopeRequest {
    role: DelegableRoleId;
    allowWeb: boolean;
    parentSessionId?: string;
    mode?: SuanHengMode;
    language?: OutputLanguage;
    explicitLanguage?: boolean;
}
/**
 * 创建委派执行器
 * @param {DelegateDepsInfo} deps - 依赖
 * @returns {{ delegate: (raw: unknown, exec: DelegateExecInfo, session: DelegateSessionInfo) => Promise<DelegationRecord> }} 执行器
 */
export declare const intDelegator: (deps: DelegateDepsInfo) => {
    delegate: (raw: unknown, exec: DelegateExecInfo, session: DelegateSessionInfo) => Promise<DelegationRecord>;
};
