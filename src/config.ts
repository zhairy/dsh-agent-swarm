import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_JEV_CONFIG, type JevConfigInfo } from './jev.js'
import { DEFAULT_BUDGETS, DEFAULT_TRIAGE_THRESHOLDS, type BudgetInfo, type TriageThresholdsInfo } from './policy.js'
import { DEFAULT_ESCALATION, DEFAULT_ROUTE_CHAINS, type EscalationKind, type RouteInfo, type RouteKey } from './routes.js'
import { readLiveObject } from './util/live.js'

const RouteSchema = Schema.object({
  provider: Schema.string().required().description('provider 路由名，例如 qwen-token-plan-cn'),
  model: Schema.string().required().description('模型 ID'),
  reasoningEffort: Schema.string().description('推理强度（可选）')
})

const RoleRouteSchema = Schema.object({
  chain: Schema.array(RouteSchema).default([]).description('路由链：首选 → 备用'),
  escalation: Schema.union(['codex', 'claude']).description('升级通道（可选）')
})

/** swarm-core 行的 Config；字段标记为 volatile，可被 DSH 配置编辑接口在线修改，读取时每次取最新值 */
export const Config = Schema.object({
  routes: Schema.dict(RoleRouteSchema).default({})
    .description('按角色覆盖路由链；键为角色 ID（算衡用 suan_heng:research / suan_heng:verify）；留空使用内置默认').volatile(),
  rootFallback: Schema.boolean().default(true).description('主会话模型致命失败时按角色链回退').volatile(),
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
    maxRetries: Schema.natural().default(2),
    maxCallsPerSession: Schema.natural().default(20),
    mathConfidence: Schema.number().default(0.6),
    benchmarkNoul: Schema.number().default(0.5),
    noveltyScore: Schema.number().default(1),
    noveltyConfidence: Schema.number().default(0.5)
  }).default({}).description('衡鉴 Jev 分流').volatile(),
  budgets: Schema.object({
    maxDelegationsPerTask: Schema.natural().default(20),
    maxCallsPerRole: Schema.natural().default(4),
    maxCallsZhuJian: Schema.natural().default(6),
    maxAutoFixRounds: Schema.natural().default(2),
    delegationTimeoutMs: Schema.natural().default(1800000)
  }).default({}).description('预算').volatile(),
  ledgerDir: Schema.string().default('').description('账本目录；留空为 <DSH_HOME>/share/dsh-agent-swarm/ledger').volatile()
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
}

/** 合并默认值后的完整配置 */
export interface SwarmConfigInfo {
  routes: Partial<Record<RouteKey, RoleRouteInfo>>
  rootFallback: boolean
  nativeEscalation: 'manual' | 'auto'
  native: NativeConfigInfo
  jev: JevConfigInfo
  thresholds: TriageThresholdsInfo
  budgets: BudgetInfo
  ledgerDir: string
}

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

const getRouteOverrides = (raw: unknown): Partial<Record<RouteKey, RoleRouteInfo>> => {
  const entries = Object.entries(asRecord(raw)).flatMap(([key, value]): Array<[RouteKey, RoleRouteInfo]> => {
    if (!(ROUTE_KEYS as readonly string[]).includes(key)) return []
    const record = asRecord(value)
    if (!Array.isArray(record.chain) || !record.chain.every(isRoute)) return []
    const chain = record.chain.map((route: RouteInfo) => ({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort })
    }))
    const escalation = record.escalation === 'codex' || record.escalation === 'claude' ? record.escalation : undefined
    return [[key as RouteKey, escalation === undefined ? { chain } : { chain, escalation }]]
  })
  return Object.fromEntries(entries)
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
    nativeEscalation: plain.nativeEscalation === 'auto' ? 'auto' : 'manual',
    native: getMerged(DEFAULT_NATIVE_CONFIG, plain.native),
    jev: getMerged(DEFAULT_JEV_CONFIG, plain.jev),
    thresholds: getMerged(DEFAULT_TRIAGE_THRESHOLDS, plain.jev),
    budgets: getMerged(DEFAULT_BUDGETS, plain.budgets),
    ledgerDir: typeof plain.ledgerDir === 'string' ? plain.ledgerDir : ''
  }
}

/**
 * 取某路由键的有效路由：用户覆盖（非空链）优先，否则用内置默认；升级通道同理
 * @param {SwarmConfigInfo} config - 配置
 * @param {RouteKey} key - 路由键
 * @returns {RoleRouteInfo} 路由
 */
export const getRoleRoute = (config: SwarmConfigInfo, key: RouteKey): RoleRouteInfo => {
  const override = config.routes[key]
  const chain = override !== undefined && override.chain.length > 0 ? override.chain : [...DEFAULT_ROUTE_CHAINS[key]]
  const escalation = override?.escalation ?? DEFAULT_ESCALATION[key]
  return escalation === undefined ? { chain } : { chain, escalation }
}
