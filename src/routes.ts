import type { LlmFailureLike, LlmLike } from './host-contract.js'
import type { RoleId, SuanHengMode } from './role-registry.js'
import { getErrorText } from './util/errors.js'

export const PROVIDER_QWEN = 'qwen-token-plan-cn'
export const PROVIDER_GO = 'opencode-go'
export const PROVIDER_DS = 'deepseek-official'

/** 一条模型路由 */
export interface RouteInfo {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 路由表的键：算衡按模式拆成两条 */
export type RouteKey = Exclude<RoleId, 'suan_heng'> | 'suan_heng:research' | 'suan_heng:verify'
export type EscalationKind = 'codex' | 'claude'
export type ModelFamily = 'deepseek' | 'qwen' | 'kimi' | 'glm' | 'minimax' | 'mimo' | 'gpt' | 'grok' | 'claude' | 'hunyuan' | 'longcat' | 'other'

type CatalogInfo = Readonly<Record<string, { vision: boolean }>>

/** pi-ai 0.85.1（随 DSH 0.1.7-alpha.2）内置的 qwen-token-plan-cn 目录 */
export const QWEN_TOKEN_PLAN_MODELS: CatalogInfo = {
  'MiniMax-M2.5': { vision: false },
  'deepseek-v3.2': { vision: false },
  'deepseek-v4-flash': { vision: false },
  'deepseek-v4-flash-0731': { vision: false },
  'deepseek-v4-pro': { vision: false },
  'deepseek-v4-pro-0813': { vision: false },
  'glm-5': { vision: false },
  'glm-5.1': { vision: false },
  'glm-5.2': { vision: false },
  'kimi-k2.5': { vision: true },
  'kimi-k2.6': { vision: true },
  'kimi-k2.7-code': { vision: true },
  'qwen3.6-flash': { vision: true },
  'qwen3.6-plus': { vision: true },
  'qwen3.7-max': { vision: false },
  'qwen3.7-plus': { vision: true },
  'qwen3.8-flash': { vision: true },
  'qwen3.8-max': { vision: true }
}

/** pi-ai 0.85.1 内置的 opencode-go 目录 */
export const OPENCODE_GO_MODELS: CatalogInfo = {
  'minimax-m3': { vision: true },
  'qwen3.8-flash': { vision: true },
  'deepseek-v4-flash': { vision: false },
  'deepseek-v4-flash-vision-exp': { vision: true },
  'deepseek-v4-pro': { vision: false },
  'glm-5.1': { vision: false },
  'glm-5.2': { vision: false },
  'glm-5.3': { vision: false },
  'glm-5.3-flash': { vision: true },
  'hy3': { vision: false },
  'hy4-preview': { vision: false },
  'kimi-k2.6': { vision: true },
  'kimi-k2.7-code': { vision: true },
  'kimi-k3': { vision: true },
  'longcat-2.0': { vision: false },
  'mimo-v2.5': { vision: true },
  'mimo-v2.5-pro': { vision: false },
  'minimax-m2.7': { vision: false },
  'omen-alpha': { vision: true },
  'qwen3.6-plus': { vision: true },
  'qwen3.7-max': { vision: false },
  'qwen3.7-plus': { vision: true },
  'qwen3.8-max': { vision: true },
  'gpt-5.6-luna': { vision: true },
  'grok-4.6': { vision: true },
  'muse-spark-1.2-contributor': { vision: true },
  'muse-spark-1.3-contributor': { vision: true }
}

/** DSH 0.1.7-alpha.2 原生 DeepSeek 适配器目录 */
export const DEEPSEEK_OFFICIAL_MODELS: CatalogInfo = {
  'deepseek-flash': { vision: true },
  'deepseek-v4-pro': { vision: false }
}

/** 两个订阅都有的模型：一律 qwen-token-plan-cn 优先、opencode-go 备用 */
export const QWEN_PREFERRED_MODELS: readonly string[] = Object.keys(QWEN_TOKEN_PLAN_MODELS).filter((model) => model in OPENCODE_GO_MODELS)

const q = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_QWEN, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const g = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_GO, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const d = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_DS, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })

