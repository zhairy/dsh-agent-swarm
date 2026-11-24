import { type Capability } from './host-contract.js';
import { type OutputLanguage } from './language.js';
import { type PromptStyle } from './model-family.js';
/** 13 个角色的稳定 ASCII ID（天枢 + 12 个可委派角色） */
export declare const ROLE_IDS: readonly ['tian_shu', 'mou_ding', 'shu_ji', 'suan_heng', 'tan_wei', 'bo_wen', 'guan_xiang', 'zhu_jian', 'xing_zhou', 'ji_feng', 'yu_shi', 'fu_he', 'miao_bi'];
export type RoleId = typeof ROLE_IDS[number];
export type DelegableRoleId = Exclude<RoleId, 'tian_shu'>;
export type PermissionLevel = 'orchestrator' | 'read' | 'limited-exec' | 'verify' | 'workspace-edit';
export type WebPolicy = 'always' | 'on-request' | 'never';
export type SuanHengMode = 'research' | 'verify';
/** 角色定义：职责、边界、触发、交付、权限与工具能力 */
export interface RoleInfo {
    id: RoleId;
    presetId: string;
    name: string;
    title: string;
    duty: string;
    boundaries: readonly string[];
    triggers: readonly string[];
    deliverables: readonly string[];
    permission: PermissionLevel;
    capabilities: readonly Capability[];
    web: WebPolicy;
    needsVision: boolean;
    concurrencySafe: boolean;
    order: number;
}
export declare const ROLE_INFO_LIST: readonly RoleInfo[];
/** 子会话没有目标管理权，Host 的 goal guidance 不应继续诱导其调用 goal 工具。 */
export declare const GOAL_CHILD_BOUNDARY = "\u5B50\u667A\u80FD\u4F53\u4E0D\u5F97\u521B\u5EFA\u3001\u7F16\u8F91\u3001\u6682\u505C\u3001\u6062\u590D\u6216\u7EC8\u7ED3\u5BBF\u4E3B\u76EE\u6807\uFF1B\u4EFB\u4F55\u76EE\u6807\u7EA7\u51B3\u5B9A\u5FC5\u987B\u4EA4\u56DE\u7236\u5929\u67A2\u3002";
/** 非直接 human 的顶层轮次不持有 create/edit/pause/resume 等人类专属目标授权。 */
export declare const GOAL_NON_HUMAN_BOUNDARY = "\u5F53\u524D\u8F6E\u6B21\u4E0D\u662F\u76F4\u63A5\u4EBA\u7C7B\u8F93\u5165\u3002\u7981\u6B62\u4EFB\u4F55\u76EE\u6807\u521B\u5EFA\u3001\u7F16\u8F91\u3001\u6682\u505C\u6216\u6062\u590D\uFF1B\u4EC5\u5F53\u5F53\u524D\u76EE\u6807\u5DF2\u771F\u5B9E\u5B8C\u6210\u6216\u5DF2\u6EE1\u8DB3\u5BBF\u4E3B\u963B\u585E\u6761\u4EF6\u65F6\uFF0C\u624D\u53EF\u66F4\u65B0\u76EE\u6807\u7EC8\u6001\u3002";
/**
 * 角色适用的工程规范（含语言要求）
 * @param {RoleId} id - 角色
 * @param {OutputLanguage} [language] - 给出时直接写入语言名称；省略时保留占位符，由 runtime 行替换
 * @returns {string[]} 规范，每条一行
 */
export declare const getRoleRules: (id: RoleId, language?: OutputLanguage | null) => string[];
/** 子智能体 persona 中的机器可读角色标签 */
export declare const ROLE_TAG_PATTERN: RegExp;
export declare const isRoleId: (value: unknown) => value is RoleId;
export declare const isDelegableRoleId: (value: unknown) => value is DelegableRoleId;
/**
 * 按 ID 取角色定义
 * @param {RoleId} id - 角色 ID
 * @returns {RoleInfo} 角色定义
 */
export declare const getRoleInfo: (id: RoleId) => RoleInfo;
/**
 * 按预设 ID 查找角色
 * @param {string | undefined} presetId - 会话头中的 agentPreset
 * @returns {RoleInfo | undefined} 角色定义，非 swarm 预设返回 undefined
 */
export declare const FindRoleByPresetId: (presetId: string | undefined) => RoleInfo | undefined;
export declare const getDelegableRoleIds: () => DelegableRoleId[];
/** Semantic capability hints are separate from Host tool permissions. */
export declare const ROLE_CAPABILITY_TAGS: Readonly<Record<DelegableRoleId, readonly string[]>>;
export declare const getRoleCapabilityTags: (id: DelegableRoleId) => readonly string[];
/** Suggestions never change the requested role, allowed tools or mandatory workflow gates. */
export declare const suggestRolesByCapabilities: (tags: readonly string[], options?: {
    allowWrite?: boolean;
}) => Array<{
    role: DelegableRoleId;
    tags: readonly string[];
}>;
export declare const isEditRole: (id: RoleId) => boolean;
export declare const isWriteAllowed: (id: RoleId) => boolean;
export declare const getPermissionLabel: (id: RoleId) => string;
/**
 * 计算角色希望使用的宿主工具名（调用时再与实际可见工具求交集）
 * @param {RoleId} id - 角色 ID
 * @param {{ allowWeb?: boolean }} [options] - 本次委派是否开放 web
 * @returns {string[]} 候选工具名
 */
export declare const getWantedTools: (id: RoleId, options?: {
    allowWeb?: boolean;
}) => string[];
export declare const getRoleTag: (id: RoleId) => string;
/**
 * 生成被委派子智能体的 persona，按模型家族组织（Claude：XML 分节；GPT：目标/约束/停止规则；其他：编号必做项）
 * @param {DelegableRoleId} id - 角色 ID
 * @param {SuanHengMode} [mode] - 算衡模式
 * @param {PromptStyle} [style='generic'] - 提示风格
 * @param {OutputLanguage} [language] - 输出语言；省略时保留 {$language} 占位符
 * @returns {string} persona 文本
 */
export declare const getChildPersona: (id: DelegableRoleId, mode?: SuanHengMode, style?: PromptStyle, language?: OutputLanguage | null) => string;
/**
 * 生成天枢工具说明中使用的角色目录（每行一个可委派角色）
 * @returns {string} 角色目录文本
 */
export declare const getRoleCatalogText: () => string;
/**
 * 生成预设（用户直接选用的会话）的 persona 前缀
 * @param {RoleId} id - 角色 ID
 * @returns {string} persona 文本，只使用 {{model}} 变量
 */
export declare const getPresetPersona: (id: RoleId) => string;
