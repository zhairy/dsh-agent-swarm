import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_JEV_CONFIG, type JevConfigInfo } from './jev.js'
import { PROMPT_STYLES, type PromptStylePolicy } from './model-family.js'
import { DEFAULT_BUDGETS, DEFAULT_TRIAGE_THRESHOLDS, type BudgetInfo, type TriageThresholdsInfo } from './policy.js'
import { DEFAULT_ESCALATION, DEFAULT_ROUTE_CHAINS, type EscalationKind, type RouteInfo, type RouteKey } from './routes.js'
import { DEFAULT_UPGRADES, UPGRADE_TRIGGERS, UPGRADEABLE_KEYS, isUpgradeTrigger, type UpgradeInfo } from './upgrade.js'
import { DEFAULT_REVIEW_THRESHOLDS, type ReviewThresholdsInfo } from './review.js'
import { readLiveObject } from './util/live.js'

export const APPROVAL_SCOPES = ['write', 'shell', 'external_mcp', 'jev'] as const
export interface ApprovalsConfigInfo { mode: 'inherit' | 'ask' | 'deny'; scope: readonly typeof APPROVAL_SCOPES[number][] }
export const DEFAULT_APPROVALS_CONFIG: ApprovalsConfigInfo = { mode: 'inherit', scope: [...APPROVAL_SCOPES] }

const RouteSchema = Schema.object({
  provider: Schema.string().required().description('provider 路由名，例如 qwen-token-plan-cn'),
  model: Schema.string().required().description('模型 ID'),
  reasoningEffort: Schema.string().description('推理强度（可选）'),
  policy: Schema.object({
    accessMode: Schema.union(['subscription', 'metered_api', 'judgment_api', 'unknown']),
    quotaDomainId: Schema.string(),
    quotaScope: Schema.union(['account', 'plan', 'model', 'pool', 'unknown']),
    poolId: Schema.string(),
    capabilities: Schema.object({ generation: Schema.boolean(), structuredOutput: Schema.boolean(), vision: Schema.boolean(), tools: Schema.boolean() })
  }).description('适配器或用户明确配置的资源与共享额度域；不含凭据')
})

const UpgradeSchema = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用容灾升级'),
  chain: Schema.array(RouteSchema).default([]).description('升级模型链：命中触发条件时优先使用，失败再回到常规路由链'),
  triggers: Schema.array(Schema.union([...UPGRADE_TRIGGERS])).default([]).description('触发条件；天枢显式要求升级时总会触发')
})

const RoleRouteSchema = Schema.object({
  chain: Schema.array(RouteSchema).default([]).description('路由链：主模型 → 备用（层数不限）'),
  escalation: Schema.union(['codex', 'claude']).description('原生升级通道（可选，需安装 Codex/Claude Code 原生 bundle）'),
  upgrade: UpgradeSchema.description('容灾升级（仅天枢、谋定、枢机、算衡·验算、铸剑、御史可用）')
})

