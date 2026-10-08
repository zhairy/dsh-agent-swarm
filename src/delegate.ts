import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import { ValidateStructuredOutput, getEvidenceFromOutput, getOutputSchema, type EvidenceItem } from './contracts.js'
import type { BackendKind, DelegationRecord, DelegationRetryInfo, DelegationSessionInfo, Ledger, RouteAttempt, TaskRecord, TaskStore } from './evidence.js'
import {
  SPAWN_PROVIDER,
  STRUCTURED_OUTPUT_TOOL,
  getAgentHeader,
  type AgentLike,
  type AttachmentsLike,
  type ContentBlockLike,
  type SubagentEndInfoLike,
  type SubagentResultLike,
  type SubagentRunLike,
  type SubagentsLike,
  type ToolsLike
} from './host-contract.js'
import { getPromptStyle, getStyledTaskPrompt, type PromptStyle } from './model-family.js'
import { isNetworkSuspect, type NetworkMonitorInfo } from './network.js'
import { GATE_IDS, GATE_ROLE, ValidateDelegationBudget, type GateId } from './policy.js'
import type { FallbackEventInfo, RouteStateRegistry } from './route-state.js'
import {
  getChildPersona,
  getRoleInfo,
  getWantedTools,
  isDelegableRoleId,
  isEditRole,
  type DelegableRoleId,
  type SuanHengMode
} from './role-registry.js'
import { FindUsableRoutes, getModelFamily, getRouteKey, getRouteLabel, type EscalationKind, type ModelFamily, type RouteInfo, type RouteProbe } from './routes.js'
import { SESSION_CHOICES, getRuleSessionPlan, type ChildEndHub, type SessionChoice, type SessionPlan, type ThreadInfo, type ThreadRegistry } from './threads.js'
import { getUpgradeReasons, getUpgradedChain } from './upgrade.js'
import { SwarmError, getErrorText } from './util/errors.js'
import { getExplainedError } from './util/failure-hint.js'
import { getChangedFiles, type GitStatusInfo } from './util/git.js'
import type { MutexInfo } from './util/mutex.js'
import { ValidateImagePaths, getImageBlocks } from './vision.js'

export const DELEGATE_BACKENDS = ['auto', 'api', 'codex', 'claude'] as const
export type DelegateBackend = typeof DELEGATE_BACKENDS[number]

/** swarm_delegate 的参数 */
export interface DelegateInput {
  task_id: string
  role: DelegableRoleId
  mode?: SuanHengMode
  prompt: string
  context_paths?: string[]
  image_paths?: string[]
  backend?: DelegateBackend
  allow_web?: boolean
  gate?: GateId
  /** 天枢判断本次需要更强的模型（高风险、高歧义或置信度不足） */
  upgrade?: boolean
  /** 会话方式：auto 由衡鉴判断；new 新建连续会话；continue 追加到该角色已有的会话；oneshot 一次性调用 */
  session?: SessionChoice
  node_id?: string
  request_id?: string
  expected_workflow_revision?: number
  /** 仅服务层生成；不公开给模型参数 schema。 */
  attempt_id?: string
  review_phase?: 'blind' | 'response'
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * 校验委派参数（包括角色与参数的组合约束）
 * @param {unknown} raw - 工具参数
 * @returns {{ input?: DelegateInput; errors: string[] }} 规范化参数或错误
 */
export const ValidateDelegateInput = (raw: unknown): { input?: DelegateInput; errors: string[] } => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['参数必须是对象'] }
  const value = raw as Record<string, unknown>
  const errors: string[] = []
  if (typeof value.task_id !== 'string' || value.task_id.trim() === '') errors.push('task_id 必须是非空字符串')
  if (typeof value.prompt !== 'string' || value.prompt.trim() === '') errors.push('prompt 必须是非空字符串')
  const role = value.role
  if (!isDelegableRoleId(role)) {
    errors.push('role 必须是可委派角色 ID（天枢不能被委派）')
    return { errors }
  }
  if (value.mode !== undefined && role !== 'suan_heng') errors.push('mode 只适用于 suan_heng')
  if (value.mode !== undefined && value.mode !== 'research' && value.mode !== 'verify') errors.push('mode 必须是 research 或 verify')
  if (value.image_paths !== undefined && role !== 'guan_xiang') errors.push('image_paths 只适用于 guan_xiang')
  if (value.image_paths !== undefined && !isStringList(value.image_paths)) errors.push('image_paths 必须是字符串数组')
  if (value.context_paths !== undefined && !isStringList(value.context_paths)) errors.push('context_paths 必须是字符串数组')
  if (value.allow_web !== undefined && typeof value.allow_web !== 'boolean') errors.push('allow_web 必须是布尔值')
  if (value.upgrade !== undefined && typeof value.upgrade !== 'boolean') errors.push('upgrade 必须是布尔值')
  if (value.session !== undefined && !(SESSION_CHOICES as readonly unknown[]).includes(value.session)) errors.push(`session 必须是 ${SESSION_CHOICES.join(' / ')} 之一`)
  if (value.review_phase !== undefined && !['blind', 'response'].includes(String(value.review_phase))) errors.push('review_phase 必须是 blind 或 response')
  if (value.review_phase !== undefined && role !== 'yu_shi' && !(role === 'suan_heng' && value.mode === 'verify')) errors.push('只有独立审查/验算角色可声明评审阶段')
  if (value.allow_web === true && getRoleInfo(role).web === 'never') errors.push(`「${getRoleInfo(role).name}」不开放 web 工具`)
  if (value.gate !== undefined && !(GATE_IDS as readonly unknown[]).includes(value.gate)) errors.push(`gate 必须是 ${GATE_IDS.join(' / ')} 之一`)
  if (value.backend !== undefined && !(DELEGATE_BACKENDS as readonly unknown[]).includes(value.backend)) errors.push(`backend 必须是 ${DELEGATE_BACKENDS.join(' / ')} 之一`)
  if (errors.length > 0) return { errors }
  return { input: value as unknown as DelegateInput, errors: [] }
}

/** 允许使用原生后端的只读类角色 */
export const NATIVE_READ_ROLES: readonly DelegableRoleId[] = ['mou_ding', 'shu_ji', 'suan_heng', 'tan_wei', 'bo_wen', 'yu_shi', 'miao_bi']
/** 允许使用原生后端的编辑类角色 */
export const NATIVE_EDIT_ROLES: readonly DelegableRoleId[] = ['zhu_jian', 'ji_feng']

/**
 * 按角色与选择确定原生后端实例种类；执行/验证/视觉角色不走原生后端
 * @param {DelegableRoleId} role - 角色
 * @param {EscalationKind} choice - codex 或 claude
 * @returns {BackendKind | undefined} 实例种类
 */
export const getNativeKind = (role: DelegableRoleId, choice: EscalationKind): BackendKind | undefined => {
  if (NATIVE_EDIT_ROLES.includes(role)) return choice === 'codex' ? 'codex-edit' : 'claude-edit'
  if (NATIVE_READ_ROLES.includes(role)) return choice === 'codex' ? 'codex' : 'claude-plan'
  return undefined
}

export const getNativeProviderName = (kind: BackendKind, config: SwarmConfigInfo): string => {
  const names: Record<BackendKind, string> = {
    spawn: SPAWN_PROVIDER,
    codex: config.native.codexProvider,
    'codex-edit': config.native.codexEditProvider,
    'claude-plan': config.native.claudePlanProvider,
    'claude-edit': config.native.claudeEditProvider
  }
  return names[kind]
}

