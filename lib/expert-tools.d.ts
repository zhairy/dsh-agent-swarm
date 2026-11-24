import { type PluginContextLike } from './host-contract.js';
export declare const name = "dsh-agent-swarm-expert-tools";
export declare const inject: string[];
/** 新宿主的独立专家 composition 不继承天枢工具；只补任务绑定工具，编排与全局 Jev 留在根会话。 */
export declare const apply: (ctx: PluginContextLike) => void;
