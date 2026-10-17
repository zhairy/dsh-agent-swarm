import { isJevProbability } from './jev.js'
import type { TaskCard, TaskFlags } from './policy.js'
import { getRoleInfo, type DelegableRoleId } from './role-registry.js'

/**
 * 编排规划：任务卡通过后、委派开始前，先把「要不要拆、按什么角度拆、哪些能并行」定下来。
 * 规则给出确定性基线，Jev 只做复杂度与拆分倾向的判断；两者都写进任务记录，供状态与图表展示。
 */

/** 中大型任务解耦的常见角度。名称用于展示，id 稳定、可被测试与图表引用。 */
export const ORCHESTRATION_DIMENSIONS = [
  'layer', 'vertical-slice', 'domain-boundary', 'data-ownership', 'stable-base', 'deployment-unit',
  'client-side', 'contract-first', 'risk-isolation', 'conway', 'state-machine', 'resource-profile', 'rule-frequency'
] as const
export type OrchestrationDimension = typeof ORCHESTRATION_DIMENSIONS[number]

export const DIMENSION_LABELS: Readonly<Record<OrchestrationDimension, string>> = Object.freeze({
  layer: '技术分层',
  'vertical-slice': '业务闭环切片',
  'domain-boundary': '领域边界',
  'data-ownership': '数据所有权',
  'stable-base': '稳定基座先行',
  'deployment-unit': '部署单元',
  'client-side': '端侧/界面',
  'contract-first': '接口契约先行',
  'risk-isolation': '难点与风险隔离',
  conway: '按团队/角色技能',
  'state-machine': '业务流程状态机',
  'resource-profile': '资源特征（计算/IO/实时）',
  'rule-frequency': '变更频率/规则引擎'
})

export const COMPLEXITY_LEVELS = ['small', 'medium', 'large'] as const
export type ComplexityLevel = typeof COMPLEXITY_LEVELS[number]
export const COMPLEXITY_LABELS: Readonly<Record<ComplexityLevel, string>> = Object.freeze({
  small: '小型（单点改动，一个专家即可）',
  medium: '中型（2–3 条可并行的工作流）',
  large: '大型（需要先立基座，再并行多条切片）'
})

export interface OrchestrationSubtask {
  readonly id: string
  readonly title: string
  readonly role: DelegableRoleId
  readonly dependsOn: readonly string[]
  /** 可与本子任务同时开工的兄弟子任务（串行/并行决策的直接依据）。 */
  readonly parallelWith: readonly string[]
  readonly dimension: OrchestrationDimension
  readonly deliverable: string
}

export interface OrchestrationPlan {
  readonly complexity: ComplexityLevel
  readonly source: 'jev' | 'rules' | 'jev-fallback'
  readonly reason: string
  readonly dimensions: readonly OrchestrationDimension[]
  readonly subtasks: readonly OrchestrationSubtask[]
  /** 无依赖、可同时委派的子任务分组。 */
  readonly parallelGroups: readonly (readonly string[])[]
  /** 必须按顺序执行的依赖链（每条链内部串行）。 */
  readonly serialized: readonly (readonly string[])[]
  readonly risks: readonly string[]
  readonly mermaid: string
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)]

/** 只读视图：不修改入参，允许调用方传冻结的任务卡。 */
const flag = (flags: TaskFlags, key: keyof TaskFlags): boolean => flags[key] === true

/** 复杂度基线：范围、验收条数与风险标记共同决定，不依赖模型。 */
export const getRuleComplexity = (card: TaskCard, flags: TaskFlags): { level: ComplexityLevel; reason: string } => {
  const risks = (['changesAlgorithm', 'timeSeriesOrBacktest', 'stateMachine', 'crossModuleArchitecture', 'touchesFinancialLogic', 'sharedStateConcurrency'] as const).filter((key) => flag(flags, key))
  const breadth = card.scope.length + card.acceptance.length
  if (risks.length >= 2 || breadth >= 6 || flag(flags, 'crossModuleArchitecture')) {
    return { level: 'large', reason: `风险标记 ${risks.length} 项、范围与验收共 ${breadth} 条，需要先立契约再并行切片` }
  }
  if (risks.length === 1 || breadth >= 3) {
    return { level: 'medium', reason: `存在风险标记 ${risks.join('、') || '无'}、范围与验收共 ${breadth} 条，适合 2–3 条并行工作流` }
  }
  return { level: 'small', reason: `范围与验收共 ${breadth} 条且无高风险标记，单点改动一个专家即可` }
}