/**
 * 子智能体工具过滤：角色需要的工具 ∩ 父会话实际可见的工具；无交集时隐藏全部可见工具
 * @param {DelegableRoleId} role - 角色
 * @param {string[]} visibleNames - 父会话可见工具名
 * @param {boolean} allowWeb - 本次是否开放 web
 * @returns {{ allow?: string[]; deny?: string[] } | undefined} toolFilter
 */
export const getToolFilter = (role: DelegableRoleId, visibleNames: string[], allowWeb: boolean): { allow?: string[]; deny?: string[] } | undefined => {
  const visible = new Set(visibleNames)
  const allow = getWantedTools(role, { allowWeb }).filter((name) => visible.has(name))
  if (allow.length > 0) return { allow }
  const deny = visibleNames.filter((name) => name !== STRUCTURED_OUTPUT_TOOL)
  return deny.length > 0 ? { deny } : undefined
}

/**
 * 生成交给子智能体的任务背景（子智能体看不到天枢对话）
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @returns {string} 背景文本
 */
export const getTaskBrief = (task: TaskRecord, input: DelegateInput, delegationId: string): string => {
  const card = task.card
  const constraints = Object.entries(card.constraints ?? {}).map(([key, value]) => `${key}=${String(value)}`)
  const perf = Object.entries(card.perf ?? {}).map(([key, value]) => `${key}=${String(value)}`)
  return [
    `任务 ${task.taskId} / 委派 ${delegationId} / 需求版本 ${task.requestRevision ?? 1} / 合同版本 ${task.cardRevision ?? 1} / 流程版本 ${task.workflowRevision ?? 1}`,
    ...((input.role === 'yu_shi' || (input.role === 'suan_heng' && input.mode === 'verify')) ? [
      input.review_phase === 'response'
        ? '评审阶段：response。宿主已确认同版本、同产物的冻结初审；可读取同伴材料并回应，保留原初审，回应不能替代初审门禁。产物改变后重新盲审。'
        : '评审阶段：blind。独立初审不读取作者推理、历史评分或同伴解释；先提交并冻结结论，之后才能进入 response。'
    ] : []),
    `任务标题：${card.title}`,
    `目标：${card.goal}`,
    `验收标准：\n${card.acceptance.map((item) => `- ${item}`).join('\n')}`,
    `范围：${card.scope.length > 0 ? card.scope.join('、') : '未指定'}`,
    ...((task.contextRefs ?? []).length > 0 ? [`授权材料索引：${task.contextRefs!.slice(0, 4).map((item) => `${item.ref}(${item.layer}/${item.kind})`).join('、')}`] : []),
    '先用 swarm_context_read({task_id}) 列授权材料和执行摘要；私有 state/ledger 不用通用 read。未知路径先 swarm_project_files/glob 实际发现。',
    ...(constraints.length > 0 ? [`约束：${constraints.join('；')}`] : []),
    ...(perf.length > 0 ? [`性能预算：${perf.join('；')}`] : []),
    ...(input.gate === undefined ? [] : [`本次委派用于满足门禁：${input.gate}（${GATE_ROLE[input.gate].label}）`]),
    ...((input as DelegateInput & { node_id?: string }).node_id === undefined ? [] : [`当前节点：${(input as DelegateInput & { node_id?: string }).node_id}；完成节点要求后提交证据，立即停止。`]),
    ...((input.context_paths ?? []).length > 0 ? [`相关文件：\n${(input.context_paths ?? []).map((path) => `- ${path}`).join('\n')}`] : [])
  ].join('\n')
}

/**
 * 一次性调用的任务说明（宿主提供结构化提交工具），按模型家族组织
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @param {PromptStyle} [style='generic'] - 提示风格
 * @returns {string} 文本
 */
export const getChildPromptText = (task: TaskRecord, input: DelegateInput, delegationId: string, style: PromptStyle = 'generic'): string =>
  getStyledTaskPrompt({
    brief: getTaskBrief(task, input, delegationId),
    request: input.prompt,
    delivery: `完成后调用 ${STRUCTURED_OUTPUT_TOOL} 提交结果（${getRoleInfo(input.role).deliverables.join('、')}）。`
  }, style)

/** 连续会话的交付要求正文：宿主不为连续会话提供结构化提交工具，结果以 json 代码块回复 */
export const getJsonDeliveryBody = (role: DelegableRoleId): string =>
  [
    `完成后，最后一条回复只包含一个 \`\`\`json 代码块（代码块外不要写其他文字），提交结构化结果（${getRoleInfo(role).deliverables.join('、')}），字段必须符合以下 JSON Schema：`,
    JSON.stringify(getOutputSchema(role))
  ].join('\n\n')

/** 带标题的连续会话交付要求（用于会话内的重试提示） */
export const getJsonDeliveryText = (role: DelegableRoleId): string => ['—— 交付 ——', getJsonDeliveryBody(role)].join('\n\n')

/** 连续会话的首轮任务 */
export const getThreadPromptText = (task: TaskRecord, input: DelegateInput, delegationId: string, style: PromptStyle = 'generic'): string =>
  getStyledTaskPrompt({ brief: getTaskBrief(task, input, delegationId), request: input.prompt, delivery: getJsonDeliveryBody(input.role) }, style)

/**
 * 追加到连续会话的新任务：会话没见过的任务附完整背景，同一任务只附编号
 * @param {TaskRecord} task - 任务
 * @param {DelegateInput} input - 委派参数
 * @param {string} delegationId - 委派 ID
 * @param {boolean} knowsTask - 该会话此前处理过这个任务
 * @param {PromptStyle} [style='generic'] - 提示风格（与建会话时的 persona 一致）
 * @returns {string} 文本
 */
export const getThreadFollowupText = (task: TaskRecord, input: DelegateInput, delegationId: string, knowsTask: boolean, style: PromptStyle = 'generic'): string =>
  getStyledTaskPrompt({
    header: knowsTask ? `【追加】任务 ${task.taskId} / 委派 ${delegationId}（同一任务的后续工作，沿用你已有的上下文）` : '【追加】新的任务，背景如下。',
    ...(knowsTask ? {} : { brief: getTaskBrief(task, input, delegationId) }),
    request: input.prompt,
    delivery: getJsonDeliveryBody(input.role)
  }, style)

/**
 * 连续会话内的重试提示：中断则续跑，交付不合格则只修正结构化结果
 * @param {DelegableRoleId} role - 角色
 * @param {{ stopReason: string; error?: string; missing: boolean }} failure - 失败情况
 * @returns {string} 文本
 */
export const getThreadRetryText = (role: DelegableRoleId, failure: { stopReason: string; error?: string; missing: boolean }): string => {
  if (failure.stopReason !== 'completed') {
    return `上一次执行中断（${failure.error ?? failure.stopReason}）。请在已有进展的基础上继续完成本次任务，不要从头重做。\n\n${getJsonDeliveryText(role)}`
  }
  if (failure.missing) return `你的上一条回复里没有可解析的 json 代码块。不要重做已完成的工作，只按下面的要求提交结构化结果。\n\n${getJsonDeliveryText(role)}`
  return `上一条回复的结构化结果不符合要求：${failure.error ?? '未知错误'}。不要重做已完成的工作，修正后重新提交。\n\n${getJsonDeliveryText(role)}`
}

/** 原生后端（Codex / Claude Code 客户端）对应的提示风格 */
export const getNativeStyle = (kind: BackendKind): PromptStyle => (kind.startsWith('codex') ? 'gpt' : 'claude')

export const getNativePromptText = (task: TaskRecord, input: DelegateInput, delegationId: string, mode?: SuanHengMode, style: PromptStyle = 'generic'): string =>
  [
    getChildPersona(input.role, mode, style),
    getStyledTaskPrompt({
      brief: getTaskBrief(task, input, delegationId),
      request: input.prompt,
      delivery: ['最后以一个 ```json 代码块输出结果，字段必须符合以下 JSON Schema（不要输出其他 json 代码块）：', JSON.stringify(getOutputSchema(input.role))].join('\n\n')
    }, style)
  ].join('\n\n')

