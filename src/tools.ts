import { DELEGATE_BACKENDS } from './delegate.js'
import type { DelegationRecord } from './evidence.js'
import { SWARM_SERVICE, type PluginContextLike, type PromptAssemblyLike, type SkillsLike, type ToolsLike } from './host-contract.js'
import { getJevToolDefinitions } from './jev-tools.js'
import { getMathToolDefinitions } from './math-tools.js'
import { getCollaborationToolDefinitions } from './collaboration-tools.js'
import { PROMPT_STYLE_LABELS, getOrchestratorStyleSection, getPromptStyle, type PromptStylePolicy } from './model-family.js'
import { FLAG_KEYS, GATE_IDS, type FlagKey } from './policy.js'
import { ROLE_TAG_PATTERN, getDelegableRoleIds, getRoleCatalogText, getRoleInfo, isDelegableRoleId } from './role-registry.js'
import { getAssessmentText } from './review.js'
import { getRouteDisplay } from './routes.js'
import { getEmbeddedSkills } from './skills.js'
import { SESSION_CHOICES } from './threads.js'
import type { AcceptResultInfo, SwarmService } from './service.js'
import { getToolDefinition, type ToolDefinitionLike, type ToolExecLike } from './tool-shape.js'
import { SwarmError } from './util/errors.js'
import type { JsonSchemaObject } from './util/json-schema.js'

/** 预设行：只挂在天枢预设上，注册 4 个百工工具、7 个 Jev 判断工具与 2 个内嵌技能，并按模型家族补充天枢的调度说明 */
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

const clip = (text: string, max = MAX_RENDER): string =>
  text.length > max ? `${text.slice(0, max)}\n…（已截断，完整内容见 swarm_status verbose 或账本）` : text

const strList = (description: string): JsonSchemaObject => ({ type: 'array', items: { type: 'string' }, description })

const getExec = (exec: ToolExecLike) => {
  if (exec.agent === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '工具调用缺少会话上下文')
  return { agent: exec.agent, signal: exec.signal, callId: exec.callId }
}

export const TASK_CARD_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: '更新已有任务时传入；新任务不传' },
    expected_card_revision: { type: 'number', description: '更新任务时的合同版本，用于并发比较' },
    workflow: { type: 'object', additionalProperties: true, description: '可选结构化流程；依赖、角色和门禁由宿主校验，Mermaid 自动生成' },
    intent: { type: 'object', properties: { text: { type: 'string' }, sourceRef: { type: 'string' } }, required: ['text'], additionalProperties: false, description: '旧宿主不能读取用户消息时的显式原始需求，不能冒称已获宿主验证' },
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
        ,targets: { type: 'array', items: { type: 'object', properties: {
          metric: { type: 'string', enum: ['p95', 'p99', 'throughput', 'peakMemory', 'numericError'] },
          operator: { type: 'string', enum: ['<=', '>='] }, value: { type: 'number' },
          unit: { type: 'string', enum: ['ms', 'ops/s', 'bytes', 'absolute'] }, minSamples: { type: 'number' }
        }, required: ['metric', 'operator', 'value', 'unit'], additionalProperties: false } }
      },
      additionalProperties: false
    },
    flags: {
      type: 'object',
      description: '风险标志：如实填写，规则据此给出硬门槛，并决定是否自动触发容灾升级',
      properties: Object.fromEntries(FLAG_KEYS.map((key) => [key, { type: 'boolean', description: FLAG_DESCRIPTIONS[key] }])),
      additionalProperties: false
    },
    upgrade: { type: 'boolean', description: '天枢自身的容灾升级：你对本任务的判断置信度不足、需要更强模型裁决时传 true，本任务后续的主会话请求改用升级模型，验收后恢复；传 false 取消。命中配置的触发条件时会自动升级，无需传' }
  },
  required: ['title', 'goal', 'acceptance', 'flags'],
  additionalProperties: false
}

