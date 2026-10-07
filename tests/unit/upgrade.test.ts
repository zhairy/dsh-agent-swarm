import { describe, expect, it } from 'vitest'
import { getRoleRoute, getSwarmConfig } from '../../src/config.js'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'
import {
  DEFAULT_UPGRADES,
  UPGRADEABLE_KEYS,
  UPGRADE_TRIGGERS,
  UPGRADE_TRIGGER_LABELS,
  getConflictReason,
  getUpgradeReasons,
  getUpgradedChain,
  type UpgradeInfo
} from '../../src/upgrade.js'

const makeTask = (flags: Record<string, boolean>, extra: Partial<TaskRecord> = {}, perf?: Record<string, unknown>): TaskRecord => {
  const card = ValidateTaskCard({ title: 't', goal: 'g', acceptance: ['a'], flags, ...(perf === undefined ? {} : { perf }) }).card as TaskCard
  return { taskId: 'T-1', sessionId: 's', card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1, ...extra }
}

const delegation = (patch: Partial<DelegationRecord>): DelegationRecord => ({
  delegationId: 'D-1', taskId: 'T-1', role: 'fu_he', roleName: 'x', status: 'completed', summary: '', evidence: [], attempts: [],
  independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 1, ...patch
})

const all: UpgradeInfo = { enabled: true, chain: [{ provider: 'codex', model: 'gpt-6-astra' }], triggers: [...UPGRADE_TRIGGERS] }

describe('容灾升级：触发条件', () => {
  it('每个触发条件都有中文说明；可升级角色都在路由表中', () => {
    for (const trigger of UPGRADE_TRIGGERS) expect(UPGRADE_TRIGGER_LABELS[trigger]).toBeTruthy()
    for (const key of UPGRADEABLE_KEYS) expect(DEFAULT_ROUTE_CHAINS[key]).toBeDefined()
    for (const key of Object.keys(DEFAULT_UPGRADES)) expect(UPGRADEABLE_KEYS).toContain(key)
  })

  it('未配置、停用或升级链为空时不触发', () => {
    const ctx = { task: makeTask({ ambiguousRequirements: true }), delegations: [], explicit: true }
    expect(getUpgradeReasons(undefined, ctx)).toEqual([])
    expect(getUpgradeReasons({ ...all, enabled: false }, ctx)).toEqual([])
    expect(getUpgradeReasons({ ...all, chain: [] }, ctx)).toEqual([])
  })

  it('任务卡标志与性能预算按所选触发条件命中；未选的条件不命中', () => {
    const task = makeTask({ ambiguousRequirements: true, touchesFinancialLogic: true, crossModuleArchitecture: true, sharedStateConcurrency: true, stateMachine: true, changesAlgorithm: true, securitySensitive: true }, {}, { p95Ms: 20 })
    expect(getUpgradeReasons(all, { task, delegations: [] })).toEqual([
      '需求高歧义', '核心交易或金融逻辑', '跨模块架构或大范围重构', '并发一致性或共享状态', '复杂状态机', '改变算法语义', '安全敏感', '有性能预算'
    ])
    expect(getUpgradeReasons({ ...all, triggers: ['security'] }, { task, delegations: [] })).toEqual(['安全敏感'])
    expect(getUpgradeReasons({ ...all, triggers: [] }, { task: makeTask({}), delegations: [], explicit: true })).toEqual(['天枢显式要求升级'])
  })

  it('结论冲突：验算反例、御史 critical、复核失败；未完成的委派不算', () => {
    const refuted = delegation({ delegationId: 'D-2', role: 'suan_heng', mode: 'verify', structured: { claims: [{ status: 'refuted' }] } })
    const critical = delegation({ delegationId: 'D-3', role: 'yu_shi', structured: { findings: [{ severity: 'critical' }] } })
    const failed = delegation({ delegationId: 'D-4', role: 'fu_he', structured: { verdict: 'fail' } })
    expect(getConflictReason([refuted])).toContain('D-2')
    expect(getConflictReason([critical])).toContain('critical')
    expect(getConflictReason([failed])).toContain('复核')
    expect(getConflictReason([{ ...refuted, status: 'running' }, delegation({ role: 'yu_shi', structured: { findings: [{ severity: 'high' }] } })])).toBeUndefined()
    expect(getUpgradeReasons({ ...all, triggers: ['conflict'] }, { task: makeTask({}), delegations: [failed] })[0]).toMatch(/^结论冲突：/)
  })

  it('重试：任务被打回，或同一角色（算衡按模式）此前失败/被拦', () => {
    const retry: UpgradeInfo = { ...all, triggers: ['retry'] }
    expect(getUpgradeReasons(retry, { task: makeTask({}, { rounds: 1 }), delegations: [] })).toHaveLength(1)
    const failedVerify = delegation({ role: 'suan_heng', mode: 'verify', status: 'failed' })
    expect(getUpgradeReasons(retry, { task: makeTask({}), delegations: [failedVerify], role: 'suan_heng', mode: 'verify' })).toHaveLength(1)
    expect(getUpgradeReasons(retry, { task: makeTask({}), delegations: [failedVerify], role: 'suan_heng', mode: 'research' })).toEqual([])
    expect(getUpgradeReasons(retry, { task: makeTask({}), delegations: [delegation({ role: 'zhu_jian', status: 'blocked' })], role: 'zhu_jian' })).toHaveLength(1)
  })

  it('升级链在前、常规链在后并去重', () => {
    const a = { provider: 'codex', model: 'gpt-6-astra' }
    const b = { provider: 'claude', model: 'claude-opus-5-5' }
    expect(getUpgradedChain([a, b], [b, { provider: 'x', model: 'y' }])).toEqual([a, b, { provider: 'x', model: 'y' }])
  })
})

