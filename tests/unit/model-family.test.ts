import { describe, expect, it } from 'vitest'
import { getChildPromptText, getNativePromptText, getNativeStyle, getThreadFollowupText, getThreadPromptText } from '../../src/delegate.js'
import type { TaskRecord } from '../../src/evidence.js'
import { getOrchestratorStyleSection, getPromptStyle, getStyledTaskPrompt } from '../../src/model-family.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'
import { ROLE_IDS, ROLE_TAG_PATTERN, getChildPersona, getPresetPersona } from '../../src/role-registry.js'
import { LANGUAGE_PLACEHOLDER, getLanguageInstruction } from '../../src/language.js'
import { OUTPUT_LANGUAGE_SECTION, PERSONA_PREFIX_SECTION, getRuntimeAssembly } from '../../src/runtime.js'
import { ORCHESTRATION_STYLE_SECTION, getStyledAssembly } from '../../src/tools.js'

const card = ValidateTaskCard({ title: '修复', goal: '修好登录', acceptance: ['测试通过'], scope: ['src/a.ts'], flags: { changesCode: true } }).card as TaskCard
const task = { taskId: 'T-1', sessionId: 's', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 0, updatedAt: 0 } as TaskRecord
const input = { task_id: 'T-1', role: 'zhu_jian' as const, prompt: '实现登录' }

describe('按模型家族选择提示风格', () => {
  it('Claude / GPT（Codex）/ 其他模型；配置可以固定风格', () => {
    expect(getPromptStyle({ provider: 'claude', model: 'claude-opus-5-5' })).toBe('claude')
    expect(getPromptStyle({ provider: 'opencode-go', model: 'claude-sonnet-5' })).toBe('claude')
    expect(getPromptStyle({ provider: 'codex', model: 'gpt-6-sol' })).toBe('gpt')
    expect(getPromptStyle({ provider: 'opencode-go', model: 'gpt-5.6-luna' })).toBe('gpt')
    expect(getPromptStyle({ provider: 'qwen-token-plan-cn', model: 'deepseek-v4.1-flash' })).toBe('generic')
    expect(getPromptStyle(undefined)).toBe('generic')
    expect(getPromptStyle({ provider: 'claude', model: 'claude-opus-5-5' }, 'generic')).toBe('generic')
    expect(getNativeStyle('codex-edit')).toBe('gpt')
    expect(getNativeStyle('claude-plan')).toBe('claude')
  })
})

describe('子智能体 persona', () => {
  it('三种风格都保留角色标签、边界与交付说明，各自的组织方式不同', () => {
    const claude = getChildPersona('yu_shi', undefined, 'claude')
    const gpt = getChildPersona('yu_shi', undefined, 'gpt')
    const generic = getChildPersona('yu_shi')
    for (const text of [claude, gpt, generic]) {
      expect(ROLE_TAG_PATTERN.exec(text)?.[1]).toBe('yu_shi')
      expect(text).toContain('独立判断，不以实现者的说明代替核查')
      expect(text).toContain('jev_*')
      expect(text).not.toContain('{{')
    }
    expect(claude).toMatch(/<role>[\s\S]*<\/role>[\s\S]*<boundaries>[\s\S]*<deliverable>[\s\S]*<deliverable> 一节/)
    expect(gpt).toMatch(/Role: [\s\S]*Goal: [\s\S]*Success criteria: [\s\S]*Stop rules:/)
    expect(gpt).toContain('DELIVERABLE（交付）一节')
    expect(generic).toMatch(/必须遵守：\n1\. /)
    expect(generic).toContain('末尾「交付」一节')
  })

  it('算衡带模式说明；没有 jev 能力的角色不出现 jev 提示', () => {
    expect(getChildPersona('suan_heng', 'verify', 'claude')).toMatch(/<mode>\n当前模式：验算/)
    expect(getChildPersona('zhu_jian', undefined, 'gpt')).not.toContain('jev_*')
  })
})

