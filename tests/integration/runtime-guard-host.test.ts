import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPluginRoot, REPO_ROOT, SANDBOX_ROOT, runDshAsync } from '../../scripts/sandbox.mjs'

/** The default smoke run is short. Set SWARM_AUTH_OBSERVE_MS=300000 for a real five-minute observation. */
const observationMs = Number(process.env.SWARM_AUTH_OBSERVE_MS ?? 1000)
const stage = () => {
  if (!Number.isSafeInteger(observationMs) || observationMs < 1000 || observationMs > 600000) throw new Error('invalid SDK observation window')
  const source = getPluginRoot()
  if (!existsSync(join(source, 'lib/authorization-runtime.js'))) throw new Error('build the isolated plugin candidate before Host integration')
  mkdirSync(SANDBOX_ROOT, { recursive: true })
  const base = mkdtempSync(join(SANDBOX_ROOT, 'auth-313-host-')), plugin = join(base, 'plugin'), driver = join(base, 'driver'), home = join(base, 'home')
  mkdirSync(plugin); mkdirSync(driver)
  for (const file of ['package.json', 'cordis.patch.yml']) cpSync(join(source, file), join(plugin, file))
  for (const directory of ['lib', 'presets', 'locale', 'config', 'skills']) if (existsSync(join(source, directory))) cpSync(join(source, directory), join(plugin, directory), { recursive: true })
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(plugin, 'node_modules'), 'dir')
  const preset = join(plugin, 'presets/tian-shu.patch.yml'), raw = readFileSync(preset, 'utf8')
  const target = '          - id: tool-ask-user\n            name: "@deepseek-ai/dsh-tool-ask-user"\n'
  if (!raw.includes(target)) throw new Error('actual ask-user preset row must be reviewed before patching this fixture')
  const timedRow = target + '            config:\n              mode: timed\n              timeout: 1\n'
  writeFileSync(preset, raw.includes(timedRow) ? raw : raw.replace(target, timedRow))
  cpSync(join(REPO_ROOT, 'tests/integration/driver/runtime-guard-scenarios.js'), join(driver, 'driver.js'))
  writeFileSync(join(driver, 'package.json'), JSON.stringify({ name: 'swarm-auth-313-host', version: '0.0.0', private: true, type: 'module', exports: { '.': './driver.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(driver, 'cordis.patch.yml'), '- insert:\n    - id: agent-preset-registry\n      name: "@deepseek-ai/dsh-agent-preset-registry"\n      config:\n        default: tian-shu\n    - id: swarm-auth-313-host\n      name: swarm-auth-313-host\n')
  const profile = join(home, 'profiles', 'auth313'), modules = join(profile, 'node_modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-auth313', private: true, dependencies: {
    'swarm-auth-313-host': 'link:' + driver, 'dsh-agent-swarm': 'link:' + plugin
  }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'swarm-auth-313-host', 'dsh-agent-swarm'] } } }))
  for (const file of ['cordis.yml', 'cordis.patch.yml']) writeFileSync(join(profile, file), '[]\n')
  symlinkSync(driver, join(modules, 'swarm-auth-313-host'), 'dir'); symlinkSync(plugin, join(modules, 'dsh-agent-swarm'), 'dir')
  const workspace = join(base, 'workspace'); mkdirSync(workspace); writeFileSync(join(workspace, 'README.md'), 'isolated authorization runtime fixture\n')
  const state = join(base, 'state'), evidence = join(base, 'evidence'), patch = join(base, 'patch.json')
  writeFileSync(patch, JSON.stringify([{ id: 'swarm-core', config: { rootFallback: false, jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false },
    workflow: { mode: 'advisory' }, persistence: { enabled: true, directory: state }, agents: { maxRetries: 0, networkWaitMs: 0 }, routes: { tian_shu: { chain: [{ provider: 'swarm-auth-313-mock', model: 'root' }] } } } }]))
  return { base, plugin, home, workspace, state, evidence, patch }
}

describe('真实rc.3授权等待与晚答复', () => {
  it('pending无LLM/goal增长；真实答复落账、错误来源/暂停/替换/取消不复活旧目标', async () => {
    const fixture = stage()
    const run = await runDshAsync({ version: '0.2.1-rc.3', args: ['--profile', 'auth313', '--patch', fixture.patch], cwd: fixture.workspace,
      timeout: observationMs + 90000, env: { DSH_HOME: fixture.home, SWARM_AUTH_WAIT_MS: String(observationMs), SWARM_AUTH_EVIDENCE_DIR: fixture.evidence,
        SWARM_AUTH_PLUGIN: fixture.plugin, SWARM_AUTH_STATE: fixture.state } })
    const path = join(fixture.evidence, 'host-auth-result.json')
    if (!existsSync(path)) throw new Error(`SDK fixture produced no result: ${run.stdout}\n${run.stderr}`)
    const result = JSON.parse(readFileSync(path, 'utf8'))
    expect(result.status, result.error ?? run.stderr).toBe('done')
    expect(result.errors).toEqual([])
    const pending = result.sessions['five-minute-pending']
    expect(pending.waitFinal.observedMs).toBeGreaterThanOrEqual(observationMs)
    expect(pending.waitFinal.requests).toBe(pending.waitBaseline.requests)
    expect(pending.waitFinal.goal.roundsStarted).toBe(pending.waitBaseline.goal.roundsStarted)
    expect(pending.waitFinal.goal).toMatchObject({ phase: 'active', activation: 'disarmed' })
    expect(pending.afterWrongSource.requests).toBe(pending.waitBaseline.requests)
    expect(pending.persistedDecisions).toHaveLength(1)
    expect(pending.persistedDecisions[0]).toMatchObject({ phase: 'answered', answerOrigin: { kind: 'user-question-reply' }, appliesToBinding: { requestRevision: 2 } })
    expect(pending.goalChanges.filter((change: { operation: string }) => change.operation === 'resume')).toHaveLength(1)
    expect(result.sessions['manual-paused'].afterAnswer.goal.phase).toBe('paused')
    expect(result.sessions['replaced-goal'].goalChanges.filter((change: { operation: string }) => change.operation === 'resume')).toHaveLength(0)
    expect(result.sessions['manual-stopped'].persistedDecisions[0].phase).toBe('cancelled')
    expect(result.sessions['manual-stopped'].answerAfterStop).toBe(false)
    expect(result.sessions['no-answerer'].persistedDecisions[0].phase).toBe('waiting')
    expect(result.sessions['inline-answer'].persistedDecisions[0]).toMatchObject({ phase: 'answered', answerOrigin: { kind: 'tool-result' }, appliesToBinding: { requestRevision: 2 } })
  }, observationMs + 100000)
})
