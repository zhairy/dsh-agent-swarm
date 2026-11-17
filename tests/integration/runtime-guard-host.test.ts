import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPluginRoot, getSandboxDshModules, REPO_ROOT, SANDBOX_ROOT, runDshAsync } from '../../scripts/sandbox.mjs'

const PRIVATE_RC3_ROOT = '/home/zhairy/.dsh/local-bundles/dsh-0.2.2-rc.3-swarm340'
const PRIVATE_RC3_MODULES = join(PRIVATE_RC3_ROOT, 'node_modules')
const DEFAULT_EVIDENCE_ROOT = '/data/nas/public/swarm/release-artifacts/v3.4.0-routing-notebook-20261117'
const evidenceRoot = process.env.SWARM_TEST_EVIDENCE_DIR ?? DEFAULT_EVIDENCE_ROOT
const requestedVersion = process.env.SWARM_DSH_VERSION
const hostVersions = requestedVersion === undefined
  ? ['0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-rc.3']
  : [...new Set([requestedVersion, ...(requestedVersion === '0.2.2-rc.3' ? [] : ['0.2.2-rc.3'])])]
const runId = () => new Date().toISOString().replace(/[:.]/g, '-')

const runPrivateRc3 = ({ args, cwd, env, timeout }: { args: string[]; cwd: string; env: Record<string, string | undefined>; timeout: number }) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const bin = join(PRIVATE_RC3_MODULES, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (!existsSync(bin)) throw new Error(`private rc.3 SDK missing: ${bin}`)
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_SWARM_ROLE_PRESETS: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout)
    child.on('close', status => {
      clearTimeout(timer)
      resolve({ status, stdout, stderr })
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({ status: null, stdout, stderr: `${stderr}${String(error)}` })
    })
  })

const persistHostEvidence = (version: string, suffix: string, value: unknown): string => {
  mkdirSync(evidenceRoot, { recursive: true })
  const id = runId()
  const path = join(evidenceRoot, `host-${version}-${suffix}-${id}.json`)
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
  return path
}

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

describe.each(hostVersions)('真实%s授权等待与晚答复', (hostVersion) => {
  it('pending无LLM/goal增长；真实答复落账、错误来源/暂停/替换/取消不复活旧目标', async () => {
    const fixture = stage()
    if (hostVersion === '0.2.2-rc.3') {
      const versionPath = join(PRIVATE_RC3_MODULES, '@deepseek-ai', 'dsh', 'package.json')
      expect(JSON.parse(readFileSync(versionPath, 'utf8')).version).toBe('0.2.2-rc.3')
    }
    const modules = hostVersion === '0.2.2-rc.3' ? PRIVATE_RC3_MODULES : getSandboxDshModules(hostVersion)
    const env = { DSH_HOME: fixture.home, SWARM_DSH_MODULES: modules, SWARM_DSH_VERSION: hostVersion, SWARM_AUTH_WAIT_MS: String(observationMs),
      SWARM_AUTH_EVIDENCE_DIR: fixture.evidence, SWARM_AUTH_PLUGIN: fixture.plugin, SWARM_AUTH_STATE: fixture.state, SWARM_HOST_VERSION: hostVersion,
      SWARM_TEST_EVIDENCE_DIR: evidenceRoot }
    const run = hostVersion === '0.2.2-rc.3'
      ? await runPrivateRc3({ args: ['--profile', 'auth313', '--patch', fixture.patch], cwd: fixture.workspace, timeout: observationMs + 90000, env })
      : await runDshAsync({ version: hostVersion, args: ['--profile', 'auth313', '--patch', fixture.patch], cwd: fixture.workspace,
        timeout: observationMs + 90000, env })
    const path = join(fixture.evidence, 'host-auth-result.json')
    if (!existsSync(path)) throw new Error(`SDK fixture produced no result: ${run.stdout}\n${run.stderr}`)
    const result = JSON.parse(readFileSync(path, 'utf8'))
    persistHostEvidence(hostVersion, 'result', result)
    persistHostEvidence(hostVersion, 'process', run)
    expect(result.status, result.error ?? run.stderr).toBe('done')
    expect(result.hostVersion).toBe(hostVersion)
    expect(result.sdkModules).toBe(modules)
    expect(result.sdkVersion).toBe(hostVersion)
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
