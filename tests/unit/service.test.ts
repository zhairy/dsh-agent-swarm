import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig, type SwarmConfigInfo } from '../../src/config.js'
import { getLedgerEvents } from '../../src/evidence.js'
import type { SubagentStartRequestLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import { ValidateAcceptInput, intSwarmService, type SwarmServiceDepsInfo } from '../../src/service.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const root = { id: 'root-1', session: { header: { agentPreset: 'tian-shu', cwd: process.cwd() } } }
const exec = () => ({ agent: root, signal: new AbortController().signal })

const jevBody = { answers: { math_task: { choice: 'research', confidence: 0.9 }, need_benchmark: { noul: 0.1 }, novelty: { score: 0.2, confidence: 0.9 } } }

const makeService = (options: { config?: Record<string, unknown>; env?: Partial<SwarmServiceDepsInfo> } = {}) => {
  const dshHome = mkdtempSync(join(tmpdir(), 'swarm-service-'))
  dirs.push(dshHome)
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(jevBody), { status: 200 }))
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => (name === 'spawn' ? { capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } } : undefined),
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      const structured = role === 'suan_heng' ? { ...(VALID_OUTPUTS.suan_heng as object), mode: request.persona?.includes('验算') ? 'verify' : 'research' } : VALID_OUTPUTS[role]
      return { id: `child-${role}-${subagents.start.mock.calls.length}`, result: Promise.resolve({ output: [], structured, stopReason: 'completed' }), dispose: async () => undefined }
    })
  }
  const config: SwarmConfigInfo = getSwarmConfig(options.config ?? {})
  const deps: SwarmServiceDepsInfo = {
    getConfig: () => config,
    getLlm: () => ({ listProviders: () => [{ id: 'qwen-token-plan-cn' }, { id: 'opencode-go' }, { id: 'deepseek-official' }], resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }),
    getSubagents: () => subagents,
    getTools: () => ({ register: () => () => undefined, schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].map((name) => ({ name })), guard: () => () => undefined }),
    getAttachments: () => undefined,
    getCredentials: () => ({ resolve: async (ref: string) => (ref === 'TYPESAFE_API_KEY' ? { value: 'k' } : undefined) }),
    dshHome,
    fetch: fetchMock as unknown as typeof fetch,
    sleep: async () => undefined,
    gitStatus: async () => undefined,
    now: (() => { let clock = 1000; return () => (clock += 10) })(),
    ...options.env
  }
  return { service: intSwarmService(deps), fetchMock, subagents, dshHome }
}

const cardInput = (flags: Record<string, boolean>, extra: Record<string, unknown> = {}) => ({ title: '任务', goal: '目标', acceptance: ['通过'], scope: ['src/a.ts'], flags, ...extra })

describe('AddTaskCard', () => {
  it('规则门禁 + Jev 追加门禁，写账本', async () => {
    const { service, fetchMock, dshHome } = makeService()
    const result = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(result.task_id).toBe('T-1')
    expect(result.requiredGates.map((g) => g.gate).sort()).toEqual(['G_MATH_RESEARCH', 'G_MATH_VERIFY', 'G_VERIFY'])
    expect(result.triage.source).toBe('rules+jev')
    expect(result.suggestedRoles.map((s) => s.role)).toContain('fu_he')
    expect(result.requiredGates[0]).toHaveProperty('roleName')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.ledgerPath.startsWith(join(dshHome, 'share', 'dsh-agent-swarm', 'ledger'))).toBe(true)
    expect(getLedgerEvents(result.ledgerPath).map((e) => e.type)).toEqual(['jev/call', 'task/card'])
  })

  it('Jev 关闭时只用规则；无关任务不调用 Jev', async () => {
    const { service, fetchMock } = makeService({ config: { jev: { enabled: false } } })
    const disabled = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(disabled.triage).toMatchObject({ source: 'rules', fallbackReason: 'jev-disabled' })
    const copy = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(copy.triage.source).toBe('rules')
    expect(copy.task_id).toBe('T-2')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Jev 缺少密钥时走严格路径；超出调用预算同样', async () => {
    const { service } = makeService({ config: { jev: { apiKeyEnv: 'SWARM_TEST_UNSET_KEY' } }, env: { getCredentials: () => undefined } })
    const result = await service.AddTaskCard(cardInput({ changesCode: true, changesAlgorithm: true }), exec())
    expect(result.triage).toMatchObject({ source: 'rules+jev-fallback', fallbackReason: 'missing-api-key' })
    expect(result.requiredGates.find((g) => g.gate === 'G_MATH_VERIFY')?.source).toBe('jev-fallback')
    const budget = makeService({ config: { jev: { maxCallsPerSession: 0 } } })
    const limited = await budget.service.AddTaskCard(cardInput({ changesCode: true }), exec())
    expect(limited.triage.fallbackReason).toBe('jev-budget')
  })

  it('环境变量兜底 Jev 密钥', async () => {
    process.env.SWARM_TEST_JEV_KEY = 'env-key'
    const { service, fetchMock } = makeService({ config: { jev: { apiKeyEnv: 'SWARM_TEST_JEV_KEY' } } })
    await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer env-key')
    delete process.env.SWARM_TEST_JEV_KEY
  })

  it('更新已有任务时门禁只增不减；未知任务与非法卡片报错', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    await service.AddTaskCard(cardInput({ hasVisualInput: true }), exec())
    const updated = await service.AddTaskCard(cardInput({ changesCode: true }, { task_id: 'T-1' }), exec())
    expect(updated.task_id).toBe('T-1')
    expect(updated.requiredGates.map((g) => g.gate).sort()).toEqual(['G_VERIFY', 'G_VISION'])
    await expect(service.AddTaskCard(cardInput({}, { task_id: 'T-9' }), exec())).rejects.toThrow('未知任务')
    await expect(service.AddTaskCard({ title: '' }, exec())).rejects.toThrow('title')
  })
})