/** 由任务标记推导拆分角度：每条规则都能追溯到卡片里的一个具体事实。 */
export const getRuleDimensions = (flags: TaskFlags): OrchestrationDimension[] => {
  const dimensions: OrchestrationDimension[] = []
  if (flag(flags, 'crossModuleArchitecture')) dimensions.push('domain-boundary', 'contract-first')
  if (flag(flags, 'changesCode')) dimensions.push('vertical-slice')
  if (flag(flags, 'changesAlgorithm') || flag(flags, 'timeSeriesOrBacktest')) dimensions.push('risk-isolation')
  if (flag(flags, 'stateMachine')) dimensions.push('state-machine')
  if (flag(flags, 'sharedStateConcurrency')) dimensions.push('resource-profile')
  if (flag(flags, 'hasVisualInput') || flag(flags, 'uiCopy')) dimensions.push('client-side')
  if (flag(flags, 'touchesFinancialLogic')) dimensions.push('data-ownership')
  if (flag(flags, 'securitySensitive')) dimensions.push('risk-isolation')
  if (flag(flags, 'hasExecSteps')) dimensions.push('stable-base')
  if (dimensions.length === 0) dimensions.push('vertical-slice')
  return unique(dimensions).slice(0, 5)
}

const roleFor = (dimension: OrchestrationDimension, complexity: ComplexityLevel): OrchestrationRolePick => {
  switch (dimension) {
    case 'domain-boundary':
    case 'data-ownership':
    case 'contract-first': return { role: 'mou_ding', deliverable: '边界与契约说明（接口/表结构/事件定义）' }
    case 'risk-isolation': return { role: 'suan_heng', deliverable: '难点方案与可复现验证（含边界样例）' }
    case 'client-side': return { role: 'ji_feng', deliverable: '界面实现与可交互证据' }
    case 'stable-base': return { role: 'xing_zhou', deliverable: '可复用的基座组件与用法说明' }
    case 'state-machine': return { role: 'shu_ji', deliverable: '状态迁移表与异常分支处理' }
    case 'resource-profile': return { role: 'zhu_jian', deliverable: '并发/资源方案与压测读数' }
    case 'conway': return { role: 'shu_ji', deliverable: '分工说明与交付清单' }
    case 'rule-frequency': return { role: 'bo_wen', deliverable: '规则来源与变更影响面' }
    case 'vertical-slice': return complexity === 'small' ? { role: 'ji_feng', deliverable: '切片实现与自测记录' } : { role: 'tan_wei', deliverable: '切片现状与改动面' }
    default: return { role: 'tan_wei', deliverable: '事实与证据清单' }
  }
}

interface OrchestrationRolePick { readonly role: DelegableRoleId; readonly deliverable: string }

const titleOf = (dimension: OrchestrationDimension): string => `按${DIMENSION_LABELS[dimension]}拆分`

/**
 * 规则编排：把维度、角色与依赖显式化。
 * 第 1 条切片先探明现状，其余切片依赖它，因此彼此之间可并行——这正是「先勘察、后并行」的最小形状。
 */
export const getRuleOrchestration = (card: TaskCard, flags: TaskFlags): OrchestrationPlan => {
  const complexity = getRuleComplexity(card, flags)
  const dimensions = getRuleDimensions(flags)
  const subtasks: OrchestrationSubtask[] = []
  const recon = complexity.level === 'small' ? undefined : dimensions[0]
  if (recon !== undefined) {
    subtasks.push({
      id: 'recon', title: '并行前勘察：事实与边界', role: 'tan_wei', dependsOn: [], parallelWith: [],
      dimension: recon, deliverable: '仓库/接口/数据现状与未知项清单（只读）'
    })
  }
  const slices: OrchestrationDimension[] = unique<OrchestrationDimension>([...dimensions, 'vertical-slice']).slice(0, complexity.level === 'large' ? 4 : complexity.level === 'medium' ? 3 : 1)
  slices.forEach((dimension, index) => {
    const pick = roleFor(dimension, complexity.level)
    const dependsOn = recon === undefined || (index === 0 && dimension === recon) ? [] : ['recon']
    subtasks.push({
      id: `slice-${index + 1}`,
      title: titleOf(dimension),
      role: pick.role,
      dependsOn,
      parallelWith: [],
      dimension,
      deliverable: pick.deliverable
    })
  })
  if (subtasks.length === 0) {
    const pick = roleFor('vertical-slice', 'small')
    subtasks.push({ id: 'slice-1', title: '单点实现', role: pick.role, dependsOn: [], parallelWith: [], dimension: 'vertical-slice', deliverable: pick.deliverable })
  }
  const parallelGroups = [[...new Set(subtasks.filter((item) => item.dependsOn.length === 0).map((item) => item.id))]]
    .concat(subtasks.some((item) => item.dependsOn.includes('recon'))
      ? [subtasks.filter((item) => item.dependsOn.includes('recon')).map((item) => item.id)]
      : [])
    .filter((group) => group.length > 0)
  const withParallel = subtasks.map((item) => ({
    ...item,
    parallelWith: parallelGroups.find((group) => group.includes(item.id))?.filter((id) => id !== item.id).filter((id) => {
      const peer = subtasks.find((candidate) => candidate.id === id)
      return peer !== undefined && !peer.dependsOn.includes(item.id) && !item.dependsOn.includes(peer.id)
    }) ?? []
  }))
  // 每条依赖边单独成链：覆盖全部串行约束，又不把同层兄弟切片排成先后顺序。
  const serialized = withParallel.flatMap((item) => item.dependsOn.map((dependency) => [dependency, item.id]))
  const risks = [
    ...(flag(flags, 'touchesFinancialLogic') ? ['涉及金融/资金语义：任何性能或正确性声明都必须有可复现证据'] : []),
    ...(flag(flags, 'sharedStateConcurrency') ? ['共享状态并发：需要明确锁/队列/幂等边界'] : []),
    ...(flag(flags, 'securitySensitive') ? ['安全敏感：先做威胁面梳理再改实现'] : [])
  ]
  const plan: Omit<OrchestrationPlan, 'mermaid'> = {
    complexity: complexity.level,
    source: 'rules',
    reason: complexity.reason,
    dimensions: slices,
    subtasks: withParallel,
    parallelGroups,
    serialized,
    risks
  }
  return { ...plan, mermaid: getOrchestrationMermaid(plan) }
}

