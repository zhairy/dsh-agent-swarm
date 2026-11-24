import Schema from '@deepseek-ai/schemastery';
import { type AgentLike, type PromptAssemblyLike, type PluginContextLike } from './host-contract.js';
import { type OutputLanguage } from './language.js';
import { type PromptStylePolicy } from './model-family.js';
import { type DelegableRoleId, type SuanHengMode } from './role-registry.js';
export declare const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
export declare const OUTPUT_LANGUAGE_SECTION = "dsh-agent-swarm:output-language";
export declare const GOAL_TOOL_SECTION = "tool:goal";
export declare const GOAL_BOUNDARY_SECTION = "dsh-agent-swarm:goal-boundary";
/** Set only by the locally patched 0.2.2 Host that supports safe step re-preparation. */
export declare const STEP_MODEL_BRIDGE: unique symbol;
export type GoalAuthority = 'direct-human' | 'non-human' | 'child';
interface AgentRegistryLike {
    get?: (id: string) => AgentLike | undefined;
    turnBoundaryOf?: (session: unknown) => {
        openTurnStartSeq: number | null;
    };
}
/**
 * 按 Host 当前 open turn 的真实来源判定 goal 权限。
 * 信息缺失或读取失败时保守判为非 human，绝不把未知来源提升为人类授权。
 */
export declare const getGoalAuthority: (agent: AgentLike | undefined, agents: AgentRegistryLike | undefined) => GoalAuthority;
/** 委派出的子会话在系统提示里的身份：角色、算衡模式、语言；规划审核等特殊子会话可给出固定 persona */
export interface ChildPromptInfo {
    role: DelegableRoleId;
    mode?: SuanHengMode;
    language?: OutputLanguage;
    explicitLanguage?: boolean;
    persona?: string;
}
/**
 * 每次组装系统提示时：把各段里的 {$language} 换成设置页选择的语言，并在末尾追加用该语言书写的输出语言要求；
 * 委派出的子会话（0.2.1 起其 persona 来自静态角色预设）换成按实际路由模型家族生成的委派专用 persona。
 * @param {PromptAssemblyLike} assembled - 宿主组装结果
 * @param {{ language: OutputLanguage; promptStyle: PromptStylePolicy; child?: ChildPromptInfo; goalAuthority?: GoalAuthority }} options - 语言、提示风格、子会话身份与目标权限
 * @returns {PromptAssemblyLike} 新的组装结果
 */
export declare const getRuntimeAssembly: (assembled: PromptAssemblyLike, options: {
    language: OutputLanguage;
    languageExclusions?: readonly string[];
    dynamicLanguage?: boolean;
    promptStyle: PromptStylePolicy;
    child?: ChildPromptInfo;
    goalAuthority?: GoalAuthority;
}) => PromptAssemblyLike;
/** 预设行：挂在全部 13 个预设上，在预设作用域内改写路由并处理回退 */
export declare const name = "dsh-agent-swarm-runtime";
export declare const inject: string[];
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    role: Schema<"bo_wen" | "fu_he" | "guan_xiang" | "ji_feng" | "miao_bi" | "mou_ding" | "shu_ji" | "suan_heng" | "tan_wei" | "tian_shu" | "xing_zhou" | "yu_shi" | "zhu_jian", "bo_wen" | "fu_he" | "guan_xiang" | "ji_feng" | "miao_bi" | "mou_ding" | "shu_ji" | "suan_heng" | "tan_wei" | "tian_shu" | "xing_zhou" | "yu_shi" | "zhu_jian", "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    role: Schema<"bo_wen" | "fu_he" | "guan_xiang" | "ji_feng" | "miao_bi" | "mou_ding" | "shu_ji" | "suan_heng" | "tan_wei" | "tian_shu" | "xing_zhou" | "yu_shi" | "zhu_jian", "bo_wen" | "fu_he" | "guan_xiang" | "ji_feng" | "miao_bi" | "mou_ding" | "shu_ji" | "suan_heng" | "tan_wei" | "tian_shu" | "xing_zhou" | "yu_shi" | "zhu_jian", "defined">;
}>>, "plain">;
/**
 * 运行时插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 * @param {unknown} config - `{ role }`
 */
export declare const apply: (ctx: PluginContextLike, config: unknown) => void;
export {};
