import type { LlmFailureLike, LlmLike } from './host-contract.js'
import type { RoleId, SuanHengMode } from './role-registry.js'
import { getErrorText } from './util/errors.js'
import { normalizeRouteFailure, getRouteFailure, getRouteResourcePolicy, getWireReasoningEffort, type RouteResourcePolicy } from './provider-policy.js'

export const PROVIDER_QWEN = 'qwen-token-plan-cn'
export const PROVIDER_GO = 'opencode-go'
export const PROVIDER_DS = 'deepseek-official'
/** dsh-plugin-subscriptions 提供的订阅 provider：ChatGPT（Codex）与 Claude */
export const PROVIDER_CODEX = 'codex'
export const PROVIDER_CLAUDE = 'claude'

/** 一条模型路由 */
export interface RouteInfo {
  provider: string
  model: string
  reasoningEffort?: string
  policy?: RouteResourcePolicy
}

/** 路由表的键：算衡按模式拆成两条 */
export type RouteKey = Exclude<RoleId, 'suan_heng'> | 'suan_heng:research' | 'suan_heng:verify'
export type EscalationKind = 'codex' | 'claude'
export type ModelFamily = 'deepseek' | 'qwen' | 'kimi' | 'glm' | 'minimax' | 'mimo' | 'gpt' | 'grok' | 'claude' | 'hunyuan' | 'longcat' | 'muse' | 'other'

type CatalogInfo = Readonly<Record<string, { vision: boolean }>>

