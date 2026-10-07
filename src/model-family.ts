/**
 * 按模型家族调整提示词（参考 oh-my-openagent 的 agent-model-matching、Anthropic 与 OpenAI 官方提示指南）：
 * - Claude（Opus / Sonnet）：机制化的提示效果好——XML 分节、写明每条规则的理由、长材料在前、要求在最后；
 *   不写「必须！！」式强调，不加反复自检的套话，按要求的范围交付、报告简洁。
 * - GPT（GPT-6 Sol / Astra 等 Codex 模型）：原则化的提示效果好——Role / Goal / Success criteria / Constraints /
 *   Output / Stop rules，每条规则只说一次；偏向直接行动，明确停止条件与证据要求，避免过度编排。
 * - 其他（DeepSeek、Qwen、Kimi、GLM、MiMo、MiniMax 等）：编号的必做步骤、禁止事项、成功标准与停止条件。
 */

export type PromptStyle = 'claude' | 'gpt' | 'generic'

/** 配置里的提示风格：auto 按模型自动选择 */
export type PromptStylePolicy = 'auto' | PromptStyle

export const PROMPT_STYLES: readonly PromptStylePolicy[] = ['auto', 'claude', 'gpt', 'generic']

/**
 * 判断路由所属的提示风格
 * @param {{ provider?: string; model?: string } | undefined} route - 路由
 * @param {PromptStylePolicy} [policy='auto'] - 配置的风格；非 auto 时直接采用
 * @returns {PromptStyle} 风格
 */
