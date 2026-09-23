import { DELEGATE_BACKENDS } from './delegate.js'
import type { DelegationRecord } from './evidence.js'
import { SWARM_SERVICE, type PluginContextLike, type ToolsLike } from './host-contract.js'
import { FLAG_KEYS, GATE_IDS, type FlagKey } from './policy.js'
import { getDelegableRoleIds, getRoleCatalogText, getRoleInfo, isDelegableRoleId } from './role-registry.js'
import { getRouteLabel } from './routes.js'
import type { AcceptResultInfo, SwarmService } from './service.js'
import { getToolDefinition, type ToolDefinitionLike, type ToolExecLike } from './tool-shape.js'
import { SwarmError } from './util/errors.js'
import type { JsonSchemaObject } from './util/json-schema.js'

/** 预设行：只挂在天枢预设上，注册 4 个模型工具 */
export const name = 'dsh-agent-swarm-tools'
export const inject = [SWARM_SERVICE, 'tools']

const FLAG_DESCRIPTIONS: Readonly<Record<FlagKey, string>> = {
  changesCode: '会修改代码',
  changesAlgorithm: '改变算法语义',
  touchesFinancialLogic: '涉及资金、交易委托或策略逻辑',
  timeSeriesOrBacktest: '涉及时间序列未来信息或回测',
  stateMachine: '涉及状态机',
  numericPrecision: '涉及数值精度',
  sharedStateConcurrency: '涉及共享状态并发',
  crossModuleArchitecture: '跨模块架构或数据流',
  securitySensitive: '涉及安全、认证或密钥',
  hasVisualInput: '有截图、设计稿、图表或视觉回归产物',
  uiCopy: '涉及界面文案、命名或说明',
  hasExecSteps: '有明确的命令、构建或迁移执行步骤',
  needsExternalFacts: '需要外部最新资料、RFC 或论文',
  ambiguousRequirements: '需求模糊或多目标'
}

const MAX_RENDER = 7000
const DELEGATE_TIMEOUT_MS = 2 * 60 * 60 * 1000

const clip = (text: string, max = MAX_RENDER): string =>
  text.length > max ? `${text.slice(0, max)}\n…（已截断，完整内容见 swarm_status verbose 或账本）` : text

const strList = (description: string): JsonSchemaObject => ({ type: 'array', items: { type: 'string' }, description })

const getExec = (exec: ToolExecLike) => {
  if (exec.agent === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '工具调用缺少会话上下文')
  return { agent: exec.agent, signal: exec.signal }
}

export const TASK_CARD_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: '更新已有任务时传入；新任务不传' },
    title: { type: 'string', description: '任务标题' },
    goal: { type: 'string', description: '目标与期望结果' },
    acceptance: strList('可核对的验收标准（至少 1 条）'),
    scope: strList('涉及的文件或模块路径；未知可留空'),
    constraints: {
      type: 'object',
      properties: {
        apiCompat: { type: 'string', description: 'API 兼容要求' },
        environment: { type: 'string', description: '关键运行环境' },
        resourceLimits: { type: 'string', description: 'CPU/内存/I/O 上限' }
      },
      additionalProperties: false
    },
    perf: {
      type: 'object',
      description: '性能预算；未知参数写「待测」，不要编造',
      properties: {
        p95Ms: { description: 'p95 延迟（毫秒数字）或「待测」' },
        p99Ms: { description: 'p99 延迟（毫秒数字）或「待测」' },
        throughput: { type: 'string', description: '吞吐要求' },
        dataScale: { type: 'string', description: '数据规模' }
      },
      additionalProperties: false
    },
    flags: {
      type: 'object',
      description: '风险标志：如实填写，规则据此给出硬门槛',
      properties: Object.fromEntries(FLAG_KEYS.map((key) => [key, { type: 'boolean', description: FLAG_DESCRIPTIONS[key] }])),
      additionalProperties: false
    }
  },
  required: ['title', 'goal', 'acceptance', 'flags'],
  additionalProperties: false
}