/**
 * 从原生后端的文本回答中取结构化结果：最后一个 json 代码块，退化为首尾花括号片段
 * @param {string} text - 回答文本
 * @returns {unknown} 解析结果，失败为 undefined
 */
export const ParseNativeOutput = (text: string): unknown => {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
  const candidate = blocks.at(-1)?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return undefined
  }
}

export const getOutputText = (result: SubagentResultLike): string =>
  result.output.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('\n')

/**
 * 独立性要求避开的模型家族：御史避开实现者，验算避开研算
 * @param {DelegableRoleId} role - 本次角色
 * @param {SuanHengMode | undefined} mode - 算衡模式
 * @param {DelegationRecord[]} delegations - 本任务已有委派
 * @returns {ModelFamily[]} 需要避开的家族
 */
export const getAvoidFamilies = (role: DelegableRoleId, mode: SuanHengMode | undefined, delegations: DelegationRecord[]): ModelFamily[] => {
  const familiesOf = (match: (d: DelegationRecord) => boolean): ModelFamily[] =>
    [...new Set(delegations.filter((d) => d.status === 'completed' && d.route !== undefined && match(d)).map((d) => getModelFamily((d.route as RouteInfo).model)))]
  if (role === 'yu_shi') return familiesOf((d) => NATIVE_EDIT_ROLES.includes(d.role))
  if (role === 'suan_heng' && mode === 'verify') return familiesOf((d) => d.role === 'suan_heng' && d.mode === 'research')
  return []
}

/** 单个根会话的委派上下文 */
export interface DelegateSessionInfo {
  sessionId: string
  store: TaskStore
  ledger: Ledger
  editLock: MutexInfo
  counters: { native: number }
  /** 该根会话的连续会话 */
  threads: ThreadRegistry
}

/** 衡鉴判断会话方式的输入 */
export interface PlanSessionInput {
  input: DelegateInput
  task: TaskRecord
  /** 可追加的候选会话（同一路由键中最近使用的空闲会话） */
  thread?: ThreadInfo
  session: DelegateSessionInfo
  signal: AbortSignal
}

export interface DelegateExecInfo {
  agent: AgentLike
  signal: AbortSignal
  callId?: string
  /** Trusted control-plane target; never accepted as a model/tool parameter. */
  controlledThreadId?: string
}

/** 委派执行依赖（全部可替换，便于测试） */
export interface DelegateDepsInfo {
  getConfig: () => SwarmConfigInfo
  getSubagents: () => SubagentsLike | undefined
  getTools: () => ToolsLike | undefined
  getAttachments: () => AttachmentsLike | undefined
  probe: RouteProbe
  probeForChild?: (childId: string, route: RouteInfo) => ReturnType<RouteProbe>
  routeState: RouteStateRegistry
  readFile: (path: string) => Promise<Uint8Array>
  gitStatus: (cwd: string) => Promise<GitStatusInfo | undefined>
  now: () => number
  newId: (prefix: string) => string
  /** 连续会话的子会话 ID */
  newChildId: () => string
  /** 连续会话的结束事件 */
  hub: ChildEndHub
  /** 衡鉴判断会话方式；缺省或返回 undefined 时按规则 */
  planSession?: (input: PlanSessionInput) => Promise<SessionPlan | undefined>
  /** 等待；传入 signal 时调用方取消即提前结束 */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 联网探测：出错重试前若已断网，等待网络恢复而不是按固定间隔重试 */
  network?: NetworkMonitorInfo
  onChildStart?: (info: { agentId: string; task: TaskRecord; record: DelegationRecord; role: DelegableRoleId; signal: AbortSignal; persistent?: boolean; input?: DelegateInput; parent?: AgentLike }) => void | Promise<void>
  onChildEnd?: (agentId: string, stopReason?: string) => void | Promise<void>
}

/** 一次运行（一次性或连续会话的一轮，含自动重试）的结果 */
interface RunOutcomeInfo {
  evaluation: EvaluationInfo
  childId: string
  finalRoute?: RouteInfo
  retries: DelegationRetryInfo[]
  session: DelegationSessionInfo
  /** 实际使用的提示风格 */
  promptStyle?: PromptStyle
}

interface EvaluationInfo {
  status: 'completed' | 'failed'
  summary: string
  structured?: unknown
  unresolved: string[]
  evidence: EvidenceItem[]
  error?: string
}

const HIGH_RISK_GATES: readonly GateId[] = ['G_MATH_VERIFY', 'G_REVIEW', 'G_DIFF_TEST']

/**
 * 评估子智能体结果：必须 completed、提交结构化结果并通过契约校验
 * @param {DelegableRoleId} role - 角色
 * @param {SuanHengMode | undefined} mode - 算衡模式
 * @param {SubagentResultLike} result - 子智能体结果
 * @param {unknown} structured - 结构化结果（原生后端由文本解析得到）
 * @returns {EvaluationInfo} 评估
 */
const getEvaluation = (role: DelegableRoleId, mode: SuanHengMode | undefined, result: SubagentResultLike, structured: unknown): EvaluationInfo => {
  const text = getOutputText(result).slice(0, 500)
  if (result.stopReason !== 'completed') {
    return { status: 'failed', summary: text || '子智能体未完成', unresolved: [], evidence: [], error: getExplainedError(`${result.stopReason}${result.diagnostic === undefined ? '' : `：${result.diagnostic}`}`) }
  }
  if (structured === undefined) return { status: 'failed', summary: text || '无结果', unresolved: [], evidence: [], error: '子智能体没有提交结构化结果' }
  const errors = ValidateStructuredOutput(role, structured, mode)
  if (errors.length > 0) {
    return { status: 'failed', summary: text || '结果不合格', structured, unresolved: [], evidence: [], error: `结构化结果不符合契约：${errors.slice(0, 5).join('；')}` }
  }
  const value = structured as { summary: string; unresolved: string[] }
  return { status: 'completed', summary: value.summary, structured, unresolved: value.unresolved, evidence: getEvidenceFromOutput(role, structured) }
}

/**
 * 创建委派执行器
 * @param {DelegateDepsInfo} deps - 依赖
 * @returns {{ delegate: (raw: unknown, exec: DelegateExecInfo, session: DelegateSessionInfo) => Promise<DelegationRecord> }} 执行器
 */