/** swarm-core 行的 Config；字段标记为 volatile，可被 DSH 配置编辑接口在线修改，读取时每次取最新值 */
export const Config = Schema.object({
  routes: Schema.dict(RoleRouteSchema).default({})
    .description('按角色覆盖路由链；键为角色 ID（算衡用 suan_heng:research / suan_heng:verify）；留空使用内置默认').volatile(),
  rootFallback: Schema.boolean().default(true).description('主会话模型致命失败时按角色链回退').volatile(),
  approvals: Schema.object({
    mode: Schema.union(['inherit', 'ask', 'deny']).default('inherit'),
    scope: Schema.array(Schema.union([...APPROVAL_SCOPES])).default([...APPROVAL_SCOPES])
  }).default({}).description('工具审批：继承宿主、额外申请或拒绝；不能覆盖宿主 never，不控制内部 Jev HTTP 判断').volatile(),
  nativeEscalation: Schema.union(['manual', 'auto']).default('manual')
    .description('原生 Codex/Claude 升级：manual 仅在显式要求时使用；auto 在高风险任务上自动使用').volatile(),
  native: Schema.object({
    codexProvider: Schema.string().default('swarm-codex'),
    codexEditProvider: Schema.string().default('swarm-codex-edit'),
    claudePlanProvider: Schema.string().default('swarm-claude-plan'),
    claudeEditProvider: Schema.string().default('swarm-claude-edit'),
    maxCallsPerSession: Schema.natural().default(3)
  }).default({}).description('原生后端实例名与每会话调用上限').volatile(),
  jev: Schema.object({
    enabled: Schema.boolean().default(true),
    apiKeyEnv: Schema.string().default('TYPESAFE_API_KEY'),
    baseUrl: Schema.string().default('https://api.typesafe.ai'),
    model: Schema.string().default('jev-latest'),
    timeoutMs: Schema.natural().default(10000),
    maxRetries: Schema.natural().default(4).description('单次 Jev 请求失败后的重试次数；Jev 调用不设会话额度'),
    maxRequestsPerSecond: Schema.natural().default(0).description('兼容旧配置；Jev 不设插件侧限流，所有入口实际按不限处理'),
    maxRequestChars: Schema.natural().default(120000).description('单次 Jev 请求体的字符上限，超出时直接拒绝'),
    mathConfidence: Schema.number().default(0.6),
    benchmarkNoul: Schema.number().default(0.5),
    noveltyScore: Schema.number().default(1),
    noveltyConfidence: Schema.number().default(0.5)
  }).default({}).description('衡鉴 Jev 分流').volatile(),
  review: Schema.object({
    enabled: Schema.boolean().default(true).description('每位专家交付后、天枢验收时，由衡鉴调用 Jev 复评置信度'),
    trustedAbove: Schema.number().default(DEFAULT_REVIEW_THRESHOLDS.trustedAbove).description('可信度达到此值（且证据支撑 ≥ 0.6）判为可信'),
    doubtfulBelow: Schema.number().default(DEFAULT_REVIEW_THRESHOLDS.doubtfulBelow).description('可信度低于此值（或证据支撑 < 0.35）判为存疑')
  }).default({}).description('衡鉴复评（沿用 jev 的密钥、地址与模型）').volatile(),
  agents: Schema.object({
    session: Schema.union(['auto', 'oneshot', 'continuable']).default('auto')
      .description('专家会话策略：auto 由衡鉴（Jev）按任务判断一次性调用还是连续会话；oneshot 全部一次性；continuable 全部连续会话'),
    repeatAbove: Schema.number().default(0.5).description('衡鉴判断「同一大类任务还会再次调用该专家」的概率不低于此值时，开连续会话'),
    sameCategoryAbove: Schema.number().default(0.5).description('衡鉴判断新请求与已有会话「属于同一大类任务」的概率不低于此值时，追加到该会话'),
    maxRetries: Schema.natural().default(3).description('专家未执行、中断、出错或交付不合格时的自动重试次数（不含首次）'),
    retryBackoffMs: Schema.natural().default(5000).description('出错重试前的等待时间（毫秒，逐次加倍）'),
    promptStyle: Schema.union([...PROMPT_STYLES]).default('auto')
      .description('提示风格：auto 按模型自动选择（Claude 用 XML 分节，GPT 用目标/停止条件/证据，其他模型用编号步骤）；也可固定为 claude / gpt / generic'),
    networkWaitMs: Schema.natural().default(600000).description('模型请求因网络中断失败时，等待网络恢复的最长时间（毫秒）；0 为不等待，直接回退到下一层路由'),
    rootRecoverMs: Schema.natural().default(600000).description('天枢回退到备用模型后，经过这段时间（毫秒）重新尝试对话框所选的模型；0 为一直使用备用模型'),
    networkProbeUrls: Schema.array(Schema.string()).default(['https://api.deepseek.com', 'https://dashscope.aliyuncs.com', 'https://www.baidu.com'])
      .description('判断网络是否可达的探测地址：任一地址有 HTTP 响应即视为联网'),
    modelCallDisplay: Schema.union(['every', 'turn']).default('every')
      .description('百工会话聊天窗口里的「调用模型」行：every 每次调用都显示；turn 只在每轮首次调用与换模型时显示')
  }).default({}).description('专家的会话与重试策略；专家执行不设时间限制').volatile(),
  budgets: Schema.object({
    maxDelegationsPerTask: Schema.natural().default(0).description('每个任务的委派次数上限；0 为不限'),
    maxCallsPerRole: Schema.natural().default(0).description('每个任务中单个角色的调用次数上限；0 为不限'),
    maxCallsZhuJian: Schema.natural().default(0).description('每个任务中铸剑的调用次数上限；0 为不限'),
    maxAutoFixRounds: Schema.natural().default(2)
  }).default({}).description('预算').volatile(),
  ledgerDir: Schema.string().default('').description('账本目录；留空为 <DSH_HOME>/share/dsh-agent-swarm/ledger').volatile(),
  workflow: Schema.object({
    mode: Schema.union(['off', 'advisory', 'enforced']).default('advisory'),
    maxNodes: Schema.natural().default(32),
    maxEdges: Schema.natural().default(64)
  }).default({}).description('任务流程：观察模式兼容旧委派；强制模式执行依赖与审核门槛').volatile(),
  planningReview: Schema.object({
    enabled: Schema.boolean().default(true),
    requireJev: Schema.boolean().default(false),
    maxFixRounds: Schema.natural().default(2),
    reviewAbove: Schema.number().default(0.8)
  }).default({}).description('生成后独立审核目标、流程设计与 Mermaid 代码').volatile(),
  execution: Schema.object({
    profile: Schema.union(['legacy', 'bounded']).default('legacy'),
    maxCalls: Schema.natural().default(0),
    maxTokens: Schema.natural().default(0),
    maxCostUsd: Schema.number().default(0)
  }).default({}).description('生成模型执行预算；0 表示不限，Jev 完全排除').volatile(),
  recovery: Schema.object({
    maxTransientRetries: Schema.natural().default(1),
    maxLogicalAttempts: Schema.natural().default(8),
    maxShortRetryDelayMs: Schema.natural().default(2000),
    maxTransientWaitMs: Schema.natural().default(5000)
  }).default({}).description('额度/模型池耗尽立即回退；只对临时故障进行短时重试').volatile(),
  persistence: Schema.object({
    enabled: Schema.boolean().default(false),
    directory: Schema.string().default('')
  }).default({}).description('完整状态快照与恢复；不以脱敏账本作为恢复真源').volatile(),
  messageBus: Schema.object({
    enabled: Schema.boolean().default(false),
    maxPending: Schema.natural().default(128)
  }).default({}).description('专家受限文件邮箱，启用时需同时启用持久化').volatile(),
  math: Schema.object({
    enabled: Schema.boolean().default(true),
    enableExtended: Schema.boolean().default(false),
    maxCallsPerTask: Schema.natural().default(64)
  }).default({}).description('有界纯函数数学计算；计算结果不等于数学证明').volatile(),
  experience: Schema.object({
    enabled: Schema.boolean().default(false)
  }).default({}).description('有证据的经验候选、复核晋升与失效管理').volatile()
})