export const DELEGATE_PARAMETERS: JsonSchemaObject = {
  type: 'object',
  properties: {
    task_id: { type: 'string', description: 'swarm_task_card 返回的 task_id' },
    node_id: { type: 'string', description: '执行节点 ID；必须与 ready 节点及角色对应' },
    expected_workflow_revision: { type: 'number', description: '流程版本；过期版本拒绝执行' },
    request_id: { type: 'string', description: '幂等执行标识，重复提交不会重新启动专家' },
    review_phase: { type: 'string', enum: ['blind', 'response'], description: '审查/验算先默认 blind。response 只能在当前合同与产物已有冻结初审之后使用；宿主验证，不能替代新产物的独立门禁。' },
    role: { type: 'string', enum: getDelegableRoleIds(), description: `专家角色：\n${getRoleCatalogText()}` },
    mode: { type: 'string', enum: ['research', 'verify'], description: '仅算衡：research=研算（实现前定义语义与复杂度），verify=验算（独立找反例）' },
    prompt: { type: 'string', description: '自包含的任务说明：目标、相关文件、约束与交付要求。专家看不到本对话。' },
    context_paths: strList('相关文件路径'),
    image_paths: strList('仅观象：工作区内的截图/设计稿路径'),
    backend: { type: 'string', enum: DELEGATE_BACKENDS, description: 'auto（默认，按配置）/ api / codex（ChatGPT Plus 原生 Codex）/ claude（Claude Pro 原生 Claude Code）' },
    allow_web: { type: 'boolean', description: '仅枢机/算衡/妙笔：本次开放 web_search 与 web_fetch' },
    gate: { type: 'string', enum: GATE_IDS, description: '本次委派用于满足的门禁' },
    upgrade: { type: 'boolean', description: '要求本次委派使用该角色的容灾升级模型（谋定、枢机、算衡·验算、铸剑、御史可配置）。命中配置的触发条件时会自动升级，只有你判断需要更强模型时才显式传 true' },
    session: {
      type: 'string',
      enum: SESSION_CHOICES,
      description: '会话方式。auto（默认）：由衡鉴判断一次性调用、新建连续会话，还是追加到该专家已有的会话（同一大类任务的后续工作会追加，保留上下文）；continue：追加到该角色最近的空闲会话；new：开新的连续会话（需要全新视角时）；oneshot：一次性调用'
    }
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
      description: '逐条说明处理结果：御史的 critical/high 发现（index 为 findings 下标），以及算衡·验算给出的反例（index 为 claims 下标）',
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

/** 天枢容灾升级的状态行 */
const getRootUpgradeLines = (upgrade: TaskCardResult['rootUpgrade']): string[] => {
  if (upgrade === null) return []
  if (upgrade.cancelledByUser === true) return [`天枢容灾升级：你已在对话框中换过模型，本批任务不再自动升级（原因：${upgrade.reasons.join('；')}）`]
  if (upgrade.chain.length === 0) return [`天枢容灾升级：已触发，但升级模型当前都不可用，继续使用对话框所选模型（原因：${upgrade.reasons.join('；')}）`]
  return [`天枢容灾升级：生效中 → ${upgrade.chain.join(' → ')}；任务 ${upgrade.taskIds.join('、')} 验收或标记未完成后恢复（原因：${upgrade.reasons.join('；')}）`]
}

export const getTaskCardText = (result: TaskCardResult): string => {
  const triage = result.triage
  const answers = triage.answers === undefined ? '' : `；Jev：${JSON.stringify(triage.answers)}`
  const summary = clip([
    `task_id: ${result.task_id}（任务卡已记录）`,
    `标题：${result.title}`,
    `目标：${result.goal}`,
    `验收标准：${result.acceptance.join('；')}`,
    `相关文件：${result.scope.join(', ') || '无文件变更'}`,
    `性能要求：${result.perf === null ? '待测' : JSON.stringify(result.perf)}`,
    '必需门禁（硬门槛，不能跳过）：',
    ...(result.requiredGates.length === 0 ? ['- 无'] : result.requiredGates.map((g) => `- ${g.gate} ${g.label} → ${g.roleName}（${g.source}：${g.reason}）`)),
    '建议角色：',
    ...(result.suggestedRoles.length === 0 ? ['- 无'] : result.suggestedRoles.map((s) => `- ${s.role} ${s.roleName}：${s.reason}`)),
    `衡鉴：${triage.source}${triage.fallbackReason === undefined ? '' : `（回退原因：${triage.fallbackReason}）`}${answers}`,
    `预算：每任务 ${result.budgets.maxDelegationsPerTask || '不限'} 次委派；每角色 ${result.budgets.maxCallsPerRole || '不限'} 次（铸剑 ${result.budgets.maxCallsZhuJian || '不限'} 次）；自动修复最多 ${result.budgets.maxAutoFixRounds} 轮`,
    `需求版本：${result.requestRevision}；合同版本：${result.cardRevision}；流程版本：${result.workflowRevision}；规划审核：${result.planningReview?.status ?? 'pending'}`,
    ...(result.planningRecovery.automaticReviewPaused && !['pass', 'pass_with_degradation'].includes(result.planningReview?.status ?? '')
      ? ['自动规划审核已暂停；任务卡与 scope 仍可修改。完成修订后调用 swarm_review_plan 显式复审，不能复用旧批准。'] : []),
    `上下文引用：${result.contextRefs.join(', ')}`,
  ].join('\n'))
  // Keep the complete bounded projection and closing fence: clipping Mermaid produces invalid code.
  return [summary,
    ...(result.flow === null ? [] : [`任务流程：\n\`\`\`mermaid\n${result.flow.mermaid}\n\`\`\``]),
    clip([...getRootUpgradeLines(result.rootUpgrade), '执行记录：swarm_status；授权材料：swarm_context_read（不传 ref 可先列出当前任务材料）。私有账本不通过通用文件工具读取。'].join('\n'))
  ].join('\n')
}

const RETRY_ACTION_LABELS: Readonly<Record<NonNullable<DelegationRecord['retries']>[number]['action'], string>> = {
  continue: '同一会话续跑或修正',
  restart: '重新启动',
  fallback: '改为一次性调用'
}

/** 会话方式的一行说明 */
const getSessionLine = (session: NonNullable<DelegationRecord['session']>): string => {
  const source = ({ jev: '衡鉴判定', rules: '规则', explicit: '天枢指定', config: '配置' } as Record<string, string>)[session.source] ?? session.source
  if (session.kind === 'oneshot') return `会话：一次性调用（${source}：${session.reason}）`
  const where = session.appended ? `追加到连续会话 ${session.threadId ?? ''}，第 ${session.round ?? 1} 轮` : `新建连续会话 ${session.threadId ?? ''}`
  return `会话：${where}（${source}：${session.reason}）；同类后续工作再次委派同一角色即可追加`
}

export const getDelegationText = (record: DelegationRecord): string => {
  const attempts = record.attempts
    .filter((a) => a.outcome === 'skipped' || a.outcome === 'fallback' || a.outcome === 'failed')
    .map((a) => `${a.outcome === 'skipped' ? '跳过' : a.outcome === 'fallback' ? '回退' : '失败'} ${a.route}（${a.reason ?? ''}）`)
  return clip([
    `【${record.roleName}】${record.status}：${record.summary}`,
    `委派 ${record.delegationId} · 后端 ${record.backend ?? '无'} · 模型 ${record.route === undefined ? '无' : getRouteDisplay(record.route)}${record.promptStyle === undefined ? '' : ` · ${PROMPT_STYLE_LABELS[record.promptStyle]}`}`,
    ...(record.upgrade === undefined ? [] : [`容灾升级：${record.upgrade.reasons.join('；')} → 优先使用 ${record.upgrade.chain.join(' → ')}`]),
    ...(record.session === undefined ? [] : [getSessionLine(record.session)]),
    ...((record.retries ?? []).length > 0 ? [`自动重试 ${(record.retries ?? []).length} 次：${(record.retries ?? []).map((r) => `${r.attempt}. ${RETRY_ACTION_LABELS[r.action]}（${r.reason}）`).join('；')}`] : []),
    ...(attempts.length > 0 ? [`路由记录：${attempts.join('；')}`] : []),
    ...[getAssessmentText(record.assessment)].filter((line): line is string => line !== undefined),
    ...(record.evidenceAssessment === undefined ? [] : [
      `探索证据：${record.evidenceAssessment.status} · ${record.evidenceAssessment.disposition}；可信度与项目关联度独立评估，置信程度不等于正确率。`,
      ...record.evidenceAssessment.items.map((item) => `${item.id}：可信度 ${item.credibility.score === undefined ? '未知' : item.credibility.score.toFixed(2)}（判断置信 ${item.credibility.confidence === undefined ? '未知' : item.credibility.confidence.toFixed(2)}）；项目关联度 ${item.relevance.score === undefined ? '未知' : item.relevance.score.toFixed(2)}（判断置信 ${item.relevance.confidence === undefined ? '未知' : item.relevance.confidence.toFixed(2)}）；${item.disposition}${item.reasons.length === 0 ? '' : `：${item.reasons.join('；')}`}`)
    ]),
    `独立性：${record.independence}　硬隔离：${record.hardIsolation ? '是' : '否'}`,
    ...(record.changedFiles !== undefined && record.changedFiles.length > 0 ? [`改动文件：${record.changedFiles.join(', ')}`] : []),
    ...(record.unresolved.length > 0 ? [`未解决：${record.unresolved.join('；')}`] : []),
    ...(record.error === undefined ? [] : [`错误：${record.error}`]),
    ...(record.structured === undefined ? [] : ['结构化结果：', '```json', JSON.stringify(record.structured, null, 2), '```'])
  ].join('\n'))
}

export const getStatusText = (result: StatusResult): string => {
  const tasks = result.tasks.flatMap((task) => [
    `任务 ${task.task_id}：${task.title}（修复轮次 ${task.rounds}；委派 ${task.budget.used}${task.budget.max > 0 ? `/${task.budget.max}` : ' 次（不限）'}）`,
    `需求版本：${task.requestRevision}；合同版本：${task.cardRevision}；流程版本：${task.workflowRevision}；规划审核：${task.planningReview?.status ?? 'pending'}`,
    ...(task.stateRefreshRequired ? [`只读投影待同步：已登记需求 ${task.publishedRevisions.requestRevision} / 合同 ${task.publishedRevisions.cardRevision} / 流程 ${task.publishedRevisions.workflowRevision}；调用 swarm_review_plan 显式同步审核。`] : []),
    ...(task.planningRecovery.automaticReviewPaused ? ['自动规划审核已暂停；任务卡仍可修改，修订后调用 swarm_review_plan 显式复审。'] : []),
    ...task.gates.map((g) => `${g.satisfied ? '✓' : '✗'} ${g.gate} ${g.label}${g.satisfied ? `（${g.by ?? ''}）` : `：${g.missing ?? ''}`}${g.notes.length > 0 ? `；${g.notes.join('；')}` : ''}`),
    ...task.delegations.map((d) => {
      const review = getAssessmentText(d.assessment ?? undefined)
      return `- ${d.delegationId} ${d.roleName} ${d.status} · ${d.route ?? '无路由'} · ${d.summary}${d.error === null ? '' : ` · 错误：${d.error}`}${review === undefined ? '' : ` · ${review}`}${d.evidenceAssessment === null ? '' : ` · 探索证据 ${d.evidenceAssessment.status}/${d.evidenceAssessment.disposition}`}`
    }),
    ...(task.acceptance === null ? [] : [`验收：${task.acceptance.status}（${task.acceptance.stopReason}）`]),
    ...task.delegations.filter((d) => 'structured' in d).map((d) => `${d.delegationId} 结构化结果：${JSON.stringify((d as { structured?: unknown }).structured)}`)
  ])
  return clip([
    ...(tasks.length > 0 ? tasks : ['本会话还没有任务卡']),
    ...getRootUpgradeLines(result.rootUpgrade),
    ...(result.threads.length > 0 ? ['连续会话：', ...result.threads.map((t) => `- ${t.threadId} ${t.roleName}${t.mode === undefined ? '' : `·${t.mode === 'research' ? '研算' : '验算'}`} · ${t.rounds} 轮 · ${t.closed ? '已关闭' : t.busy ? '工作中' : '空闲'} · 任务 ${t.taskIds.join('、') || '无'}${t.lastSummary === null ? '' : ` · 最近：${t.lastSummary}`}`)] : []),
    `调用：原生后端 ${result.usage.nativeCalls} 次，Jev 分诊 ${result.usage.jevCalls} 次，衡鉴会话判断 ${result.usage.sessionCalls} 次，衡鉴复评 ${result.usage.reviewCalls} 次`,
    ...(result.diagnostics.length > 0 ? [`宿主降级：${result.diagnostics.join('；')}`] : []),
    `账本：${result.ledgerPath}`
  ].join('\n'))
}

export const getAcceptText = (result: AcceptResultInfo): string =>
  clip([
    `验收结果：${result.status}`,
    ...(result.missing.length > 0 ? ['缺少：', ...result.missing.map((m) => `- ${m}`)] : []),
    `修复轮次：${result.roundsUsed}/${result.maxAutoFixRounds}`,
    ...[getAssessmentText(result.assessment)].filter((line): line is string => line !== undefined).map((line) => line.replace('衡鉴复评', '衡鉴复评（验收结论）'))
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
    isConcurrencySafe: (args) => isDelegableRoleId(args.role) && getRoleInfo(args.role).concurrencySafe,
    execute: (args, exec) => service.delegate(args, getExec(exec)),
    render: (_args, value) => getDelegationText(value)
  }),
  getToolDefinition<unknown, StatusResult>({
    name: 'swarm_status',
    description: '只读查询当前会话任务的版本、规划审核、门禁、委派状态/路由/证据、调用用量与宿主降级。优先用本工具核对流程；Web taskView RPC 需要宿主认证，不能用匿名 curl 代替。',
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

/** 天枢系统提示里按模型家族追加的调度风格一节 */
export const ORCHESTRATION_STYLE_SECTION = 'dsh-agent-swarm:orchestration-style'

const TOOL_RECOVERY_SECTION = 'dsh-agent-swarm:tool-recovery'
const TOOL_RECOVERY_TEXT = [
  '工具调用恢复：',
  '- 核对任务用 swarm_status，授权材料用 swarm_context_read；只读 Web RPC 仍需登录认证，401 不能证明任务数据损坏，不通过读取私有状态绕过。',
  '- read 的 offset 是从 1 开始的行号；超出总行数时按当前文件重新定位或从 offset:1 读取，不复用旧行号重试。',
  '- 参数校验失败先核对工具 schema 再修正；jev_check 的 state 与 propositions 必须在顶级并列。agent-browser 截图路径是位置参数（screenshot ./page.png），先用 screenshot --help 核对当前 CLI。',
  '- 持久状态校验失败时保留错误及 swarm_status 中的版本，停止重复写入并报告维护问题；重启不等于已修复，规划未批准时不能开始执行。'
].join('\n')

/**
 * 按所选模型的家族给天枢的系统提示追加调度风格说明（Claude / GPT / 其他）。
 * 专家子会话的 persona 带角色标签，它们沿用委派时按路由生成的 persona，不追加。
 * @param {PromptAssemblyLike} assembled - 组装结果
 * @param {PromptStylePolicy} policy - 配置的提示风格
 * @returns {PromptAssemblyLike} 追加后的组装结果
 */
export const getStyledAssembly = (assembled: PromptAssemblyLike, policy: PromptStylePolicy): PromptAssemblyLike => {
  const sections = Array.isArray(assembled.sections) ? assembled.sections : []
  if (sections.some((section) => section.name === ORCHESTRATION_STYLE_SECTION || ROLE_TAG_PATTERN.test(section.text))) return assembled
  const variables = assembled.variables ?? {}
  const style = getPromptStyle({ ...(variables.provider === undefined ? {} : { provider: variables.provider }), ...(variables.model === undefined ? {} : { model: variables.model }) }, policy)
  return { ...assembled, sections: [...sections,
    ...(sections.some((section) => section.name === TOOL_RECOVERY_SECTION) ? [] : [{ name: TOOL_RECOVERY_SECTION, text: TOOL_RECOVERY_TEXT, interpolate: false }]),
    { name: ORCHESTRATION_STYLE_SECTION, text: getOrchestratorStyleSection(style), interpolate: false }
  ] }
}

/**
 * 工具插件入口
 * @param {PluginContextLike} ctx - 预设作用域上下文
 */
export const apply = (ctx: PluginContextLike): void => {
  const service = ctx.get(SWARM_SERVICE) as SwarmService | undefined
  const tools = ctx.get('tools') as ToolsLike | undefined
  if (service === undefined || tools === undefined) return
  // Jev 与衡鉴共享客户端及凭据，不设本地限流或使用额度；新工具另有真实会话/任务权限检查。
  const taskParameters: JsonSchemaObject = { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false }
  const definitions = [
    ...getSwarmToolDefinitions(service), ...getJevToolDefinitions(() => service.jev.tools),
    ...getMathToolDefinitions({ calculate: (args, exec) => service.Calculate(args, exec) }),
    ...getCollaborationToolDefinitions({ send: service.MessageSend, read: service.MessageRead, acknowledge: service.MessageAck }),
    getToolDefinition({ name: 'swarm_review_plan', description: '独立只读 Agent 与 Jev 复审当前目标、流程设计和 Mermaid 源码。结果绑定原始需求及当前版本，不能代替实现后验证。',
      parameters: { ...taskParameters, properties: { ...taskParameters.properties, bypass_cache: { type: 'boolean' } } },
      execute: (args, exec) => service.ReviewPlan(args, getExec(exec)), render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => false }),
    getToolDefinition({ name: 'swarm_context_read', description: '不传 ref 时列出当前任务授权材料与执行摘要；传 ref 分页读取。始终校验任务/版本，不读取其他任务或盲审禁止的作者过程。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, ref: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' }, expectedDigest: { type: 'string' } }, additionalProperties: false },
      execute: service.ReadContext, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
    getToolDefinition({ name: 'swarm_project_files', description: '只列举当前任务工作区实际存在的文件；query为文件名或路径片段。先发现再read/grep；无匹配返回正常空结果和真实候选，不猜测或自动改写路径。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, query: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      execute: service.ProjectFiles, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
    getToolDefinition({ name: 'swarm_experience', description: '检索最多三条有出处、版本与失效条件的经验；候选不能当作已验证事实，盲审不能读取经验。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, problemClass: { type: 'string' }, includeCandidates: { type: 'boolean' } }, additionalProperties: false },
      execute: service.Experience, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true })
  ]
  for (const definition of definitions) ctx.effect(() => tools.register(definition))
  const skills = ctx.get('skills') as SkillsLike | undefined
  if (skills !== undefined) for (const skill of getEmbeddedSkills()) ctx.effect(() => skills.register(skill))
  ctx.on('system-prompt/assemble', async (_assembly: unknown, _context: unknown, next: () => Promise<PromptAssemblyLike>) =>
    getStyledAssembly(await next(), service.getConfig().agents.promptStyle))
}
