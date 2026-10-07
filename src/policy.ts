import { getRoleInfo, type DelegableRoleId, type SuanHengMode } from './role-registry.js'

export const GATE_IDS = ['G_VERIFY', 'G_REVIEW', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_DIFF_TEST', 'G_BENCH', 'G_VISION'] as const
export type GateId = typeof GATE_IDS[number]

export const FLAG_KEYS = [
  'changesCode', 'changesAlgorithm', 'touchesFinancialLogic', 'timeSeriesOrBacktest', 'stateMachine',
  'numericPrecision', 'sharedStateConcurrency', 'crossModuleArchitecture', 'securitySensitive',
  'hasVisualInput', 'uiCopy', 'hasExecSteps', 'needsExternalFacts', 'ambiguousRequirements'
] as const
export type FlagKey = typeof FLAG_KEYS[number]
export type TaskFlags = Record<FlagKey, boolean>

/** 性能预算；未知参数写「待测」 */
export interface PerfInfo {
  p95Ms?: number | string
  p99Ms?: number | string
  throughput?: string
  dataScale?: string
}

/** 经校验的任务卡 */
export interface TaskCard {
  title: string
  goal: string
  acceptance: string[]
  scope: string[]
  constraints?: { apiCompat?: string; environment?: string; resourceLimits?: string }
  perf?: PerfInfo
  flags: TaskFlags
}

export type GateSource = 'rule' | 'jev' | 'jev-fallback'

/** 一条必需门禁 */
export interface GateRequirement {
  gate: GateId
  role: DelegableRoleId
  mode?: SuanHengMode
  reason: string
  source: GateSource
}

/** 门禁 → 负责角色 */
export const GATE_ROLE: Readonly<Record<GateId, { role: DelegableRoleId; mode?: SuanHengMode; label: string }>> = {
  G_VERIFY: { role: 'fu_he', label: '复核实际运行验证' },
  G_REVIEW: { role: 'yu_shi', label: '御史独立审查' },
  G_MATH_RESEARCH: { role: 'suan_heng', mode: 'research', label: '算衡·研算' },
  G_MATH_VERIFY: { role: 'suan_heng', mode: 'verify', label: '算衡·验算（与研算不同模型家族）' },
  G_DIFF_TEST: { role: 'fu_he', label: '差分/性质测试' },
  G_BENCH: { role: 'fu_he', label: '可重复基准测试' },
  G_VISION: { role: 'guan_xiang', label: '观象视觉核对' }
}

const PERF_NUMBER_KEYS = ['p95Ms', 'p99Ms'] as const
const PERF_TEXT_KEYS = ['throughput', 'dataScale'] as const
const CONSTRAINT_KEYS = ['apiCompat', 'environment', 'resourceLimits'] as const

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const getStringList = (value: unknown, key: string, errors: string[]): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    errors.push(`${key} 必须是字符串数组`)
    return []
  }
  return value as string[]
}

const getFlags = (raw: unknown, errors: string[]): TaskFlags => {
  const flags = Object.fromEntries(FLAG_KEYS.map((key) => [key, false])) as TaskFlags
  if (raw === undefined) return flags
  if (!isPlainObject(raw)) {
    errors.push('flags 必须是对象')
    return flags
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!(FLAG_KEYS as readonly string[]).includes(key)) errors.push(`未知风险标志 ${key}`)
    else if (typeof value !== 'boolean') errors.push(`flags.${key} 必须是布尔值`)
    else flags[key as FlagKey] = value
  }
  return flags
}

const getPerf = (raw: unknown, errors: string[]): PerfInfo | undefined => {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push('perf 必须是对象')
    return undefined
  }
  for (const key of PERF_NUMBER_KEYS) {
    const value = raw[key]
    if (value !== undefined && typeof value !== 'number' && value !== '待测') errors.push(`perf.${key} 必须是数字或「待测」`)
  }
  for (const key of PERF_TEXT_KEYS) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') errors.push(`perf.${key} 必须是字符串`)
  }
  return raw as PerfInfo
}

