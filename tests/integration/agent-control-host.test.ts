import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { execFileSync } from 'node:child_process'
import { REPO_ROOT, DRIVER_DIR, SANDBOX_ROOT, PROFILE, ensureProfile, runDshAsync } from '../../scripts/sandbox.mjs'

const workspaceFixture = () => {
  if (!existsSync(join(REPO_ROOT, 'lib/index.js'))) throw new Error('build plugin first')
  ensureProfile(); mkdirSync(SANDBOX_ROOT, { recursive: true })
  const workspace = mkdtempSync(join(SANDBOX_ROOT, 'agent-control-it-'))
  writeFileSync(join(workspace, 'README.md'), '# Agent control integration fixture\n')
  const git = (args: string[]) => execFileSync('git', ['-c', 'user.name=control-test', '-c', 'user.email=control@test.local', ...args], { cwd: workspace, stdio: 'ignore' })
  git(['init', '-q']); git(['add', '-A']); git(['commit', '-q', '-m', 'fixture'])
  return workspace
}
const phase = async (workspace: string, scenario: string, options: { persistence?: boolean; hostController?: boolean } = {}) => {
  const overlay = `${workspace}.${scenario}.overlay.yml`
  const writer = scenario === 'manual-writer'
  const longrun = scenario === 'preferred-recovery'
  const initialModel = longrun ? 'preferred' : writer ? 'writer-hang' : scenario.includes('isolated') ? 'fail-pool' : 'hang'
  writeFileSync(overlay, YAML.stringify([
    { id: 'swarm-core', config: { rootFallback: false, jev: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' }, persistence: { enabled: options.persistence === true }, agents: { maxRetries: 3, retryBackoffMs: 1, networkWaitMs: 0 }, routes: { [writer ? 'ji_feng' : 'tan_wei']: { chain: [{ provider: 'swarm-control-mock', model: initialModel }, ...(longrun ? [{ provider: 'swarm-control-mock', model: 'backup' }] : [])] } } } },
    { insert: [
      ...(options.hostController ? [{ id: 'control-it-workspace', name: '@deepseek-ai/dsh-workspace' }, { id: 'control-it-connection', name: '@deepseek-ai/dsh-client-connection' }, { id: 'control-it-file-uploads', name: '@deepseek-ai/dsh-client-file-upload' }, { id: 'control-it-session-controller', name: '@deepseek-ai/dsh-api-session-controller', config: { nativeOpen: false } }] : []),
      { id: 'swarm-agent-control-integration', name: join(DRIVER_DIR, 'agent-control-scenarios.js') }
    ] }
  ]))
  const out = `${workspace}.${scenario}.out.json`
  const run = await runDshAsync({ args: ['--profile', PROFILE, '--patch', overlay], cwd: workspace, timeout: 35000, env: { SWARM_SCENARIO: '', SWARM_AGENT_CONTROL_SCENARIO: scenario, SWARM_DRIVER_OUT: out, SWARM_CONTROL_RESTART_MANIFEST: `${workspace}.restart.json` } })
  if (!existsSync(out)) throw new Error(`${run.stdout}\n${run.stderr}`)
  const result = JSON.parse(readFileSync(out, 'utf8'))
  expect(result.status, result.error ?? run.stderr).toBe('done')
  return result
}

describe('real DSH continuable child manual model controls', () => {
  it('a real automatic fallback header does not pin a persistent child; the next tool step recovers its preferred model', async () => {
    const result = await phase(workspaceFixture(), 'preferred-recovery')
    expect(result.requests.map((item: { model: string }) => item.model)).toEqual(['preferred', 'backup', 'preferred'])
    expect(new Set(result.requests.map((item: { sessionId: string }) => item.sessionId))).toEqual(new Set([result.childId]))
    expect(result.firstDelegation.status).toBe('completed')
    expect(result.firstDelegation.route.model).toBe('preferred')
    expect(result.manualOverride).toBeUndefined()
    expect(result.realReadResult).toContain('Agent control integration fixture')
    expect(result.headerModels).toEqual(['preferred', 'backup', 'preferred'])
    expect(result.selectionEvents).toEqual([])
    expect(result.controls.at(-1).actual.route.model).toBe('preferred')
    expect(result.rootHumanPreference).toEqual({ provider: 'swarm-control-mock', model: 'recovered', reasoningEffort: 'max' })
    expect(result.rootPickerRequest).toEqual(result.rootHumanPreference)
  })
  it('interrupts a hanging actual attempt, waits for settlement and resumes on the same persisted manual route', async () => {
    const result = await phase(workspaceFixture(), 'manual-switch')
    expect(result.firstDelegation.status).toBe('failed')
    expect(result.firstDelegation.error).toBe('manual-intervention')
    expect(result.firstDelegation.route.model).toBe('hang')
    expect(result.controls[0].actual.route.reasoningEffort).toBe('high')
    expect(result.requestsBeforeContinue[0].reasoningEffort).toBe('high')
    expect(result.requestsBeforeContinue.map((item: { model: string }) => item.model)).toEqual(['hang'])
    expect(result.controls[1]).toMatchObject({ phase: 'paused', actual: { route: { model: 'hang' }, state: 'settled' }, selectedNext: { model: 'recovered' } })
    expect(result.requests.map((item: { model: string }) => item.model)).toEqual(['hang', 'recovered', 'recovered'])
    expect(result.requests.filter((item: { model: string }) => item.model === 'recovered').every((item: { reasoningEffort: string }) => item.reasoningEffort === 'max')).toBe(true)
    expect(new Set(result.requests.map((item: { sessionId: string }) => item.sessionId))).toEqual(new Set([result.childId]))
    expect(result.continueReceipt).toMatchObject({ accepted: true })
    expect(result.secondDelegation.status).toBe('completed')
    expect(result.controls[2].actual).toMatchObject({ route: { provider: 'swarm-control-mock', model: 'recovered', reasoningEffort: 'max' }, source: 'agent-loop-attempt', state: 'settled' })
  })

  for (const retry of [false, true]) it(retry ? 'a scoped retry is claimed only at the actual next request, then success restores that pool' : 'a healthy manual model can recover a child whose entire original role chain is quarantined', async () => {
    const result = await phase(workspaceFixture(), retry ? 'manual-retry-isolated' : 'manual-isolated')
    const next = retry ? 'fail-pool' : 'recovered'
    expect(result.requestsBeforeContinue.map((item: { model: string }) => item.model)).toEqual(['fail-pool'])
    expect(result.requests.map((item: { model: string }) => item.model)).toEqual(['fail-pool', next, next])
    expect(result.firstDelegation.status).toBe('failed')
    expect(result.secondDelegation.status).toBe('completed')
    expect(new Set(result.requests.map((item: { sessionId: string }) => item.sessionId))).toEqual(new Set([result.childId]))
    if (retry) expect(result.healthAfterContinue).toEqual([])
  })

  it('two independent Host processes preserve the same paused child and manual route; cold view generates nothing', async () => {
    const workspace = workspaceFixture()
    const saved = await phase(workspace, 'restart-save', { persistence: true, hostController: true })
    expect(saved.persistedChild.meta.parentSession).toBe(saved.parentSessionId)
    expect(saved.persistedParent.meta.agentPreset).toBe('tian-shu')
    expect(saved.controls.at(-1)).toMatchObject({ phase: 'paused', selectedNext: { model: 'recovered', reasoningEffort: 'max' } })
    const loaded = await phase(workspace, 'restart-load', { persistence: true, hostController: true })
    expect(loaded.parentLiveBeforeView).toBe(false)
    expect(loaded.parentLiveAfterView).toBe(false)
    expect(loaded.requestsAfterColdView).toEqual([])
    expect(loaded.parentLiveAfterSelect).toBe(true)
    expect(loaded.childId).toBe(saved.childId)
    expect(loaded.requests.map((item: { sessionId: string; model: string; reasoningEffort: string }) => [item.sessionId, item.model, item.reasoningEffort])).toEqual([[saved.childId, 'recovered', 'max']])
    expect(loaded.restoredControl).toMatchObject({ childId: saved.childId, phase: 'idle', actual: { route: { model: 'recovered', reasoningEffort: 'max' }, state: 'settled' } })
  })
  it('a real allowed write marks side-effect risk, refuses unconfirmed continuation and is not replayed after confirmation', async () => {
    const result = await phase(workspaceFixture(), 'manual-writer')
    expect(result.writerRiskBeforeStop).toBe(true)
    expect(result.fileBeforeStop).toBe('one controlled write\n')
    expect(result.noConfirmationRefusal).toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(result.requestsAfterRefusal).toHaveLength(2)
    expect(result.requests.map((item: { model: string }) => item.model)).toEqual(['writer-hang', 'writer-hang', 'recovered', 'recovered'])
    expect(result.writeCalls).toHaveLength(1)
    expect(result.writeResults).toEqual([{ isError: false }])
    expect(result.writerReadResult).toContain('one controlled write')
    expect(result.fileAfterContinue).toBe(result.fileBeforeStop)
    expect(result.controls.at(-1)).toMatchObject({ phase: 'idle', needsSideEffectReview: false })
    expect(new Set(result.requests.map((item: { sessionId: string }) => item.sessionId))).toEqual(new Set([result.childId]))
  })
})
