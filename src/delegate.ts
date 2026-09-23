import { getRoleRoute, type SwarmConfigInfo } from './config.js'
import { ValidateStructuredOutput, getEvidenceFromOutput, getOutputSchema, type EvidenceItem } from './contracts.js'
import type { BackendKind, DelegationRecord, Ledger, RouteAttempt, TaskRecord, TaskStore } from './evidence.js'
import {
  SPAWN_PROVIDER,
  STRUCTURED_OUTPUT_TOOL,
  getAgentHeader,
  type AgentLike,
  type AttachmentsLike,
  type ContentBlockLike,
  type SubagentResultLike,
  type SubagentRunLike,
  type SubagentsLike,
  type ToolsLike
} from './host-contract.js'
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
import { SwarmError, getErrorText } from './util/errors.js'
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
    `任务 ${task.taskId} / 委派 ${delegationId}`,
    `任务标题：${card.title}`,
    `目标：${card.goal}`,
    `验收标准：\n${card.acceptance.map((item) => `- ${item}`).join('\n')}`,
    `范围：${card.scope.length > 0 ? card.scope.join('、') : '未指定'}`,
    ...(constraints.length > 0 ? [`约束：${constraints.join('；')}`] : []),
    ...(perf.length > 0 ? [`性能预算：${perf.join('；')}`] : []),
    ...(input.gate === undefined ? [] : [`本次委派用于满足门禁：${input.gate}（${GATE_ROLE[input.gate].label}）`]),
    ...((input.context_paths ?? []).length > 0 ? [`相关文件：\n${(input.context_paths ?? []).map((path) => `- ${path}`).join('\n')}`] : [])
  ].join('\n')
}

export const getChildPromptText = (task: TaskRecord, input: DelegateInput, delegationId: string): string =>
  [
    getTaskBrief(task, input, delegationId),
    '—— 本次任务 ——',
    input.prompt,
    '—— 交付 ——',
    `完成后调用 ${STRUCTURED_OUTPUT_TOOL} 提交结果（${getRoleInfo(input.role).deliverables.join('、')}）。`
  ].join('\n\n')

export const getNativePromptText = (task: TaskRecord, input: DelegateInput, delegationId: string, mode?: SuanHengMode): string =>
  [
    getChildPersona(input.role, mode),
    getTaskBrief(task, input, delegationId),
    '—— 本次任务 ——',
    input.prompt,
    '—— 交付 ——',
    '最后以一个 ```json 代码块输出结果，字段必须符合以下 JSON Schema（不要输出其他 json 代码块）：',
    JSON.stringify(getOutputSchema(input.role))
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
}

export interface DelegateExecInfo {
  agent: AgentLike
  signal: AbortSignal
}

/** 委派执行依赖（全部可替换，便于测试） */
export interface DelegateDepsInfo {
  getConfig: () => SwarmConfigInfo
  getSubagents: () => SubagentsLike | undefined
  getTools: () => ToolsLike | undefined
  getAttachments: () => AttachmentsLike | undefined
  probe: RouteProbe
  routeState: RouteStateRegistry
  readFile: (path: string) => Promise<Uint8Array>
  gitStatus: (cwd: string) => Promise<GitStatusInfo | undefined>
  now: () => number
  newId: (prefix: string) => string
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
    return { status: 'failed', summary: text || '子智能体未完成', unresolved: [], evidence: [], error: `${result.stopReason}${result.diagnostic === undefined ? '' : `：${result.diagnostic}`}` }
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
   * 带超时与调用方取消的运行：超时或取消都会中止子智能体
   * beforeDispose 在释放子智能体之前调用：宿主在释放时触发 agent/disposed，运行时行会随即清理该子智能体的路由状态
   */
  const runWithSignal = async (
    exec: DelegateExecInfo,
    config: SwarmConfigInfo,
    start: (signal: AbortSignal) => Promise<SubagentRunLike>,
    hooks: { onRun?: (run: SubagentRunLike) => void; beforeDispose?: (run: SubagentRunLike) => void } = {}
  ) => {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    exec.signal.addEventListener('abort', onAbort, { once: true })
    // 已经取消的信号不会再触发 abort 事件，必须主动检查
    if (exec.signal.aborted) controller.abort()
    const timer = setTimeout(() => controller.abort(), config.budgets.delegationTimeoutMs)
    try {
      const run = await start(controller.signal)
      hooks.onRun?.(run)
      try {
        return { run, result: await run.result }
      } catch (error) {
        return { run, result: { output: [], stopReason: 'error', diagnostic: getErrorText(error) } as SubagentResultLike }
      } finally {
        hooks.beforeDispose?.(run)
        await run.dispose().catch(() => undefined)
      }
    } finally {
      clearTimeout(timer)
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
    const text = getNativePromptText(task, input, record.delegationId, input.mode)
    let outcome: { run: SubagentRunLike; result: SubagentResultLike }
    try {
      outcome = await runWithSignal(exec, config, (signal) =>
        subagents.start(provider, { label: `${getRoleInfo(input.role).name}·${task.taskId}`, prompt: [{ type: 'text', text }], parent: exec.agent, signal }))
    } catch (error) {
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
      changeTracking: change.changeTracking,
      ...(change.changedFiles === undefined ? {} : { changedFiles: change.changedFiles })
    })
  }