describe('委派任务说明', () => {
  it('Claude：背景在前、要求在后，XML 分节；GPT：GOAL / STOP WHEN / EVIDENCE；其他：分隔标题', () => {
    const claude = getChildPromptText(task, input, 'D-1', 'claude')
    expect(claude.indexOf('<task_context>')).toBeLessThan(claude.indexOf('<task>'))
    expect(claude.indexOf('<task>')).toBeLessThan(claude.indexOf('<deliverable>'))
    expect(claude).toContain('structured_output')
    const gpt = getChildPromptText(task, input, 'D-1', 'gpt')
    expect(gpt).toMatch(/^GOAL:\n实现登录[\s\S]*CONTEXT:[\s\S]*STOP WHEN: [\s\S]*EVIDENCE: [\s\S]*DELIVERABLE（交付）:/)
    const generic = getChildPromptText(task, input, 'D-1')
    expect(generic).toMatch(/任务 T-1 \/ 委派 D-1[\s\S]*—— 本次任务 ——\n\n实现登录[\s\S]*输出语言：[\s\S]*—— 交付 ——/)
  })

  it('连续会话：首轮带完整背景；追加到已知任务时只带编号；原生后端带 persona 与 JSON Schema', () => {
    expect(getThreadPromptText(task, input, 'D-1', 'claude')).toContain('```json')
    const known = getThreadFollowupText(task, input, 'D-2', true, 'gpt')
    expect(known).toMatch(/^【追加】任务 T-1 \/ 委派 D-2/)
    expect(known).not.toContain('CONTEXT:')
    const fresh = getThreadFollowupText(task, input, 'D-2', false, 'claude')
    expect(fresh).toMatch(/^【追加】新的任务，背景如下。\n\n<task_context>/)
    const native = getNativePromptText(task, input, 'D-3', undefined, 'gpt')
    expect(native).toMatch(/^Role: [\s\S]*\[\[swarm:role=zhu_jian\]\][\s\S]*GOAL:/)
    expect(native).toContain('"required"')
    // 原生客户端不经过系统提示组装：persona 里的语言占位符要在这里解析
    const english = getNativePromptText(task, { ...input, language: 'en' }, 'D-4', undefined, 'claude')
    expect(english).not.toContain('{$')
    expect(english).toContain('English')
  })

  it('getStyledTaskPrompt 可省略背景', () => {
    expect(getStyledTaskPrompt({ request: 'r', delivery: 'd' }, 'claude')).toBe('<task>\nr\n</task>\n\n<deliverable>\nd\n</deliverable>')
  })

  it('新增近距离合同保留当前角色、节点、版本与授权材料', () => {
    const envelope = { role: '算衡', permission: '只读计算', taskId: 'T1', nodeId: 'math_verify', attemptId: 'attempt1', cardRevision: 2, workflowRevision: 3, allowedPaths: ['src/math.ts'], materialRefs: ['ctx-evidence'] }
    for (const style of ['claude', 'gpt', 'generic'] as const) {
      const text = getStyledTaskPrompt({ request: '独立寻找反例', delivery: '提交真实依据', envelope }, style)
      expect(text).toContain('T1 / math_verify / attempt1')
      expect(text).toContain('合同 2；流程 3')
      expect(text).toContain('ctx-evidence')
      expect(text.indexOf('独立寻找反例')).toBeLessThan(text.indexOf('身份：算衡'))
    }
  })
})

describe('天枢的调度风格说明', () => {
  const assembly = (model: string | undefined, provider: string | undefined, extra: Array<{ name: string; text: string }> = []) => ({
    sections: [{ name: 'deployment:persona-prefix', text: '你是「天枢」' }, ...extra],
    contexts: [],
    tools: [],
    variables: { ...(model === undefined ? {} : { model }), ...(provider === undefined ? {} : { provider }) }
  })

  it('按所选模型追加一节，不做插值；三种风格内容不同', () => {
    const claude = getStyledAssembly(assembly('claude-opus-5-5', 'claude'), 'auto')
    expect(claude.sections.at(-1)).toEqual({ name: ORCHESTRATION_STYLE_SECTION, text: getOrchestratorStyleSection('claude'), interpolate: false })
    expect(getStyledAssembly(assembly('gpt-6-sol', 'codex'), 'auto').sections.at(-1)?.text).toContain('Orchestration style (GPT)')
    expect(getStyledAssembly(assembly(undefined, undefined), 'auto').sections.at(-1)?.text).toContain('调度要求')
    expect(getStyledAssembly(assembly('gpt-6-sol', 'codex'), 'claude').sections.at(-1)?.text).toContain('orchestration_style')
  })

  it('专家子会话（persona 带角色标签）与已追加过的组装保持不变', () => {
    const child = assembly('gpt-6-sol', 'codex', [{ name: 'x', text: '…[[swarm:role=yu_shi]]' }])
    expect(getStyledAssembly(child, 'auto')).toBe(child)
    const once = getStyledAssembly(assembly('gpt-6-sol', 'codex'), 'auto')
    expect(getStyledAssembly(once, 'auto')).toBe(once)
  })
})

