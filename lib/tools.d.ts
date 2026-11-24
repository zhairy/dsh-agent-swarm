import type { DelegationRecord } from './evidence.js';
import { type PluginContextLike, type PromptAssemblyLike } from './host-contract.js';
import { type PromptStylePolicy } from './model-family.js';
import type { AcceptResultInfo, SwarmService } from './service.js';
import { type ToolDefinitionLike } from './tool-shape.js';
import type { JsonSchemaObject } from './util/json-schema.js';
/** 预设行：只挂在天枢预设上，注册百工与任务绑定工具、规划复审与经验工具、7 个 Jev 判断工具和 2 个内嵌技能，并按模型家族补充天枢的调度说明 */
/**
 * 插件自身的位置与版本。
 * agent 排查问题时经常要定位实现文件，这里给出确定性答案：源码在 `src/`、构建产物在 `lib/`，
 * 本仓库不使用 `dist/`（猜成 `dist/*.js` 或宿主 `packages/` 下的路径都会让搜索命令直接失败）。
 */
export declare const getPluginInfo: () => {
    readonly root: string;
    readonly version: string;
    readonly sourceDir: string;
    readonly buildDir: string;
};
export declare const name = "dsh-agent-swarm-tools";
export declare const inject: string[];
export declare const TASK_CARD_PARAMETERS: JsonSchemaObject;
export declare const DELEGATE_PARAMETERS: JsonSchemaObject;
export declare const STATUS_PARAMETERS: JsonSchemaObject;
export declare const ACCEPT_PARAMETERS: JsonSchemaObject;
type TaskCardResult = Awaited<ReturnType<SwarmService['AddTaskCard']>>;
type StatusResult = ReturnType<SwarmService['getStatus']>;
export declare const getTaskCardText: (result: TaskCardResult) => string;
export declare const getDelegationText: (record: DelegationRecord) => string;
export declare const getStatusText: (result: StatusResult) => string;
export declare const getAcceptText: (result: AcceptResultInfo) => string;
/**
 * 生成 4 个模型工具定义
 * @param {SwarmService} service - 服务
 * @returns {ToolDefinitionLike[]} 工具定义
 */
export declare const getSwarmToolDefinitions: (service: SwarmService) => ToolDefinitionLike[];
/** 天枢系统提示里按模型家族追加的调度风格一节 */
export declare const ORCHESTRATION_STYLE_SECTION = "dsh-agent-swarm:orchestration-style";
/**
 * 按所选模型的家族给天枢的系统提示追加调度风格说明（Claude / GPT / 其他）。
 * 专家子会话的 persona 带角色标签，它们沿用委派时按路由生成的 persona，不追加；输出语言由 runtime 行统一追加。
 * @param {PromptAssemblyLike} assembled - 组装结果
 * @param {PromptStylePolicy} policy - 配置的提示风格
 * @returns {PromptAssemblyLike} 追加后的组装结果
 */
export declare const getStyledAssembly: (assembled: PromptAssemblyLike, policy: PromptStylePolicy) => PromptAssemblyLike;
/**
 * 工具插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 */
export declare const apply: (ctx: PluginContextLike) => void;
export {};
