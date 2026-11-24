import type { DelegationRecord, TaskRecord } from '../../evidence.js';
import type { SuanHengMode } from '../../role-registry.js';
import { type RouteInfo, type RouteKey } from './routes.js';
/**
 * 容灾升级：命中高风险 / 高歧义条件时，先改用更强的「升级模型」，失败再回到常规路由链。
 * 与 escalation（Codex/Claude Code 原生客户端）是两套机制：这里只是换一条 API 路由。
 */
/** 可选的触发条件（天枢在 swarm_delegate / swarm_task_card 里显式要求升级时总会触发，不在此列） */
export declare const UPGRADE_TRIGGERS: readonly ['ambiguous', 'conflict', 'lowConfidence', 'financial', 'crossModule', 'concurrency', 'stateMachine', 'algorithm', 'security', 'perf', 'retry'];
export type UpgradeTrigger = typeof UPGRADE_TRIGGERS[number];
/** 触发条件的中文说明（设置页与结果文本共用） */
export declare const UPGRADE_TRIGGER_LABELS: Readonly<Record<UpgradeTrigger, string>>;
/** 一个角色的容灾升级配置 */
export interface UpgradeInfo {
    enabled: boolean;
    /** 升级模型链：按顺序尝试，全部不可用时回到常规路由链 */
    chain: RouteInfo[];
    triggers: UpgradeTrigger[];
}
/** 可以配置容灾升级的角色：只有承担判断或复杂实现的角色需要，执行类角色不提供 */
export declare const UPGRADEABLE_KEYS: readonly RouteKey[];
/** 默认容灾升级：天枢、谋定 → GPT-6 Astra；铸剑 → Claude Opus 5.5；算衡·验算在冲突时换第三方裁决 */
export declare const DEFAULT_UPGRADES: Readonly<Partial<Record<RouteKey, UpgradeInfo>>>;
export declare const isUpgradeTrigger: (value: unknown) => value is UpgradeTrigger;
/**
 * 本任务的证据里是否出现结论冲突：验算给出反例、御史给出严重发现、复核判定失败
 * @param {DelegationRecord[]} delegations - 本任务的委派
 * @returns {string | undefined} 冲突说明
 */
export declare const getConflictReason: (delegations: DelegationRecord[]) => string | undefined;
/** 判定升级时需要的上下文 */
export interface UpgradeContextInfo {
    task: TaskRecord;
    delegations: DelegationRecord[];
    /** 天枢显式要求升级 */
    explicit?: boolean;
    /** 委派时：本次角色与算衡模式，用于判断「同一角色此前失败」 */
    role?: string;
    mode?: SuanHengMode;
}
/**
 * 计算应当触发升级的原因；空数组表示不升级
 * @param {UpgradeInfo | undefined} upgrade - 角色的升级配置
 * @param {UpgradeContextInfo} ctx - 任务上下文
 * @returns {string[]} 触发原因（中文）
 */
export declare const getUpgradeReasons: (upgrade: UpgradeInfo | undefined, ctx: UpgradeContextInfo) => string[];
/**
 * 升级优先并去重；两条链共享的按量末级兜底仍留在基础链末尾。
 * 只识别两条声明中唯一的共同末项，不重排显式 API primary 或任意未知路由。
 * @param {RouteInfo[]} upgrade - 升级链
 * @param {readonly RouteInfo[]} chain - 常规链
 * @returns {RouteInfo[]} 合并后的链
 */
export declare const getUpgradedChain: (upgrade: readonly RouteInfo[], chain: readonly RouteInfo[]) => RouteInfo[];
