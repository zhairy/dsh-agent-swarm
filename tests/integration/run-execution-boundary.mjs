import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, renameSync, rmSync, openSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const project = fileURLToPath(new URL('../../', import.meta.url))
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1]
if (!args.includes('--dsh') || !args.includes('--out')) throw new Error('Usage: node tests/integration/run-execution-boundary.mjs --dsh <node_modules> --out <evidence-directory> [--bundle <extracted-package>]')
const modules = resolve(option('--dsh')), sourceHost = dirname(modules), output = resolve(option('--out'))
const bundle = args.includes('--bundle') ? resolve(option('--bundle')) : project
mkdirSync(output, { recursive: true, mode: 0o700 })
const runId = randomUUID(), startedAt = new Date().toISOString()
writeFileSync(join(output, 'summary.json'), JSON.stringify({ status: 'running', runId, startedAt }), { mode: 0o600 })
const plan = JSON.parse(readFileSync(join(project, 'patches/dsh-execution-boundary-0.2.2-rc.1.json'), 'utf8'))
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const sourceHashes = Object.fromEntries(plan.files.map(entry => [entry.path, hash(join(modules, entry.path))]))
const sdk = mkdtempSync(join(dirname(sourceHost), '.swarm-execution-proof-'))
const home = mkdtempSync(join(tmpdir(), 'swarm-execution-proof-')), repo = join(home, 'repo')
let child
const run = (program, command, options = {}) => execFileSync(program, command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, ...options })
const installer = flags => run(process.execPath, [join(project, 'scripts/apply-dsh-execution-boundary.mjs'), '--dsh', join(sdk, 'node_modules'), ...flags])
const atomic = (file, content) => { const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); renameSync(temp, file) }
const fixture = join(home, 'fixture.json'), patch = join(home, 'proof.yml'), preload = join(sdk, `proof-${randomUUID()}.mjs`)
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)) }) })
const runPhase = async phase => {
  const port = await freePort(), resultFile = join(output, `${phase}.json`), log = join(output, `${phase}.log`)
  const fd = openSync(log, 'w', 0o600)
  let timer
  try {
    child = spawn(process.execPath, [join(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', String(port), '--no-open'], {
      cwd: repo, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--import=${preload}`, SWARM_BOUNDARY_FIXTURE: fixture, SWARM_BOUNDARY_PHASE: phase, SWARM_BOUNDARY_OUT: resultFile }, stdio: ['ignore', fd, fd]
    })
    timer = setTimeout(() => child.kill('SIGTERM'), 125000)
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    const result = JSON.parse(readFileSync(resultFile, 'utf8'))
    assert.equal(code, 0, `${phase}: ${result.error ?? 'Host exited unsuccessfully'}`)
    assert.equal(result.status, 'passed', `${phase}: ${result.error ?? 'failed'}`)
    console.log(JSON.stringify({ phase, status: result.status, requests: result.requests, children: result.children.length }))
    return result
  } finally {
    clearTimeout(timer); closeSync(fd)
    atomic(log, readFileSync(log, 'utf8').replace(/token=[^\s]+/g, 'token=[REDACTED]'))
  }
}

try {
  // Hardlinks keep the isolated SDK cheap; the installer ALWAYS replaces via
  // rename, so even its fault/rollback tests cannot edit the live inode.
  run('cp', ['-al', '--', `${sourceHost}/.`, sdk])
  installer(['--restore'])
  mkdirSync(repo); mkdirSync(join(repo, 'allowed'))
  const git = (...command) => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', '-C', repo, ...command])
  git('init', '-b', 'main')
  for (const [name, value] of Object.entries({ '.gitignore': '.agents/\n', 'source.txt': 'source-protected', 'denied.txt': 'scope-protected', 'allowed/inside.txt': 'initial', 'allowed/drift.txt': 'source-drift-protected' })) writeFileSync(join(repo, name), value)
  git('add', '.'); git('commit', '-m', 'execution boundary fixture')
  const newFixture = () => ({ repositoryRoot: repo, path: join(repo, '.agents/worktrees/boundary-case'), rootId: `boundary-root-${randomUUID()}` })
  writeFileSync(fixture, JSON.stringify(newFixture()), { mode: 0o600 })
  const profile = join(home, 'profiles/web'); mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(bundle, join(profile, 'node_modules/dsh-agent-swarm'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'execution-boundary-proof', private: true, type: 'module', dependencies: { 'dsh-agent-swarm': `link:${bundle}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-swarm'] } } }), { mode: 0o600 })
  writeFileSync(patch, `- id: permission\n  config:\n    defaultPreset: boundary-proof\n    presets:\n      boundary-proof:\n        sandbox: workspace-write\n        approval: never\n- id: swarm-core\n  config:\n    jev:\n      enabled: false\n    review:\n      enabled: false\n    planningReview:\n      enabled: false\n    watchdog:\n      enabled: false\n    workflow:\n      mode: advisory\n    agents:\n      maxRetries: 0\n    routes:\n      zhu_jian:\n        chain:\n          - provider: swarm-boundary-mock\n            model: role-zhu_jian\n      tian_shu:\n        chain:\n          - provider: swarm-boundary-mock\n            model: root\n- insert:\n    - id: boundary-worktrees\n      name: '@deepseek-ai/dsh-experimental-worktree'\n    - id: boundary-worktree-tool\n      name: '@deepseek-ai/dsh-experimental-tool-worktree'\n    - id: boundary-driver\n      name: ${project}/tests/integration/driver/execution-boundary.mjs\n`, { mode: 0o600 })
  // Keep the bootstrap outside /tmp: the real Host workspace sandbox masks
  // host /tmp. HOME itself is inherited/left unset, never repurposed.
  writeFileSync(preload, `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();const real=globalThis.fetch;globalThis.fetch=(x,o)=>{const u=new URL(typeof x==='string'||x instanceof URL?String(x):x.url);return ['127.0.0.1','localhost'].includes(u.hostname)?real(x,o):Promise.resolve(new Response('offline fixture',{status:503}))};`, { flag: 'wx', mode: 0o600 })
  const unsupported = await runPhase('unsupported')
  installer([]); installer([])
  const first = join(sdk, 'node_modules', plan.files[0].path), valid = readFileSync(first)
  atomic(first, Buffer.concat([valid, Buffer.from('\n// unknown fixture bytes\n')]))
  assert.throws(() => installer(['--check']), /Unknown Host checksum/)
  atomic(first, valid)
  installer(['--restore'])
  for (const entry of plan.files) assert.equal(hash(join(sdk, 'node_modules', entry.path)), entry.beforeSha256)
  installer([])
  writeFileSync(fixture, JSON.stringify(newFixture()), { mode: 0o600 })
  const live = await runPhase('live'), cold = await runPhase('cold')
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(join(modules, name)), expected, 'live Host file changed')
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ status: 'passed', runId, startedAt, finishedAt: new Date().toISOString(), host: plan.hostVersion, bundle, modelProvider: 'local mock; no external inference', sourceHostUnchanged: true, bridgeChecks: ['unpatched-refusal', 'idempotence', 'unknown-checksum-refusal', 'restore'], unsupportedHostBlocked: unsupported.unsupportedHostBlocked, liveHandoff: live.snapshotRetained && live.oldOwnerDenied, physicalScopeEnforced: live.fsBoundaryDenied && live.driftPrevented, coldWriteGrantDenied: cold.coldWriteGrantDenied }, null, 2), { mode: 0o600 })
} catch (error) {
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ status: 'failed', runId, startedAt, error: String(error) }), { mode: 0o600 })
  throw error
} finally {
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }) }
  for (const [name, expected] of Object.entries(sourceHashes)) assert.equal(hash(join(modules, name)), expected, 'live Host changed during proof')
  rmSync(sdk, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true })
}