/** 原生后端实例配置 */
export interface NativeConfigInfo {
  codexProvider: string
  codexEditProvider: string
  claudePlanProvider: string
  claudeEditProvider: string
  maxCallsPerSession: number
}

export const DEFAULT_NATIVE_CONFIG: NativeConfigInfo = {
  codexProvider: 'swarm-codex',
  codexEditProvider: 'swarm-codex-edit',
  claudePlanProvider: 'swarm-claude-plan',
  claudeEditProvider: 'swarm-claude-edit',
  maxCallsPerSession: 3
}

/** 某角色的路由 */
export interface RoleRouteInfo {
  chain: RouteInfo[]
  escalation?: EscalationKind
  upgrade?: UpgradeInfo
}

/** 衡鉴复评配置（不设调用额度：Jev 单次成本约 $0.00001） */
export interface ReviewConfigInfo extends ReviewThresholdsInfo {
  enabled: boolean
}

export const DEFAULT_REVIEW_CONFIG: ReviewConfigInfo = { enabled: true, ...DEFAULT_REVIEW_THRESHOLDS }

/** 专家会话策略 */
export type AgentSessionPolicy = 'auto' | 'oneshot' | 'continuable'

/** 专家的会话与重试策略 */
export interface AgentsConfigInfo {
  session: AgentSessionPolicy
  repeatAbove: number
  sameCategoryAbove: number
  maxRetries: number
  retryBackoffMs: number
  /** 提示风格：auto 按模型家族选择 */
  promptStyle: PromptStylePolicy
  /** 网络中断时等待恢复的最长时间（毫秒），0 为不等待 */
  networkWaitMs: number
  /** 天枢回退覆盖的有效期（毫秒），到期后重新尝试对话框所选模型；0 为不过期 */
  rootRecoverMs: number
  /** 联网探测地址 */
  networkProbeUrls: string[]
  /** 聊天窗口「调用模型」行的显示方式（由浏览器端读取） */
  modelCallDisplay: ModelCallDisplay
}