const getConstraints = (raw: unknown, errors: string[]): TaskCard['constraints'] => {
  if (raw === undefined) return undefined
  if (!isPlainObject(raw)) {
    errors.push('constraints 必须是对象')
    return undefined
  }
  for (const key of CONSTRAINT_KEYS) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') errors.push(`constraints.${key} 必须是字符串`)
  }
  return raw as TaskCard['constraints']
}

/**
 * 校验并规范化任务卡输入
 * @param {unknown} input - swarm_task_card 的参数
 * @returns {{ card?: TaskCard; errors: string[] }} 规范化后的任务卡或错误列表
 */
export const ValidateTaskCard = (input: unknown): { card?: TaskCard; errors: string[] } => {
  if (!isPlainObject(input)) return { errors: ['任务卡必须是对象'] }
  const errors: string[] = []
  const getText = (key: 'title' | 'goal'): string => {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    errors.push(`${key} 必须是非空字符串`)
    return ''
  }
  const title = getText('title')
  const goal = getText('goal')
  const acceptance = getStringList(input.acceptance, 'acceptance', errors)
  if (acceptance.length === 0) errors.push('acceptance 至少包含 1 条验收标准')
  const scope = getStringList(input.scope, 'scope', errors)
  const flags = getFlags(input.flags, errors)
  const perf = getPerf(input.perf, errors)
  const constraints = getConstraints(input.constraints, errors)
  if (errors.length > 0) return { errors }
  return {
    card: {
      title, goal, acceptance, scope, flags,
      ...(perf === undefined ? {} : { perf }),
      ...(constraints === undefined ? {} : { constraints })
    },
    errors: []
  }
}

/**
 * 是否声明了真实的性能预算（「待测」不算）
 * @param {PerfInfo | undefined} perf - 性能预算
 * @returns {boolean} 是否需要基准门禁
 */
export const hasPerfBudget = (perf: PerfInfo | undefined): boolean =>
  perf !== undefined && Object.values(perf).some((value) => value !== undefined && value !== '' && value !== '待测')

const AddGate = (gates: GateRequirement[], gate: GateId, reason: string, source: GateSource): void => {
  if (gates.some((item) => item.gate === gate)) return
  const { role, mode } = GATE_ROLE[gate]
  gates.push({ gate, role, ...(mode === undefined ? {} : { mode }), reason, source })
}

const getFlagReason = (card: TaskCard, keys: readonly FlagKey[]): string =>
  keys.filter((key) => card.flags[key]).join('、')

/**
 * 确定性规则给出的强制门禁（先于 Jev，且不能被 Jev 移除）
 * @param {TaskCard} card - 任务卡
 * @returns {GateRequirement[]} 门禁列表
 */
export const getRuleGates = (card: TaskCard): GateRequirement[] => {
  const f = card.flags
  const gates: GateRequirement[] = []
  if (f.changesCode) AddGate(gates, 'G_VERIFY', '任务涉及代码改动', 'rule')
  const reviewKeys: FlagKey[] = ['crossModuleArchitecture', 'sharedStateConcurrency', 'changesAlgorithm', 'securitySensitive', 'touchesFinancialLogic', 'timeSeriesOrBacktest']
  if (reviewKeys.some((key) => f[key])) AddGate(gates, 'G_REVIEW', `高风险标志：${getFlagReason(card, reviewKeys)}`, 'rule')
  if (f.changesAlgorithm) AddGate(gates, 'G_MATH_RESEARCH', '改变算法语义，需在实现前定义不变量与复杂度', 'rule')
  const mathKeys: FlagKey[] = ['touchesFinancialLogic', 'timeSeriesOrBacktest', 'stateMachine', 'numericPrecision', 'sharedStateConcurrency']
  if (mathKeys.some((key) => f[key])) AddGate(gates, 'G_MATH_VERIFY', `强制验算：${getFlagReason(card, mathKeys)}`, 'rule')
  if ((f.touchesFinancialLogic || f.timeSeriesOrBacktest) && f.changesAlgorithm) AddGate(gates, 'G_DIFF_TEST', '量化核心算法改动需要差分/性质测试', 'rule')
  if (hasPerfBudget(card.perf)) AddGate(gates, 'G_BENCH', '任务声明了性能预算', 'rule')
  if (f.hasVisualInput) AddGate(gates, 'G_VISION', '任务包含截图、设计稿或视觉产物', 'rule')
  return gates
}

