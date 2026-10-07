import type { DelegationRecord, TaskRecord } from './evidence.js'
import { hasPerfBudget } from './policy.js'
import type { SuanHengMode } from './role-registry.js'
import { PROVIDER_CLAUDE, PROVIDER_CODEX, PROVIDER_DS, PROVIDER_QWEN, type RouteInfo, type RouteKey } from './routes.js'

/**
 * 容灾升级：命中高风险 / 高歧义条件时，先改用更强的「升级模型」，失败再回到常规路由链。
 * 与 escalation（Codex/Claude Code 原生客户端）是两套机制：这里只是换一条 API 路由。
 */

/** 可选的触发条件（天枢在 swarm_delegate / swarm_task_card 里显式要求升级时总会触发，不在此列） */
export const UPGRADE_TRIGGERS = [
  'ambiguous', 'conflict', 'lowConfidence', 'financial', 'crossModule', 'concurrency', 'stateMachine', 'algorithm', 'security', 'perf', 'retry'
] as const
export type UpgradeTrigger = typeof UPGRADE_TRIGGERS[number]

/** 触发条件的中文说明（设置页与结果文本共用） */
export const UPGRADE_TRIGGER_LABELS: Readonly<Record<UpgradeTrigger, string>> = {
  ambiguous: '需求高歧义',
  conflict: '结论冲突（验算反例 / 御史严重发现 / 复核失败）',
  lowConfidence: '衡鉴复评存疑（Jev 判定交付可信度不足）',
  financial: '核心交易或金融逻辑',
  crossModule: '跨模块架构或大范围重构',
  concurrency: '并发一致性或共享状态',
  stateMachine: '复杂状态机',
  algorithm: '改变算法语义',
  security: '安全敏感',
  perf: '有性能预算',
  retry: '同一角色此前失败或任务被打回'
}

/** 一个角色的容灾升级配置 */
export interface UpgradeInfo {
  enabled: boolean
  /** 升级模型链：按顺序尝试，全部不可用时回到常规路由链 */
  chain: RouteInfo[]
  triggers: UpgradeTrigger[]
}

/** 可以配置容灾升级的角色：只有承担判断或复杂实现的角色需要，执行类角色不提供 */
export const UPGRADEABLE_KEYS: readonly RouteKey[] = ['tian_shu', 'mou_ding', 'shu_ji', 'suan_heng:verify', 'zhu_jian', 'yu_shi']

const route = (provider: string, model: string, reasoningEffort?: string): RouteInfo => ({ provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })

/** 默认容灾升级：天枢、谋定 → GPT-6 Astra；铸剑 → Claude Opus 5.5；算衡·验算在冲突时换第三方裁决 */
export const DEFAULT_UPGRADES: Readonly<Partial<Record<RouteKey, UpgradeInfo>>> = {
  tian_shu: {
    enabled: true,
    chain: [route(PROVIDER_CODEX, 'gpt-6-astra', 'max'), route(PROVIDER_CLAUDE, 'claude-opus-5-5', 'max')],
    triggers: ['ambiguous', 'conflict', 'lowConfidence', 'financial', 'crossModule', 'concurrency']
  },
  mou_ding: {
    enabled: true,
    chain: [route(PROVIDER_CODEX, 'gpt-6-astra', 'max')],
    triggers: ['ambiguous', 'crossModule', 'conflict', 'lowConfidence', 'retry']
  },
  zhu_jian: {
    enabled: true,
    chain: [route(PROVIDER_CLAUDE, 'claude-opus-5-5', 'xhigh'), route(PROVIDER_CODEX, 'gpt-6-astra', 'xhigh')],
    triggers: ['crossModule', 'concurrency', 'financial', 'stateMachine', 'perf', 'lowConfidence', 'retry']
  },
  'suan_heng:verify': {
    enabled: true,
    chain: [route(PROVIDER_QWEN, 'deepseek-v4.1-flash', 'max'), route(PROVIDER_QWEN, 'qwen3.8-max', 'xhigh'), route(PROVIDER_DS, 'deepseek-flash', 'max')],
    triggers: ['conflict', 'lowConfidence']
  }
}

export const isUpgradeTrigger = (value: unknown): value is UpgradeTrigger => (UPGRADE_TRIGGERS as readonly unknown[]).includes(value)

const isCompleted = (d: DelegationRecord): boolean => d.status === 'completed'

const getItems = (d: DelegationRecord, key: string): Array<Record<string, unknown>> => {
  const items = (d.structured as Record<string, unknown> | undefined)?.[key]
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>) : []
}