describe('runtime 行：语言与委派子会话 persona', () => {
  const assembly = (persona: string, model = 'gpt-6-sol', provider = 'codex') => ({
    sections: [{ name: PERSONA_PREFIX_SECTION, text: persona }, { name: 'tool:bash', text: 'Execute a bash command.' }],
    contexts: [], tools: [], variables: { model, provider }
  })

  it('每个预设 persona 都带 {$language}，按设置页语言替换并在末尾追加用目标语言书写的要求', () => {
    for (const role of ROLE_IDS) expect(getPresetPersona(role)).toContain(`- **Language**: 强制使用${LANGUAGE_PLACEHOLDER}回答与思考`)
    const zh = getRuntimeAssembly(assembly(getPresetPersona('tian_shu')), { language: 'zh-CN', promptStyle: 'auto' })
    expect(zh.sections[0]!.text).toContain('强制使用简体中文回答与思考')
    expect(zh.sections[0]!.text).not.toContain(LANGUAGE_PLACEHOLDER)
    expect(zh.sections.at(-1)).toEqual({ name: OUTPUT_LANGUAGE_SECTION, text: getLanguageInstruction('zh-CN'), interpolate: false })
    expect(zh.sections.at(-1)!.text).toContain('思考与推理过程')
    const en = getRuntimeAssembly(zh, { language: 'en', promptStyle: 'auto' })
    expect(en.sections.filter((section) => section.name === OUTPUT_LANGUAGE_SECTION)).toHaveLength(1)
    expect(getRuntimeAssembly(assembly(getPresetPersona('tian_shu')), { language: 'ja', promptStyle: 'auto' }).sections.at(-1)!.text).toMatch(/^出力言語：日本語（ja）/)
  })

  it('委派子会话的静态角色预设 persona 换成按当前模型家族生成的委派 persona，含工程规范与本次语言', () => {
    const child = getRuntimeAssembly(assembly(getPresetPersona('zhu_jian'), 'claude-opus-5-5', 'claude'), { language: 'zh-CN', promptStyle: 'auto', child: { role: 'zhu_jian' } })
    const persona = child.sections[0]!
    expect(persona).toMatchObject({ name: PERSONA_PREFIX_SECTION, interpolate: false })
    expect(ROLE_TAG_PATTERN.exec(persona.text)?.[1]).toBe('zhu_jian')
    expect(persona.text).toContain('<engineering_rules>')
    expect(persona.text).toContain('**No Over-Engineering**')
    expect(persona.text).toContain('强制使用简体中文回答与思考')
    expect(persona.text).not.toContain('用户直接与你协作')
    const verify = getRuntimeAssembly(assembly(getPresetPersona('suan_heng'), 'deepseek-flash', 'deepseek-official'), { language: 'zh-CN', promptStyle: 'auto', child: { role: 'suan_heng', mode: 'verify', language: 'en', explicitLanguage: true } })
    expect(verify.sections[0]!.text).toContain('当前模式：验算')
    expect(verify.sections[0]!.text).toContain('强制使用English回答与思考')
    expect(verify.sections.at(-1)!.text).toContain('set explicitly for this delegation')
    const fixed = getRuntimeAssembly(assembly(getPresetPersona('yu_shi')), { language: 'zh-CN', promptStyle: 'auto', child: { role: 'yu_shi', persona: '规划审查者 [[swarm:role=yu_shi]]' } })
    expect(fixed.sections[0]!.text).toBe('规划审查者 [[swarm:role=yu_shi]]')
  })
})
