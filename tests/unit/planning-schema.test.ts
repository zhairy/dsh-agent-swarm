import { describe, expect, it } from 'vitest'
import { ValidateTaskCard, getRuleGates } from '../../src/policy.js'
import {
  getPlanningReviewDiagnostics, getPlanningReviewPrompt, getPlanningReviewQuestions, getPlanningReviewSchema, getPlanningReviewState, getReviewSnapshot,
  RunPlanningReview, ValidatePlanningReviewResult, type PlanningReviewResult, type ReviewSnapshot
} from '../../src/planning-review.js'
import { getDefaultWorkflow, MERMAID_PARSER_VERSION } from '../../src/workflow.js'
import { ValidateJsonValue, type JsonSchemaObject } from '../../src/util/json-schema.js'

const snapshotFor = (taskId = 'T-1'): ReviewSnapshot => {
  const card = ValidateTaskCard({ title: '输入校验修复', goal: '检查规划输入并报告风险', acceptance: ['逐条核对需求与证据'], flags: {},
    planningScope: { kind: 'phase', deliverables: ['规划输入审查'], deferred: ['业务实现'], rationale: '先恢复规划准入' }
  }).card!
  const gates = getRuleGates(card)
  return getReviewSnapshot({ rootSessionId: 'root', workspaceId: 'work', taskId, requestRevision: 1,
    cardRevision: 1, workflowRevision: 1, requestText: '先检查规划输入，之后继续业务实现。禁止实盘。', requestSource: 'host',
    requestRefs: [{ source: `human-${taskId}`, text: '先检查规划输入' }], card, workflow: getDefaultWorkflow(card, gates), gates })
}

const goodResult = (snapshot: ReviewSnapshot): PlanningReviewResult => ({
  snapshotDigest: snapshot.snapshotDigest, verdict: 'pass',
  goalReview: { verdict: 'pass', summary: '本阶段回应输入，后续业务明确延期', evidenceRefs: ['request', 'R1', 'D1'] },
  designReview: { verdict: 'pass', summary: 'analysis 产生 A1 可核对的结论', evidenceRefs: ['analysis', 'A1'] },
  mermaidReview: { verdict: 'pass', summary: '图与分析和验收节点一致', evidenceRefs: ['workflow', 'mermaid'] },
  requirementCoverage: [{ requirementId: 'R1', covered: true, evidence: 'analysis 对照 A1 交付审查结论' },
    { requirementId: 'D1', covered: false, evidence: '业务实现明确留到后续阶段' }],
  findings: [], assumptions: [], unresolved: []
})

const property = (schema: JsonSchemaObject, name: string): JsonSchemaObject => {
  const value = schema.properties?.[name]
  if (value === undefined) throw new Error(`缺少 schema 字段 ${name}`)
  return value
}

