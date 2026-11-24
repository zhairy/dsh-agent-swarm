import type { RoleId, SuanHengMode } from '../../role-registry.js';
import { type RouteResourcePolicy } from './provider-policy.js';
export declare const PROVIDER_QWEN = "qwen-token-plan-cn";
export declare const PROVIDER_GO = "opencode-go";
export declare const PROVIDER_DSH_GO = "dsh-opencode-go";
export declare const PROVIDER_OPENCODE = "opencode";
export declare const PROVIDER_DS = "deepseek-official";
/** Subscription providers exposed by dsh-plugin-subscriptions. */
export declare const PROVIDER_CODEX = "codex";
export declare const PROVIDER_CLAUDE = "claude";
export declare const PROVIDER_ANTIGRAVITY = "antigravity";
export declare const PROVIDER_GROK = "grok";
export declare const PROVIDER_COPILOT = "copilot";
export declare const PROVIDER_JEV = "jev";
/** Stable domain-side failure input; host adapters structurally satisfy it. */
export interface RouteFailureInput {
    code?: string;
    status?: number;
    message?: string;
    providerRetryAfterMs?: number;
    requestId?: string;
    kind?: string;
    quotaDomainId?: string;
    quotaScope?: 'account' | 'plan' | 'model' | 'pool' | 'unknown';
    poolId?: string;
    resetAt?: string;
}
/** Stable domain-side LLM catalog port; DSH's ctx.llm is adapted at the composition boundary. */
export interface RouteLlmInput {
    listProviders: () => Array<{
        id: string;
    }>;
    resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{
        inputModalities?: readonly string[];
        reasoning?: {
            efforts: readonly {
                id: string;
                name?: string;
            }[];
            defaultEffort?: string;
        };
        context?: {
            contextWindow?: number;
        };
        defaultMaxTokens?: number;
    }>;
    resolveCallConfig?: (config: {
        provider: string;
        model: string;
        reasoningEffort?: string;
    }, signal?: AbortSignal) => Promise<unknown>;
}
/** 一条模型路由 */
export interface RouteInfo {
    provider: string;
    model: string;
    reasoningEffort?: string;
    policy?: RouteResourcePolicy;
}
/** 路由表的键：算衡按模式拆成两条；补阙仅为内部失败恢复入口，不属于公开角色。 */
export type RouteKey = Exclude<RoleId, 'suan_heng'> | 'suan_heng:research' | 'suan_heng:verify' | 'bu_que';
export type EscalationKind = 'codex' | 'claude';
export type ModelFamily = 'deepseek' | 'qwen' | 'kimi' | 'glm' | 'minimax' | 'mimo' | 'gpt' | 'gemini' | 'grok' | 'claude' | 'hunyuan' | 'longcat' | 'muse' | 'other';
type CatalogInfo = Readonly<Record<string, {
    vision: boolean;
}>>;
/** pi-ai 0.87.1 内置的 qwen-token-plan-cn 目录（DSH 0.1.7 自带 0.85.1，本机已替换为 0.87.1） */
export declare const QWEN_TOKEN_PLAN_MODELS: CatalogInfo;
/** pi-ai 0.87.1 内置的 opencode-go 目录 */
export declare const OPENCODE_GO_MODELS: CatalogInfo;
/** DSH 0.1.7 原生 DeepSeek 适配器目录（deepseek-flash 即 DeepSeek V4.1 Flash） */
export declare const DEEPSEEK_OFFICIAL_MODELS: CatalogInfo;
/** Fallback capabilities for Antigravity models; live host metadata remains authoritative. */
export declare const ANTIGRAVITY_MODELS: CatalogInfo;
/**
 * DSH 模型目录为各模型声明的推理档位（2026-09-24 从 Web 端实时目录读取）。
 * 路由里写了目录不支持的档位，请求会被拒绝、整层被跳过，单元测试据此逐条检查默认配置。
 */
export declare const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>>;
/** 补阙是隐藏内部键：可直接按名称读取，但不进入公开默认链的枚举与文档/配额遍历。 */
export declare const DEFAULT_ROUTE_CHAINS: Readonly<Record<RouteKey, readonly RouteInfo[]>>;
/** 默认原生升级通道（Codex/Claude Code 原生客户端）：只在显式要求或 nativeEscalation=auto 且高风险时使用 */
export declare const DEFAULT_ESCALATION: Readonly<Partial<Record<RouteKey, EscalationKind>>>;
export declare const getRouteKey: (role: RoleId, mode?: SuanHengMode) => RouteKey;
export declare const getRouteLabel: (route: RouteInfo) => string;
/** 供应商的中文名称（聊天窗口与委派结果中显示） */
export declare const PROVIDER_LABELS: Readonly<Record<string, string>>;
/**
 * 「模型 · 供应商」的显示文本，例如 `claude-opus-5-5 · Claude 订阅（claude）`
 * @param {RouteInfo} route - 路由
 * @returns {string} 显示文本
 */