describe('容灾升级：配置', () => {
  it('默认：天枢、谋定、铸剑、算衡·验算有升级；其余角色没有', () => {
    const config = getSwarmConfig({})
    expect(getRoleRoute(config, 'tian_shu').upgrade?.chain[0]).toEqual({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' })
    expect(getRoleRoute(config, 'zhu_jian').upgrade?.chain[0]).toEqual({ provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'xhigh' })
    expect(getRoleRoute(config, 'suan_heng:verify').upgrade?.triggers).toEqual(['conflict', 'lowConfidence'])
    expect(getRoleRoute(config, 'shu_ji').upgrade).toBeUndefined()
    expect(getRoleRoute(config, 'fu_he').upgrade).toBeUndefined()
  })

  it('用户覆盖：可停用、可替换；只覆盖升级时常规链沿用默认；执行类角色的升级被忽略', () => {
    const config = getSwarmConfig({
      routes: {
        tian_shu: { upgrade: { enabled: false, chain: [{ provider: 'codex', model: 'gpt-6-astra' }], triggers: ['conflict'] } },
        shu_ji: { chain: [{ provider: 'q', model: 'm' }], upgrade: { chain: [{ provider: 'claude', model: 'claude-opus-5-5' }], triggers: ['conflict', 'bogus', 'conflict'] } },
        fu_he: { upgrade: { chain: [{ provider: 'codex', model: 'gpt-6-astra' }], triggers: ['retry'] } }
      }
    })
    expect(config.routes.tian_shu?.upgrade?.enabled).toBe(false)
    expect(getRoleRoute(config, 'tian_shu')).toEqual({ chain: [...DEFAULT_ROUTE_CHAINS.tian_shu] })
    expect(getRoleRoute(config, 'shu_ji').upgrade).toEqual({ enabled: true, chain: [{ provider: 'claude', model: 'claude-opus-5-5' }], triggers: ['conflict'] })
    expect(getRoleRoute(config, 'shu_ji').chain).toEqual([{ provider: 'q', model: 'm' }])
    expect(config.routes.fu_he).toBeUndefined()
  })
})