describe('委派、状态与验收', () => {
  it('缺少复核时验收被拦下，补齐后通过；状态显示门禁与委派', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    const edit = await service.delegate({ task_id, role: 'ji_feng', prompt: '改文件' }, exec())
    expect(edit.status).toBe('completed')
    const blocked = service.AcceptTask({ task_id, decision: 'accept', summary: '完成', stopReason: '完成' }, exec())
    expect(blocked.status).toBe('blocked')
    expect(blocked.missing.join('')).toContain('G_VERIFY')
    await service.delegate({ task_id, role: 'fu_he', prompt: '跑测试' }, exec())
    const status = service.getStatus({ task_id }, exec())
    expect(status.tasks[0]?.gates[0]).toMatchObject({ gate: 'G_VERIFY', satisfied: true })
    expect(status.tasks[0]?.delegations.map((d) => d.role)).toEqual(['ji_feng', 'fu_he'])
    expect(status.tasks[0]?.delegations[0]?.structured).toBeUndefined()
    expect(service.getStatus({ task_id, verbose: true }, exec()).tasks[0]?.delegations[0]?.structured).toBeDefined()
    const accepted = service.AcceptTask({ task_id, decision: 'accept', summary: '完成', unresolved: [], stopReason: '门禁全部满足' }, exec())
    expect(accepted.status).toBe('accepted')
    expect(service.getStatus({}, exec()).tasks[0]?.acceptance?.status).toBe('accepted')
  })

  it('天枢在复核之后亲自改文件，已有验证失效，需重新复核', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ changesCode: true }), exec())
    await service.delegate({ task_id, role: 'ji_feng', prompt: '改文件' }, exec())
    await service.delegate({ task_id, role: 'fu_he', prompt: '跑测试' }, exec())
    expect(service.getGuardReason({ name: 'edit', agent: root })).toBeUndefined()
    const stale = service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())
    expect(stale.status).toBe('blocked')
    expect(stale.missing.join('')).toContain('G_VERIFY')
    await service.delegate({ task_id, role: 'fu_he', prompt: '重新跑测试' }, exec())
    expect(service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec()).status).toBe('accepted')
  })

  it('天枢在任务创建之前的编辑不影响之后的任务；子会话的写操作不算天枢编辑', async () => {
    const { service } = makeService({ config: { jev: { enabled: false } } })
    service.getGuardReason({ name: 'write', agent: root })
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec()).status).toBe('accepted')
    const child = { id: 'kid-2', session: { header: { agentPreset: 'tian-shu', parentSession: 'root-1' } } }
    service.getGuardReason({ name: 'write', agent: child })
    expect(service.getStatus({ task_id }, exec()).tasks[0]?.gates).toEqual([])
  })

  it('御史高危发现需要处理说明', async () => {
    const { service, subagents } = makeService({ config: { jev: { enabled: false } } })
    const { task_id } = await service.AddTaskCard(cardInput({ crossModuleArchitecture: true }), exec())
    subagents.start.mockImplementationOnce(async () => ({
      id: 'review', dispose: async () => undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed', structured: { summary: 's', unresolved: [], findings: [{ severity: 'high', location: 'a', issue: 'i', suggestion: 's' }] } })
    }))
    const review = await service.delegate({ task_id, role: 'yu_shi', prompt: '审查' }, exec())
    const first = service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's' }, exec())
    expect(first.missing.join('')).toContain(`${review.delegationId}#0`)
    const second = service.AcceptTask({ task_id, decision: 'accept', summary: 's', stopReason: 's', findingResolutions: [{ delegationId: review.delegationId, index: 0, resolution: '已修复并补测试' }] }, exec())
    expect(second.status).toBe('accepted')
  })

  it('拒绝会累计修复轮次，超过上限后 blocked；incomplete 仅记录', async () => {
    const { service } = makeService({ config: { jev: { enabled: false }, budgets: { maxAutoFixRounds: 1 } } })
    const { task_id } = await service.AddTaskCard(cardInput({ uiCopy: true }), exec())
    expect(service.AcceptTask({ task_id, decision: 'reject', summary: 's', stopReason: '需修复' }, exec())).toMatchObject({ status: 'recorded', roundsUsed: 1 })
    expect(service.AcceptTask({ task_id, decision: 'reject', summary: 's', stopReason: '需修复' }, exec())).toMatchObject({ status: 'blocked', roundsUsed: 2 })
    expect(service.AcceptTask({ task_id, decision: 'incomplete', summary: 's', stopReason: '缺少信息' }, exec()).status).toBe('recorded')
    expect(() => service.AcceptTask({ task_id: 'T-9', decision: 'accept', summary: 's', stopReason: 's' }, exec())).toThrow('未知任务')
    expect(() => service.getStatus({ task_id: 'T-9' }, exec())).toThrow('未知任务')
  })

  it('ValidateAcceptInput', () => {
    expect(ValidateAcceptInput('x').errors).toEqual(['参数必须是对象'])
    const result = ValidateAcceptInput({ task_id: 1, decision: 'maybe', summary: 1, stopReason: '', unresolved: [1], findingResolutions: [{ delegationId: 'd' }] })
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
    expect(ValidateAcceptInput({ task_id: 'T', decision: 'accept', summary: 's', stopReason: 's' }).input).toMatchObject({ unresolved: [], findingResolutions: [] })
  })
})