/** 默认路由链（首选 → 备用），见 spec §7.1 */
export const DEFAULT_ROUTE_CHAINS: Readonly<Record<RouteKey, readonly RouteInfo[]>> = {
  tian_shu: [q('deepseek-v4-pro'), g('deepseek-v4-pro'), d('deepseek-v4-pro')],
  mou_ding: [q('qwen3.8-max'), g('qwen3.8-max'), q('deepseek-v4-pro'), d('deepseek-v4-pro')],
  shu_ji: [q('deepseek-v4-pro'), g('deepseek-v4-pro'), q('glm-5.2'), d('deepseek-v4-pro')],
  'suan_heng:research': [q('deepseek-v4-pro', 'max'), g('deepseek-v4-pro', 'max'), d('deepseek-v4-pro', 'max')],
  'suan_heng:verify': [q('qwen3.8-max', 'xhigh'), g('qwen3.8-max', 'xhigh'), g('glm-5.3', 'max')],
  tan_wei: [g('mimo-v2.5-pro'), q('kimi-k2.7-code'), g('kimi-k2.7-code'), q('qwen3.8-flash')],
  bo_wen: [q('kimi-k2.6'), g('kimi-k2.6'), g('minimax-m3')],
  guan_xiang: [q('qwen3.8-max'), g('qwen3.8-max'), q('kimi-k2.6'), g('deepseek-v4-flash-vision-exp'), d('deepseek-flash')],
  zhu_jian: [q('kimi-k2.7-code'), g('kimi-k2.7-code'), q('deepseek-v4-pro'), g('deepseek-v4-pro')],
  xing_zhou: [q('deepseek-v4-flash'), g('deepseek-v4-flash'), q('qwen3.8-flash'), d('deepseek-flash')],
  ji_feng: [q('deepseek-v4-flash'), g('deepseek-v4-flash'), q('qwen3.8-flash'), d('deepseek-flash')],
  yu_shi: [q('glm-5.2'), g('glm-5.2'), g('glm-5.3')],
  fu_he: [q('qwen3.8-flash'), g('qwen3.8-flash'), q('deepseek-v4-flash'), g('deepseek-v4-flash')],
  miao_bi: [q('qwen3.8-max'), g('qwen3.8-max'), q('kimi-k2.6'), g('kimi-k2.6')]
}

/** 默认升级通道：只在显式要求或 nativeEscalation=auto 且高风险时使用 */
export const DEFAULT_ESCALATION: Readonly<Partial<Record<RouteKey, EscalationKind>>> = {
  mou_ding: 'codex',
  shu_ji: 'claude',
  'suan_heng:research': 'codex',
  'suan_heng:verify': 'codex',
  zhu_jian: 'claude',
  yu_shi: 'codex'
}

export const getRouteKey = (role: RoleId, mode?: SuanHengMode): RouteKey =>
  role === 'suan_heng' ? `suan_heng:${mode ?? 'research'}` : role

export const getRouteLabel = (route: RouteInfo): string => `${route.provider}/${route.model}`

export const isSameRoute = (a: RouteInfo, b: RouteInfo): boolean => a.provider === b.provider && a.model === b.model

const FAMILY_RULES: ReadonlyArray<readonly [RegExp, ModelFamily]> = [
  [/^deepseek/, 'deepseek'],
  [/^qwen/, 'qwen'],
  [/^kimi/, 'kimi'],
  [/^glm/, 'glm'],
  [/^minimax/, 'minimax'],
  [/^mimo/, 'mimo'],
  [/^gpt|codex/, 'gpt'],
  [/^grok/, 'grok'],
  [/claude/, 'claude'],
  [/^hy\d/, 'hunyuan'],
  [/^longcat/, 'longcat']
]

/**
 * 按模型 ID 判断模型家族，用于实现者与审查者的独立性检查
 * @param {string} model - 模型 ID
 * @returns {ModelFamily} 家族
 */
export const getModelFamily = (model: string): ModelFamily => {
  const lower = model.toLowerCase()
  return FAMILY_RULES.find(([pattern]) => pattern.test(lower))?.[1] ?? 'other'
}

const CATALOG_BY_PROVIDER: Readonly<Record<string, CatalogInfo>> = {
  [PROVIDER_QWEN]: QWEN_TOKEN_PLAN_MODELS,
  [PROVIDER_GO]: OPENCODE_GO_MODELS,
  [PROVIDER_DS]: DEEPSEEK_OFFICIAL_MODELS
}

/**
 * 按内置目录判断路由是否支持图片；未知 provider 返回 undefined
 * @param {RouteInfo} route - 路由
 * @returns {boolean | undefined} 是否支持图片
 */
export const getCatalogVision = (route: RouteInfo): boolean | undefined =>
  CATALOG_BY_PROVIDER[route.provider]?.[route.model]?.vision

export type RouteProbeResult = { ok: true; vision: boolean } | { ok: false; reason: string }
export type RouteProbe = (route: RouteInfo) => Promise<RouteProbeResult>