/**
 * 是否值得调用 Jev：只在涉及代码/算法/性能且规则尚未覆盖全部可加门禁时调用
 * @param {TaskCard} card - 任务卡
 * @param {GateRequirement[]} gates - 规则门禁
 * @returns {boolean} 是否调用
 */
export const isTriageUseful = (card: TaskCard, gates: GateRequirement[]): boolean => {
  const relevant = card.flags.changesCode || card.flags.changesAlgorithm || hasPerfBudget(card.perf)
  if (!relevant) return false
  const present = new Set(gates.map((item) => item.gate))
  const addable: GateId[] = ['G_REVIEW', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_BENCH']
  return addable.some((gate) => !present.has(gate))
}

/** Jev 答案中本插件读取的字段 */
export interface TriageAnswers {
  mathTask?: { choice: string; confidence: number }
  needBenchmark?: number
  novelty?: { score: number; confidence: number }
}

/** Jev 分流阈值（保守默认值，可按本地标注集校准） */
export interface TriageThresholdsInfo {
  mathConfidence: number
  benchmarkNoul: number
  noveltyScore: number
  noveltyConfidence: number
}

export const DEFAULT_TRIAGE_THRESHOLDS: TriageThresholdsInfo = {
  mathConfidence: 0.6,
  benchmarkNoul: 0.5,
  noveltyScore: 1,
  noveltyConfidence: 0.5
}

const AddStrictGates = (gates: GateRequirement[], card: TaskCard, reason: string): void => {
  if (!card.flags.changesAlgorithm) return
  AddGate(gates, 'G_MATH_VERIFY', `衡鉴按严格路径：${reason}`, 'jev-fallback')
  AddGate(gates, 'G_REVIEW', `衡鉴按严格路径：${reason}`, 'jev-fallback')
}

/**
 * 按 Jev 答案追加门禁；Jev 失败或置信度低时走严格路径。只增不减
 * @param {GateRequirement[]} gates - 已有门禁
 * @param {TaskCard} card - 任务卡
 * @param {{ answers?: TriageAnswers; failed: boolean; reason?: string }} triage - Jev 结果
 * @param {TriageThresholdsInfo} thresholds - 阈值
 * @returns {GateRequirement[]} 新的门禁列表
 */
export const AddTriageGates = (
  gates: GateRequirement[],
  card: TaskCard,
  triage: { answers?: TriageAnswers; failed: boolean; reason?: string },
  thresholds: TriageThresholdsInfo
): GateRequirement[] => {
  const out = gates.map((item) => ({ ...item }))
  const answers = triage.answers
  if (triage.failed || answers === undefined) {
    AddStrictGates(out, card, triage.reason ?? 'Jev 不可用')
    return out
  }
  const mathTask = answers.mathTask
  if (mathTask !== undefined && mathTask.confidence < thresholds.mathConfidence) {
    AddStrictGates(out, card, `math_task 置信度 ${mathTask.confidence} 低于阈值 ${thresholds.mathConfidence}`)
  } else if (mathTask !== undefined && ['invariant', 'equivalence', 'research'].includes(mathTask.choice)) {
    AddGate(out, 'G_MATH_VERIFY', `Jev：数学检查类型 ${mathTask.choice}（置信度 ${mathTask.confidence}）`, 'jev')
    if (mathTask.choice === 'research') AddGate(out, 'G_MATH_RESEARCH', 'Jev：需要设计新算法', 'jev')
  }
  if ((answers.needBenchmark ?? 0) >= thresholds.benchmarkNoul) AddGate(out, 'G_BENCH', `Jev：需要基准（概率 ${answers.needBenchmark}）`, 'jev')
  const novelty = answers.novelty
  if (novelty !== undefined && novelty.score >= thresholds.noveltyScore && novelty.confidence >= thresholds.noveltyConfidence) {
    AddGate(out, 'G_REVIEW', `Jev：算法变化程度 ${novelty.score}`, 'jev')
  }
  return out
}

/**
 * 根据任务卡与门禁建议参与的角色（天枢据此决策，不强制）
 * @param {TaskCard} card - 任务卡
 * @param {GateRequirement[]} gates - 门禁
 * @returns {Array<{ role: DelegableRoleId; reason: string }>} 建议
 */
export const getSuggestedRoles = (card: TaskCard, gates: GateRequirement[]): Array<{ role: DelegableRoleId; reason: string }> => {
  const out: Array<{ role: DelegableRoleId; reason: string }> = []
  const push = (role: DelegableRoleId, reason: string): void => {
    if (!out.some((item) => item.role === role)) out.push({ role, reason })
  }
  const f = card.flags
  if (f.ambiguousRequirements) push('mou_ding', '需求模糊或多目标，先分解约束与方案')
  if (f.crossModuleArchitecture || f.sharedStateConcurrency) push('shu_ji', '跨模块或共享状态边界需要先梳理')
  if (f.changesCode && card.scope.length === 0) push('tan_wei', '未给出代码范围，先定位代码与调用链')
  if (f.needsExternalFacts) push('bo_wen', '需要外部资料')
  if (f.hasVisualInput) push('guan_xiang', '有图片或视觉产物')
  if (f.uiCopy) push('miao_bi', '涉及文案与表达')
  if (f.changesCode) push(f.changesAlgorithm || f.crossModuleArchitecture ? 'zhu_jian' : 'ji_feng', f.changesAlgorithm || f.crossModuleArchitecture ? '跨文件或算法实现' : '局部低风险改动')
  if (f.hasExecSteps) push('xing_zhou', '有明确的执行步骤')
  for (const item of gates) push(item.role, `门禁 ${item.gate}：${GATE_ROLE[item.gate].label}`)
  return out
}

/** 门禁判定需要的委派字段 */
export interface GateDelegationView {
  delegationId: string
  role: DelegableRoleId
  mode?: SuanHengMode
  status: 'queued' | 'running' | 'completed' | 'failed' | 'blocked'
  structured?: unknown
  startedAt?: number
  finishedAt?: number
  independence: 'achieved' | 'not-achieved' | 'n/a'
  childId?: string
  changedFiles?: string[]
  changeTracking?: 'git' | 'unavailable'
}

/** 天枢对御史发现或验算反例的处理说明 */
export interface FindingResolution {
  delegationId: string
  index: number
  resolution: string
}

/** 单个门禁的判定结果 */
export interface GateStatus {
  gate: GateId
  satisfied: boolean
  by?: string
  missing?: string
  notes: string[]
}

const EDIT_ROLES: readonly DelegableRoleId[] = ['zhu_jian', 'ji_feng']

/**
 * 是否算作一次代码编辑：编辑角色完成了委派；或已启动但失败，且确实产生了改动（或改动无法追踪，按保守处理）
 * @param {GateDelegationView} d - 委派
 * @returns {boolean} 是否计入最后一次编辑
 */
const isEditDelegation = (d: GateDelegationView): boolean => {
  if (!EDIT_ROLES.includes(d.role)) return false
  if (d.status === 'completed') return true
  if (d.status !== 'failed' || d.childId === undefined) return false
  return d.changeTracking !== 'git' || (d.changedFiles?.length ?? 0) > 0
}

/** 最后一次编辑的时刻：编辑委派的完成时刻与外部编辑（天枢自己改文件）时刻取最大值 */
const getLastEditTime = (delegations: GateDelegationView[], externalEditAt: number): number =>
  Math.max(0, externalEditAt, ...delegations.filter(isEditDelegation).map((d) => d.finishedAt ?? 0))

/** 在 after 时刻之后才开始的已完成委派（验证必须开始于最后一次编辑结束之后），按完成时间倒序 */
const getCompletedAfter = (delegations: GateDelegationView[], role: DelegableRoleId, after: number, mode?: SuanHengMode): GateDelegationView[] =>
  delegations
    .filter((d) => d.role === role && d.status === 'completed' && (d.startedAt ?? d.finishedAt ?? 0) >= after && (mode === undefined || d.mode === mode))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))

