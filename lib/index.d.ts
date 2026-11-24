import { Config } from './config.js';
import { type PluginContextLike } from './host-contract.js';
/** 宿主行：提供 agentSwarm 服务、注册写操作守卫与设置页 RPC，本身不向模型注册工具 */
export declare const name = "dsh-agent-swarm";
export declare const inject: string[];
export { Config };
/**
 * DSH 主目录：profileContext.home → DSH_HOME → ~/.dsh
 * @param {PluginContextLike} ctx - 插件上下文
 * @returns {string} 目录
 */
export declare const getDshHome: (ctx: PluginContextLike) => string;
/**
 * 在 globalThis 登记百工管理的会话，供 dsh-llm-fallbacks 等插件跳过全局回退
 * @param {(agent: unknown) => boolean} isManaged - 判定函数
 * @returns {() => void} 撤销登记（只撤销自己登记的那一份）
 */
export declare const PublishManagedAgents: (isManaged: (agent: unknown) => boolean) => (() => void);
/**
 * 宿主插件入口
 * @param {PluginContextLike} ctx - 插件上下文
 * @param {unknown} config - swarm-core 行的 Config（volatile）
 */
export declare const apply: (ctx: PluginContextLike, config: unknown) => void;
