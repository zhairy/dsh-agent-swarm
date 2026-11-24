import type { TaskCard, TriageAnswers } from './policy.js';
/** Jev 调用配置 */
export interface JevConfigInfo {
    enabled: boolean;
    source: 'official' | 'third-party';
    apiKeyEnv: string;
    baseUrl: string;
    model: string;
    thirdParty?: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    };
    timeoutMs: number;
    maxRetries: number;
    /** 兼容旧配置；Jev 不主动限流，此值不再参与发送决策 */
    maxRequestsPerSecond: number;
    /** 单次请求（state + questions 序列化后）的字符上限 */
    maxRequestChars: number;
}
export declare const DEFAULT_JEV_CONFIG: JevConfigInfo;
export declare const JEV_PATH = "/v1/systemone";
export declare const JEV_MODELS_PATH = "/v1/models";
/** V2 设计稿 §4 定义的三道分流题 */
export declare const JEV_QUESTIONS: {
    readonly math_task: {
        readonly type: 'choice';
        readonly instructions: '选择此任务需要的数学检查类型；按最高必要强度选择';
        readonly criteria: {
            readonly ordinary: '只改变工程实现，不改变算法语义';
            readonly invariant: '需要检查边界条件、状态不变量或数值精度';
            readonly equivalence: '增量和全量实现需要语义等价验证';
            readonly research: '需要设计新算法并比较复杂度、正确性和性能';
        };
    };
    readonly need_benchmark: {
        readonly type: 'noul';
        readonly instructions: '是否有性能目标或关键数据规模要求，需做可重复基准测试';
    };
    readonly novelty: {
        readonly type: 'score';
        readonly instructions: '算法变化的程度';
        readonly criteria: readonly ['行为不变的局部调整', '改变状态或边界处理', '提出新算法或语义'];
    };
};
/** 工作区题仅对有项目规则材料的任务启用，与原分流题在同一次请求中判断。 */
export declare const getJevQuestions: (workspace?: import('./workspace-policy.js').WorkspacePlan) => {
    readonly math_task: {
        readonly type: 'choice';
        readonly instructions: '选择此任务需要的数学检查类型；按最高必要强度选择';
        readonly criteria: {
            readonly ordinary: '只改变工程实现，不改变算法语义';
            readonly invariant: '需要检查边界条件、状态不变量或数值精度';
            readonly equivalence: '增量和全量实现需要语义等价验证';
            readonly research: '需要设计新算法并比较复杂度、正确性和性能';
        };
    };
    readonly need_benchmark: {
        readonly type: 'noul';
        readonly instructions: '是否有性能目标或关键数据规模要求，需做可重复基准测试';
    };
    readonly novelty: {
        readonly type: 'score';
        readonly instructions: '算法变化的程度';
        readonly criteria: readonly ['行为不变的局部调整', '改变状态或边界处理', '提出新算法或语义'];
    };
} | {
    math_task: {
        readonly type: 'choice';
        readonly instructions: '选择此任务需要的数学检查类型；按最高必要强度选择';
        readonly criteria: {
            readonly ordinary: '只改变工程实现，不改变算法语义';
            readonly invariant: '需要检查边界条件、状态不变量或数值精度';
            readonly equivalence: '增量和全量实现需要语义等价验证';
            readonly research: '需要设计新算法并比较复杂度、正确性和性能';
        };
    };
    need_benchmark: {
        readonly type: 'noul';
        readonly instructions: '是否有性能目标或关键数据规模要求，需做可重复基准测试';
    };
    novelty: {
        readonly type: 'score';
        readonly instructions: '算法变化的程度';
        readonly criteria: readonly ['行为不变的局部调整', '改变状态或边界处理', '提出新算法或语义'];
    };
    workspace_mode: {
        type: 'choice';
        instructions: string;
        criteria: {
            primary: string;
            linked: string;
            blocked: string;
        };
    };
};
/** 只替换常见密钥格式（线性匹配、不截断）；直通 Jev 工具用它，判断正文的其余部分保持原样。 */
export declare const getSecretFormatRedacted: (text: string) => string;
/**
 * 去掉密钥样式内容并截断，保证发往 Jev 的只有脱敏摘要。
 * 先按键值整体替换（值可含认证方案与组合凭据），再替换独立的常见密钥格式；
 * 覆盖 JSON 形式的键值（结构化交付会先 JSON.stringify 再脱敏）、PEM 私钥、JWT 与常见服务的令牌前缀。
 * 只处理截断点之后留有余量的前缀，跨越截断点的密钥仍能被整体识别。
 * @param {string} text - 原文
 * @param {number} [max=500] - 截断长度
 * @returns {string} 脱敏文本
 */
