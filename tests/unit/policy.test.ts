import { describe, expect, it } from 'vitest'
import {
  AddTriageGates,
  DEFAULT_BUDGETS,
  DEFAULT_TRIAGE_THRESHOLDS,
  ValidateDelegationBudget,
  ValidateTaskCard,
  getAcceptanceCheck,
  getEffectiveGates,
  getGateStatus,
  getRuleGates,
  getSuggestedRoles,
  hasPerfBudget,
  isTriageUseful,
  type GateDelegationView,
  type TaskCard
} from '../../src/policy.js'

const makeCard = (flags: Partial<TaskCard['flags']> = {}, extra: Partial<TaskCard> = {}): TaskCard => {
  const result = ValidateTaskCard({ title: '任务', goal: '目标', acceptance: ['通过测试'], scope: ['src/a.ts'], flags, ...extra })
  if (result.card === undefined) throw new Error(result.errors.join(';'))
  return result.card
}

const done = (partial: Partial<GateDelegationView> & Pick<GateDelegationView, 'role'>): GateDelegationView => ({
  delegationId: `D-${partial.role}-${partial.finishedAt ?? 1}`,
  status: 'completed',
  startedAt: partial.finishedAt ?? 1,
  finishedAt: 1,
  independence: 'n/a',
  ...partial
})

describe('ValidateTaskCard', () => {
  it('填充缺省标志并保留字段', () => {
    const card = makeCard({ changesCode: true }, { perf: { p95Ms: 50 }, constraints: { apiCompat: '保持' } })
    expect(card.flags.changesCode).toBe(true)
    expect(card.flags.hasVisualInput).toBe(false)
    expect(card.perf).toEqual({ p95Ms: 50 })
    expect(card.constraints).toEqual({ apiCompat: '保持' })
  })

  it('报告非法输入', () => {
    expect(ValidateTaskCard('x').errors).toEqual(['任务卡必须是对象'])
    const result = ValidateTaskCard({ title: '', goal: 1, acceptance: [], scope: 'x', flags: { nope: true, changesCode: 'y' }, perf: { p95Ms: {} }, constraints: { apiCompat: 1 } })
    expect(result.card).toBeUndefined()
    expect(result.errors).toEqual(expect.arrayContaining([
      'title 必须是非空字符串',
      'goal 必须是非空字符串',
      'acceptance 至少包含 1 条验收标准',
      'scope 必须是字符串数组',
      '未知风险标志 nope',
      'flags.changesCode 必须是布尔值',
      'perf.p95Ms 必须是数字或「待测」',
      'constraints.apiCompat 必须是字符串'
    ]))
  })

  it('性能预算：数字才算，「待测」不算', () => {
    expect(hasPerfBudget(undefined)).toBe(false)
    expect(hasPerfBudget({ p95Ms: '待测' })).toBe(false)
    expect(hasPerfBudget({ p99Ms: 20 })).toBe(true)
    expect(hasPerfBudget({ throughput: '1k/s' })).toBe(true)
  })
})