export const intDelegator = (deps: DelegateDepsInfo) => {
  const finish = (session: DelegateSessionInfo, record: DelegationRecord, patch: Partial<DelegationRecord>): DelegationRecord => {
    const finishedAt = deps.now()
    const next = session.store.UpdateDelegation(record.delegationId, { ...patch, finishedAt, durationMs: finishedAt - record.startedAt })
    session.ledger.AddLedgerEvent({
      type: `delegation/${next.status}` as 'delegation/completed',
      taskId: next.taskId,
      delegationId: next.delegationId,
      data: {
        role: next.role, summary: next.summary, error: next.error, route: next.route === undefined ? undefined : getRouteLabel(next.route),
        backend: next.backend, attempts: next.attempts, independence: next.independence, hardIsolation: next.hardIsolation,
        changedFiles: next.changedFiles, evidenceCount: next.evidence.length, durationMs: next.durationMs
      }
    })
    return next
  }

  const block = (session: DelegateSessionInfo, record: DelegationRecord, reason: string, attempts: RouteAttempt[] = []): DelegationRecord =>
    finish(session, record, { status: 'blocked', summary: reason, error: reason, attempts: [...record.attempts, ...attempts] })

  const markRunning = (session: DelegateSessionInfo, record: DelegationRecord, backend: BackendKind): DelegationRecord => {
    const next = session.store.UpdateDelegation(record.delegationId, { status: 'running', backend })
    session.ledger.AddLedgerEvent({ type: 'delegation/running', taskId: next.taskId, delegationId: next.delegationId, data: { backend } })
    return next
  }

  /**
   * 跟随调用方取消的运行；专家执行不设时间限制，只有天枢（或用户）取消才会中止
   * beforeDispose 在释放子智能体之前调用：宿主在释放时触发 agent/disposed，运行时行会随即清理该子智能体的路由状态
   */
  const runWithSignal = async (
    exec: DelegateExecInfo,
    start: (signal: AbortSignal) => Promise<SubagentRunLike>,
    hooks: { onRun?: (run: SubagentRunLike) => void | Promise<void>; beforeDispose?: (run: SubagentRunLike) => void } = {}
  ) => {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    exec.signal.addEventListener('abort', onAbort, { once: true })
    // 已经取消的信号不会再触发 abort 事件，必须主动检查
    if (exec.signal.aborted) controller.abort()
    try {
      const run = await start(controller.signal)
      void run.result.catch(() => undefined)
      try {
        await hooks.onRun?.(run)
        try {
          return { run, result: await run.result }
        } catch (error) {
          return { run, result: { output: [], stopReason: 'error', diagnostic: getErrorText(error) } as SubagentResultLike }
        }
      } finally {
        try { hooks.beforeDispose?.(run) } finally {
          await run.dispose().catch(() => undefined)
          await deps.onChildEnd?.(run.id)
        }
      }
    } finally {
      exec.signal.removeEventListener('abort', onAbort)
    }
  }

  const getWorkspaceRoot = (agent: AgentLike): string => getAgentHeader(agent).cwd ?? process.cwd()

  /** 统计执行前后的工作区改动；只读角色出现改动时追加告警 */
  const getChangeInfo = (role: DelegableRoleId, before: GitStatusInfo | undefined, after: GitStatusInfo | undefined) => {
    if (before === undefined || after === undefined) return { changeTracking: 'unavailable' as const, changedFiles: undefined, warnings: [] as string[] }
    const changedFiles = getChangedFiles(before, after)
    const warnings = !isEditRole(role) && changedFiles.length > 0
      ? [`警告：「${getRoleInfo(role).name}」执行期间工作区出现改动：${changedFiles.join(', ')}（可能来自并行任务或越权操作，请核对）`]
      : []
    return { changeTracking: 'git' as const, changedFiles, warnings }
  }

  const getNativeChoice = (input: DelegateInput, task: TaskRecord, config: SwarmConfigInfo): EscalationKind | undefined => {
    if (input.backend === 'codex' || input.backend === 'claude') return input.backend
    if (input.backend === 'api' || config.nativeEscalation !== 'auto') return undefined
    const escalation = getRoleRoute(config, getRouteKey(input.role, input.mode)).escalation
    const highRisk = task.gates.some((gate) => HIGH_RISK_GATES.includes(gate.gate)) || task.card.flags.securitySensitive
    return highRisk ? escalation : undefined
  }

  const tryNative = async (
    input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo,
    session: DelegateSessionInfo, config: SwarmConfigInfo, subagents: SubagentsLike, choice: EscalationKind, attempts: RouteAttempt[]
  ): Promise<DelegationRecord | undefined> => {
    const kind = getNativeKind(input.role, choice)
    if (kind === undefined) {
      attempts.push({ route: `native:${choice}`, backend: 'spawn', outcome: 'skipped', reason: `「${getRoleInfo(input.role).name}」不支持原生后端` })
      return undefined
    }
    const provider = getNativeProviderName(kind, config)
    if (subagents.getProvider(provider) === undefined) {
      attempts.push({ route: provider, backend: kind, outcome: 'skipped', reason: 'native-unavailable' })
      return undefined
    }
    if (session.counters.native >= config.native.maxCallsPerSession) {
      attempts.push({ route: provider, backend: kind, outcome: 'skipped', reason: 'native-budget' })
      return undefined
    }
    session.counters.native += 1
    session.ledger.AddLedgerEvent({ type: 'native/call', taskId: task.taskId, delegationId: record.delegationId, data: { provider, kind, used: session.counters.native } })
    const running = markRunning(session, record, kind)
    const cwd = getWorkspaceRoot(exec.agent)
    const before = await deps.gitStatus(cwd)
    const promptStyle = getNativeStyle(kind)
    const text = getNativePromptText(task, input, record.delegationId, input.mode, promptStyle)
    let outcome: { run: SubagentRunLike; result: SubagentResultLike }
    let published = false
    try {
      outcome = await runWithSignal(exec, (signal) =>
        subagents.start(provider, { label: `${getRoleInfo(input.role).name}·${task.taskId}`, prompt: [{ type: 'text', text }], parent: exec.agent, signal }),
      { onRun: (run) => { published = true; return deps.onChildStart?.({ agentId: run.id, task, record: running, role: input.role, signal: exec.signal, persistent: false, input, parent: exec.agent }) } })
    } catch (error) {
      if (published) return finish(session, running, { status: 'failed', summary: '已开始的原生调用未能登记，已停止并保留待核对状态；没有另启后端重放', error: getErrorText(error), backend: kind, hardIsolation: false, unresolved: ['核对已开始的原生调用可能产生的改动后再继续'], attempts: [...attempts, { route: provider, backend: kind, outcome: 'failed', reason: `registration: ${getErrorText(error)}` }] })
      // 启动失败（例如原生客户端未登录）没有消耗订阅额度：归还次数，记录失败并退回 spawn
      session.counters.native -= 1
      attempts.push({ route: provider, backend: kind, outcome: 'failed', reason: `start: ${getErrorText(error)}` })
      return undefined
    }
    const { run, result } = outcome
    const evaluation = getEvaluation(input.role, input.mode, result, ParseNativeOutput(getOutputText(result)))
    const change = getChangeInfo(input.role, before, await deps.gitStatus(cwd))
    const route: RouteInfo = { provider, model: kind.startsWith('codex') ? 'codex-native' : 'claude-native' }
    const avoid = getAvoidFamilies(input.role, input.mode, session.store.getTaskDelegations(task.taskId))
    return finish(session, running, {
      ...evaluation,
      unresolved: [...evaluation.unresolved, ...change.warnings],
      evidence: [...evaluation.evidence, ...(change.changedFiles ?? []).filter(() => isEditRole(input.role)).map((ref) => ({ kind: 'file-change' as const, ref }))],
      route,
      backend: kind,
      childId: run.id,
      hardIsolation: false,
      independence: avoid.length === 0 ? 'n/a' : avoid.includes(getModelFamily(route.model)) ? 'not-achieved' : 'achieved',
      attempts: [...attempts, { route: getRouteLabel(route), backend: kind, outcome: 'used' }],
      promptStyle,
      changeTracking: change.changeTracking,
      ...(change.changedFiles === undefined ? {} : { changedFiles: change.changedFiles })
    })
  }

  /** 重试原因；不可重试（已完成、调用方取消、模型拒绝）时为 undefined */
  const getRetryReason = (evaluation: EvaluationInfo, result: SubagentResultLike, exec: DelegateExecInfo): { reason: string; backoff: boolean } | undefined => {
    if (evaluation.status === 'completed' || exec.signal.aborted || result.stopReason === 'refusal') return undefined
    if (result.stopReason !== 'completed') return { reason: `执行中断：${evaluation.error ?? result.stopReason}`, backoff: result.stopReason === 'error' }
    return { reason: evaluation.error ?? '交付不合格', backoff: false }
  }

  const AddRetry = (session: DelegateSessionInfo, record: DelegationRecord, retries: DelegationRetryInfo[], retry: DelegationRetryInfo): void => {
    retries.push(retry)
    session.ledger.AddLedgerEvent({ type: 'delegation/retry', taskId: record.taskId, delegationId: record.delegationId, data: { ...retry } })
  }

  const getBackoffMs = (config: SwarmConfigInfo, attempt: number): number => config.agents.retryBackoffMs * 2 ** Math.max(0, attempt - 1)

  /**
   * 出错重试前的等待：可能由断网引起的失败，在确认断网后等网络恢复（最长 networkWaitMs），否则按退避时间等待
   * @param {SwarmConfigInfo} config - 配置
   * @param {number} attempt - 第几次重试
   * @param {boolean} suspectNetwork - 失败是否可能由断网引起
   * @param {AbortSignal} signal - 调用方取消信号
   * @returns 是否因断网而等待
   */
  const WaitBeforeRetry = async (config: SwarmConfigInfo, attempt: number, suspectNetwork: boolean, signal: AbortSignal): Promise<boolean> => {
    const network = deps.network
    if (network !== undefined && config.agents.networkWaitMs > 0 && suspectNetwork && !(await network.isOnline())) {
      await network.waitOnline(signal, config.agents.networkWaitMs)
      return true
    }
    await deps.sleep(getBackoffMs(config, attempt), signal)
    return false
  }

  /** 执行出错（stopReason 为 error）时连续会话拿不到诊断文本，一律先做联网探测；其余按错误文本判断 */
  const isNetworkFailure = (result: SubagentResultLike, error: string | undefined): boolean =>
    result.stopReason === 'error' || isNetworkSuspect({ message: error ?? '' })

  const getStyle = (route: RouteInfo | undefined, config: SwarmConfigInfo): PromptStyle => getPromptStyle(route, config.agents.promptStyle)

  /** 本次委派的会话安排：天枢显式指定 > 配置 > 衡鉴 > 规则 */
  const getSessionPlan = async (input: DelegateInput, task: TaskRecord, exec: DelegateExecInfo, session: DelegateSessionInfo, config: SwarmConfigInfo): Promise<SessionPlan> => {
    // 工具范围在建会话时固定：只追加到开放 web 与否一致的会话
    const thread = session.threads.getCandidates(getRouteKey(input.role, input.mode)).find((t) => t.allowWeb === (input.allow_web === true))
    if (exec.controlledThreadId !== undefined) {
      const target = session.threads.get(exec.controlledThreadId)
      if (target === undefined || target.busy || target.closed || target.key !== getRouteKey(input.role, input.mode) || target.allowWeb !== (input.allow_web === true)) throw new SwarmError('RECOVERY_REQUIRED', '所选子会话当前不能追加，不能改为另一专家会话')
      return { kind: 'continue', threadId: target.threadId, source: 'explicit', reason: '用户显式继续此持久子会话' }
    }
    const choice = input.session ?? 'auto'
    if (choice === 'oneshot') return { kind: 'oneshot', source: 'explicit', reason: '天枢指定一次性调用' }
    if (choice === 'new') return { kind: 'new', source: 'explicit', reason: '天枢指定新建连续会话' }
    if (choice === 'continue') {
      return thread !== undefined
        ? { kind: 'continue', threadId: thread.threadId, source: 'explicit', reason: '天枢指定追加到已有会话' }
        : { kind: 'new', source: 'explicit', reason: '天枢要求追加，但该角色没有空闲的会话，新建连续会话' }
    }
    if (config.agents.session === 'oneshot') return { kind: 'oneshot', source: 'config', reason: '配置为一次性调用' }
    const decided = await deps.planSession?.({ input, task, session, signal: exec.signal, ...(thread === undefined ? {} : { thread }) })
    const plan = decided ?? getRuleSessionPlan({ role: input.role, taskId: task.taskId, reason: 'Jev 未启用', ...(thread === undefined ? {} : { thread }) })
    if (config.agents.session === 'continuable' && plan.kind === 'oneshot') return { kind: 'new', source: 'config', reason: '配置为连续会话' }
    return plan
  }

  interface RunContext {
    input: DelegateInput
    task: TaskRecord
    record: DelegationRecord
    exec: DelegateExecInfo
    session: DelegateSessionInfo
    config: SwarmConfigInfo
    subagents: SubagentsLike
    usable: RouteInfo[]
    compatibleDeclared: RouteInfo[]
    requireVision: boolean
    toolFilter: { allow?: string[]; deny?: string[] } | undefined
    images: ContentBlockLike[]
    attempts: RouteAttempt[]
    onFallback: (event: FallbackEventInfo) => void
    retries: DelegationRetryInfo[]
  }

  /** 一次性调用（宿主强制结构化提交）；未执行、中断或交付不合格时重新启动，最多 maxRetries 次 */
  const runOneShot = async (ctx: RunContext, plan: SessionPlan): Promise<RunOutcomeInfo> => {
    const { input, task, record, exec, session, config, subagents, usable, compatibleDeclared, requireVision, toolFilter, images, attempts, onFallback, retries } = ctx
    const role = getRoleInfo(input.role)
    const session_: DelegationSessionInfo = { kind: 'oneshot', appended: false, source: plan.source, reason: plan.reason }
    let last: RunOutcomeInfo | undefined
    for (let attempt = 0; ; attempt++) {
      const retryNote = attempt === 0 ? '' : `\n\n（第 ${attempt} 次重试：上一次${retries.at(-1)?.reason ?? '未完成'}。请完整完成任务，并按交付要求提交。）`
      let usedIndex = -1
      let usedStyle: PromptStyle | undefined
      const startSpawn = async (signal: AbortSignal): Promise<SubagentRunLike> => {
        for (const [index, route] of usable.entries()) {
          // 任务说明与 persona 按这一层路由的模型家族组织
          const style = getStyle(route, config)
          try {
            const run = await subagents.start(SPAWN_PROVIDER, {
              label: `${role.name}·${task.taskId}`,
              prompt: [{ type: 'text', text: getChildPromptText(task, input, record.delegationId, style) + retryNote }, ...images],
              parent: exec.agent,
              signal,
              agentOptions: route,
              outputSchema: getOutputSchema(input.role),
              maxDepth: 1,
              ...(toolFilter === undefined ? {} : { toolFilter }),
              persona: getChildPersona(input.role, input.mode, style)
            })
            usedIndex = index
            usedStyle = style
            return run
          } catch (error) {
            attempts.push({ route: getRouteLabel(route), backend: 'spawn', outcome: 'failed', reason: `start: ${getErrorText(error)}` })
          }
        }
        throw new SwarmError('SERVICE_UNAVAILABLE', '所有可用路由都无法启动子智能体')
      }
      let finalRoute: RouteInfo | undefined
      let outcome: { run: SubagentRunLike; result: SubagentResultLike } | undefined
      let startError: string | undefined
      try {
        outcome = await runWithSignal(exec, startSpawn, {
          onRun: async (run) => {
            deps.routeState.AddChild(run.id, { chain: compatibleDeclared, initialRoute: usable[usedIndex], respectStoredOverride: false, requireVision, role: input.role, onFallback, logicalRequestId: record.delegationId })
            await deps.onChildStart?.({ agentId: run.id, task, record, role: input.role, signal: exec.signal, persistent: false, input, parent: exec.agent })
          },
          beforeDispose: (run) => {
            finalRoute = deps.routeState.getLastRoute(run.id) ?? deps.routeState.getChild(run.id)?.route
            deps.routeState.DelAgent(run.id)
          }
        })
      } catch (error) {
        startError = getErrorText(error)
      }
      const result: SubagentResultLike = outcome?.result ?? { output: [], stopReason: 'error', diagnostic: `未能启动：${startError ?? 'unknown'}` }
      const evaluation = getEvaluation(input.role, input.mode, result, result.structured)
      last = {
        evaluation, childId: outcome?.run.id ?? '', ...(finalRoute ?? usable[usedIndex] ? { finalRoute: finalRoute ?? usable[usedIndex] } : {}), retries, session: session_,
        ...(usedStyle === undefined ? {} : { promptStyle: usedStyle })
      }
      const retry = getRetryReason(evaluation, result, exec)
      if (deps.routeState.getTerminal(outcome?.run.id ?? '') !== undefined || retry === undefined || attempt >= config.agents.maxRetries) return last
      AddRetry(session, record, retries, { attempt: attempt + 1, reason: retry.reason, action: 'restart' })
      if (retry.backoff) await WaitBeforeRetry(config, attempt + 1, isNetworkFailure(result, evaluation.error ?? startError), exec.signal)
      if (exec.signal.aborted) return last
    }
  }

  /**
   * 连续会话的一轮：新建或追加到已有会话，等待该轮沉寂并解析 json 结果；
   * 中断则在同一会话续跑，交付不合格则只要求修正，最多 maxRetries 次。
   * 会话无法建立或无法投递时返回 undefined，由调用方退回一次性调用。
   */
  const runThread = async (ctx: RunContext, plan: Exclude<SessionPlan, { kind: 'oneshot' }>): Promise<RunOutcomeInfo | undefined> => {
    const { input, task, record, exec, session, config, subagents, usable, compatibleDeclared, requireVision, toolFilter, images, attempts, onFallback, retries } = ctx
    // 宿主方法依赖 this（SubagentRuntime 实例），必须以 subagents.xxx(...) 调用，不能解构
    if (subagents.startContinuable === undefined || subagents.sendMessage === undefined) return undefined
    const role = getRoleInfo(input.role)
    const key = getRouteKey(input.role, input.mode)
    let appended = plan.kind === 'continue'
    let thread = appended ? session.threads.get((plan as { threadId: string }).threadId) : undefined
    // 衡鉴判断期间可能被并行委派占用：已忙或已关闭就新建
    if (thread !== undefined && (thread.busy || thread.closed || thread.allowWeb !== (input.allow_web === true))) {
      if (exec.controlledThreadId !== undefined) throw new SwarmError('RECOVERY_REQUIRED', '所选子会话已被占用或关闭，不能另建会话重放')
      thread = undefined
      appended = false
    }
    let threadId = thread?.threadId ?? deps.newChildId()
    // 新会话按首选路由的模型家族定风格；追加沿用会话建立时的风格，与其 persona 一致
    const newStyle = getStyle(usable[0], config)
    if (thread !== undefined) session.threads.Update(threadId, { busy: true })
    else {
      thread = { threadId, key, role: input.role, ...(input.mode === undefined ? {} : { mode: input.mode }), rounds: 0, busy: true, closed: false, allowWeb: input.allow_web === true, style: newStyle, taskIds: [], history: [], createdAt: deps.now(), lastUsedAt: deps.now() }
      session.threads.Add(thread)
    }
    let style: PromptStyle = thread.style ?? newStyle
    const Arm = (id: string): void => deps.routeState.AddChild(id, { chain: compatibleDeclared, initialRoute: usable[0], respectStoredOverride: false, requireVision, role: input.role, onFallback, persistent: true, logicalRequestId: record.delegationId })
    Arm(threadId)
    await deps.onChildStart?.({ agentId: threadId, task, record, role: input.role, signal: exec.signal, persistent: true, input, parent: exec.agent })
    const seen = thread.seenRevisions?.[task.taskId]
    const knowsRevision = thread.taskIds.includes(task.taskId) && (seen === undefined
      ? (task.cardRevision ?? 1) === 1 && (task.workflowRevision ?? 1) === 1 && (task.requestRevision ?? 1) === 1
      : seen.cardRevision === (task.cardRevision ?? 1) && seen.workflowRevision === (task.workflowRevision ?? 1) && (seen.requestRevision ?? 1) === (task.requestRevision ?? 1))
    let text = appended ? getThreadFollowupText(task, input, record.delegationId, knowsRevision, style) : getThreadPromptText(task, input, record.delegationId, style)
    let content: ContentBlockLike[] = [{ type: 'text', text }, ...images]
    let started = appended
    let evaluation: EvaluationInfo | undefined
    for (let attempt = 0; ; attempt++) {
      const waitAbort = new AbortController()
      const onAbort = (): void => waitAbort.abort()
      exec.signal.addEventListener('abort', onAbort, { once: true })
      if (exec.signal.aborted) waitAbort.abort()
      const ended = deps.hub.wait(threadId, waitAbort.signal)
      ended.catch(() => undefined)
      try {
        if (started) await subagents.sendMessage(exec.agent, threadId, content, { signal: exec.signal })
        else {
          await subagents.startContinuable({
            provider: SPAWN_PROVIDER,
            label: `${role.name}·${task.taskId}`,
            childId: threadId,
            signal: exec.signal,
            request: {
              prompt: content,
              parent: exec.agent,
              agentOptions: usable[0] as RouteInfo,
              maxDepth: 1,
              ...(toolFilter === undefined ? {} : { toolFilter }),
              persona: getChildPersona(input.role, input.mode, style)
            }
          })
          started = true
        }
      } catch (error) {
        waitAbort.abort()
        exec.signal.removeEventListener('abort', onAbort)
        const reason = getErrorText(error)
        if (exec.controlledThreadId !== undefined) {
          session.threads.Update(threadId, { busy: false })
          await deps.onChildEnd?.(threadId, 'not-admitted')
          return { evaluation: { status: 'failed', summary: '指定持久子会话未接受继续请求', error: reason, unresolved: ['未创建替代会话或重放旧操作'], evidence: [] }, childId: threadId, retries, session: { kind: 'continuable', threadId, appended: true, source: plan.source, reason: plan.reason } }
        }
        attempts.push({ route: getRouteLabel(usable[0] as RouteInfo), backend: 'spawn', outcome: 'failed', reason: `${started ? 'send' : 'start'}: ${reason}` })
        session.threads.Update(threadId, { busy: false, closed: true })
        deps.routeState.DelAgent(threadId)
        if (exec.signal.aborted) {
          return { evaluation: { status: 'failed', summary: '调用方已取消委派', unresolved: [], evidence: [], error: 'aborted' }, childId: threadId, retries, session: { kind: 'continuable', threadId, appended, source: plan.source, reason: plan.reason } }
        }
        if (attempt >= config.agents.maxRetries) return undefined
        // 会话无法建立或投递：换一个新的连续会话重来
        AddRetry(session, record, retries, { attempt: attempt + 1, reason: `连续会话${started ? '投递' : '建立'}失败：${reason}`, action: 'restart' })
        await WaitBeforeRetry(config, attempt + 1, isNetworkSuspect({ message: reason }), exec.signal)
        threadId = deps.newChildId()
        style = newStyle
        thread = { threadId, key, role: input.role, ...(input.mode === undefined ? {} : { mode: input.mode }), rounds: 0, busy: true, closed: false, allowWeb: input.allow_web === true, style, taskIds: [], history: [], createdAt: deps.now(), lastUsedAt: deps.now() }
        session.threads.Add(thread)
        Arm(threadId)
        appended = false
        started = false
        text = getThreadPromptText(task, input, record.delegationId, style)
        content = [{ type: 'text', text }, ...images]
        continue
      }
      let info: SubagentEndInfoLike
      try {
        info = await ended
      } catch {
        // 天枢（或用户）取消：中止该会话当前这一轮，会话保留，之后仍可追加。
        // 被中止的一轮仍会向天枢投递「子智能体已结束」通知；标记为已取走，避免停止后天枢被它再次唤醒
        subagents.interrupt?.(threadId, { kind: 'ancestor', agent: exec.agent })
        deps.hub.MarkConsumed(threadId)
        session.threads.Update(threadId, { busy: false })
        return { evaluation: { status: 'failed', summary: '调用方已取消委派', unresolved: [], evidence: [], error: 'aborted' }, childId: threadId, retries, session: { kind: 'continuable', threadId, appended, source: plan.source, reason: plan.reason } }
      } finally {
        exec.signal.removeEventListener('abort', onAbort)
      }
      deps.hub.MarkConsumed(threadId)
      const result: SubagentResultLike = { output: [...(info.lastAssistantMessage ?? [])], stopReason: info.stopReason }
      const structured = ParseNativeOutput(getOutputText(result))
      evaluation = getEvaluation(input.role, input.mode, result, structured)
      if (deps.routeState.isManualPaused(threadId)) {
        if (evaluation.status !== 'completed') evaluation = ['aborted', 'cancelled', 'interrupted'].includes(result.stopReason)
          ? { ...evaluation, status: 'failed', summary: '子会话已人工暂停，等待确认副作用后安全继续', error: 'manual-intervention', unresolved: [...evaluation.unresolved, '人工取消后的副作用与任务进度需要核对；本轮未自动重放'] }
          : { ...evaluation, status: 'failed', summary: '子会话执行失败，已暂停等待恢复', error: deps.routeState.getTerminal(threadId) ?? evaluation.error ?? 'request-failed-paused', unresolved: [...evaluation.unresolved, '需依据实际错误恢复当前任务，未自动重放旧操作'] }
        break
      }
      const retry = getRetryReason(evaluation, result, exec)
      if (deps.routeState.getTerminal(threadId) !== undefined || retry === undefined || attempt >= config.agents.maxRetries) break
      AddRetry(session, record, retries, { attempt: attempt + 1, reason: retry.reason, action: 'continue' })
      if (retry.backoff) {
        await WaitBeforeRetry(config, attempt + 1, isNetworkFailure(result, evaluation.error), exec.signal)
        // 出错多半是整条路由链暂时不可用：从主模型重新开始
        Arm(threadId)
      }
      content = [{ type: 'text', text: getThreadRetryText(input.role, { stopReason: result.stopReason, missing: structured === undefined, ...(evaluation.error === undefined ? {} : { error: evaluation.error }) }) }]
    }
    const finalRoute = deps.routeState.getLastRoute(threadId) ?? deps.routeState.getChild(threadId)?.route
    const updated = session.threads.AddRound(threadId, { delegationId: record.delegationId, taskId: task.taskId, request: input.prompt, summary: evaluation.summary, status: evaluation.status }, deps.now())
    session.threads.Update(threadId, { seenRevisions: { ...updated?.seenRevisions, [task.taskId]: { cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1, requestRevision: task.requestRevision ?? 1 } } })
    await deps.onChildEnd?.(threadId)
    return {
      evaluation,
      childId: threadId,
      ...(finalRoute === undefined ? {} : { finalRoute }),
      retries,
      session: { kind: 'continuable', threadId, round: updated?.rounds ?? 1, appended, source: plan.source, reason: plan.reason },
      promptStyle: style
    }
  }

  const runSpawn = async (
    input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo,
    session: DelegateSessionInfo, config: SwarmConfigInfo, subagents: SubagentsLike, existing: DelegationRecord[], attempts: RouteAttempt[]
  ): Promise<DelegationRecord> => {
    const role = getRoleInfo(input.role)
    const roleRoute = getRoleRoute(config, getRouteKey(input.role, input.mode))
    const reasons = getUpgradeReasons(roleRoute.upgrade, { task, delegations: existing, explicit: input.upgrade === true, role: input.role, ...(input.mode === undefined ? {} : { mode: input.mode }) })
    if (input.upgrade === true && roleRoute.upgrade === undefined) {
      attempts.push({ route: 'upgrade', backend: 'spawn', outcome: 'skipped', reason: `「${role.name}」未配置或已停用容灾升级，按常规路由执行` })
    }
    const upgrade = reasons.length > 0 && roleRoute.upgrade !== undefined
      ? { reasons, chain: roleRoute.upgrade.chain.map(getRouteLabel) }
      : undefined
    if (upgrade !== undefined) {
      session.store.UpdateDelegation(record.delegationId, { upgrade })
      session.ledger.AddLedgerEvent({ type: 'route/upgrade', taskId: task.taskId, delegationId: record.delegationId, data: upgrade })
    }
    const baseChain = upgrade !== undefined && roleRoute.upgrade !== undefined ? getUpgradedChain(roleRoute.upgrade.chain, roleRoute.chain) : roleRoute.chain
    const retries: DelegationRetryInfo[] = []
    // Persistent user selection can be the only available route, so determine its
    // actual target before probing the role's original chain.
    const plan = await getSessionPlan(input, task, exec, session, config)
    const manual = plan.kind === 'continue' ? deps.routeState.getChildOverride(plan.threadId) : undefined
    const declared = manual === undefined ? undefined : baseChain.find((item) => item.provider === manual.provider && item.model === manual.model)
    const chain = manual === undefined ? baseChain : [{ ...manual, ...(declared?.policy === undefined ? {} : { policy: declared.policy }) }, ...baseChain.filter((item) => item.provider !== manual.provider || item.model !== manual.model)]
    const requireVision = role.needsVision || (input.image_paths?.length ?? 0) > 0
    const getSelection = () => FindUsableRoutes(chain, {
      probe: plan.kind === 'continue' && deps.probeForChild !== undefined ? (route) => deps.probeForChild!(plan.threadId, route) : deps.probe,
      requireVision,
      avoidFamilies: getAvoidFamilies(input.role, input.mode, existing)
    })
    let selection = await getSelection()
    // 没有可用路由可能是暂时的（网络或宿主刚启动）：等待后重新检查；视觉能力不足不会因重试改变
    for (let attempt = 1; selection.usable.length === 0 && attempt <= config.agents.maxRetries && !exec.signal.aborted
      && !selection.skipped.every((item) => item.reason === 'route-isolated'); attempt++) {
      if (requireVision && selection.skipped.some((s) => s.reason === 'vision-unsupported')) break
      AddRetry(session, record, retries, { attempt, reason: 'no-usable-route：路由链上暂时没有可用模型', action: 'restart' })
      // 订阅类 provider 解析模型要联网：断网时整条链都会预检失败
      await WaitBeforeRetry(config, attempt, true, exec.signal)
      selection = await getSelection()
    }
    for (const skipped of selection.skipped) {
      attempts.push({ route: getRouteLabel(skipped.route), backend: 'spawn', outcome: 'skipped', reason: skipped.reason })
      session.ledger.AddLedgerEvent({ type: 'route/skipped', taskId: task.taskId, delegationId: record.delegationId, data: { route: getRouteLabel(skipped.route), reason: skipped.reason } })
    }
    if (selection.usable.length === 0) {
      const visionOnly = requireVision && selection.skipped.some((s) => s.reason === 'vision-unsupported')
      const reason = visionOnly ? 'vision-unsupported：路由链上没有支持图片输入的可用模型，不会降级为纯文本推断' : 'no-usable-route：路由链上没有可用的 provider/模型，请检查 Models 配置'
      return finish(session, record, { status: 'blocked', summary: reason, error: reason, attempts: [...record.attempts, ...attempts], ...(retries.length > 0 ? { retries } : {}) })
    }
    const tools = deps.getTools()
    if (tools === undefined) return block(session, record, '工具服务不可用，无法限制子智能体权限', attempts)
    const toolFilter = getToolFilter(input.role, tools.schemas(exec.agent).map((schema) => schema.name), input.allow_web === true)
    let images: ContentBlockLike[] = []
    if (input.image_paths !== undefined) {
      const check = ValidateImagePaths(input.image_paths, getWorkspaceRoot(exec.agent))
      if (!check.ok) return block(session, record, check.errors.join('；'), attempts)
      try {
        images = await getImageBlocks(check.resolved, { readFile: deps.readFile, ...(deps.getAttachments() === undefined ? {} : { attachments: deps.getAttachments() }) })
      } catch (error) {
        return block(session, record, `图片入库失败：${getErrorText(error)}`, attempts)
      }
    }
    const running = markRunning(session, record, 'spawn')
    const cwd = getWorkspaceRoot(exec.agent)
    const before = await deps.gitStatus(cwd)
    const fallbacks: RouteAttempt[] = []
    const onFallback = (event: FallbackEventInfo): void => {
      fallbacks.push({ route: getRouteLabel(event.from), backend: 'spawn', outcome: 'fallback', reason: `${event.failure.code ?? event.failure.status ?? 'error'} → ${getRouteLabel(event.to)}` })
      session.ledger.AddLedgerEvent({ type: 'route/fallback', taskId: task.taskId, delegationId: record.delegationId, data: { from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
    }
    session.ledger.AddLedgerEvent({ type: 'session/plan', taskId: task.taskId, delegationId: record.delegationId, data: { ...plan } })
    const avoid = getAvoidFamilies(input.role, input.mode, existing)
    const permanentlySkipped = new Set(selection.skipped.filter((item) => ['vision-unsupported', 'same-family'].includes(item.reason) || item.reason.startsWith('capability-incompatible:') || /unsupported.?reasoning|unsupported.?effort|UNSUPPORTED_REASONING_EFFORT/.test(item.reason)).map((item) => item.route))
    const compatibleDeclared = chain.filter((route) => !permanentlySkipped.has(route) && (selection.independence !== 'achieved' || !avoid.includes(getModelFamily(route.model))))
    const ctx: RunContext = { input, task, record, exec, session, config, subagents, usable: selection.usable, compatibleDeclared, requireVision, toolFilter, images, attempts, onFallback, retries }
    const supportsThreads = subagents.startContinuable !== undefined && subagents.sendMessage !== undefined
    let outcome = plan.kind === 'oneshot' || !supportsThreads ? undefined : await runThread(ctx, plan)
    if (outcome === undefined) {
      if (plan.kind !== 'oneshot' && supportsThreads) AddRetry(session, record, retries, { attempt: retries.length + 1, reason: '连续会话多次无法建立或投递', action: 'fallback' })
      const reason = plan.kind === 'oneshot' ? plan.reason
        : supportsThreads ? `${plan.reason}；连续会话无法建立，改为一次性调用` : `${plan.reason}；宿主不支持连续会话（需要 DSH 0.1.7-rc.2 及以上），改为一次性调用`
      outcome = await runOneShot(ctx, { kind: 'oneshot', source: plan.source, reason })
    }
    const { evaluation, finalRoute } = outcome
    const change = getChangeInfo(input.role, before, await deps.gitStatus(cwd))
    const used: RouteAttempt[] = finalRoute === undefined ? [] : [{ route: getRouteLabel(finalRoute), backend: 'spawn', outcome: 'used' }]
    return finish(session, running, {
      ...evaluation,
      unresolved: [...evaluation.unresolved, ...change.warnings],
      evidence: [...evaluation.evidence, ...(isEditRole(input.role) ? (change.changedFiles ?? []).map((ref) => ({ kind: 'file-change' as const, ref })) : [])],
      ...(finalRoute === undefined ? {} : { route: finalRoute }),
      backend: 'spawn',
      ...(outcome.childId === '' ? {} : { childId: outcome.childId }),
      independence: selection.independence,
      attempts: [...attempts, ...fallbacks, ...used],
      session: outcome.session,
      ...(outcome.retries.length > 0 ? { retries: outcome.retries } : {}),
      ...(outcome.promptStyle === undefined ? {} : { promptStyle: outcome.promptStyle }),
      changeTracking: change.changeTracking,
      ...(change.changedFiles === undefined ? {} : { changedFiles: change.changedFiles })
    })
  }

  const execute = async (input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo, session: DelegateSessionInfo): Promise<DelegationRecord> => {
    // 可能刚等完编辑锁：调用方已取消就不再启动；委派列表也在等待期间变化过，重新读取
    if (exec.signal.aborted) return finish(session, record, { status: 'failed', summary: '调用方已取消委派', error: 'aborted' })
    const existing = session.store.getTaskDelegations(task.taskId).filter((d) => d.delegationId !== record.delegationId)
    const config = deps.getConfig()
    const subagents = deps.getSubagents()
    if (subagents === undefined) return block(session, record, '子智能体服务不可用')
    const attempts: RouteAttempt[] = []
    const choice = getNativeChoice(input, task, config)
    if (choice !== undefined) {
      const native = await tryNative(input, task, record, exec, session, config, subagents, choice, attempts)
      if (native !== undefined) return native
    }
    return runSpawn(input, task, record, exec, session, config, subagents, existing, attempts)
  }

  const delegate = async (raw: unknown, exec: DelegateExecInfo, session: DelegateSessionInfo): Promise<DelegationRecord> => {
    const { input, errors } = ValidateDelegateInput(raw)
    if (input === undefined) throw new SwarmError('INVALID_ARGS', errors.join('；'))
    const task = session.store.getTask(input.task_id)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${input.task_id}，请先调用 swarm_task_card`)
    const role = getRoleInfo(input.role)
    const mode = input.role === 'suan_heng' ? (input.mode ?? 'research') : undefined
    const normalized: DelegateInput = mode === undefined ? input : { ...input, mode }
    const existing = session.store.getTaskDelegations(task.taskId)
    const record: DelegationRecord = {
      delegationId: deps.newId('D'), taskId: task.taskId, role: input.role, roleName: role.name,
      ...(mode === undefined ? {} : { mode }), ...(input.gate === undefined ? {} : { gate: input.gate }),
      status: 'queued', summary: '', evidence: [], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: deps.now(),
      cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1, requestRevision: task.requestRevision ?? 1,
      ...(input.attempt_id === undefined ? {} : { attemptId: input.attempt_id }),
      ...(input.review_phase === undefined ? {} : { reviewPhase: input.review_phase }),
      ...(input.node_id === undefined ? {} : { nodeId: input.node_id })
    }
    session.store.AddDelegation(record)
    session.ledger.AddLedgerEvent({ type: 'delegation/queued', taskId: task.taskId, delegationId: record.delegationId, data: { role: input.role, roleName: role.name, mode, gate: input.gate, backend: input.backend ?? 'auto' } })
    const budgetReason = ValidateDelegationBudget(existing, input.role, deps.getConfig().budgets)
    if (budgetReason !== undefined) return block(session, record, budgetReason)
    // 兜底：任何意外异常都把仍在 queued/running 的记录收尾为 failed，避免任务永远无法验收
    const run = async (): Promise<DelegationRecord> => {
      try {
        return await execute(normalized, task, record, exec, session)
      } catch (error) {
        const current = session.store.getDelegation(record.delegationId) ?? record
        if (current.status !== 'queued' && current.status !== 'running') throw error
        return finish(session, current, { status: 'failed', summary: `委派异常中止：${getErrorText(error)}`, error: getErrorText(error) })
      }
    }
    return role.concurrencySafe ? run() : session.editLock.run(run)
  }

  return { delegate }
}