interface CommandView { exitCode?: unknown; kind?: unknown; summary?: unknown }

const getCommands = (d: GateDelegationView): CommandView[] => {
  const commands = (d.structured as { commands?: unknown } | undefined)?.commands
  return Array.isArray(commands) ? (commands as CommandView[]) : []
}

/** 带数值的摘要（基准结论必须给出数字） */
const HAS_NUMBER = /\d/

const hasPassedCommand = (d: GateDelegationView, kinds: readonly string[], needsNumber = false): boolean =>
  getCommands(d).some((c) => c.exitCode === 0 && kinds.includes(String(c.kind)) && (needsNumber ? HAS_NUMBER.test(String(c.summary ?? '')) : true))

const hasFailedCommand = (d: GateDelegationView, kinds: readonly string[]): boolean =>
  getCommands(d).some((c) => kinds.includes(String(c.kind)) && typeof c.exitCode === 'number' && c.exitCode !== 0)

const getVerdict = (d: GateDelegationView): unknown => (d.structured as { verdict?: unknown } | undefined)?.verdict

const isVerdictPass = (d: GateDelegationView): boolean =>
  getVerdict(d) === 'pass' && getCommands(d).some((c) => typeof c.exitCode === 'number')

const getSatisfied = (gate: GateId, by: GateDelegationView | undefined, missing: string, notes: string[] = []): GateStatus =>
  by === undefined ? { gate, satisfied: false, missing, notes } : { gate, satisfied: true, by: by.delegationId, notes }