export const getPromptStyle = (route: { provider?: string; model?: string } | undefined, policy: PromptStylePolicy = 'auto'): PromptStyle => {
  if (policy !== 'auto') return policy
  const provider = (route?.provider ?? '').toLowerCase()
  const model = (route?.model ?? '').toLowerCase()
  if (provider === 'claude' || provider.includes('anthropic') || model.startsWith('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('fable')) return 'claude'
  if (provider === 'codex' || provider.includes('openai') || /^(gpt-|o\d|codex)/.test(model)) return 'gpt'
  return 'generic'
}

export const PROMPT_STYLE_LABELS: Readonly<Record<PromptStyle, string>> = {
  claude: 'Claude 风格（XML 分节）',
  gpt: 'GPT 风格（目标/停止条件/证据）',
  generic: '通用风格（编号步骤）'
}

/** 子智能体 persona 的组成部分 */
export interface PersonaPartsInfo {
  name: string
  title: string
  duty: string
  boundaries: readonly string[]
  deliverables: readonly string[]
  modeText?: string
  roleTag: string
}

const SESSION_NOTE = '你可能会在同一会话里陆续收到同一大类任务的后续工作（例如按审查意见修改、复查、补充）。沿用已有上下文，不必重复已经完成并确认过的工作；每一轮都按该轮的交付要求重新提交完整的结构化结果。'

const bullets = (items: readonly string[]): string => items.map((item) => `- ${item}`).join('\n')

/**
 * 按风格生成子智能体 persona
 * @param {PersonaPartsInfo} parts - 角色信息
 * @param {PromptStyle} style - 风格
 * @returns {string} persona
 */
/** 各风格的任务说明里「交付」一节的名称，persona 据此引用 */
const DELIVERY_SECTION: Readonly<Record<PromptStyle, string>> = {
  claude: '<deliverable> 一节',
  gpt: 'DELIVERABLE（交付）一节',
  generic: '末尾「交付」一节'
}

export const getStyledPersona = (parts: PersonaPartsInfo, style: PromptStyle): string => {
  const intro = `你是「${parts.name}」（${parts.title}），dsh-agent-swarm 多智能体系统中的专家，由主持者「天枢」委派完成一项任务。你看不到天枢与用户的对话，只依据收到的任务说明工作。`
  const deliverable = `按每次任务说明${DELIVERY_SECTION[style]}的方式提交结构化结果（${parts.deliverables.join('、')}）。summary 用中文写结论，unresolved 列出未解决或未核实的事项。`
  if (style === 'claude') {
    return [
      `<role>\n${intro}\n</role>`,
      `<duty>\n${parts.duty}\n</duty>`,
      `<boundaries>\n${bullets(parts.boundaries)}\n</boundaries>`,
      ...(parts.modeText === undefined ? [] : [`<mode>\n${parts.modeText}\n</mode>`]),
      [
        '<working_style>',
        '- 交付被要求的内容，保持在任务意图的范围内：不顺手扩大范围或改动无关文件，因为天枢要据此核对门禁与证据。',
        '- 一次真实的检查足以支撑结论时就停止，不必反复自我验证；独立复核由「复核」专家负责。',
        '- 报告简洁：结论、证据、未解决事项即可，不写过程叙述。',
        '- 推理过程不需要写进回复；需要解释时给出简短理由。',
        '- 只有缺少关键信息无法继续，或下一步有风险时才停下，并把原因写进 unresolved。',
        '</working_style>'
      ].join('\n'),
      `<deliverable>\n${deliverable}\n</deliverable>`,
      `<session>\n${SESSION_NOTE}\n</session>`,
      parts.roleTag
    ].join('\n\n')
  }
  if (style === 'gpt') {
    return [
      `Role: ${intro}`,
      `Goal: ${parts.duty}`,
      `Success criteria: 交付覆盖任务的验收要求，每条结论都有可核对的证据（路径、命令与退出码、来源）。`,
      `Constraints:\n${bullets(parts.boundaries)}`,
      ...(parts.modeText === undefined ? [] : [`Mode: ${parts.modeText}`]),
      `Output: ${deliverable}`,
      [
        'Stop rules:',
        '- 偏向直接行动：把任务做完，而不是只给计划。',
        '- 满足成功标准、给出证据后即停止；不为可逆的低影响改动额外编写测试。',
        '- 缺少信息时根据上下文做最合理的决定并在 unresolved 中注明，不要提问。',
        '- 中文与英文、数字之间保留正确的空格，便于其他智能体解析。'
      ].join('\n'),
      `Session: ${SESSION_NOTE}`,
      parts.roleTag
    ].join('\n\n')
  }
  return [
    intro,
    `职责：${parts.duty}`,
    `必须遵守：\n${parts.boundaries.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
    ...(parts.modeText === undefined ? [] : [parts.modeText]),
    `成功标准：交付覆盖任务的验收要求，每条结论都有可核对的证据。满足后立即停止，不要过度思考或重复检查。`,
    `交付：${deliverable}`,
    `会话：${SESSION_NOTE}`,
    parts.roleTag
  ].join('\n\n')
}

/** 委派任务说明的组成部分 */
export interface TaskPromptPartsInfo {
  /** 任务背景（任务卡摘要）；追加到已知该任务的会话时省略 */
  brief?: string
  /** 天枢写的本次任务 */
  request: string
  /** 交付要求正文（不含标题，标题按风格添加） */
  delivery: string
  /** 追加到已有会话时的抬头 */
  header?: string
}

/**
 * 按风格组织委派任务说明：Claude 长材料在前、要求在后并用 XML 分节；GPT 用目标/停止条件/证据；其余用分隔标题
 * @param {TaskPromptPartsInfo} parts - 组成部分
 * @param {PromptStyle} style - 风格
 * @returns {string} 任务说明
 */
export const getStyledTaskPrompt = (parts: TaskPromptPartsInfo, style: PromptStyle): string => {
  const header = parts.header === undefined ? [] : [parts.header]
  if (style === 'claude') {
    return [
      ...header,
      ...(parts.brief === undefined ? [] : [`<task_context>\n${parts.brief}\n</task_context>`]),
      `<task>\n${parts.request}\n</task>`,
      `<deliverable>\n${parts.delivery}\n</deliverable>`
    ].join('\n\n')
  }
  if (style === 'gpt') {
    return [
      ...header,
      `GOAL:\n${parts.request}`,
      ...(parts.brief === undefined ? [] : [`CONTEXT:\n${parts.brief}`]),
      'STOP WHEN: 本次任务的要求已完成，并能用证据（文件路径、命令与退出码、来源链接）证明。',
      'EVIDENCE: 结论依据天枢可以复核的事实，而不是自述。',
      `DELIVERABLE（交付）:\n${parts.delivery}`
    ].join('\n\n')
  }
  return [
    ...header,
    ...(parts.brief === undefined ? [] : [parts.brief]),
    '—— 本次任务 ——',
    parts.request,
    '—— 交付 ——',
    parts.delivery
  ].join('\n\n')
}

/**
 * 天枢（主会话）的模型家族补充说明：随所选模型追加到系统提示末尾
 * @param {PromptStyle} style - 风格
 * @returns {string} 补充说明
 */
export const getOrchestratorStyleSection = (style: PromptStyle): string => {
  if (style === 'claude') {
    return [
      '<orchestration_style model_family="claude">',
      '- 委派说明用 XML 分节组织：<objective>、<context>（相关文件与约束）、<deliverable>；长材料放前面，要求放最后，并写明每条约束的理由。',
      '- 只把规模足够、彼此独立的工作并行委派；门禁要求的验证（复核、御史、算衡）照常委派，不要再额外派生子智能体去核实同一件事。',
      '- 依据专家返回的证据裁决，不依赖其自述；报告保持简洁，不写验证套话。',
      '</orchestration_style>'
    ].join('\n')
  }
  if (style === 'gpt') {
    return [
      'Orchestration style (GPT):',
      '- 偏向行动，把用户的任务推进到完成；能并行就并行委派互不依赖的子任务。',
      '- 每个委派写清 GOAL、STOP WHEN、EVIDENCE 与允许改动的路径；对小而有界的改动给目标，不给逐步配方。',
      '- 依据返回的证据判断是否满足停止条件，而不是依据专家的自我报告；每条规则只说一次，避免互相矛盾。'
    ].join('\n')
  }
  return [
    '调度要求：',
    '1. 按工作协议的编号步骤推进，每一步完成后对照验收标准检查。',
    '2. 委派说明写清目标、相关文件、约束、成功标准与交付格式。',
    '3. 满足验收标准即停止，不要过度思考或重复委派同一件事。'
  ].join('\n')
}