/** pi-ai 0.87.1 内置的 qwen-token-plan-cn 目录（DSH 0.1.7 自带 0.85.1，本机已替换为 0.87.1） */
export const QWEN_TOKEN_PLAN_MODELS: CatalogInfo = {
  'MiniMax-M2.5': { vision: false },
  'deepseek-v3.2': { vision: false },
  'deepseek-v4-flash': { vision: false },
  'deepseek-v4-flash-0731': { vision: false },
  'deepseek-v4-pro': { vision: false },
  'deepseek-v4-pro-0813': { vision: false },
  'deepseek-v4.1-flash': { vision: true },
  'glm-5': { vision: false },
  'glm-5.1': { vision: false },
  'glm-5.2': { vision: false },
  'glm-5.3': { vision: false },
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

/** pi-ai 0.87.1 内置的 opencode-go 目录 */
export const OPENCODE_GO_MODELS: CatalogInfo = {
  'minimax-m3': { vision: true },
  'qwen3.8-flash': { vision: true },
  'deepseek-v4-flash': { vision: false },
  'deepseek-v4-flash-vision-exp': { vision: true },
  'deepseek-v4-pro': { vision: false },
  'deepseek-v4.1-flash': { vision: true },
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
  'mimo-v2.6-flash': { vision: true },
  'mimo-v2.6-pro': { vision: false },
  'minimax-m2.7': { vision: false },
  'omen-alpha': { vision: true },
  'qwen3.6-plus': { vision: true },
  'qwen3.7-max': { vision: false },
  'qwen3.7-plus': { vision: true },
  'qwen3.8-max': { vision: true },
  'gpt-5.6-luna': { vision: true },
  'grok-4.6': { vision: true },
  'grok-4.7': { vision: true },
  'muse-spark-1.2-contributor': { vision: true },
  'muse-spark-1.3-contributor': { vision: true }
}

/** DSH 0.1.7 原生 DeepSeek 适配器目录（deepseek-flash 即 DeepSeek V4.1 Flash） */
export const DEEPSEEK_OFFICIAL_MODELS: CatalogInfo = {
  'deepseek-flash': { vision: true },
  'deepseek-v4-pro': { vision: false }
}

/** 两个订阅都有的模型：一律 qwen-token-plan-cn 优先、opencode-go 备用 */
export const QWEN_PREFERRED_MODELS: readonly string[] = Object.keys(QWEN_TOKEN_PLAN_MODELS).filter((model) => model in OPENCODE_GO_MODELS)

const q = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_QWEN, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const g = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_GO, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const d = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_DS, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const o = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_CODEX, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
const c = (model: string, reasoningEffort?: string): RouteInfo => ({ provider: PROVIDER_CLAUDE, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })

/**
 * 常用模型的路由。同一模型先消耗订阅额度：qwen-token-plan-cn → opencode-go，
 * DeepSeek 官方 API 按量计费，只作兜底；其余额与上游限速仍可能导致失败。
 */
/** 各模型的路由；推理等级按角色需要传入（每个模型支持的档位见 MODEL_REASONING_EFFORTS） */
const astra = (effort: string): RouteInfo => o('gpt-6-astra', effort)
const sol = (effort: string): RouteInfo => o('gpt-6-sol', effort)
const opus = (effort: string): RouteInfo => c('claude-opus-5-5', effort)
const sonnet = (effort: string): RouteInfo => c('claude-sonnet-5', effort)
const dsFlash = (effort: string): RouteInfo => q('deepseek-v4.1-flash', effort)
const qwenMax = (effort: string): RouteInfo => q('qwen3.8-max', effort)
const qwenFlash = (effort: string): RouteInfo => q('qwen3.8-flash', effort)
const mimoPro = (effort: string): RouteInfo => g('mimo-v2.6-pro', effort)
const mimoFlash = (effort: string): RouteInfo => g('mimo-v2.6-flash', effort)
const minimax = (effort: string): RouteInfo => g('minimax-m3', effort)
/**
 * 兜底层：DeepSeek 官方 API（deepseek-flash 即 V4.1 Flash）。
 * V4.1 Flash 的评测不低于 V4 Pro（含 0813），价格约为其 1/4，且支持图片输入，所以默认链不再使用 V4 Pro；
 * V4 Pro 仍保留在目录里，可在设置页手动选用。
 */
const lastFlash = (effort: string): RouteInfo => d('deepseek-flash', effort)

/**
 * DSH 模型目录为各模型声明的推理档位（2026-09-24 从 Web 端实时目录读取）。
 * 路由里写了目录不支持的档位，请求会被拒绝、整层被跳过，单元测试据此逐条检查默认配置。
 */
export const MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly string[]>> = {
  [`${PROVIDER_CODEX}/gpt-6-astra`]: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  [`${PROVIDER_CODEX}/gpt-6-sol`]: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  [`${PROVIDER_CLAUDE}/claude-opus-5-5`]: ['low', 'medium', 'high', 'xhigh', 'max'],
  [`${PROVIDER_CLAUDE}/claude-sonnet-5`]: ['low', 'medium', 'high', 'xhigh', 'max'],
  [`${PROVIDER_QWEN}/deepseek-v4-pro`]: ['high', 'max'],
  [`${PROVIDER_QWEN}/deepseek-v4.1-flash`]: ['low', 'high', 'max'],
  [`${PROVIDER_QWEN}/qwen3.8-max`]: ['low', 'medium', 'xhigh'],
  [`${PROVIDER_QWEN}/qwen3.8-flash`]: ['low', 'medium', 'xhigh'],
  [`${PROVIDER_QWEN}/glm-5.3`]: ['low', 'high', 'max'],
  [`${PROVIDER_GO}/mimo-v2.6-pro`]: ['off', 'minimal', 'low', 'medium', 'high'],
  [`${PROVIDER_GO}/mimo-v2.6-flash`]: ['off', 'minimal', 'low', 'medium', 'high'],
  [`${PROVIDER_GO}/muse-spark-1.3-contributor`]: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  [`${PROVIDER_GO}/minimax-m3`]: ['off', 'minimal', 'low', 'medium', 'high'],
  [`${PROVIDER_GO}/kimi-k2.7-code`]: ['off', 'minimal', 'low', 'medium', 'high'],
  [`${PROVIDER_DS}/deepseek-v4-pro`]: ['off', 'low', 'high', 'max'],
  [`${PROVIDER_DS}/deepseek-flash`]: ['off', 'low', 'high', 'max']
}

/**
 * 默认路由链（主模型 → 备用 1 → 备用 2 → 兜底），见 docs/角色.md。
 * 前三层按「角色 → 能力 → 模型」建议配置；第四层统一是 DeepSeek 官方 API 兜底。
 * 推理等级按角色分三档：判断与验证类取该模型的高档（xhigh/max），执行类取低档保速度，
 * 资料、视觉、文案取中档；同一角色在不同模型上取各自最接近的档位。
 */
export const DEFAULT_ROUTE_CHAINS: Readonly<Record<RouteKey, readonly RouteInfo[]>> = {
  tian_shu: [sol('high'), dsFlash('high'), opus('high'), lastFlash('high')],
  mou_ding: [dsFlash('high'), sol('high'), qwenMax('xhigh'), lastFlash('high')],
  shu_ji: [opus('xhigh'), sol('xhigh'), dsFlash('max'), lastFlash('max')],
  'suan_heng:research': [astra('max'), dsFlash('max'), qwenMax('xhigh'), lastFlash('max')],
  'suan_heng:verify': [opus('max'), mimoPro('high'), qwenMax('xhigh'), lastFlash('max')],
  tan_wei: [qwenFlash('low'), mimoFlash('low'), g('muse-spark-1.3-contributor', 'low'), lastFlash('low')],
  bo_wen: [qwenMax('medium'), minimax('medium'), sol('medium'), lastFlash('high')],
  guan_xiang: [qwenMax('medium'), dsFlash('high'), minimax('medium'), lastFlash('high')],
  zhu_jian: [sonnet('high'), dsFlash('high'), g('kimi-k2.7-code', 'high'), lastFlash('high')],
  xing_zhou: [dsFlash('low'), qwenFlash('low'), mimoFlash('low'), lastFlash('low')],
  ji_feng: [dsFlash('high'), mimoFlash('medium'), qwenFlash('medium'), lastFlash('high')],
  yu_shi: [sol('xhigh'), qwenMax('xhigh'), mimoPro('high'), lastFlash('max')],
  fu_he: [qwenFlash('medium'), dsFlash('high'), mimoFlash('medium'), lastFlash('high')],
  miao_bi: [qwenMax('medium'), sonnet('medium'), sol('medium'), lastFlash('low')]
}

/** 默认原生升级通道（Codex/Claude Code 原生客户端）：只在显式要求或 nativeEscalation=auto 且高风险时使用 */
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

/** 供应商的中文名称（聊天窗口与委派结果中显示） */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  [PROVIDER_CODEX]: 'ChatGPT 订阅',
  [PROVIDER_CLAUDE]: 'Claude 订阅',
  [PROVIDER_QWEN]: '阿里云百炼 Token Plan',
  [PROVIDER_GO]: 'OpenCode Go',
  [PROVIDER_DS]: 'DeepSeek 官方 API'
}

