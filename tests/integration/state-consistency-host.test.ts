import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { ensureProfile, runDshAsync, SANDBOX_ROOT, PROFILE, DRIVER_DIR } from '../../scripts/sandbox.mjs'
import { validateFeatureState } from '../../src/feature-session.js'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'

type SavedState = { tasks: TaskRecord[]; delegations: DelegationRecord[] }
type Envelope = { sequence: number; state: SavedState }
type StateRun = { status: string; error?: string; sessionId: string; workspaceId: string; writes: number; results: Array<{ step: number; isError: boolean; text: string }>;
  requests: Array<{ model: string; sessionId: string }>; errors: unknown[]; observations: { afterExplore: Envelope; beforeStatus: Envelope; afterStatus: Envelope }; final: Envelope }
const PROVIDER = 'swarm-state-consistency-provider'
const runState = async (scenario: 'root-write' | 'writer-completion') => {
  ensureProfile()
  const workspace = mkdtempSync(join(SANDBOX_ROOT, 'state-consistency-ws-'))
  writeFileSync(join(workspace, 'source.ts'), 'export const stableSum = (values) => values.reduce((a, b) => a + b, 0)\n')
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=state-test', '-c', 'user.email=state@test.local', ...args], { cwd: workspace, stdio: 'ignore' })
  git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'fixture'])
  const overlay = `${workspace}.patch.yml`, out = `${workspace}.out.json`
  writeFileSync(overlay, YAML.stringify([
    { id: 'swarm-core', config: { persistence: { enabled: true }, jev: { enabled: false }, review: { enabled: false },
      planningReview: { enabled: false, requireJev: false }, workflow: { mode: 'advisory' }, agents: { maxRetries: 0, networkWaitMs: 0 },
      routes: Object.fromEntries(['tian_shu', 'tan_wei', 'ji_feng', 'fu_he', 'yu_shi'].map(role => [role, { chain: [{ provider: PROVIDER, model: role === 'tian_shu' ? 'root' : `role-${role}` }], upgrade: { enabled: false } }])) } },
    { insert: [{ id: 'swarm-state-consistency-driver', name: join(DRIVER_DIR, 'state-consistency-scenarios.js') }] }
  ]))
  const processResult = await runDshAsync({ args: ['--profile', PROFILE, '--patch', overlay], cwd: workspace, timeout: 50000,
    env: { SWARM_SCENARIO: '', SWARM_RECOVERY_SCENARIO: '', SWARM_UPGRADE_SCENARIO: '', SWARM_STATE_CONSISTENCY_SCENARIO: scenario, SWARM_STATE_CONSISTENCY_OUT: out } })
  if (!existsSync(out)) throw new Error(`State consistency driver produced no output\n${processResult.stdout}\n${processResult.stderr}`)
  return { ...JSON.parse(readFileSync(out, 'utf8')) as StateRun, workspace, stderr: processResult.stderr }
}

describe('真实 Host：流程版本变更后全状态仍可写，历史证据不换版', () => {
  it.each(['root-write', 'writer-completion'] as const)('%s：真实修改仅一次，状态投影不写入，委派/审核/任务卡继续成功', async (scenario) => {
    const run = await runState(scenario)
    expect(run.status, run.error ?? run.stderr).toBe('done')
    expect(run.errors).toEqual([])
    expect(run.results).toHaveLength(9)
    expect(run.results.filter(result => result.isError)).toEqual([])
    expect(run.writes).toBe(1)
    expect(readFileSync(join(run.workspace, 'source.ts'), 'utf8')).toBe('export const stableSum = () => 42\n')
    expect(run.observations.afterStatus).toEqual(run.observations.beforeStatus)
    for (const envelope of [...Object.values(run.observations), run.final]) {
      expect(validateFeatureState(envelope.state, { rootSessionId: run.sessionId, workspaceId: run.workspaceId })).toBe(true)
    }
    const original = run.observations.afterExplore.state.delegations.find(record => record.role === 'tan_wei')!
    expect(original.evidenceAssessment).toMatchObject({ status: 'unknown', binding: { workflowRevision: 1 } })
    const retained = run.final.state.delegations.find(record => record.delegationId === original.delegationId)!
    expect(retained.workflowRevision).toBe(1)
    expect(retained.evidenceAssessment).toEqual(original.evidenceAssessment)
    expect(retained.structured).toEqual(original.structured)
    const task = run.final.state.tasks.find(task => task.taskId === 'T-1')!
    expect(task.workflowRevision).toBe(2)
    expect(run.final.state.delegations.find(record => record.role === 'fu_he')).toMatchObject({ status: 'completed', workflowRevision: 2, nodeId: 'verification' })
    expect(task.planningReview?.mermaidReview).toMatchObject({ parseVerdict: 'pass', projectionVerdict: 'pass' })
    if (scenario === 'writer-completion') {
      expect(task.workflowState?.nodes.implementation).toMatchObject({ status: 'skipped', reason: expect.stringContaining('不自动重放') })
      expect(new Set(run.requests.filter(request => request.model === 'role-ji_feng').map(request => request.sessionId)).size).toBe(1)
    }
  })
})