describe('规则门禁', () => {
  it('代码改动 → 复核', () => {
    expect(getRuleGates(makeCard({ changesCode: true })).map((g) => g.gate)).toEqual(['G_VERIFY'])
  })

  it('量化核心算法改动触发全套门禁', () => {
    const gates = getRuleGates(makeCard({ changesCode: true, changesAlgorithm: true, touchesFinancialLogic: true }, { perf: { p95Ms: 50 } }))
    expect(gates.map((g) => g.gate).sort()).toEqual(['G_BENCH', 'G_DIFF_TEST', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_REVIEW', 'G_VERIFY'])
    expect(gates.every((g) => g.source === 'rule')).toBe(true)
    expect(gates.find((g) => g.gate === 'G_MATH_VERIFY')).toMatchObject({ role: 'suan_heng', mode: 'verify' })
  })

  it('视觉输入 → 观象；纯文案无门禁', () => {
    expect(getRuleGates(makeCard({ hasVisualInput: true })).map((g) => g.gate)).toEqual(['G_VISION'])
    expect(getRuleGates(makeCard({ uiCopy: true }))).toEqual([])
  })

  it('何时值得调用 Jev', () => {
    expect(isTriageUseful(makeCard({ uiCopy: true }), [])).toBe(false)
    const card = makeCard({ changesCode: true })
    expect(isTriageUseful(card, getRuleGates(card))).toBe(true)
    const full = makeCard({ changesCode: true, changesAlgorithm: true, touchesFinancialLogic: true }, { perf: { p95Ms: 1 } })
    expect(isTriageUseful(full, getRuleGates(full))).toBe(false)
  })
})

describe('AddTriageGates', () => {
  const card = makeCard({ changesCode: true, changesAlgorithm: true })
  const base = getRuleGates(makeCard({ changesCode: true }))
  const th = DEFAULT_TRIAGE_THRESHOLDS

  it('Jev 只增加门禁', () => {
    const gates = AddTriageGates(base, card, { failed: false, answers: { mathTask: { choice: 'research', confidence: 0.9 }, needBenchmark: 0.7, novelty: { score: 1.6, confidence: 0.8 } } }, th)
    expect(gates.map((g) => g.gate).sort()).toEqual(['G_BENCH', 'G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_REVIEW', 'G_VERIFY'])
    expect(gates.filter((g) => g.source === 'jev')).toHaveLength(4)
  })

  it('ordinary 与低分不加门禁', () => {
    const gates = AddTriageGates(base, card, { failed: false, answers: { mathTask: { choice: 'ordinary', confidence: 0.9 }, needBenchmark: 0.1, novelty: { score: 0.2, confidence: 0.9 } } }, th)
    expect(gates.map((g) => g.gate)).toEqual(['G_VERIFY'])
  })

  it('失败或置信度低时，改算法任务走严格路径', () => {
    const failed = AddTriageGates(base, card, { failed: true, reason: 'http-529' }, th)
    expect(failed.filter((g) => g.source === 'jev-fallback').map((g) => g.gate).sort()).toEqual(['G_MATH_VERIFY', 'G_REVIEW'])
    expect(failed.find((g) => g.source === 'jev-fallback')?.reason).toContain('http-529')
    const lowConfidence = AddTriageGates(base, card, { failed: false, answers: { mathTask: { choice: 'invariant', confidence: 0.3 } } }, th)
    expect(lowConfidence.some((g) => g.gate === 'G_MATH_VERIFY' && g.source === 'jev-fallback')).toBe(true)
    const plain = makeCard({ changesCode: true })
    expect(AddTriageGates(base, plain, { failed: true }, th).map((g) => g.gate)).toEqual(['G_VERIFY'])
  })
})

describe('建议角色', () => {
  it('按标志与门禁给出建议且不重复', () => {
    const card = makeCard({ ambiguousRequirements: true, changesCode: true, needsExternalFacts: true, uiCopy: true, hasExecSteps: true, hasVisualInput: true, crossModuleArchitecture: true }, { scope: [] })
    const roles = getSuggestedRoles(card, getRuleGates(card)).map((s) => s.role)
    expect(roles).toEqual(expect.arrayContaining(['mou_ding', 'shu_ji', 'tan_wei', 'bo_wen', 'guan_xiang', 'miao_bi', 'zhu_jian', 'xing_zhou', 'fu_he', 'yu_shi']))
    expect(new Set(roles).size).toBe(roles.length)
    expect(getSuggestedRoles(makeCard({ changesCode: true }), []).map((s) => s.role)).toContain('ji_feng')
  })
})

describe('门禁判定', () => {
  const fuHePass = { verdict: 'pass', commands: [{ command: 'npm test', exitCode: 0, kind: 'unit', summary: 'ok' }] }

  it('G_VERIFY 需要在最后一次编辑之后的通过复核', () => {
    const edit = done({ role: 'ji_feng', finishedAt: 10 })
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', finishedAt: 5, structured: fuHePass })], []).satisfied).toBe(false)
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', finishedAt: 20, structured: fuHePass })], []).satisfied).toBe(true)
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', startedAt: 10, finishedAt: 10, structured: fuHePass })], []).satisfied).toBe(true)
    expect(getGateStatus('G_VERIFY', [edit, done({ role: 'fu_he', startedAt: 9, finishedAt: 30, structured: fuHePass })], []).satisfied).toBe(false)
    expect(getGateStatus('G_VERIFY', [done({ role: 'fu_he', finishedAt: 20, structured: { ...fuHePass, verdict: 'fail' } })], []).satisfied).toBe(false)
  })

  it('G_DIFF_TEST 与 G_BENCH 需要对应类别的命令', () => {
    const diff = done({ role: 'fu_he', structured: { verdict: 'pass', commands: [{ command: 'diff', exitCode: 0, kind: 'differential', summary: '0 mismatch' }] } })
    expect(getGateStatus('G_DIFF_TEST', [diff], []).satisfied).toBe(true)
    expect(getGateStatus('G_BENCH', [diff], []).satisfied).toBe(false)
    const bench = done({ role: 'fu_he', structured: { verdict: 'pass', commands: [{ command: 'bench', exitCode: 0, kind: 'benchmark', summary: 'p95=12ms' }] } })
    expect(getGateStatus('G_BENCH', [bench], []).satisfied).toBe(true)
  })

  it('G_REVIEW 要求处理全部 critical/high 发现', () => {
    const review = done({ role: 'yu_shi', delegationId: 'D-r', structured: { findings: [{ severity: 'high', location: 'a', issue: 'x', suggestion: 'y' }, { severity: 'low', location: 'b', issue: 'x', suggestion: 'y' }] } })
    const missing = getGateStatus('G_REVIEW', [review], [])
    expect(missing.satisfied).toBe(false)
    expect(missing.missing).toContain('D-r#0')
    expect(getGateStatus('G_REVIEW', [review], [{ delegationId: 'D-r', index: 0, resolution: '已修复' }]).satisfied).toBe(true)
  })

  it('算衡与观象门禁', () => {
    const research = done({ role: 'suan_heng', mode: 'research', structured: { invariants: ['x'], complexity: 'O(n)' } })
    expect(getGateStatus('G_MATH_RESEARCH', [research], []).satisfied).toBe(true)
    expect(getGateStatus('G_MATH_RESEARCH', [done({ role: 'suan_heng', mode: 'research', structured: { invariants: [] } })], []).satisfied).toBe(false)
    const verify = done({ role: 'suan_heng', mode: 'verify', independence: 'not-achieved' })
    const status = getGateStatus('G_MATH_VERIFY', [verify], [])
    expect(status.satisfied).toBe(true)
    expect(status.notes.join('')).toContain('独立性未实现')
    expect(getGateStatus('G_VISION', [done({ role: 'guan_xiang', status: 'blocked' })], []).satisfied).toBe(false)
    expect(getGateStatus('G_VISION', [done({ role: 'guan_xiang' })], []).satisfied).toBe(true)
  })

  it('getEffectiveGates 在出现编辑委派后补上 G_VERIFY；验收汇总缺失项', () => {
    const gates = getEffectiveGates([], [done({ role: 'zhu_jian' })])
    expect(gates.map((g) => g.gate)).toEqual(['G_VERIFY'])
    expect(getEffectiveGates(gates, [done({ role: 'zhu_jian' })])).toHaveLength(1)
    const check = getAcceptanceCheck(gates, [done({ role: 'zhu_jian' })], [])
    expect(check.ok).toBe(false)
    expect(check.missing[0]).toContain('G_VERIFY')
    expect(getAcceptanceCheck([], [], []).ok).toBe(true)
  })
})

describe('预算', () => {
  it('任务总数与角色次数上限', () => {
    const many = Array.from({ length: DEFAULT_BUDGETS.maxDelegationsPerTask }, () => done({ role: 'tan_wei' }))
    expect(ValidateDelegationBudget(many, 'fu_he', DEFAULT_BUDGETS)).toContain('上限')
    const four = Array.from({ length: 4 }, () => done({ role: 'fu_he' }))
    expect(ValidateDelegationBudget(four, 'fu_he', DEFAULT_BUDGETS)).toContain('「复核」')
    expect(ValidateDelegationBudget(four, 'zhu_jian', DEFAULT_BUDGETS)).toBeUndefined()
    const blocked = Array.from({ length: 4 }, () => done({ role: 'fu_he', status: 'blocked' }))
    expect(ValidateDelegationBudget(blocked, 'fu_he', DEFAULT_BUDGETS)).toBeUndefined()
  })
})
