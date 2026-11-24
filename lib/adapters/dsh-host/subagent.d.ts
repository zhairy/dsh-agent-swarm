import type { AgentLike, ContentBlockLike, SubagentRunLike, SubagentStartRequestLike, SubagentsLike } from '../../host-contract.js';
/** 版本无关的子智能体启动参数：旧宿主用 persona/toolFilter，0.2.1-alpha 起由 agentPreset 指定的预设负责 composition。 */
export interface ChildStartInput {
    provider: string;
    label: string;
    name?: string;
    childId?: string;
    prompt: ContentBlockLike[];
    parent: AgentLike;
    signal: AbortSignal;
    agentOptions?: SubagentStartRequestLike['agentOptions'];
    outputSchema?: object;
    maxDepth?: number;
    /** 新宿主：角色预设 id（persona + 工具组合都来自预设） */
    agentPreset?: string;
    /** 旧宿主：persona 文本与工具过滤 */
    persona?: string;
    toolFilter?: SubagentStartRequestLike['toolFilter'];
}
/** 0.2.1-alpha 起的激活协议：本地子会话固定为连续会话，结算后自动关闭；一次性由调用方在结果后 dispose。 */
export declare const hasActivationApi: (subagents: SubagentsLike) => boolean;
/** 连续会话：旧宿主 startContinuable，新宿主 startActivation（同一 childId 可被 sendMessage 冷恢复）。 */
export declare const supportsContinuableSessions: (subagents: SubagentsLike) => boolean;
/**
 * 统一启动一个子智能体，返回旧协议的 {id,result,dispose} 形状。
 * 新宿主缺 start 时改走 startActivation；delivery 固定 caller，结束通知由本插件自己管理，避免重复进入天枢上下文。
 */
export declare const startChild: (subagents: SubagentsLike, input: ChildStartInput) => Promise<SubagentRunLike>;
