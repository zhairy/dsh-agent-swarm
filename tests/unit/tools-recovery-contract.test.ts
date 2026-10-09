import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { DEFAULT_JEV_CONFIG, type JevClient } from '../../src/jev.js'
import { getJevToolDefinitions, intJevTools } from '../../src/jev-tools.js'
import { intSwarmService } from '../../src/service.js'
import { getStatusText, getStyledAssembly } from '../../src/tools.js'

describe('tool recovery contracts', () => {
  it('rejects nested jev_check propositions before a model call and accepts the corrected top-level shape', async () => {
    const ask = vi.fn(async (_state: unknown, _questions: Record<string, unknown>) => ({ ok: true as const, model: 'jev-fixture', attempts: 1,
      answers: { supported: { noul: 0.9 } }, latencyMs: 1, usage: { inputTokens: 10, outputTokens: 1 } }))
    const client = { config: DEFAULT_JEV_CONFIG, ask } as unknown as JevClient
    const tools = intJevTools({ getClient: () => client })
    const check = getJevToolDefinitions(() => tools).find((tool) => tool.name === 'jev_check')!
    const facts = { evidence: ['Two write tools failed'], unknown: ['Specific invalid field'] }
    const propositions = { supported: 'Evidence shows more than one write tool failed' }
    const exec = { signal: new AbortController().signal }

    await expect(check.execute({ state: { ...facts, propositions } }, exec)).rejects.toThrow('$.propositions 缺失')
    expect(ask).not.toHaveBeenCalled()
    expect(check.description).toContain('两个字段在顶级并列')
    expect(check.parameters.properties?.propositions?.description).toContain('与 state 并列')

    await expect(check.execute({ state: facts, propositions }, exec)).resolves.toMatchObject({ ok: true, answers: { flags: ['supported'] } })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0]?.[0]).toEqual(facts)
  })

  it('makes invalid-call recovery available once without changing expert personas or model style', () => {
    const base = { sections: [{ name: 'persona', text: '你是天枢' }], contexts: [], tools: [], variables: { model: 'gpt-6-sol', provider: 'codex' } }
    const assembled = getStyledAssembly(base, 'auto')
    const recovery = assembled.sections.find((section) => section.name === 'dsh-agent-swarm:tool-recovery')!
    expect(recovery.text).toContain('只读 Web RPC 仍需登录认证')
    expect(recovery.text).toContain('offset:1')
    expect(recovery.text).toContain('screenshot ./page.png')
    expect(recovery.text).toContain('规划未批准时不能开始执行')
    expect(assembled.sections.at(-1)?.text).toContain('Orchestration style (GPT)')
    expect(getStyledAssembly(assembled, 'auto')).toBe(assembled)
    const child = { ...base, sections: [{ name: 'persona', text: '[[swarm:role=yu_shi]]' }] }
    expect(getStyledAssembly(child, 'auto')).toBe(child)
  })

  it('renders the real readonly task versions and planning state for diagnostics', async () => {
    const home = mkdtempSync(join(tmpdir(), 'swarm-tool-contract-'))
    const service = intSwarmService({ getConfig: () => getSwarmConfig({ jev: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'off' } }),
      getLlm: () => undefined, getSubagents: () => undefined, getTools: () => undefined, getAttachments: () => undefined,
      getCredentials: () => undefined, fetch: async () => { throw new Error('No network is allowed in this readonly diagnostic test') },
      dshHome: home, gitStatus: async () => undefined })
    try {
      const exec = { agent: { id: 'contract-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }, signal: new AbortController().signal }
      const card = await service.AddTaskCard({ title: '只读诊断', goal: '报告当前合同版本', acceptance: ['版本真实'], flags: {} }, exec)
      const status = service.getStatus({ task_id: card.task_id }, exec)
      const task = status.tasks[0]!
      const text = getStatusText(status)
      expect(text).toContain(`需求版本：${task.requestRevision}；合同版本：${task.cardRevision}；流程版本：${task.workflowRevision}`)
      expect(text).toContain(`规划审核：${task.planningReview?.status ?? 'pending'}`)
    } finally { await service.dispose(); rmSync(home, { recursive: true, force: true }) }
  })
})