/** 编排图：子任务、依赖与并行分组；只画编排决策，不冒充执行进度。 */
export const getOrchestrationMermaid = (plan: Omit<OrchestrationPlan, 'mermaid'> | OrchestrationPlan): string => {
  const lines: string[] = ['flowchart TD']
  lines.push(`  root["任务：${plan.complexity === 'small' ? '单点' : plan.complexity === 'medium' ? '中型' : '大型'}编排（${plan.dimensions.map((d) => DIMENSION_LABELS[d]).join('、')}）"]`)
  for (const subtask of plan.subtasks) {
    lines.push(`  ${subtask.id}["${getRoleInfo(subtask.role).name}：${subtask.title}<br/>交付：${subtask.deliverable}"]`)
  }
  for (const subtask of plan.subtasks) {
    if (subtask.dependsOn.length === 0) lines.push(`  root --> ${subtask.id}`)
    for (const dependency of subtask.dependsOn) lines.push(`  ${dependency} --> ${subtask.id}`)
  }
  plan.parallelGroups.filter((group) => group.length > 1).forEach((group, index) => {
    lines.push(`  par${index + 1}["可并行：${group.join(' + ')}"]`)
    for (const id of group) lines.push(`  par${index + 1} -. 同时开工 .- ${id}`)
  })
  return lines.join('\n')
}

/** 编排判断题：只让 Jev 判断「复杂度」与「是否值得拆」，具体切法留给规则，保证可复核。 */
export const getOrchestrationQuestions = (): Record<string, unknown> => ({
  complexity: {
    type: 'choice',
    instructions: '这个任务在执行前需要多大的编排投入（拆分维度、并行度、是否先立契约）',
    criteria: {
      small: '单点改动，一个专家在一轮内可完成，无需并行',
      medium: '需要 2–3 条可并行的工作流，但仍可在一个契约下完成',
      large: '需要先建立契约或基座，再并行多条切片，风险面广'
    }
  },
  split: {
    type: 'noul',
    instructions: '这个任务值得在执行前显式拆分成多个子任务（而不是由主持者边走边拆）',
    criteria: { true: '任务面宽或风险高，显式拆分能降低耦合并提高并行度', false: '任务足够小，拆分只会增加协调成本' }
  }
})

/** 解析 Jev 答案；任一项缺失或不合法时返回 undefined，由调用方回退规则。 */
export const ParseOrchestrationPlan = (answers: Record<string, unknown>, card: TaskCard, flags: TaskFlags): OrchestrationPlan | undefined => {
  const complexityAnswer = answers.complexity as { choice?: unknown; confidence?: unknown } | undefined
  const level = typeof complexityAnswer?.choice === 'string' && (COMPLEXITY_LEVELS as readonly string[]).includes(complexityAnswer.choice)
    ? complexityAnswer.choice as ComplexityLevel
    : undefined
  const split = (answers.split as { noul?: unknown } | undefined)?.noul
  if (level === undefined || !isJevProbability(split)) return undefined
  const base = getRuleOrchestration(card, flags)
  // Jev 只调整投入级别：small 且不建议拆分时收敛为单点；large 时保留规则给出的全部切片。
  if (level === 'small' && split < 0.5) {
    const pick = roleFor('vertical-slice', 'small')
    const single: Omit<OrchestrationPlan, 'mermaid'> = {
      ...base, complexity: 'small', source: 'jev', reason: `Jev：${COMPLEXITY_LABELS.small}（拆分倾向 ${split.toFixed(2)}）`,
      dimensions: ['vertical-slice'],
      subtasks: [{ id: 'slice-1', title: '单点实现', role: pick.role, dependsOn: [], parallelWith: [], dimension: 'vertical-slice', deliverable: pick.deliverable }],
      parallelGroups: [['slice-1']], serialized: []
    }
    return { ...single, mermaid: getOrchestrationMermaid(single) }
  }
  const adjusted: Omit<OrchestrationPlan, 'mermaid'> = {
    ...base,
    complexity: level,
    source: 'jev',
    reason: `Jev：${COMPLEXITY_LABELS[level]}（拆分倾向 ${split.toFixed(2)}）；规则基线：${base.reason}`
  }
  return { ...adjusted, mermaid: getOrchestrationMermaid(adjusted) }
}