/** 路由选择结果 */
export interface RouteSelection {
  usable: RouteInfo[]
  skipped: Array<{ route: RouteInfo; reason: string }>
  independence: 'achieved' | 'not-achieved' | 'n/a'
}

/**
 * 在链上筛出可用路由：先做可用性与视觉预检，再按独立性优先不同家族
 * @param {readonly RouteInfo[]} chain - 路由链
 * @param {{ probe: RouteProbe; requireVision?: boolean; avoidFamilies?: readonly ModelFamily[] }} options - 预检函数与约束
 * @returns {Promise<RouteSelection>} 可用路由与跳过原因
 */
export const FindUsableRoutes = async (
  chain: readonly RouteInfo[],
  options: { probe: RouteProbe; requireVision?: boolean; avoidFamilies?: readonly ModelFamily[] }
): Promise<RouteSelection> => {
  const skipped: RouteSelection['skipped'] = []
  const available: RouteInfo[] = []
  for (const route of chain) {
    const result = await options.probe(route)
    if (!result.ok) {
      skipped.push({ route, reason: result.reason })
      continue
    }
    if (options.requireVision === true && !result.vision) {
      skipped.push({ route, reason: 'vision-unsupported' })
      continue
    }
    available.push(route)
  }
  const avoid = options.avoidFamilies ?? []
  if (avoid.length === 0 || available.length === 0) return { usable: available, skipped, independence: 'n/a' }
  const independent = available.filter((route) => !avoid.includes(getModelFamily(route.model)))
  if (independent.length === 0) return { usable: available, skipped, independence: 'not-achieved' }
  const sameFamily = available.filter((route) => !independent.includes(route)).map((route) => ({ route, reason: 'same-family' }))
  return { usable: independent, skipped: [...skipped, ...sameFamily], independence: 'achieved' }
}

export type FailureClass = 'route-fatal' | 'auth' | 'transient' | 'other'

const ROUTE_FATAL_CODES = new Set(['NO_ADAPTER', 'UNKNOWN_MODEL', 'UNKNOWN_PROVIDER', 'MISSING_CREDENTIAL', 'QUOTA', 'UNSUPPORTED_OPTION', 'IMAGE_UNSUPPORTED'])
const AUTH_CODES = new Set(['INVALID_CREDENTIAL', 'UNAUTHORIZED', 'FORBIDDEN'])
const TRANSIENT_CODES = new Set(['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'OVERLOADED', 'SERVER_ERROR'])
const QUOTA_MESSAGE = /usage limit|quota|insufficient (balance|quota)|余额不足|额度/i

/**
 * 对模型请求失败分类，决定是否换路由
 * @param {LlmFailureLike | undefined} failure - 失败信息
 * @returns {FailureClass} 分类
 */
export const getFailureClass = (failure: LlmFailureLike | undefined): FailureClass => {
  if (failure === undefined) return 'other'
  const code = String(failure.code ?? '').toUpperCase()
  const status = failure.status ?? 0
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return 'auth'
  if (ROUTE_FATAL_CODES.has(code) || QUOTA_MESSAGE.test(failure.message ?? '')) return 'route-fatal'
  if (TRANSIENT_CODES.has(code) || status === 408 || status === 429 || status >= 500) return 'transient'
  if (status === 400 || status === 404 || status === 422) return 'route-fatal'
  return 'other'
}

/**
 * 是否值得切换到下一条路由：致命与认证失败立即切换；瞬时/其他失败在宿主重试用尽后切换
 * @param {FailureClass} failureClass - 失败分类
 * @param {boolean} exhausted - 宿主是否已放弃（request-error 的 next() 返回 undefined）
 * @returns {boolean} 是否切换
 */
export const isSwitchWorthy = (failureClass: FailureClass, exhausted: boolean): boolean =>
  failureClass === 'route-fatal' || failureClass === 'auth' || exhausted

/**
 * 基于 ctx.llm 的路由预检：provider 已注册且模型可解析
 * @param {() => LlmLike | undefined} getLlm - 取 LLM 服务
 * @returns {RouteProbe} 预检函数
 */
export const intRouteProbe = (getLlm: () => LlmLike | undefined): RouteProbe => async (route) => {
  const llm = getLlm()
  if (llm === undefined) return { ok: false, reason: 'llm-service-unavailable' }
  if (!llm.listProviders().some((provider) => provider.id === route.provider)) return { ok: false, reason: 'provider-not-configured' }
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const vision = info.inputModalities === undefined ? (getCatalogVision(route) ?? false) : info.inputModalities.includes('image')
    return { ok: true, vision }
  } catch (error) {
    return { ok: false, reason: `model-unavailable: ${getErrorText(error)}` }
  }
}