export declare const getRedactedText: (text: string, max?: number) => string;
/**
 * 构造 Jev state：任务摘要及可选的有界 Host 工作树规则/需求；不包含业务源码和凭据。
 * @param {TaskCard} card - 任务卡
 * @returns {object} state
 */
export declare const getJevState: (card: TaskCard, workspace?: import('./workspace-policy.js').WorkspacePlan, request?: {
    text: string;
    source: 'host' | 'declared';
}) => {
    task: string;
    goal: string;
    flags: import("./policy.js").TaskFlags;
    profile: {
        [k: string]: any;
    };
    acceptance_count: number;
    scope_count: number;
    workspace?: {
        mode: "blocked" | "linked" | "primary";
        allowedModes: ("linked" | "primary")[];
        worktreeCountAtPlanning: number;
        reason: string;
        evidence: string[];
        sourceDigests: {
            path: string;
            digest: string;
        }[];
        request?: {
            text: string;
            source: "declared" | "host";
        } | undefined;
    } | undefined;
};
/** 所有 Jev 判断入口共用数值合同；非法值不能进入分流、分档或审核结论。 */
export declare const isJevProbability: (value: unknown) => value is number;
export declare const isJevScore: (value: unknown, levels: number) => value is number;
export type JevFailureKind = 'disabled' | 'configuration' | 'permission' | 'authentication' | 'billing' | 'availability' | 'invalid-request' | 'invalid-response' | 'cancelled' | 'unknown';
interface JevFailureLike {
    reason: string;
    status?: number;
    failureKind?: JevFailureKind;
}
/** 根据稳定事实分类；不把权限、坏响应或取消伪装为可降级的服务不可用。 */
export declare const getJevFailureKind: (failure: JevFailureLike) => JevFailureKind;
/** 可选 Jev 审核只允许有明确原因的关闭、缺少配置或上游临时不可用降级。 */
export declare const isJevAvailabilityFailure: (failure: JevFailureLike) => boolean;
/** 凭据错误只带受控原因；宿主拒绝后不尝试另一凭据来源。 */
export declare class JevCredentialError extends Error {
    readonly reason: 'credential-permission-denied' | 'credential-unavailable';
    constructor(reason: 'credential-permission-denied' | 'credential-unavailable');
}
export declare const getJevCredentialError: (error: unknown) => JevCredentialError;
/**
 * 只读取程序需要的字段：math_task.choice/confidence、need_benchmark.noul、novelty.score/confidence
 * @param {unknown} body - Jev 响应体
 * @returns {TriageAnswers} 解析结果
 */
export declare const ParseJevAnswers: (body: unknown) => TriageAnswers;
export type JevOutcome = {
    ok: true;
    answers: TriageAnswers;
    attempts: number;
} | {
    ok: false;
    reason: string;
    attempts: number;
};
/** Jev 用量：输入与输出 token（服务端报告） */
export interface JevUsageInfo {
    /** 缺失/非法服务用量为 unknown，不能冒充零。 */
    inputTokens?: number;
    outputTokens?: number;
}
/** 通用提问的结果：answers 为 Jev 原始答案（按题目 ID） */
export type JevAskOutcome = {
    ok: true;
    answers: Record<string, unknown>;
    model?: string;
    attempts: number;
    usage: JevUsageInfo;
    latencyMs: number;
} | {
    ok: false;
    reason: string;
    attempts: number;
    status?: number;
    retryAfterMs?: number;
    failureKind?: JevFailureKind;
};
/** 模型列表（健康检查） */
export type JevModelsOutcome = {
    ok: true;
    models: Array<{
        name: string;
        description: string;
        releaseDate: string;
    }>;
    latencyMs: number;
} | {
    ok: false;
    reason: string;
    status?: number;
    failureKind?: JevFailureKind;
};
/** Jev 客户端依赖 */
export interface JevDepsInfo {
    fetch: typeof fetch;
    getApiKey: () => Promise<string | undefined>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}
/**
 * 创建 Jev 客户端（TypeSafe System One HTTP API）
 * @param {JevConfigInfo} config - 调用配置
 * @param {JevDepsInfo} deps - fetch、密钥读取与等待函数
 * @returns 客户端：ask（任意题目）、triage（任务分流）、listModels（健康检查）
 */
export declare const intJevClient: (config: JevConfigInfo, deps: JevDepsInfo) => {
    ask: (state: unknown, questions: Record<string, unknown>, signal?: AbortSignal) => Promise<JevAskOutcome>;
    triage: (card: TaskCard, signal?: AbortSignal, workspace?: import('./workspace-policy.js').WorkspacePlan, request?: {
        text: string;
        source: 'host' | 'declared';
    }) => Promise<JevOutcome>;
    listModels: (signal?: AbortSignal) => Promise<JevModelsOutcome>;
    config: JevConfigInfo;
};
export type JevClient = ReturnType<typeof intJevClient>;
export {};