const getUnsatisfied = (gate: GateId, missing: string): GateStatus => ({ gate, satisfied: false, missing, notes: [] })

const isResolved = (resolutions: FindingResolution[], delegationId: string, index: number): boolean =>
  resolutions.some((r) => r.delegationId === delegationId && r.index === index && r.resolution.trim() !== '')

/** 列出某些委派中满足条件、且没有处理说明的条目（形如 D-3#0） */
const getUnresolvedItems = <T>(
  list: GateDelegationView[], key: string, isSerious: (item: T) => boolean, resolutions: FindingResolution[]
): string[] =>
  list.flatMap((d) => {
    const items = (d.structured as Record<string, unknown> | undefined)?.[key]
    return (Array.isArray(items) ? (items as T[]) : [])
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => isSerious(item) && !isResolved(resolutions, d.delegationId, index))
      .map(({ index }) => `${d.delegationId}#${index}`)
  })

/** 复核类门禁：最后一次编辑之后，任何一次失败都否决之前的通过 */
const getVerifyStatus = (fuHe: GateDelegationView[]): GateStatus => {
  const failing = fuHe.find((d) => getVerdict(d) === 'fail')
  if (failing !== undefined) return getUnsatisfied('G_VERIFY', `复核 ${failing.delegationId} 判定为 fail，需修复后重新复核`)
  return getSatisfied('G_VERIFY', fuHe.find(isVerdictPass), '缺少最后一次代码改动之后、判定为通过且带退出码的复核结果')
}