export const DELEGATE_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'swarm_task_card 返回的 task_id' },
    role: { type: 'string', enum: getDelegableRoleIds(), description: `专家角色：\n${getRoleCatalogText()}` },
    mode: { type: 'string', enum: ['research', 'verify'], description: '仅算衡：research=研算（实现前定义语义与复杂度），verify=验算（独立找反例）' },
    prompt: { type: 'string', description: '自包含的任务说明：目标、相关文件、约束与交付要求。专家看不到本对话。' },
    context_paths: strList('相关文件路径'),
    image_paths: strList('仅观象：工作区内的截图/设计稿路径'),
    backend: { type: 'string', enum: DELEGATE_BACKENDS, description: 'auto（默认，按配置）/ api / codex（ChatGPT Plus 原生 Codex）/ claude（Claude Pro 原生 Claude Code）' },
    allow_web: { type: 'boolean', description: '仅枢机/算衡/妙笔：本次开放 web_search 与 web_fetch' },
    gate: { type: 'string', enum: GATE_IDS, description: '本次委派用于满足的门禁' }
  },
  required: ['task_id', 'role', 'prompt'],
  additionalProperties: false
}

export const STATUS_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: '只看某个任务；不传则列出本会话全部任务' },
    verbose: { type: 'boolean', description: '附带每个委派的结构化结果、证据与路由记录' }
  },
  additionalProperties: false
}

export const ACCEPT_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    decision: { type: 'string', enum: ['accept', 'reject', 'incomplete'], description: 'accept=申请验收；reject=不接受并进入修复轮次；incomplete=如实记录未完成' },
    summary: { type: 'string', description: '验收说明' },
    unresolved: strList('未解决问题'),
    stopReason: { type: 'string', description: '停止理由' },
    findingResolutions: {
      type: 'array',
      description: '对御史 critical/high 发现逐条说明处理结果',
      items: {
        type: 'object',
        properties: { delegationId: { type: 'string' }, index: { type: 'number' }, resolution: { type: 'string' } },
        required: ['delegationId', 'index', 'resolution'],
        additionalProperties: false
      }
    }
  },
  required: ['task_id', 'decision', 'summary', 'stopReason'],
  additionalProperties: false
}

type TaskCardResult = Awaited<ReturnType<SwarmService['AddTaskCard']>>
type StatusResult = ReturnType<SwarmService['getStatus']>

export const getTaskCardText = (result: TaskCardResult): string => {
  const triage = result.triage
  const answers = triage.answers === undefined ? '' : `；Jev：${JSON.stringify(triage.answers)}`
  return clip([
    `task_id: ${result.task_id}（任务卡已记录）`,
    `标题：${result.title}`,
    '必需门禁（硬门槛，不能跳过）：',
    ...(result.requiredGates.length === 0 ? ['- 无'] : result.requiredGates.map((g) => `- ${g.gate} ${g.label} → ${g.roleName}（${g.source}：${g.reason}）`)),
    '建议角色：',
    ...(result.suggestedRoles.length === 0 ? ['- 无'] : result.suggestedRoles.map((s) => `- ${s.role} ${s.roleName}：${s.reason}`)),
    `衡鉴：${triage.source}${triage.fallbackReason === undefined ? '' : `（回退原因：${triage.fallbackReason}）`}${answers}`,
    `预算：每任务最多 ${result.budgets.maxDelegationsPerTask} 次委派；每角色 ${result.budgets.maxCallsPerRole} 次（铸剑 ${result.budgets.maxCallsZhuJian} 次）；自动修复最多 ${result.budgets.maxAutoFixRounds} 轮`,
    `账本：${result.ledgerPath}`
  ].join('\n'))
}

export const getDelegationText = (record: DelegationRecord): string => {
  const attempts = record.attempts
    .filter((a) => a.outcome === 'skipped' || a.outcome === 'fallback' || a.outcome === 'failed')
    .map((a) => `${a.outcome === 'skipped' ? '跳过' : a.outcome === 'fallback' ? '回退' : '失败'} ${a.route}（${a.reason ?? ''}）`)
  return clip([
    `【${record.roleName}】${record.status}：${record.summary}`,
    `委派 ${record.delegationId} · 后端 ${record.backend ?? '无'} · 路由 ${record.route === undefined ? '无' : getRouteLabel(record.route)}`,
    ...(attempts.length > 0 ? [`路由记录：${attempts.join('；')}`] : []),
    `独立性：${record.independence}　硬隔离：${record.hardIsolation ? '是' : '否'}`,
    ...(record.changedFiles !== undefined && record.changedFiles.length > 0 ? [`改动文件：${record.changedFiles.join(', ')}`] : []),
    ...(record.unresolved.length > 0 ? [`未解决：${record.unresolved.join('；')}`] : []),
    ...(record.error === undefined ? [] : [`错误：${record.error}`]),
    ...(record.structured === undefined ? [] : ['结构化结果：', '```json', JSON.stringify(record.structured, null, 2), '```'])
  ].join('\n'))
}