/**
 * 本任务的证据里是否出现结论冲突：验算给出反例、御史给出严重发现、复核判定失败
 * @param {DelegationRecord[]} delegations - 本任务的委派
 * @returns {string | undefined} 冲突说明
 */
export const getConflictReason = (delegations: DelegationRecord[]): string | undefined => {
  const done = delegations.filter(isCompleted)
  const refuted = done.filter((d) => d.role === 'suan_heng' && d.mode === 'verify' && getItems(d, 'claims').some((c) => c.status === 'refuted'))
  if (refuted.length > 0) return `验算 ${refuted.map((d) => d.delegationId).join('、')} 给出反例`
  const critical = done.filter((d) => d.role === 'yu_shi' && getItems(d, 'findings').some((f) => f.severity === 'critical'))
  if (critical.length > 0) return `御史 ${critical.map((d) => d.delegationId).join('、')} 给出 critical 发现`
  const failed = done.filter((d) => d.role === 'fu_he' && (d.structured as { verdict?: unknown } | undefined)?.verdict === 'fail')
  if (failed.length > 0) return `复核 ${failed.map((d) => d.delegationId).join('、')} 判定失败`
  return undefined
}

/** 判定升级时需要的上下文 */
export interface UpgradeContextInfo {
  task: TaskRecord
  delegations: DelegationRecord[]
  /** 天枢显式要求升级 */
  explicit?: boolean
  /** 委派时：本次角色与算衡模式，用于判断「同一角色此前失败」 */
  role?: string
  mode?: SuanHengMode
}

/**
 * 计算应当触发升级的原因；空数组表示不升级
 * @param {UpgradeInfo | undefined} upgrade - 角色的升级配置
 * @param {UpgradeContextInfo} ctx - 任务上下文
 * @returns {string[]} 触发原因（中文）
 */
export const getUpgradeReasons = (upgrade: UpgradeInfo | undefined, ctx: UpgradeContextInfo): string[] => {
  if (upgrade === undefined || !upgrade.enabled || upgrade.chain.length === 0) return []
  const f = ctx.task.card.flags
  const reasons: string[] = []
  if (ctx.explicit === true) reasons.push('天枢显式要求升级')
  const hit = (trigger: UpgradeTrigger, matched: boolean, detail?: string): void => {
    if (matched && upgrade.triggers.includes(trigger)) reasons.push(detail ?? UPGRADE_TRIGGER_LABELS[trigger])
  }
  hit('ambiguous', f.ambiguousRequirements)
  hit('financial', f.touchesFinancialLogic || f.timeSeriesOrBacktest)
  hit('crossModule', f.crossModuleArchitecture)
  hit('concurrency', f.sharedStateConcurrency)
  hit('stateMachine', f.stateMachine)
  hit('algorithm', f.changesAlgorithm)
  hit('security', f.securitySensitive)
  hit('perf', hasPerfBudget(ctx.task.card.perf))
  const conflict = upgrade.triggers.includes('conflict') ? getConflictReason(ctx.delegations) : undefined
  hit('conflict', conflict !== undefined, conflict === undefined ? undefined : `结论冲突：${conflict}`)
  // 委派时只看同一角色（算衡按模式）此前被判存疑的交付；天枢看本任务的全部委派
  const doubtful = ctx.delegations.filter((d) => d.assessment?.verdict === 'doubtful'
    && (ctx.role === undefined || (d.role === ctx.role && (ctx.mode === undefined || d.mode === ctx.mode))))
  hit('lowConfidence', doubtful.length > 0, `衡鉴复评存疑：${doubtful.map((d) => d.delegationId).join('、')}`)
  const retried = ctx.task.rounds > 0 || (ctx.role !== undefined && ctx.delegations.some((d) =>
    d.role === ctx.role && (ctx.mode === undefined || d.mode === ctx.mode) && (d.status === 'failed' || d.status === 'blocked')))
  hit('retry', retried)
  return reasons
}

/**
 * 升级链在前、常规链在后，去掉重复路由
 * @param {RouteInfo[]} upgrade - 升级链
 * @param {readonly RouteInfo[]} chain - 常规链
 * @returns {RouteInfo[]} 合并后的链
 */
export const getUpgradedChain = (upgrade: readonly RouteInfo[], chain: readonly RouteInfo[]): RouteInfo[] => {
  const out: RouteInfo[] = []
  for (const item of [...upgrade, ...chain]) {
    if (!out.some((r) => r.provider === item.provider && r.model === item.model)) out.push(item)
  }
  return out
}