/**
 * 「模型 · 供应商」的显示文本，例如 `claude-opus-5-5 · Claude 订阅（claude）`
 * @param {RouteInfo} route - 路由
 * @returns {string} 显示文本
 */
export const getRouteDisplay = (route: RouteInfo): string => {
  const label = PROVIDER_LABELS[route.provider]
  const effort = route.reasoningEffort === undefined ? '' : ` · 推理 ${route.reasoningEffort}`
  return `${route.model} · ${label === undefined ? route.provider : `${label}（${route.provider}）`}${effort}`
}

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
  [/^longcat/, 'longcat'],
  [/^muse/, 'muse']
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

/** Codex / Claude 订阅的主力模型（由订阅插件实时发现，这里只作视觉能力的兜底判断） */
export const CODEX_MODELS: CatalogInfo = {
  'gpt-6-astra': { vision: true },
  'gpt-6-sol': { vision: true },
  'gpt-6-luna': { vision: true }
}
export const CLAUDE_MODELS: CatalogInfo = {
  'claude-opus-5-5': { vision: true },
  'claude-sonnet-5': { vision: true }
}

const CATALOG_BY_PROVIDER: Readonly<Record<string, CatalogInfo>> = {
  [PROVIDER_QWEN]: QWEN_TOKEN_PLAN_MODELS,
  [PROVIDER_CODEX]: CODEX_MODELS,
  [PROVIDER_CLAUDE]: CLAUDE_MODELS,
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
  // 各层预检互不依赖：并行执行，按链的顺序取结果
  const results = await Promise.all(chain.map((route) => options.probe(route)))
  for (const [index, route] of chain.entries()) {
    const result = results[index] as RouteProbeResult
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
const TRANSIENT_CODES = new Set(['RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'TRANSPORT', 'OVERLOADED', 'SERVER_ERROR', 'SERVER', 'EMPTY_RESPONSE'])
/** 账号未开通该模型：只影响这个模型，不能按认证失败把整个 provider 跳过 */
const UNPURCHASED_MESSAGE = /Unpurchased|Access to model denied|not eligible for (using )?(this|the) model/i

/**
 * 对模型请求失败分类，决定是否换路由
 * @param {LlmFailureLike | undefined} failure - 失败信息
 * @returns {FailureClass} 分类
 */
export const getFailureClass = (failure: LlmFailureLike | undefined): FailureClass => {
  if (failure === undefined) return 'other'
  const code = String(failure.code ?? '').toUpperCase()
  const status = failure.status ?? 0
  const normalized = normalizeRouteFailure(failure, { provider: '', model: '' })
  if (normalized.kind === 'auth_invalid') return 'auth'
  if (normalized.kind === 'context_exceeded') return 'other'
  if (normalized.kind === 'capability_mismatch') return 'route-fatal'
  if (['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'model_unavailable'].includes(normalized.kind)) return 'route-fatal'
  if (UNPURCHASED_MESSAGE.test(failure.message ?? '')) return 'route-fatal'
  if (AUTH_CODES.has(code) || status === 401 || status === 403) return 'auth'
  if (ROUTE_FATAL_CODES.has(code)) return 'route-fatal'
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

/** 预检结果缓存：可用结果缓存较久，失败结果很快过期，故障恢复后能及时重新启用 */
export const PROBE_OK_TTL_MS = 120_000
export const PROBE_FAIL_TTL_MS = 15_000

/**
 * 基于 ctx.llm 的路由预检：provider 已注册且模型可解析。
 * 订阅类 provider 解析模型可能要访问网络（实测单次 2–3 秒），结果按路由短时缓存，并发的同一预检共用一次调用
 * @param {() => LlmLike | undefined} getLlm - 取 LLM 服务
 * @param {{ now?: () => number }} [options] - 时钟
 * @returns {RouteProbe} 预检函数
 */
export const intRouteProbe = (getLlm: () => LlmLike | undefined, options: {
  now?: () => number
  isRouteAvailable?: (route: RouteInfo) => boolean
  onFailure?: (route: RouteInfo, failure: LlmFailureLike) => void | Promise<void>
} = {}): RouteProbe => {
  const now = options.now ?? Date.now
  const cache = new Map<string, { at: number; result: RouteProbeResult }>()
  const pending = new Map<string, Promise<RouteProbeResult>>()
  const ProbeRoute = async (route: RouteInfo): Promise<RouteProbeResult> => {
    const llm = getLlm()
    if (llm === undefined) return { ok: false, reason: 'llm-service-unavailable' }
    if (!llm.listProviders().some((provider) => provider.id === route.provider)) return { ok: false, reason: 'provider-not-configured' }
    try {
      const resource = getRouteResourcePolicy(route)
      if (resource.accessMode === 'judgment_api' || resource.capabilities?.generation === false || resource.capabilities?.tools === false) return { ok: false, reason: 'capability-incompatible: generation-tools-unavailable' }
      const info = await llm.resolveModelInfo(route.provider, route.model)
      const effort = getWireReasoningEffort(route)
      if (llm.resolveCallConfig !== undefined) await llm.resolveCallConfig({ provider: route.provider, model: route.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
      else if (effort !== undefined && !info.reasoning?.efforts.some((item) => item.id === effort)) return { ok: false, reason: 'capability-incompatible: unsupported-reasoning-effort' }
      const observedVision = info.inputModalities === undefined ? (getCatalogVision(route) ?? false) : info.inputModalities.includes('image')
      const vision = observedVision && resource.capabilities?.vision !== false
      return { ok: true, vision }
    } catch (error) {
      const failure = getRouteFailure(error)
      if (normalizeRouteFailure(failure, route).kind === 'capability_mismatch') return { ok: false, reason: `capability-incompatible: ${getErrorText(error)}` }
      await options.onFailure?.(route, failure)
      if (options.isRouteAvailable?.(route) === false) return { ok: false, reason: 'route-isolated' }
      return { ok: false, reason: `model-unavailable: ${getErrorText(error)}` }
    }
  }
  return async (route) => {
    if (options.isRouteAvailable?.(route) === false) return { ok: false, reason: 'route-isolated' }
    const key = JSON.stringify([route.provider, route.model, getWireReasoningEffort(route) ?? null,
      route.policy?.quotaDomainId ?? null, route.policy?.poolId ?? null, route.policy?.capabilities ?? null])
    const hit = cache.get(key)
    if (hit !== undefined && now() - hit.at < (hit.result.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS)) return hit.result
    const running = pending.get(key)
    if (running !== undefined) return running
    const next = ProbeRoute(route).then((result) => {
      // 服务暂不可用（宿主刚启动）不缓存
      if (result.ok || result.reason !== 'llm-service-unavailable') cache.set(key, { at: now(), result })
      return result
    }).finally(() => pending.delete(key))
    pending.set(key, next)
    return next
  }
}