/** every：每次调用都显示；turn：每轮首次调用与换模型时显示 */
export type ModelCallDisplay = 'every' | 'turn'

export const DEFAULT_NETWORK_PROBE_URLS: readonly string[] = ['https://api.deepseek.com', 'https://dashscope.aliyuncs.com', 'https://www.baidu.com']

export const DEFAULT_AGENTS_CONFIG: AgentsConfigInfo = {
  session: 'auto',
  repeatAbove: 0.5,
  sameCategoryAbove: 0.5,
  maxRetries: 3,
  retryBackoffMs: 5000,
  promptStyle: 'auto',
  networkWaitMs: 600_000,
  rootRecoverMs: 600_000,
  networkProbeUrls: [...DEFAULT_NETWORK_PROBE_URLS],
  modelCallDisplay: 'every'
}

/** 合并默认值后的完整配置 */
export interface SwarmConfigInfo {
  approvals: ApprovalsConfigInfo
  routes: Partial<Record<RouteKey, RoleRouteInfo>>
  rootFallback: boolean
  nativeEscalation: 'manual' | 'auto'
  native: NativeConfigInfo
  jev: JevConfigInfo
  thresholds: TriageThresholdsInfo
  review: ReviewConfigInfo
  agents: AgentsConfigInfo
  budgets: BudgetInfo
  ledgerDir: string
  workflow: { mode: 'off' | 'advisory' | 'enforced'; maxNodes: number; maxEdges: number }
  planningReview: { enabled: boolean; requireJev: boolean; maxFixRounds: number; reviewAbove: number }
  execution: { profile: 'legacy' | 'bounded'; maxCalls: number; maxTokens: number; maxCostUsd: number }
  recovery: { maxTransientRetries: number; maxLogicalAttempts: number; maxShortRetryDelayMs: number; maxTransientWaitMs: number }
  persistence: { enabled: boolean; directory: string }
  messageBus: { enabled: boolean; maxPending: number }
  math: { enabled: boolean; enableExtended: boolean; maxCallsPerTask: number }
  experience: { enabled: boolean }
}

export const DEFAULT_WORKFLOW_CONFIG: SwarmConfigInfo['workflow'] = { mode: 'advisory', maxNodes: 32, maxEdges: 64 }
export const DEFAULT_PLANNING_REVIEW: SwarmConfigInfo['planningReview'] = { enabled: true, requireJev: false, maxFixRounds: 2, reviewAbove: 0.8 }
export const DEFAULT_EXECUTION_CONFIG: SwarmConfigInfo['execution'] = { profile: 'legacy', maxCalls: 0, maxTokens: 0, maxCostUsd: 0 }
export const DEFAULT_RECOVERY_CONFIG: SwarmConfigInfo['recovery'] = { maxTransientRetries: 1, maxLogicalAttempts: 8, maxShortRetryDelayMs: 2000, maxTransientWaitMs: 5000 }

