import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService } from '../../src/service.js'
import { getWorkspacePlan } from '../../src/workspace-policy.js'
import type { AgentLike } from '../../src/host-contract.js'

it('从项目子目录首次规划允许 Git 根为祖先，后续不得切换到另一项目', async () => {
  const home = mkdtempSync(join(tmpdir(), 'workspace-anchor-'))
  const rootPath = join(home, 'project'), nested = join(rootPath, 'nested'), other = join(home, 'other')
  mkdirSync(nested, { recursive: true }); mkdirSync(other)
  const agent: AgentLike = { id: 'root-anchor', session: { header: { cwd: nested, agentPreset: 'tian-shu' } } }
  let cwd = nested, repositoryRoot = rootPath, branch = 'main'
  const plan = () => getWorkspacePlan({ repositoryRoot, branch, head: 'a'.repeat(40), sources: [] })
  const previousKey = process.env.SWARM_WORKSPACE_TEST_KEY
  process.env.SWARM_WORKSPACE_TEST_KEY = 'fixture-key'
  const config = getSwarmConfig({ jev: { enabled: true, apiKeyEnv: 'SWARM_WORKSPACE_TEST_KEY' }, planningReview: { enabled: false }, workflow: { mode: 'advisory' } })
  const service = intSwarmService({ getConfig: () => config, getLlm: () => undefined, getSubagents: () => undefined,
    getTools: () => undefined, getAttachments: () => undefined, getCredentials: () => undefined,
    dshHome: home, fetch: async () => new Response(JSON.stringify({ model: 'fixture', answers: {
      workspace_mode: { choice: 'linked', confidence: 0.99 }, math_task: { choice: 'research', confidence: 0.99 },
      need_benchmark: { noul: 1 }, novelty: { score: 2, confidence: 0.99 }
    } }), { headers: { 'content-type': 'application/json' } }),
    probe: async () => ({ ok: true, vision: false }), gitStatus: async () => undefined,
    getWorktreeHost: () => ({ cwd: () => cwd, inspectWorkspace: async () => ({ plan: plan(), record: {
      kind: 'primary', repositoryRoot, path: repositoryRoot, branch: 'main', baseCommit: 'a'.repeat(40)
    } }) }) as never })
  const card = { title: '子目录只读任务', goal: '分析当前项目文件', acceptance: ['只读结论'], scope: [], flags: {} }
  const execution = { agent, signal: new AbortController().signal }
  try {
    repositoryRoot = other; cwd = other
    await expect(service.AddTaskCard(card, execution)).rejects.toThrow('项目根已改变')
    repositoryRoot = rootPath; cwd = nested
    const task = await service.AddTaskCard(card, execution)
    expect(task.workspacePlan?.repositoryRoot).toBe(rootPath)
    expect(task.workspacePlan?.decisionSource).toBe('rules+jev')
    expect(task.requiredGates).toEqual([])
    branch = 'another-base'
    await expect(service.AddTaskCard({ ...card, task_id: task.task_id, expected_card_revision: task.cardRevision }, execution)).rejects.toThrow('主分支')
    branch = 'main'
    repositoryRoot = other; cwd = other
    await expect(service.AddTaskCard({ ...card, title: '第二个项目' }, execution)).rejects.toThrow('项目根已改变')
    expect(service.getStatus({}, execution).tasks).toHaveLength(1)
  } finally {
    await service.dispose(); rmSync(home, { recursive: true, force: true })
    if (previousKey === undefined) delete process.env.SWARM_WORKSPACE_TEST_KEY
    else process.env.SWARM_WORKSPACE_TEST_KEY = previousKey
  }
})