const getCommandGateStatus = (gate: 'G_DIFF_TEST' | 'G_BENCH', fuHe: GateDelegationView[]): GateStatus => {
  const kinds = gate === 'G_DIFF_TEST' ? ['differential', 'property'] : ['benchmark']
  const failing = fuHe.find((d) => hasFailedCommand(d, kinds))
  if (failing !== undefined) return getUnsatisfied(gate, `复核 ${failing.delegationId} 中有失败的${gate === 'G_DIFF_TEST' ? '差分/性质测试' : '基准'}命令`)
  return gate === 'G_DIFF_TEST'
    ? getSatisfied(gate, fuHe.find((d) => hasPassedCommand(d, kinds)), '复核结果中没有通过的差分/性质测试命令')
    : getSatisfied(gate, fuHe.find((d) => hasPassedCommand(d, kinds, true)), '复核结果中没有通过且带数值摘要的基准命令')
}

/** 御史门禁：汇总最后一次编辑之后的全部审查，每条严重/高危发现都要有处理说明 */
const getReviewStatus = (delegations: GateDelegationView[], resolutions: FindingResolution[], after: number): GateStatus => {
  const reviews = getCompletedAfter(delegations, 'yu_shi', after)
  if (reviews.length === 0) return getUnsatisfied('G_REVIEW', '缺少最后一次代码改动之后的御史审查')
  const unresolved = getUnresolvedItems<{ severity?: string }>(reviews, 'findings', (f) => f.severity === 'critical' || f.severity === 'high', resolutions)
  if (unresolved.length > 0) return getUnsatisfied('G_REVIEW', `御史的严重/高危发现未给出处理：${unresolved.join(', ')}`)
  const notes = reviews.some((d) => d.independence === 'not-achieved') ? ['审查者与实现者模型家族相同（独立性未实现）'] : []
  return getSatisfied('G_REVIEW', reviews[0], '', notes)
}

/** 验算门禁：最后一次编辑之后的验算，反例都要有处理说明，最新一次至少证实一条结论 */
const getMathVerifyStatus = (delegations: GateDelegationView[], resolutions: FindingResolution[], after: number): GateStatus => {
  const verifies = getCompletedAfter(delegations, 'suan_heng', after, 'verify')
  if (verifies.length === 0) return getUnsatisfied('G_MATH_VERIFY', '缺少最后一次代码改动之后的算衡·验算结果')
  const refuted = getUnresolvedItems<{ status?: string }>(verifies, 'claims', (c) => c.status === 'refuted', resolutions)
  if (refuted.length > 0) return getUnsatisfied('G_MATH_VERIFY', `验算给出了反例且未说明处理：${refuted.join(', ')}`)
  const latest = verifies[0] as GateDelegationView
  const claims = (latest.structured as { claims?: Array<{ status?: string }> } | undefined)?.claims ?? []
  if (!claims.some((c) => c.status === 'proved')) return getUnsatisfied('G_MATH_VERIFY', `验算 ${latest.delegationId} 没有证实任何结论`)
  return getSatisfied('G_MATH_VERIFY', latest, '', latest.independence === 'not-achieved' ? ['验算与研算模型家族相同（独立性未实现）'] : [])
}

/**
 * 判定单个门禁是否已由证据满足
 * @param {GateId} gate - 门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {FindingResolution[]} resolutions - 天枢对御史发现与验算反例的处理
 * @param {number} [externalEditAt=0] - 委派之外的编辑时刻（天枢自己改文件）
 * @returns {GateStatus} 判定结果
 */