export const ROUTE_KEYS: readonly RouteKey[] = Object.keys(DEFAULT_ROUTE_CHAINS) as RouteKey[]

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** 按默认值的类型逐字段取值，类型不符时使用默认值 */
const getMerged = <T extends object>(defaults: T, raw: unknown): T => {
  const source = asRecord(raw)
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, typeof source[key] === typeof fallback ? source[key] : fallback])
  ) as T
}

const isRoute = (value: unknown): value is RouteInfo => {
  const record = asRecord(value)
  return typeof record.provider === 'string' && record.provider !== '' && typeof record.model === 'string' && record.model !== ''
    && (record.reasoningEffort === undefined || typeof record.reasoningEffort === 'string')
}

const meaningfulPolicy = (policy: RouteInfo['policy']): RouteInfo['policy'] => {
  if (policy === undefined) return undefined
  const fields = Object.fromEntries(Object.entries(policy).filter(([key, value]) =>
    key === 'capabilities' ? value !== undefined && Object.values(value).some((item) => typeof item === 'boolean') : value !== undefined && value !== ''))
  return Object.keys(fields).length === 0 ? undefined : fields as RouteInfo['policy']
}
const toRoute = (route: RouteInfo): RouteInfo => ({
  provider: route.provider,
  model: route.model,
  ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
  ...(meaningfulPolicy(route.policy) === undefined ? {} : { policy: structuredClone(meaningfulPolicy(route.policy)) })
})

/** 解析升级配置；不可升级的角色或格式不对时忽略 */
const getUpgradeOverride = (key: string, raw: unknown): UpgradeInfo | undefined => {
  if (raw === undefined || !(UPGRADEABLE_KEYS as readonly string[]).includes(key)) return undefined
  const record = asRecord(raw)
  const chain = Array.isArray(record.chain) ? record.chain.filter(isRoute).map(toRoute) : []
  const triggers = Array.isArray(record.triggers) ? [...new Set(record.triggers.filter(isUpgradeTrigger))] : []
  return { enabled: record.enabled !== false, chain, triggers }
}

const getRouteOverrides = (raw: unknown): Partial<Record<RouteKey, RoleRouteInfo>> => {
  const entries = Object.entries(asRecord(raw)).flatMap(([key, value]): Array<[RouteKey, RoleRouteInfo]> => {
    if (!(ROUTE_KEYS as readonly string[]).includes(key)) return []
    const record = asRecord(value)
    const chain = Array.isArray(record.chain) && record.chain.every(isRoute) ? record.chain.map(toRoute) : []
    const escalation = record.escalation === 'codex' || record.escalation === 'claude' ? record.escalation : undefined
    const upgrade = getUpgradeOverride(key, record.upgrade)
    if (chain.length === 0 && upgrade === undefined) return []
    return [[key as RouteKey, { chain, ...(escalation === undefined ? {} : { escalation }), ...(upgrade === undefined ? {} : { upgrade }) }]]
  })
  return Object.fromEntries(entries)
}

const AGENT_SESSION_POLICIES: readonly AgentSessionPolicy[] = ['auto', 'oneshot', 'continuable']

const getAgentsConfig = (raw: unknown): AgentsConfigInfo => {
  const merged = getMerged(DEFAULT_AGENTS_CONFIG, raw)
  const urls = Array.isArray(merged.networkProbeUrls) ? merged.networkProbeUrls.filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url)) : []
  return {
    ...merged,
    session: AGENT_SESSION_POLICIES.includes(merged.session) ? merged.session : 'auto',
    promptStyle: PROMPT_STYLES.includes(merged.promptStyle) ? merged.promptStyle : 'auto',
    networkProbeUrls: urls.length > 0 ? urls : [...DEFAULT_NETWORK_PROBE_URLS],
    modelCallDisplay: merged.modelCallDisplay === 'turn' ? 'turn' : 'every'
  }
}

