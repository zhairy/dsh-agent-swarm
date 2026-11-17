#!/usr/bin/env node
/** 在私有 profile 验证精确宿主和组合插件，不访问在役会话或外部模型。 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const option = (name) => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}
const sdk = option('--sdk'), rigor = option('--rigor'), swarm = option('--swarm'), output = option('--out')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(output, { recursive: true, mode: 0o700 })
const base = mkdtempSync(join(output, 'profile-compat-'))
const home = join(base, 'home'), profile = join(home, 'profiles/proof')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
symlinkSync(join(sdk, 'node_modules'), join(home, 'profiles/node_modules'))
symlinkSync(swarm, join(profile, 'node_modules/dsh-agent-swarm'))
symlinkSync(rigor, join(profile, 'node_modules/dsh-rigorquant'))
writeFileSync(join(profile, 'package.json'), JSON.stringify({
  name: 'profile-compat-proof', private: true,
  dependencies: { 'dsh-agent-swarm': `link:${swarm}`, 'dsh-rigorquant': `link:${rigor}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-agent-swarm', 'dsh-rigorquant'] } }
}))
writeFileSync(join(profile, 'cordis.yml'), '[]')
writeFileSync(join(profile, 'cordis.patch.yml'), '[]')
const patch = join(base, 'proof.patch.json')
writeFileSync(patch, JSON.stringify([
  { insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'standard' } },
    { id: 'proof-standard', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard', name: 'Standard proof', plugins: [] } },
    { id: 'proof-driver', name: join(repo, 'tests/integration/driver/profile-compat.mjs') }
  ] },
  { id: 'llm-retry', disabled: true },
  { id: 'rq-model-router', config: { rootPrimary: { provider: 'profile-proof', model: 'root-routed' }, doublecheckerPrimary: { provider: 'profile-proof', model: 'proof-routed' } } },
  ...['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'tool-todo', 'tool-web'].map(id => ({ id, disabled: true }))
]))
const preload = join(base, 'private-home.mjs')
writeFileSync(preload, `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();globalThis.fetch=async()=>{throw new Error('profile proof forbids network')};`, { mode: 0o600 })
const resultFile = join(base, 'result.json')
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : []
})
const tracked = [
  ...['dsh-agent-loop/lib/index.js', 'dsh-agent/lib/index.js', 'dsh-subprocess-local/lib/index.js', 'dsh-working-directory/lib/index.js', 'dsh-fs-local/lib/index.js'].map(name => join(sdk, 'node_modules/@deepseek-ai', name)),
  ...files(join(rigor, 'dsh')), ...files(join(rigor, 'agent-presets')), join(rigor, 'package.json'),
  ...files(join(swarm, 'lib')), join(swarm, 'package.json'),
  fileURLToPath(import.meta.url), join(repo, 'tests/integration/driver/profile-compat.mjs'), patch
]
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const identities = () => Object.fromEntries(tracked.map(path => [path, existsSync(path) ? hash(path) : null]))
const before = identities()
const run = spawnSync(process.execPath, [join(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'proof', '--patch', patch], {
  cwd: base, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  env: { PATH: process.env.PATH, LANG: 'C.UTF-8', NODE_OPTIONS: `--import=${preload}`, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', PROFILE_COMPAT_OUT: resultFile }
})
writeFileSync(join(base, 'host.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`, { mode: 0o600 })
let behavior
try { behavior = JSON.parse(readFileSync(resultFile, 'utf8')) } catch (error) { behavior = { status: 'missing-result', error: error.message } }
const after = identities()
const receipt = { sdk, rigor, swarm, base, exitCode: run.status, signal: run.signal, spawnError: run.error?.message, sdkUnchanged: JSON.stringify(before) === JSON.stringify(after), trackedFiles: { before, after }, behavior }
writeFileSync(join(output, 'profile-compat-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ base, exitCode: run.status, sdkUnchanged: receipt.sdkUnchanged, status: behavior.status, error: behavior.error, checks: behavior.checks }))
process.exitCode = run.status === 0 && behavior.status === 'passed' && receipt.sdkUnchanged ? 0 : 1