export const getGateStatus = (gate: GateId, delegations: GateDelegationView[], resolutions: FindingResolution[], externalEditAt = 0): GateStatus => {
  const lastEdit = getLastEditTime(delegations, externalEditAt)
  const fuHe = getCompletedAfter(delegations, 'fu_he', lastEdit)
  switch (gate) {
    case 'G_VERIFY':
      return getVerifyStatus(fuHe)
    case 'G_DIFF_TEST':
    case 'G_BENCH':
      return getCommandGateStatus(gate, fuHe)
    case 'G_REVIEW':
      return getReviewStatus(delegations, resolutions, lastEdit)
    case 'G_MATH_RESEARCH': {
      const research = getCompletedAfter(delegations, 'suan_heng', 0, 'research').find((d) => {
        const s = d.structured as { invariants?: unknown[]; complexity?: string } | undefined
        return (s?.invariants?.length ?? 0) > 0 && (s?.complexity ?? '').trim() !== ''
      })
      return getSatisfied(gate, research, '缺少含不变量与复杂度的算衡·研算结果')
    }
    case 'G_MATH_VERIFY':
      return getMathVerifyStatus(delegations, resolutions, lastEdit)
    case 'G_VISION':
      return getSatisfied(gate, getCompletedAfter(delegations, 'guan_xiang', 0)[0], '缺少观象的视觉观察结果')
  }
}

/**
 * 实际生效的门禁：出现过编辑（含天枢自己改文件）时自动补上 G_VERIFY
 * @param {GateRequirement[]} gates - 任务卡门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {number} [externalEditAt=0] - 委派之外的编辑时刻
 * @returns {GateRequirement[]} 生效门禁
 */
export const getEffectiveGates = (gates: GateRequirement[], delegations: GateDelegationView[], externalEditAt = 0): GateRequirement[] => {
  const out = gates.map((item) => ({ ...item }))
  if (delegations.some(isEditDelegation)) AddGate(out, 'G_VERIFY', '任务中出现过代码改动委派', 'rule')
  if (externalEditAt > 0) AddGate(out, 'G_VERIFY', '天枢直接修改过文件', 'rule')
  return out
}

/**
 * 汇总全部门禁的判定结果
 * @param {GateRequirement[]} gates - 生效门禁
 * @param {GateDelegationView[]} delegations - 本任务的委派
 * @param {FindingResolution[]} resolutions - 发现处理
 * @param {number} [externalEditAt=0] - 委派之外的编辑时刻
 * @returns {{ ok: boolean; statuses: GateStatus[]; missing: string[] }} 是否可验收
 */
export const getAcceptanceCheck = (gates: GateRequirement[], delegations: GateDelegationView[], resolutions: FindingResolution[], externalEditAt = 0) => {
  const statuses = gates.map((item) => getGateStatus(item.gate, delegations, resolutions, externalEditAt))
  const missing = statuses.filter((s) => !s.satisfied).map((s) => `${s.gate}：${s.missing ?? '未满足'}`)
  return { ok: missing.length === 0, statuses, missing }
}

/** 调用预算；委派次数上限为 0 表示不限（同一大类任务可以反复追加调用同一专家） */
export interface BudgetInfo {
  maxDelegationsPerTask: number
  maxCallsPerRole: number
  maxCallsZhuJian: number
  maxAutoFixRounds: number
}

export const DEFAULT_BUDGETS: BudgetInfo = {
  maxDelegationsPerTask: 0,
  maxCallsPerRole: 0,
  maxCallsZhuJian: 0,
  maxAutoFixRounds: 2
}

/**
 * 检查本次委派是否超出预算；被预算拦下的 blocked 委派不计数
 * @param {GateDelegationView[]} delegations - 本任务已有委派
 * @param {DelegableRoleId} role - 本次角色
 * @param {BudgetInfo} budgets - 预算
 * @returns {string | undefined} 超出原因
 */
export const ValidateDelegationBudget = (delegations: GateDelegationView[], role: DelegableRoleId, budgets: BudgetInfo): string | undefined => {
  const counted = delegations.filter((d) => d.status !== 'blocked')
  if (budgets.maxDelegationsPerTask > 0 && counted.length >= budgets.maxDelegationsPerTask) return `任务委派数已达上限 ${budgets.maxDelegationsPerTask}`
  const limit = role === 'zhu_jian' ? budgets.maxCallsZhuJian : budgets.maxCallsPerRole
  if (limit > 0 && counted.filter((d) => d.role === role).length >= limit) return `角色「${getRoleInfo(role).name}」在本任务的调用次数已达上限 ${limit}`
  return undefined
}