export const getStatusText = (result: StatusResult): string => {
  const tasks = result.tasks.flatMap((task) => [
    `任务 ${task.task_id}：${task.title}（修复轮次 ${task.rounds}；委派 ${task.budget.used}/${task.budget.max}）`,
    ...task.gates.map((g) => `${g.satisfied ? '✓' : '✗'} ${g.gate} ${g.label}${g.satisfied ? `（${g.by ?? ''}）` : `：${g.missing ?? ''}`}${g.notes.length > 0 ? `；${g.notes.join('；')}` : ''}`),
    ...task.delegations.map((d) => `- ${d.delegationId} ${d.roleName} ${d.status} · ${d.route ?? '无路由'} · ${d.summary}${d.error === null ? '' : ` · 错误：${d.error}`}`),
    ...(task.acceptance === null ? [] : [`验收：${task.acceptance.status}（${task.acceptance.stopReason}）`]),
    ...task.delegations.filter((d) => 'structured' in d).map((d) => `${d.delegationId} 结构化结果：${JSON.stringify((d as { structured?: unknown }).structured)}`)
  ])
  return clip([
    ...(tasks.length > 0 ? tasks : ['本会话还没有任务卡']),
    `调用：原生后端 ${result.usage.nativeCalls} 次，Jev ${result.usage.jevCalls} 次`,
    ...(result.diagnostics.length > 0 ? [`宿主降级：${result.diagnostics.join('；')}`] : []),
    `账本：${result.ledgerPath}`
  ].join('\n'))
}

export const getAcceptText = (result: AcceptResultInfo): string =>
  clip([
    `验收结果：${result.status}`,
    ...(result.missing.length > 0 ? ['缺少：', ...result.missing.map((m) => `- ${m}`)] : []),
    `修复轮次：${result.roundsUsed}/${result.maxAutoFixRounds}`
  ].join('\n'))

/**
 * 生成 4 个模型工具定义
 * @param {SwarmService} service - 服务
 * @returns {ToolDefinitionLike[]} 工具定义
 */
export const getSwarmToolDefinitions = (service: SwarmService): ToolDefinitionLike[] => [
  getToolDefinition<unknown, TaskCardResult>({
    name: 'swarm_task_card',
    description: '建立或更新任务卡：记录目标、验收标准、范围、风险标志与性能预算，由规则与衡鉴（Jev）给出必需门禁和建议角色。每个任务先调用它。',
    parameters: TASK_CARD_PARAMETERS,
    execute: (args, exec) => service.AddTaskCard(args, getExec(exec)),
    render: (_args, value) => getTaskCardText(value)
  }),
  getToolDefinition<{ role?: unknown }, DelegationRecord>({
    name: 'swarm_delegate',
    description: '委派专家：把一项自包含的子任务交给指定中文角色，自动选择模型路由、限制工具权限并校验结构化交付。只读角色可在同一条消息里并行委派；编辑与执行类角色会串行执行。',
    parameters: DELEGATE_PARAMETERS,
    timeoutMs: DELEGATE_TIMEOUT_MS,
    isConcurrencySafe: (args) => isDelegableRoleId(args.role) && getRoleInfo(args.role).concurrencySafe,
    execute: (args, exec) => service.delegate(args, getExec(exec)),
    render: (_args, value) => getDelegationText(value)
  }),
  getToolDefinition<unknown, StatusResult>({
    name: 'swarm_status',
    description: '查询任务状态：门禁是否满足、各委派的状态/路由/证据、调用用量、宿主降级与账本位置。',
    parameters: STATUS_PARAMETERS,
    execute: async (args, exec) => service.getStatus(args, getExec(exec)),
    render: (_args, value) => getStatusText(value)
  }),
  getToolDefinition<unknown, AcceptResultInfo>({
    name: 'swarm_accept',
    description: '验收：accept 时逐项核对硬门槛证据，缺失则返回 blocked；reject 进入修复轮次（最多 2 轮）；incomplete 如实记录未完成。',
    parameters: ACCEPT_PARAMETERS,
    execute: async (args, exec) => service.AcceptTask(args, getExec(exec)),
    render: (_args, value) => getAcceptText(value)
  })
]

/**
 * 工具插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 */
export const apply = (ctx: PluginContextLike): void => {
  const service = ctx.get(SWARM_SERVICE) as SwarmService | undefined
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (service === undefined || tools === undefined) return
  for (const definition of getSwarmToolDefinitions(service)) ctx.effect(() => tools.register(definition))
}
