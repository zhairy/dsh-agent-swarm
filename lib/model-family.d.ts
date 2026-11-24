/**
 * 按模型家族调整提示词（参考 oh-my-openagent 的 agent-model-matching、Anthropic 与 OpenAI 官方提示指南）：
 * - Claude（Opus / Sonnet）：机制化的提示效果好——XML 分节、写明每条规则的理由、长材料在前、要求在最后；
 *   不写「必须！！」式强调，不加反复自检的套话，按要求的范围交付、报告简洁。
 * - GPT（GPT-6 Sol / Astra 等 Codex 模型）：原则化的提示效果好——Role / Goal / Success criteria / Constraints /
 *   Output / Stop rules，每条规则只说一次；偏向直接行动，明确停止条件与证据要求，避免过度编排。
 * - 其他（DeepSeek、Qwen、Kimi、GLM、MiMo、MiniMax 等）：编号的必做步骤、禁止事项、成功标准与停止条件。
 */
export type PromptStyle = 'claude' | 'gpt' | 'generic';
/** 配置里的提示风格：auto 按模型自动选择 */
export type PromptStylePolicy = 'auto' | PromptStyle;
export declare const PROMPT_STYLES: readonly PromptStylePolicy[];
/**
 * 判断路由所属的提示风格
 * @param {{ provider?: string; model?: string } | undefined} route - 路由
 * @param {PromptStylePolicy} [policy='auto'] - 配置的风格；非 auto 时直接采用
 * @returns {PromptStyle} 风格
 */
export declare const getPromptStyle: (route: {
    provider?: string;
    model?: string;
} | undefined, policy?: PromptStylePolicy) => PromptStyle;
export declare const PROMPT_STYLE_LABELS: Readonly<Record<PromptStyle, string>>;
/** 子智能体 persona 的组成部分 */
export interface PersonaPartsInfo {
    name: string;
    title: string;
    duty: string;
    boundaries: readonly string[];
    deliverables: readonly string[];
    /** 工程规范（含语言要求），每条一行 */
    rules: readonly string[];
    modeText?: string;
    roleTag: string;
}
/**
 * 按风格生成子智能体 persona
 * @param {PersonaPartsInfo} parts - 角色信息
 * @param {PromptStyle} style - 风格
 * @returns {string} persona
 */
export declare const getStyledPersona: (parts: PersonaPartsInfo, style: PromptStyle) => string;
/** 委派任务说明的组成部分 */
export interface TaskPromptPartsInfo {
    /** 任务背景（任务卡摘要）；追加到已知该任务的会话时省略 */
    brief?: string;
    /** 天枢写的本次任务 */
    request: string;
    /** 交付要求正文（不含标题，标题按风格添加） */
    delivery: string;
    /** 追加到已有会话时的抬头 */
    header?: string;
    /** 本轮贴近任务的有限身份/节点/版本信息；旧调用不传时格式保持不变 */
    envelope?: TaskEnvelopeInfo;
}
export interface TaskEnvelopeInfo {
    role: string;
    permission: string;
    taskId: string;
    nodeId: string;
    attemptId: string;
    cardRevision: number;
    workflowRevision: number;
    allowedPaths: string[];
    materialRefs?: string[];
}
export declare const getTaskEnvelopeText: (envelope: TaskEnvelopeInfo) => string;
/**
 * 按风格组织委派任务说明：Claude 长材料在前、要求在后并用 XML 分节；GPT 用目标/停止条件/证据；其余用分隔标题
 * @param {TaskPromptPartsInfo} parts - 组成部分
 * @param {PromptStyle} style - 风格
 * @returns {string} 任务说明
 */
export declare const getStyledTaskPrompt: (parts: TaskPromptPartsInfo, style: PromptStyle) => string;
/**
 * 天枢（主会话）的模型家族补充说明：随所选模型追加到系统提示末尾
 * @param {PromptStyle} style - 风格
 * @returns {string} 补充说明
 */
export declare const getOrchestratorStyleSection: (style: PromptStyle) => string;