describe('规划输出 schema 与宿主引用校验一致', () => {
  it('阶段与完整需求使用不同覆盖判据，完整任务不继承阶段要求', () => {
    const phase = snapshotFor()
    const { planningScope: _phase, ...card } = phase.card
    const whole = getReviewSnapshot({ ...phase, card, requirements: undefined })
    const phaseCoverage = getPlanningReviewQuestions(phase).requirement_coverage
    const wholeCoverage = getPlanningReviewQuestions(whole).requirement_coverage
    expect(phaseCoverage).not.toEqual(wholeCoverage)
    expect(phaseCoverage).toMatchObject({ instructions: expect.stringContaining('本阶段每项 deliverable') })
    expect(wholeCoverage).toMatchObject({ instructions: expect.stringContaining('完整需求的执行前规划，不是阶段任务') })
  })

  it('实际 Jev 题目与审核记录及低分诊断保存同一阶段判据', async () => {
    const snapshot = snapshotFor()
    let sentQuestions: Record<string, unknown> | undefined
    const record = await RunPlanningReview(snapshot, {
      parser: async () => ({ ok: true, version: MERMAID_PARSER_VERSION }),
      reviewAgent: async (seen) => ({ result: goodResult(seen),
        reviewer: { agentId: 'fresh-reviewer', role: 'yu_shi', fresh: true, readOnly: true, authorAgentIds: ['author'] } }),
      reviewJev: async (_seen, questions) => {
        sentQuestions = structuredClone(questions)
        return { status: 'ok', answers: Object.fromEntries(Object.keys(questions).map((key) => [key, {
          noul: key === 'requirement_coverage' ? 0.35 : 0.95
        }])) }
      }
    })
    expect(record.status).toBe('review_required')
    expect(sentQuestions).toEqual(getPlanningReviewQuestions(snapshot))
    expect(record.questions).toEqual(sentQuestions)
    const blocker = getPlanningReviewDiagnostics(record).find((item) => item.dimension === 'requirement_coverage')
    expect(blocker).toMatchObject({ probability: 0.35, threshold: 0.8, question: sentQuestions!.requirement_coverage })
    expect(blocker?.question).not.toEqual(getPlanningReviewQuestions().requirement_coverage)
  })

  it('unresolved 保持自由说明文本，不被 evidenceRefs 的枚举污染', () => {
    const snapshot = snapshotFor()
    const schema = getPlanningReviewSchema(snapshot)
    const unresolved = property(schema, 'unresolved')
    expect(unresolved.items?.type).toBe('string')
    expect(unresolved.items?.enum).toBeUndefined()
    const result = goodResult(snapshot)
    result.verdict = 'needs-clarification'
    result.goalReview.verdict = 'needs-clarification'
    result.unresolved = ['当前阶段尚未确认可修改的目录，需要核对明确授权范围。']
    expect(ValidateJsonValue(schema, result)).toEqual([])
    expect(ValidatePlanningReviewResult(snapshot, result)).toEqual([])
    for (const dimension of ['goalReview', 'designReview', 'mermaidReview']) {
      const references = property(property(schema, dimension), 'evidenceRefs')
      expect(references).not.toBe(unresolved)
      expect(references.items?.enum).not.toContain(result.unresolved[0])
    }
  })

  it('自由阻塞说明不是通过许可，有 unresolved 的 pass 仍由宿主拒绝', () => {
    const snapshot = snapshotFor()
    const result = goodResult(snapshot)
    result.unresolved = ['没有证据确认新增写入范围属于当前授权。']
    expect(ValidateJsonValue(getPlanningReviewSchema(snapshot), result)).toEqual([])
    expect(ValidatePlanningReviewResult(snapshot, result).join(' ')).toContain('不能通过')
  })

  it('实质需求即使等于原始全文也保留 text，只有重复出处可使用 textRef', () => {
    const phase = snapshotFor()
    const { planningScope: _phase, ...card } = phase.card
    const snapshot = getReviewSnapshot({ ...phase, card, requirements: undefined,
      requestRefs: [{ source: 'original-human', text: phase.requestText }] })
    const state = getPlanningReviewState(snapshot)
    expect(state.requirements[0]!.text).toBe(phase.requestText)
    expect(state.requirements[0]).not.toHaveProperty('textRef')
    expect(state.requestRefs?.[0]).toMatchObject({ source: 'original-human', textRef: 'requestText' })
    expect(state.requestText).toBe(phase.requestText)
    expect(state.snapshotDigest).toBe(snapshot.snapshotDigest)
  })

  it('三个维度都明确枚举当前快照的全部合法引用', () => {
    const snapshot = snapshotFor()
    const schema = getPlanningReviewSchema(snapshot)
    const expected = new Set([
      ...snapshot.requirements.map((requirement) => requirement.id), ...snapshot.acceptances.map((acceptance) => acceptance.id),
      ...snapshot.workflow.nodes.map((node) => node.id), 'request', 'card', 'workflow', 'mermaid',
      snapshot.requestDigest, snapshot.mermaidDigest, ...snapshot.requestRefs!.map((ref) => ref.source)
    ])
    for (const dimension of ['goalReview', 'designReview', 'mermaidReview']) {
      const refs = property(property(schema, dimension), 'evidenceRefs').items?.enum
      expect(new Set(refs)).toEqual(expected)
      expect(refs?.length).toBe(expected.size)
    }
  })

  it('schema 允许的每个引用也能通过宿主校验，不凭名称猜测 JSONPath', () => {
    const snapshot = snapshotFor()
    const schema = getPlanningReviewSchema(snapshot)
    const refs = property(property(schema, 'goalReview'), 'evidenceRefs').items?.enum
    expect(refs?.length).toBeGreaterThan(0)
    for (const ref of refs ?? []) {
      const result = goodResult(snapshot)
      result.goalReview.evidenceRefs = [ref]
      expect(ValidateJsonValue(schema, result), ref).toEqual([])
      expect(ValidatePlanningReviewResult(snapshot, result), ref).toEqual([])
    }
  })

  it.each(['requestText', 'card.goal', 'requirements[R1]', '$.requestText', 'workflow.nodes[analysis]', 'human-other'])('无效引用 %s 在输出 schema 和宿主都被拒绝且不静默归一化', (ref) => {
    const snapshot = snapshotFor()
    const result = goodResult(snapshot)
    result.goalReview.evidenceRefs = [ref]
    const original = structuredClone(result)
    expect(ValidateJsonValue(getPlanningReviewSchema(snapshot), result).length).toBeGreaterThan(0)
    expect(ValidatePlanningReviewResult(snapshot, result).length).toBeGreaterThan(0)
    expect(result).toEqual(original)
  })

  it('覆盖表和 findings 只接受对应种类的实际 ID，不混淆需求、验收与节点', () => {
    const snapshot = snapshotFor()
    const schema = getPlanningReviewSchema(snapshot)
    expect(property(property(schema, 'requirementCoverage').items!, 'requirementId').enum).toEqual(snapshot.requirements.map((requirement) => requirement.id))
    const finding = property(schema, 'findings').items!
    expect(property(finding, 'requirementId').enum).toEqual(snapshot.requirements.map((requirement) => requirement.id))
    expect(property(finding, 'acceptanceId').enum).toEqual(snapshot.acceptances.map((acceptance) => acceptance.id))
    expect(property(finding, 'nodeId').enum).toEqual(snapshot.workflow.nodes.map((node) => node.id))
    const result = goodResult(snapshot)
    result.findings = [{ severity: 'low', requirementId: 'A1', acceptanceId: 'analysis', nodeId: 'R1',
      issue: '错误分类', evidence: 'ID 属于其他类型', suggestion: '使用对应类型的合法引用' }]
    expect(ValidateJsonValue(schema, result).length).toBeGreaterThan(0)
    expect(ValidatePlanningReviewResult(snapshot, result).length).toBeGreaterThan(0)
  })

  it('发给独立 Agent 的 outputSchema、提示中的 schema 与宿主使用相同当前引用集合', async () => {
    const snapshot = snapshotFor()
    const expectedSchema = getPlanningReviewSchema(snapshot)
    const prompt = getPlanningReviewPrompt(snapshot)
    const schemaText = /交付 JSON schema：\n([^\n]+)/.exec(prompt)?.[1]
    expect(schemaText).toBeDefined()
    expect(JSON.parse(schemaText!)).toEqual(expectedSchema)
    const record = await RunPlanningReview(snapshot, {
      parser: async () => ({ ok: true, version: MERMAID_PARSER_VERSION }),
      reviewAgent: async (seen, schema, receivedPrompt) => {
        expect(seen.snapshotDigest).toBe(snapshot.snapshotDigest)
        expect(schema).toEqual(expectedSchema)
        expect(receivedPrompt).toBe(prompt)
        return { result: goodResult(seen), reviewer: { agentId: 'fresh-reviewer', role: 'yu_shi', fresh: true, readOnly: true, authorAgentIds: ['author'] } }
      },
      reviewJev: async () => ({ status: 'ok', answers: Object.fromEntries(Object.keys(getPlanningReviewQuestions()).map((key) => [key, { noul: 0.95 }])) })
    })
    expect(record.status).toBe('pass')
  })

  it('不同任务引用不会跨快照缓存，修改返回 schema 不污染下一次生成', () => {
    const first = snapshotFor('T-1')
    const second = snapshotFor('T-2')
    const a = getPlanningReviewSchema(first)
    const b = getPlanningReviewSchema(second)
    const refsA = property(property(a, 'goalReview'), 'evidenceRefs').items!
    const refsB = property(property(b, 'goalReview'), 'evidenceRefs').items!
    expect(refsB.enum).not.toContain('human-T-1')
    expect(refsB.enum).toContain('human-T-2')
    refsA.enum = ['mutated']
    expect(property(property(getPlanningReviewSchema(first), 'goalReview'), 'evidenceRefs').items?.enum).not.toContain('mutated')
  })
})