describe('守卫与诊断', () => {
  it('只读角色调用写工具被拒绝；天枢与非 swarm 预设放行', async () => {
    const { service } = makeService()
    const reason = service.getGuardReason({ name: 'write', agent: { id: 'r', session: { header: { agentPreset: 'yu-shi' } } } })
    expect(reason).toContain('「御史」')
    expect(service.getGuardReason({ name: 'edit', agent: root })).toBeUndefined()
    expect(service.getGuardReason({ name: 'read', agent: { id: 'r', session: { header: { agentPreset: 'yu-shi' } } } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write', agent: { id: 'x', session: { header: { agentPreset: 'standard' } } } })).toBeUndefined()
    expect(service.getGuardReason({ name: 'write' })).toBeUndefined()
    service.routeState.AddChild('kid', { chain: [], role: 'fu_he' })
    expect(service.getGuardReason({ name: 'write', agent: { id: 'kid', session: { header: { agentPreset: 'tian-shu' } } } })).toContain('「复核」')
    expect(service.getRoleForAgent({ id: 'kid' })).toBe('fu_he')
  })

  it('诊断列出缺失或能力不足的宿主服务', () => {
    const { service } = makeService({ env: { getLlm: () => undefined, getTools: () => undefined, getSubagents: () => ({ list: () => [], getProvider: () => undefined, start: async () => { throw new Error('x') } }) } })
    const diagnostics = service.getDiagnostics().join('\n')
    expect(diagnostics).toContain('ctx.llm')
    expect(diagnostics).toContain('ctx.tools')
    expect(diagnostics).toContain('spawn')
    expect(diagnostics).toContain('附件')
    expect(makeService().service.getDiagnostics().join('')).toContain('附件')
  })
})