export declare const getRouteDisplay: (route: RouteInfo) => string;
export declare const isSameRoute: (a: RouteInfo, b: RouteInfo) => boolean;
/**
 * 按模型 ID 判断模型家族，用于实现者与审查者的独立性检查
 * @param {string} model - 模型 ID
 * @returns {ModelFamily} 家族
 */
export declare const getModelFamily: (model: string) => ModelFamily;
/** Codex / Claude 订阅的主力模型（由订阅插件实时发现，这里只作视觉能力的兜底判断） */
export declare const CODEX_MODELS: CatalogInfo;
export declare const CLAUDE_MODELS: CatalogInfo;
/**
 * 按内置目录判断路由是否支持图片；未知 provider 返回 undefined
 * @param {RouteInfo} route - 路由
 * @returns {boolean | undefined} 是否支持图片
 */
export declare const getCatalogVision: (route: RouteInfo) => boolean | undefined;
export type RouteProbeResult = {
    ok: true;
    vision: boolean;
} | {
    ok: false;
    reason: string;
};
export type RouteProbe = (route: RouteInfo, signal?: AbortSignal) => Promise<RouteProbeResult>;
/** 路由选择结果 */
export interface RouteSelection {
    usable: RouteInfo[];
    skipped: Array<{
        route: RouteInfo;
        reason: string;
    }>;
    independence: 'achieved' | 'not-achieved' | 'n/a';
}
/**
 * 在链上筛出可用路由：先做可用性与视觉预检，再按独立性优先不同家族
 * @param {readonly RouteInfo[]} chain - 路由链
 * @param {{ probe: RouteProbe; requireVision?: boolean; avoidFamilies?: readonly ModelFamily[] }} options - 预检函数与约束
 * @returns {Promise<RouteSelection>} 可用路由与跳过原因
 */
export declare const FindUsableRoutes: (chain: readonly RouteInfo[], options: {
    probe: RouteProbe;
    requireVision?: boolean;
    avoidFamilies?: readonly ModelFamily[];
    signal?: AbortSignal;
}) => Promise<RouteSelection>;
export type FailureClass = 'route-fatal' | 'auth' | 'transient' | 'other';
/**
 * 对模型请求失败分类，决定是否换路由
 * @param {RouteFailureInput | undefined} failure - 失败信息
 * @returns {FailureClass} 分类
 */
export declare const getFailureClass: (failure: RouteFailureInput | undefined) => FailureClass;
/** 预检结果缓存：可用结果缓存较久，失败结果很快过期，故障恢复后能及时重新启用 */
export declare const PROBE_OK_TTL_MS = 120000;
export declare const PROBE_FAIL_TTL_MS = 15000;
export declare const PROBE_CACHE_MAX_ENTRIES = 512;
export declare const PROBE_PENDING_WAIT_MS = 30000;
type RouteFailureObserver = (route: RouteInfo, failure: RouteFailureInput) => void | Promise<void>;
/** One service/health registry observes each shared metadata failure once, including durable rejection. */
export declare const createRouteFailureObserver: (observer: RouteFailureObserver) => RouteFailureObserver;
type RouteMetadataResult = RouteProbeResult & {
    failure?: RouteFailureInput;
};
export interface RouteMetadataCache {
    /** Metadata only. Callers must check their own current health/admission on every use. */
    probe: (llm: RouteLlmInput, route: RouteInfo) => Promise<RouteMetadataResult>;
}
/** Share successful metadata and in-flight lookups, never owner permissions or failure isolation. */
export declare const createRouteMetadataCache: (options?: {
    now?: () => number;
    maxEntries?: number;
    pendingWaitMs?: number;
}) => RouteMetadataCache;
/**
 * 基于 ctx.llm 的路由预检：provider 已注册且模型可解析。
 * 订阅类 provider 解析模型可能要访问网络（实测单次 2–3 秒），结果按路由短时缓存，并发的同一预检共用一次调用
 * @param {() => RouteLlmInput | undefined} getLlm - 取 LLM 服务
 * @param {{ now?: () => number }} [options] - 时钟
 * @returns {RouteProbe} 预检函数
 */
export declare const intRouteProbe: (getLlm: () => RouteLlmInput | undefined, options?: {
    now?: () => number;
    metadataCache?: RouteMetadataCache;
    isRouteAvailable?: (route: RouteInfo) => boolean;
    onFailure?: RouteFailureObserver;
}) => RouteProbe;
export {};