/**
 * 读取 Config 当前值并合并默认值；每次调用都重新读取，设置页修改即时生效
 * @param {unknown} raw - 插件收到的 Config（volatile 引用或普通对象）
 * @returns {SwarmConfigInfo} 完整配置
 */
export const getSwarmConfig = (raw: unknown): SwarmConfigInfo => {
  const plain = readLiveObject(raw)
  return {
    routes: getRouteOverrides(plain.routes),
    rootFallback: typeof plain.rootFallback === 'boolean' ? plain.rootFallback : true,
    approvals: (() => {
      const raw = readLiveObject(plain.approvals)
      const mode = raw.mode === 'ask' || raw.mode === 'deny' ? raw.mode : 'inherit'
      const scope = Array.isArray(raw.scope) ? [...new Set(raw.scope.filter((value): value is typeof APPROVAL_SCOPES[number] => (APPROVAL_SCOPES as readonly unknown[]).includes(value)))] : [...DEFAULT_APPROVALS_CONFIG.scope]
      return { mode, scope }
    })(),
    nativeEscalation: plain.nativeEscalation === 'auto' ? 'auto' : 'manual',
    native: getMerged(DEFAULT_NATIVE_CONFIG, plain.native),
    jev: { ...getMerged(DEFAULT_JEV_CONFIG, plain.jev), maxRequestsPerSecond: 0 },
    thresholds: getMerged(DEFAULT_TRIAGE_THRESHOLDS, plain.jev),
    review: getMerged(DEFAULT_REVIEW_CONFIG, plain.review),
    agents: getAgentsConfig(plain.agents),
    budgets: getMerged(DEFAULT_BUDGETS, plain.budgets),
    ledgerDir: typeof plain.ledgerDir === 'string' ? plain.ledgerDir : '',
    workflow: getMerged(DEFAULT_WORKFLOW_CONFIG, plain.workflow),
    planningReview: getMerged(DEFAULT_PLANNING_REVIEW, plain.planningReview),
    execution: getMerged(DEFAULT_EXECUTION_CONFIG, plain.execution),
    recovery: getMerged(DEFAULT_RECOVERY_CONFIG, plain.recovery),
    persistence: getMerged({ enabled: false, directory: '' }, plain.persistence),
    messageBus: getMerged({ enabled: false, maxPending: 128 }, plain.messageBus),
    math: getMerged({ enabled: true, enableExtended: false, maxCallsPerTask: 64 }, plain.math),
    experience: getMerged({ enabled: false }, plain.experience)
  }
}

/**
 * 取某路由键的有效路由：用户覆盖（非空链）优先，否则用内置默认；原生升级通道与容灾升级同理。
 * 容灾升级只在已启用且升级链非空时返回；用户显式停用（enabled: false）时不返回。
 * @param {SwarmConfigInfo} config - 配置
 * @param {RouteKey} key - 路由键
 * @returns {RoleRouteInfo} 路由
 */
export const getRoleRoute = (config: SwarmConfigInfo, key: RouteKey): RoleRouteInfo => {
  const override = config.routes[key]
  const chain = override !== undefined && override.chain.length > 0 ? override.chain : [...DEFAULT_ROUTE_CHAINS[key]]
  const escalation = override?.escalation ?? DEFAULT_ESCALATION[key]
  const configured = override?.upgrade ?? DEFAULT_UPGRADES[key]
  const upgrade = configured !== undefined && configured.enabled && configured.chain.length > 0
    ? { enabled: true, chain: [...configured.chain], triggers: [...configured.triggers] }
    : undefined
  return { chain, ...(escalation === undefined ? {} : { escalation }), ...(upgrade === undefined ? {} : { upgrade }) }
}