  const runSpawn = async (
    input: DelegateInput, task: TaskRecord, record: DelegationRecord, exec: DelegateExecInfo,
    session: DelegateSessionInfo, config: SwarmConfigInfo, subagents: SubagentsLike, existing: DelegationRecord[], attempts: RouteAttempt[]
  ): Promise<DelegationRecord> => {
    const role = getRoleInfo(input.role)
    const selection = await FindUsableRoutes(getRoleRoute(config, getRouteKey(input.role, input.mode)).chain, {
      probe: deps.probe,
      requireVision: role.needsVision,
      avoidFamilies: getAvoidFamilies(input.role, input.mode, existing)
    })
    for (const skipped of selection.skipped) {
      attempts.push({ route: getRouteLabel(skipped.route), backend: 'spawn', outcome: 'skipped', reason: skipped.reason })
      session.ledger.AddLedgerEvent({ type: 'route/skipped', taskId: task.taskId, delegationId: record.delegationId, data: { route: getRouteLabel(skipped.route), reason: skipped.reason } })
    }
    if (selection.usable.length === 0) {
      const visionOnly = role.needsVision && selection.skipped.some((s) => s.reason === 'vision-unsupported')
      const reason = visionOnly ? 'vision-unsupported：路由链上没有支持图片输入的可用模型，不会降级为纯文本推断' : 'no-usable-route：路由链上没有可用的 provider/模型，请检查 Models 配置'
      return block(session, record, reason, attempts)
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
    const text = getChildPromptText(task, input, record.delegationId)
    const fallbacks: RouteAttempt[] = []
    const onFallback = (event: FallbackEventInfo): void => {
      fallbacks.push({ route: getRouteLabel(event.from), backend: 'spawn', outcome: 'fallback', reason: `${event.failure.code ?? event.failure.status ?? 'error'} → ${getRouteLabel(event.to)}` })
      session.ledger.AddLedgerEvent({ type: 'route/fallback', taskId: task.taskId, delegationId: record.delegationId, data: { from: getRouteLabel(event.from), to: getRouteLabel(event.to), failure: event.failure } })
    }
    let usedIndex = -1
    const startSpawn = async (signal: AbortSignal): Promise<SubagentRunLike> => {
      for (const [index, route] of selection.usable.entries()) {
        try {
          const run = await subagents.start(SPAWN_PROVIDER, {
            label: `${role.name}·${task.taskId}`,
            prompt: [{ type: 'text', text }, ...images],
            parent: exec.agent,
            signal,
            agentOptions: route,
            outputSchema: getOutputSchema(input.role),
            maxDepth: 1,
            ...(toolFilter === undefined ? {} : { toolFilter }),
            persona: getChildPersona(input.role, input.mode)
          })
          usedIndex = index
          return run
        } catch (error) {
          attempts.push({ route: getRouteLabel(route), backend: 'spawn', outcome: 'failed', reason: `start: ${getErrorText(error)}` })
        }
      }
      throw new SwarmError('SERVICE_UNAVAILABLE', '所有可用路由都无法启动子智能体')
    }
    let finalRoute: RouteInfo | undefined
    let outcome: { run: SubagentRunLike; result: SubagentResultLike }
    try {
      outcome = await runWithSignal(exec, config, startSpawn, {
        onRun: (run) => deps.routeState.AddChild(run.id, { chain: selection.usable.slice(usedIndex), role: input.role, onFallback }),
        beforeDispose: (run) => {
          finalRoute = deps.routeState.getChild(run.id)?.route
          deps.routeState.DelAgent(run.id)
        }
      })
    } catch (error) {
      return finish(session, running, { status: 'failed', summary: getErrorText(error), error: getErrorText(error), attempts })
    }
    finalRoute = finalRoute ?? selection.usable[usedIndex]
    const evaluation = getEvaluation(input.role, input.mode, outcome.result, outcome.result.structured)
    const change = getChangeInfo(input.role, before, await deps.gitStatus(cwd))
    const used: RouteAttempt[] = finalRoute === undefined ? [] : [{ route: getRouteLabel(finalRoute), backend: 'spawn', outcome: 'used' }]
    return finish(session, running, {
      ...evaluation,
      unresolved: [...evaluation.unresolved, ...change.warnings],
      evidence: [...evaluation.evidence, ...(isEditRole(input.role) ? (change.changedFiles ?? []).map((ref) => ({ kind: 'file-change' as const, ref })) : [])],
      ...(finalRoute === undefined ? {} : { route: finalRoute }),
      backend: 'spawn',
      childId: outcome.run.id,
      independence: selection.independence,
      attempts: [...attempts, ...fallbacks, ...used],
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
      status: 'queued', summary: '', evidence: [], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: deps.now()
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
