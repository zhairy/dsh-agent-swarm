#!/usr/bin/env node
/**
 * 用私有 DSH 0.2.2-rc.3、Swarm 编译候选和 Notebook 候选启动一次真实 Host。
 *
 * 默认证据目录是 release-artifacts；每次运行都用新的 host-notebook-* 文件，
 * 不覆盖已有 service-*、host-* 证据。SDK 和 Notebook candidate 只读使用。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultEvidence = '/data/nas/public/swarm/release-artifacts/v3.4.0-routing-notebook-20261117'
const defaultSdk = '/home/zhairy/.dsh/local-bundles/dsh-0.2.2-rc.3-swarm340/node_modules'
const defaultCandidate = join(defaultEvidence, 'notebook-candidate')
const defaultPython = '/home/zhairy/.dsh/runtimes/notebook-py-8.10.0-7.4.0/bin/python'
const option = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? resolve(process.argv[index + 1]) : fallback
}
const expectRed = process.argv.includes('--expect-red')
const evidenceDir = option('--out', process.env.SWARM_TEST_EVIDENCE_DIR ?? defaultEvidence)
const sdkSource = option('--dsh', process.env.SWARM_DSH_MODULES ?? defaultSdk)
const swarmRoot = option('--swarm', process.env.SWARM_PLUGIN_ROOT ?? repo)
const candidate = option('--notebook', defaultCandidate)
const privatePython = option('--python', process.env.DSH_NOTEBOOK_PRIVATE_PYTHON ?? defaultPython)
const privatePrefix = dirname(dirname(privatePython))
const profileName = 'notebook-host'
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const evidencePrefix = `host-notebook-${runId}`
mkdirSync(evidenceDir, { recursive: true, mode: 0o700 })
const base = join(evidenceDir, `notebook-host-home-${runId}`)
const home = join(base, 'home')
const profile = join(home, 'profiles', profileName)
const workspace = join(base, 'workspace')
const tmp = join(base, 'tmp')
const sdk = join(base, 'sdk')
const driver = join(repo, 'tests/integration/driver/notebook-host.mjs')
const patch = join(base, 'notebook-host.patch.json')
const preload = join(base, 'offline-preload.mjs')
const resultFile = join(evidenceDir, `${evidencePrefix}-driver.json`)
const receiptFile = join(evidenceDir, `${evidencePrefix}-receipt.json`)
const hostLog = join(evidenceDir, `${evidencePrefix}-host.log`)
const redact = text => String(text).replace(/token=[^\s&]+/g, 'token=[REDACTED]')
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const durableWrite = (file, value) => {
  const fd = openSync(file, 'w', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
const run = (program, args, options = {}) => execFileSync(program, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options })
const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(error => error ? reject(error) : resolvePort(address.port))
  })
})
const hostVersion = () => JSON.parse(readFileSync(join(sdkSource, '@deepseek-ai/dsh/package.json'), 'utf8')).version
const getKernelPids = (scopePath = workspace) => {
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,stat=,args='], { encoding: 'utf8' })
      .split('\n')
      .filter(line => /kernel_driver\.py|ipykernel_launcher/.test(line) && line.includes(scopePath))
      .map(line => ({ pid: Number(line.trim().split(/\s+/, 1)[0]), line: line.trim() }))
      .filter(row => Number.isSafeInteger(row.pid) && row.pid > 0)
  } catch {
    return []
  }
}
const writePreload = () => {
  writeFileSync(preload, `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();const real=globalThis.fetch;globalThis.fetch=(input,init)=>{const value=typeof input==='string'||input instanceof URL?String(input):input.url;const url=new URL(value);if(url.hostname==='127.0.0.1'||url.hostname==='localhost')return real(input,init);return Promise.resolve(new Response('offline notebook host fixture',{status:503}))};`, { flag: 'wx', mode: 0o600 })
}
const writeProfile = () => {
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  if (!existsSync(join(swarmRoot, 'node_modules'))) symlinkSync(sdkSource, join(swarmRoot, 'node_modules'))
  symlinkSync(swarmRoot, join(profile, 'node_modules', 'dsh-agent-swarm'))
  mkdirSync(join(profile, 'node_modules', '@beihaizb'), { recursive: true })
  symlinkSync(candidate, join(profile, 'node_modules', '@beihaizb', 'dsh-notebook'))
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'notebook-host-proof',
    private: true,
    type: 'module',
    dependencies: {
      'dsh-agent-swarm': `link:${swarmRoot}`,
      '@beihaizb/dsh-notebook': `link:${candidate}`
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-swarm'] } }
  }, null, 2), { mode: 0o600 })
  writeFileSync(join(profile, 'cordis.yml'), '[]\n', { mode: 0o600 })
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
}
const writePatch = host => {
  const routes = {
    tian_shu: { chain: [{ provider: 'notebook-host-mock', model: 'notebook-root' }] },
    'suan_heng:research': { chain: [{ provider: 'notebook-host-mock', model: 'notebook-math' }] },
    'suan_heng:verify': { chain: [{ provider: 'notebook-host-mock', model: 'notebook-math' }] },
    fu_he: { chain: [{ provider: 'notebook-host-mock', model: 'managed-bash-math' }] }
  }
  const disabledRows = ['llm-retry', 'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill',
    'command-goal', 'tool-goal', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork',
    'workflow-ptc', 'tool-workflow', 'tool-todo', 'tool-web']
  const layers = [
    { id: 'permission', config: { defaultPreset: 'notebook-host', presets: { 'notebook-host': { sandbox: 'read-only', approval: 'never' } } } },
    { id: 'swarm-core', config: {
      routes,
      jev: { enabled: false },
      review: { enabled: false },
      planningReview: { enabled: false },
      watchdog: { enabled: false },
      workflow: { mode: 'advisory' },
      agents: { maxRetries: 0, retryBackoffMs: 0, networkWaitMs: 0 },
      persistence: { enabled: false }
    } },
    ...disabledRows.map(id => ({ id, disabled: true })),
    { insert: [
      { id: 'notebook-candidate', name: '@beihaizb/dsh-notebook' },
      { id: 'notebook-host-driver', name: driver }
    ] }
  ]
  writeFileSync(patch, JSON.stringify(layers, null, 2), { mode: 0o600 })
  return host
}
const writeReceipt = value => durableWrite(receiptFile, value)

let child
let logFd
let receiptWritten = false
try {
  if (!existsSync(join(sdkSource, '@deepseek-ai/dsh/package.json'))) throw new Error(`DSH modules missing: ${sdkSource}`)
  if (!existsSync(join(candidate, 'package.json'))) throw new Error(`Notebook candidate missing: ${candidate}`)
  if (!existsSync(privatePython)) throw new Error(`Private Notebook Python missing: ${privatePython}`)
  if (!existsSync(join(privatePrefix, 'pyvenv.cfg'))) throw new Error(`Private Notebook runtime prefix is not a venv: ${privatePrefix}`)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  mkdirSync(join(workspace, 'notebooks'), { recursive: true, mode: 0o700 })
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  writePreload()
  writeProfile()
  const trackedSdkPaths = ['dsh-subprocess-local/lib/index.js', 'dsh-working-directory/lib/index.js', 'dsh-fs-local/lib/index.js']
  const sdkSourceHashes = trackedSdkPaths.map(path => ({ path, sha256: sha(join(sdkSource, '@deepseek-ai', path)) }))
  const sharedLibService = join(repo, 'lib/application/swarm-service.js')
  const sharedLibBefore = existsSync(sharedLibService) ? sha(sharedLibService) : null
  const sourceServiceBefore = sha(join(repo, 'src/application/swarm-service.ts'))
  const kernelPidsBefore = getKernelPids()
  const host = hostVersion()
  writePatch(host)
  // The private SDK may live on another filesystem. Copy it fully so the
  // installer atomically renames patched files only in this private copy.
  const sdkModules = join(sdk, 'node_modules')
  mkdirSync(sdkModules, { recursive: true, mode: 0o700 })
  run('cp', ['-a', '--', `${sdkSource}/.`, `${sdkModules}/`])
  const installer = (...args) => run(process.execPath, [join(repo, 'scripts/apply-dsh-execution-boundary.mjs'), '--dsh', sdkModules, ...args])
  installer('--restore')
  installer()
  const patchedSdk = sdkModules
  const version = hostVersionFrom(patchedSdk)
  if (version !== host) throw new Error(`Patched SDK version changed: ${version} != ${host}`)
  const sdkHashes = trackedSdkPaths.map(path => ({ path, sha256: sha(join(patchedSdk, '@deepseek-ai', path)) }))
  const port = await freePort()
  logFd = openSync(hostLog, 'w', 0o600)
  const env = {
    PATH: '/home/zhairy/.npm-global/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_NOTEBOOK_PRIVATE_PYTHON: privatePython,
    DSH_NOTEBOOK_PRIVATE_RUNTIME_PREFIX: privatePrefix,
    DSH_NOTEBOOK_CONTROLLER_PYTHON: privatePython,
    DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX: privatePrefix,
    SWARM_DSH_MODULES: patchedSdk,
    SWARM_DSH_VERSION: version,
    SWARM_HOST_VERSION: version,
    SWARM_PLUGIN_ROOT: swarmRoot,
    SWARM_TEST_EVIDENCE_DIR: evidenceDir,
    NOTEBOOK_HOST_OUT: resultFile,
    NOTEBOOK_HOST_CANDIDATE: candidate,
    NOTEBOOK_HOST_PORT: String(port),
    NODE_OPTIONS: `--import=${preload}`,
    ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS })
  }
  child = spawn(process.execPath, [
    join(patchedSdk, '@deepseek-ai/dsh/lib/bin.js'),
    '--profile', profileName,
    '--patch', patch,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--no-open'
  ], { cwd: workspace, env, stdio: ['ignore', logFd, logFd] })
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', resolveExit)
  })
  const driverResult = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : { status: 'missing-result' }
  const baselinePids = new Set(kernelPidsBefore.map(row => row.pid))
  const residual = getKernelPids().filter(row => !baselinePids.has(row.pid))
  const sdkSourceHashesAfter = trackedSdkPaths.map(path => ({ path, sha256: sha(join(sdkSource, '@deepseek-ai', path)) }))
  const sdkSourceUnchanged = JSON.stringify(sdkSourceHashes) === JSON.stringify(sdkSourceHashesAfter)
  const sharedLibAfter = existsSync(sharedLibService) ? sha(sharedLibService) : null
  const sourceServiceAfter = sha(join(repo, 'src/application/swarm-service.ts'))
  const expectedRedMatch = expectRed && driverResult.status === 'failed'
    && /Notebook|执行边界|boundary|scope|kernel/i.test(String(driverResult.error ?? driverResult.assertions?.toolErrors ?? ''))
  const receipt = {
    status: driverResult.status === 'passed' && code === 0 && residual.length === 0 && sdkSourceUnchanged
      && sharedLibBefore === sharedLibAfter && sourceServiceBefore === sourceServiceAfter
      ? 'passed'
      : expectedRedMatch ? 'expected-red' : 'failed',
    runId,
    expectedRed: expectRed,
    hostVersion: version,
    sdkSource,
    sdkModules: patchedSdk,
    sdkSourceHashes,
    sdkSourceHashesAfter,
    sdkSourceUnchanged,
    sdkHashes,
    swarmRoot,
    swarmPackageSha256: sha(join(swarmRoot, 'package.json')),
    swarmHashes: {
      service: sha(join(swarmRoot, 'lib/application/swarm-service.js')),
      roleRegistry: sha(join(swarmRoot, 'lib/role-registry.js')),
      hostGuards: sha(join(swarmRoot, 'lib/application/host-guards.js')),
      notebookRuntime: sha(join(swarmRoot, 'lib/adapters/dsh-host/notebook-runtime.js'))
    },
    sourceService: { before: sourceServiceBefore, after: sourceServiceAfter },
    sharedLibService: { before: sharedLibBefore, after: sharedLibAfter },
    notebookCandidate: candidate,
    notebookPackageSha256: sha(join(candidate, 'package.json')),
    privatePython,
    privatePrefix,
    profile,
    workspace,
    driverResult,
    hostExitCode: code,
    kernelResidual: residual,
    evidence: { driver: resultFile, hostLog, receipt: receiptFile },
    startedAt: runId
  }
  writeReceipt(receipt)
  receiptWritten = true
  if (receipt.status === 'failed') process.exitCode = 1
  process.stdout.write(JSON.stringify({ status: receipt.status, driver: resultFile, receipt: receiptFile, hostLog, hostVersion: version, kernelResidual: residual }, null, 2) + '\n')
} catch (error) {
  if (!receiptWritten) {
    const current = {
      status: expectRed ? 'expected-red' : 'failed',
      runId,
      error: String(error?.stack ?? error),
      expectedRed: expectRed,
      evidence: { driver: resultFile, hostLog, receipt: receiptFile }
    }
    writeReceipt(current)
  }
  if (!expectRed) process.exitCode = 1
  process.stderr.write(`${String(error?.stack ?? error)}\n`)
} finally {
  try { if (logFd !== undefined) closeSync(logFd) } catch {}
  try {
    const log = existsSync(hostLog) ? readFileSync(hostLog, 'utf8') : ''
    writeFileSync(hostLog, redact(log), { mode: 0o600 })
  } catch {}
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await new Promise(resolveExit => {
      child.once('exit', resolveExit)
      setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 5000).unref()
    })
  }
}

function hostVersionFrom(modules) {
  return JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version
}
