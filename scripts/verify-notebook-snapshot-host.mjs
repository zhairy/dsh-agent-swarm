#!/usr/bin/env node
/**
 * v3.4.1 Notebook 真实 rc3 Host 两次启动保存/恢复夹具。
 *
 * 只使用显式传入的 SDK/candidate/Python。Host、profile、DSH_HOME、repo 和边界桥
 * SDK 全部落在本次私有 scratch；源 SDK 只读，auth URL 只经 IPC 进入 runner 内存。
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  captureScopedProcesses,
  collectLocalRuntimeClosure,
  getNotebookCellFacts,
  getProcessIdentity,
  parseRequiredOptions,
  readJson,
  redactSensitiveText,
  sha256File,
  sha256Tree,
  validateHttpProbeResult,
  waitFor,
  writeDurable
} from '../tests/integration/driver/notebook-snapshot-host-helpers.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = parseRequiredOptions(process.argv.slice(2), ['dsh', 'swarm', 'notebook', 'python', 'out'])
const sdkSource = resolve(options.dsh)
const swarmRoot = resolve(options.swarm)
const notebookRoot = resolve(options.notebook)
const privatePython = resolve(options.python)
const privatePrefix = dirname(dirname(privatePython))
const evidenceDir = resolve(options.out)
const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
const runRoot = join(evidenceDir, `notebook-snapshot-host-${runId}`)
const work = join(runRoot, 'work')
const home = join(work, 'home')
const profileName = 'notebook-snapshot-host'
const profile = join(home, 'profiles', profileName)
const workspace = join(work, 'repo')
const tmp = join(work, 'tmp')
const sdk = join(work, 'sdk')
const sdkModules = join(sdk, 'node_modules')
const patchFile = join(work, 'profile.patch.json')
const preloadFile = join(work, 'offline-preload.mjs')
const metadataFile = join(runRoot, 'fixture-metadata.json')
const phase1ResultFile = join(runRoot, 'phase1-driver.json')
const phase2ResultFile = join(runRoot, 'phase2-driver.json')
const phase1Log = join(runRoot, 'phase1-host.log')
const phase2Log = join(runRoot, 'phase2-host.log')
const httpResultFile = join(runRoot, 'phase2-http-probe.json')
const sentinelFile = join(work, 'phase2-http-complete.json')
const summaryFile = join(runRoot, 'summary.json')
const checkpointFile = join(runRoot, 'phase1-checkpoint.json')
const artifacts = join(runRoot, 'artifacts')
const driver = join(repo, 'tests/integration/driver/notebook-snapshot-host.mjs')
const startedAt = new Date().toISOString()
let stage = 'preflight'
let activeHost
let workRetained = false
let stabilityEvidence
let processBaseline = []
let baselineProcessIds = new Set()
let sourceSdkPlan
let sdkHashesBefore
let runtimeSourceFreshness

const describeError = error => ({
  name: typeof error?.name === 'string' ? error.name : typeof error,
  message: typeof error?.message === 'string' ? error.message : String(error ?? ''),
  code: typeof error?.code === 'string' ? error.code : null,
  stack: typeof error?.stack === 'string' ? redactSensitiveText(error.stack) : null,
  value: (() => {
    try {
      return redactSensitiveText(JSON.stringify(error))
    } catch {
      return String(error)
    }
  })()
})

const run = (program, args, options = {}) => execFileSync(program, args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 120_000,
  ...options
})

const freePort = () => new Promise((resolvePort, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(error => {
      if (error === undefined || error === null) resolvePort(address.port)
      else reject(error)
    })
  })
})

const writeAtomic = (file, value, mode = 0o600) => {
  const temporary = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', mode)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, file)
}

const writeTextAtomic = (file, value, mode = 0o600) => {
  const temporary = `${file}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', mode)
  try {
    writeFileSync(fd, String(value), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, file)
}

const getHostVersion = modules => readJson(join(modules, '@deepseek-ai/dsh/package.json')).version
const getComponentVersions = () => ({
  swarm: readJson(join(swarmRoot, 'package.json')).version,
  notebook: readJson(join(notebookRoot, 'package.json')).version
})

const writePreload = () => {
  writeTextAtomic(preloadFile, [
    "import os from 'node:os'",
    "import { syncBuiltinESMExports } from 'node:module'",
    `os.homedir = () => ${JSON.stringify(home)}`,
    'syncBuiltinESMExports()',
    'const realFetch = globalThis.fetch',
    'globalThis.fetch = (input, init) => {',
    "  const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url",
    '  const url = new URL(value)',
    "  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return realFetch(input, init)",
    "  return Promise.resolve(new Response('offline Notebook snapshot Host fixture', { status: 503 }))",
    '}',
    ''
  ].join('\n'))
}

const writeProfile = () => {
  mkdirSync(join(profile, 'node_modules', '@beihaizb'), { recursive: true })
  symlinkSync(swarmRoot, join(profile, 'node_modules', 'dsh-agent-swarm'), 'dir')
  symlinkSync(notebookRoot, join(profile, 'node_modules', '@beihaizb', 'dsh-notebook'), 'dir')
  writeDurable(join(profile, 'package.json'), {
    name: 'notebook-snapshot-host-proof',
    private: true,
    type: 'module',
    dependencies: {
      'dsh-agent-swarm': `link:${swarmRoot}`,
      '@beihaizb/dsh-notebook': `link:${notebookRoot}`
    },
    dsh: {
      profile: {
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          'dsh-agent-swarm',
          '@beihaizb/dsh-notebook'
        ]
      }
    }
  })
  writeTextAtomic(join(profile, 'cordis.yml'), '[]\n')
  writeTextAtomic(join(profile, 'cordis.patch.yml'), '[]\n')
}

const writePatch = () => {
  const disabledRows = [
    'llm-retry',
    'tool-bash',
    'tool-pwsh',
    'tool-jobs',
    'tool-fs',
    'tool-fs-search',
    'skill-filesystem',
    'tool-skill',
    'command-goal',
    'tool-goal',
    'tool-subagent-control',
    'tool-subagent-list-agents',
    'tool-subagent',
    'tool-subagent-fork',
    'workflow-ptc',
    'tool-workflow',
    'tool-todo',
    'tool-web'
  ]
  const layers = [
    {
      id: 'permission',
      config: {
        defaultPreset: 'notebook-snapshot-host',
        presets: {
          'notebook-snapshot-host': {
            sandbox: 'workspace-write',
            approval: 'never'
          }
        }
      }
    },
    {
      id: 'swarm-core',
      config: {
        routes: {
          tian_shu: { chain: [{ provider: 'notebook-snapshot-host-mock', model: 'root' }] },
          zhu_jian: { chain: [{ provider: 'notebook-snapshot-host-mock', model: 'zhu-jian' }] },
          'suan_heng:research': { chain: [{ provider: 'notebook-snapshot-host-mock', model: 'suan-heng' }] },
          'suan_heng:verify': { chain: [{ provider: 'notebook-snapshot-host-mock', model: 'suan-heng' }] }
        },
        jev: { enabled: false },
        review: { enabled: false },
        planningReview: { enabled: false },
        watchdog: { enabled: false },
        workflow: { mode: 'advisory' },
        persistence: { enabled: true },
        agents: {
          maxRetries: 0,
          retryBackoffMs: 0,
          networkWaitMs: 0
        }
      }
    },
    ...disabledRows.map(id => ({ id, disabled: true })),
    {
      insert: [{
        id: 'notebook-snapshot-host-driver',
        name: driver
      }]
    }
  ]
  writeDurable(patchFile, layers)
}

const initRepo = () => {
  mkdirSync(join(workspace, 'notebooks'), { recursive: true, mode: 0o700 })
  writeTextAtomic(
    join(workspace, 'agent.md'),
    '唯一主工作树是当前仓库。禁止 git worktree add、linked worktree、第二 checkout；所有 Notebook fixture 数据只留在 notebooks。\n'
  )
  const git = (...args) => run('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'user.name=Notebook Snapshot Fixture',
    '-c', 'user.email=fixture@localhost',
    '-C', workspace,
    ...args
  ])
  git('init', '-b', 'main')
  git('add', 'agent.md')
  git('commit', '-m', 'notebook snapshot fixture baseline')
  const expectedHead = git('rev-parse', 'HEAD').trim()
  const worktrees = git('worktree', 'list', '--porcelain')
  assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1, 'fixture repo must have exactly one worktree')
  return { expectedHead, worktrees: worktrees.trim().split('\n') }
}

const sourceSdkHashes = plan => Object.fromEntries(plan.files.map(entry => [
  entry.path,
  sha256File(join(sdkSource, entry.path))
]))

const getScopeRoots = () => [work, notebookRoot]

const getScoped = () => captureScopedProcesses(getScopeRoots())
  .filter(processInfo => processInfo.pid !== process.pid && !baselineProcessIds.has(processInfo.pid))

const sameProcessGroup = processes => {
  const group = activeHost?.processGroup
  return Number.isSafeInteger(group) && processes.some(processInfo => processInfo.pgrp === group)
}

const terminateOwnedHost = async (runState, reason) => {
  const child = runState?.child
  if (child?.pid === undefined) return { attempted: false, reason }
  const currentLeader = getProcessIdentity(child.pid)
  const group = runState.processGroup
  const scoped = getScoped()
  const leaderOwned = currentLeader?.startTicks === runState.leaderStartTicks
  const groupOwned = sameProcessGroup(scoped) || inGroup(scoped, group)
  if (!leaderOwned && !groupOwned) {
    return { attempted: false, reason, leaderOwned, groupOwned }
  }
  try {
    process.kill(-group, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  await Promise.race([
    new Promise(resolveExit => child.once('exit', resolveExit)),
    new Promise(resolveDelay => setTimeout(resolveDelay, 5_000))
  ])
  const residual = getScoped()
  if (inGroup(residual, group)) {
    try {
      process.kill(-group, 'SIGKILL')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  return { attempted: true, reason, leaderOwned, groupOwned, group, residualAfterKill: getScoped() }
}

const inGroup = (processes, group) => Number.isSafeInteger(group)
  && processes.some(processInfo => processInfo.pgrp === group)

const runHost = async (phase, hostVersion) => {
  stage = `${phase}-host:free-port`
  const port = await freePort()
  const resultFile = phase === 'save' ? phase1ResultFile : phase2ResultFile
  const logFile = phase === 'save' ? phase1Log : phase2Log
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
    SWARM_DSH_MODULES: sdkModules,
    SWARM_DSH_VERSION: hostVersion,
    SWARM_HOST_VERSION: hostVersion,
    SWARM_PLUGIN_ROOT: swarmRoot,
    SWARM_TEST_EVIDENCE_DIR: runRoot,
    NOTEBOOK_SNAPSHOT_HOST_PHASE: phase,
    NOTEBOOK_SNAPSHOT_HOST_OUT: resultFile,
    NOTEBOOK_SNAPSHOT_HOST_METADATA: metadataFile,
    NOTEBOOK_SNAPSHOT_HOST_SENTINEL: sentinelFile,
    NOTEBOOK_SNAPSHOT_HOST_HTTP_RESULT: httpResultFile,
    NOTEBOOK_SNAPSHOT_HOST_PORT: String(port),
    NOTEBOOK_SNAPSHOT_HOST_NOTEBOOK: notebookRoot,
    NOTEBOOK_SNAPSHOT_HOST_WORKSPACE: workspace,
    NODE_OPTIONS: `--import=${preloadFile}`,
    ...(process.env.XDG_RUNTIME_DIR === undefined ? {} : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
    ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined ? {} : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS })
  }
  stage = `${phase}-host:environment`
  if (phase === 'restore') env.NOTEBOOK_SNAPSHOT_HOST_EXPECTED_HEAD = readJson(metadataFile).expectedHead
  else env.NOTEBOOK_SNAPSHOT_HOST_EXPECTED_HEAD = readJson(checkpointFile).expectedHead

  stage = `${phase}-host:open-log`
  const logFd = openSync(logFile, 'w', 0o600)
  stage = `${phase}-host:spawn`
  const child = spawn(process.execPath, [
    join(sdkModules, '@deepseek-ai/dsh/lib/bin.js'),
    '--profile', profileName,
    '--patch', patchFile,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--no-open'
  ], {
    cwd: workspace,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd, 'ipc']
  })
  closeSync(logFd)
  stage = `${phase}-host:identify`
  const leader = getProcessIdentity(child.pid)
  const runState = {
    phase,
    port,
    child,
    processGroup: child.pid,
    leaderStartTicks: leader?.startTicks,
    leader,
    message: null,
    exit: null,
    logFile,
    resultFile
  }
  activeHost = runState
  child.on('message', message => {
    if (message?.type === 'notebook-snapshot-auth-url') runState.message = message
  })
  child.on('error', error => {
    runState.spawnError = describeError(error)
  })
  const exitPromise = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  runState.exitPromise = exitPromise
  return runState
}

const waitHostExit = async runState => {
  stage = `${runState.phase}-host:running`
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${runState.phase} Host 超时`)), 260_000).unref()
  })
  let exit
  try {
    exit = await Promise.race([runState.exitPromise, timeout])
  } catch (error) {
    const termination = await terminateOwnedHost(runState, 'timeout')
    throw Object.assign(error, { termination })
  }
  runState.exit = exit
  activeHost = undefined
  if (runState.message?.authUrl !== undefined) {
    throw new Error('auth URL remained unconsumed at Host exit')
  }
  return exit
}

const readDriverResult = file => existsSync(file) ? readJson(file) : { status: 'missing-result' }
const readEvidenceJson = file => {
  if (!existsSync(file)) return null
  try {
    return readJson(file)
  } catch (error) {
    return { readError: describeError(error) }
  }
}

const waitForNoScopedProcesses = async label => {
  try {
    await waitFor(() => getScoped().length === 0, 15_000, 100)
    return { label, quiescent: true, processes: [] }
  } catch {
    return { label, quiescent: false, processes: getScoped() }
  }
}

const authenticate = async authUrl => {
  const response = await fetch(authUrl, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'text/html' }
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const header = setCookie[0] ?? response.headers.get('set-cookie')
  const cookie = header?.split(';')[0]
  if (![302, 303].includes(response.status) || cookie === undefined) {
    throw new Error(`Host auth exchange failed: status=${response.status}`)
  }
  return { cookie, status: response.status, origin: new URL(authUrl).origin }
}

const postNotebook = async (origin, cookie, endpoint, body) => {
  const response = await fetch(`${origin}${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin
    },
    body: JSON.stringify(body)
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? {} : JSON.parse(text)
  } catch {
    parsed = { text: text.slice(0, 2000) }
  }
  return {
    status: response.status,
    body: parsed,
    contentType: response.headers.get('content-type')
  }
}

const performHttpProbe = async message => {
  const facts = {
    authExchange: null,
    get: null,
    unknownSession: null,
    run: null,
    edit: null,
    save: null,
    activeKernels: null
  }
  const session = await authenticate(message.authUrl)
  facts.authExchange = {
    status: session.status,
    cookieIssued: true
  }
  const get = await postNotebook(session.origin, session.cookie, '/nb/get', { _sid: message.childSid })
  const getFacts = getNotebookCellFacts(get.body)
  facts.get = {
    status: get.status,
    cells: getFacts.cellCount,
    sources: getFacts.sources,
    outputText: getFacts.outputText,
    kernelAlive: getFacts.kernelAlive,
    readOnly: getFacts.readOnly,
    path: getFacts.path,
    dirty: getFacts.dirty,
    code: get.body?.code ?? null
  }
  const unknownSid = `unknown-${randomUUID()}`
  const unknown = await postNotebook(session.origin, session.cookie, '/nb/get', { _sid: unknownSid })
  facts.unknownSession = {
    status: unknown.status,
    code: unknown.body?.code ?? null,
    error: typeof unknown.body?.error === 'string' ? unknown.body.error.slice(0, 500) : null
  }
  for (const [name, endpoint, body] of [
    ['run', '/nb/runCell', { _sid: message.childSid, cellId: 'snapshot-old-cell' }],
    ['edit', '/nb/editCell', { _sid: message.childSid, cellId: 'snapshot-old-cell', source: 'x = 99' }],
    ['save', '/nb/save', { _sid: message.childSid, path: 'notebooks/forbidden.ipynb' }]
  ]) {
    const response = await postNotebook(session.origin, session.cookie, endpoint, body)
    facts[name] = {
      status: response.status,
      code: response.body?.code ?? null,
      error: typeof response.body?.error === 'string' ? response.body.error.slice(0, 500) : null
    }
  }
  const kernels = await postNotebook(session.origin, session.cookie, '/nb/activeKernels', { _sid: message.childSid })
  const list = kernels.body?.kernels ?? kernels.body?.activeKernels ?? kernels.body
  facts.activeKernels = {
    status: kernels.status,
    count: Array.isArray(list) ? list.length : 0,
    code: kernels.body?.code ?? null
  }
  validateHttpProbeResult(facts)
  return facts
}

const completePhase2Http = async runState => {
  const message = await waitFor(() => runState.message, 90_000, 100)
  let result
  try {
    result = await performHttpProbe(message)
    writeDurable(httpResultFile, result)
    writeAtomic(sentinelFile, { ok: true, at: new Date().toISOString() })
  } catch (error) {
    result = {
      status: 'failed',
      error: redactSensitiveText(error?.stack ?? error)
    }
    writeDurable(httpResultFile, result)
    writeAtomic(sentinelFile, { ok: false, error: redactSensitiveText(error?.message ?? error) })
    throw error
  } finally {
    runState.message = null
  }
  return result
}

const copyEvidenceArtifacts = metadata => {
  mkdirSync(artifacts, { recursive: true, mode: 0o700 })
  const savedPath = metadata.savedPath
  const privateSnapshotPath = metadata.privateSnapshotPath
  if (existsSync(savedPath)) {
    copyFileSync(savedPath, join(artifacts, 'state.ipynb'))
  }
  if (existsSync(privateSnapshotPath)) {
    copyFileSync(privateSnapshotPath, join(artifacts, 'private-snapshot.json'))
  }
  return {
    savedNotebook: join(artifacts, 'state.ipynb'),
    privateSnapshot: join(artifacts, 'private-snapshot.json'),
    savedNotebookSha256: existsSync(join(artifacts, 'state.ipynb')) ? sha256File(join(artifacts, 'state.ipynb')) : null,
    privateSnapshotSha256: existsSync(join(artifacts, 'private-snapshot.json')) ? sha256File(join(artifacts, 'private-snapshot.json')) : null
  }
}

const componentSnapshot = () => {
  const hasSwarmSource = existsSync(join(swarmRoot, 'src'))
  const common = {
    swarmMode: hasSwarmSource ? 'source' : 'package',
    swarmPackageSha256: sha256File(join(swarmRoot, 'package.json')),
    swarmRuntimeTreeSha256: sha256Tree(join(swarmRoot, 'lib')),
    swarmLibIndexSha256: sha256File(join(swarmRoot, 'lib/index.js')),
    swarmNotebookContextLibSha256: sha256File(join(swarmRoot, 'lib/adapters/dsh-host/notebook-context.js')),
    notebookSourceTreeSha256: sha256Tree(notebookRoot),
    notebookPackageSha256: sha256File(join(notebookRoot, 'package.json')),
    notebookIndexSha256: sha256File(join(notebookRoot, 'lib/index.js')),
    notebookHostContextSha256: sha256File(join(notebookRoot, 'lib/notebook-host-context.js')),
    notebookSnapshotBridgeSha256: sha256File(join(notebookRoot, 'lib/notebook-snapshot-bridge.js'))
  }
  if (!hasSwarmSource) {
    return {
      ...common,
      swarmRuntimeClosure: collectLocalRuntimeClosure(swarmRoot)
    }
  }
  return {
    ...common,
    swarmSourceTreeSha256: sha256Tree(join(swarmRoot, 'src')),
    swarmNotebookContextSourceSha256: sha256File(join(swarmRoot, 'src/adapters/dsh-host/notebook-context.ts'))
  }
}

const waitForComponentStability = async () => {
  let previous = componentSnapshot()
  const checks = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 15_000))
    const current = componentSnapshot()
    const stable = JSON.stringify(current) === JSON.stringify(previous)
    checks.push({ attempt, checkedAt: new Date().toISOString(), stable, digest: sha256File(join(swarmRoot, 'package.json')) })
    if (stable) return { stable, checks, snapshot: current }
    previous = current
  }
  throw new Error('Swarm/Notebook candidate 在 45 秒稳定性窗口内继续变化；拒绝运行移动目标')
}

const cleanup = () => {
  const before = getScoped()
  if (before.length > 0) {
    workRetained = true
    return {
      cleaned: false,
      retainedWork: work,
      reason: 'scoped processes still present; refusing recursive cleanup',
      processes: before
    }
  }
  rmSync(work, { recursive: true, force: true })
  return { cleaned: !existsSync(work), removedWork: work }
}

const main = async () => {
  mkdirSync(runRoot, { recursive: true, mode: 0o700 })
  writeDurable(summaryFile, { status: 'running', runId, stage, startedAt })

  stage = 'preflight'
  assert.equal(existsSync(join(sdkSource, '@deepseek-ai/dsh/package.json')), true, `DSH modules missing: ${sdkSource}`)
  assert.equal(existsSync(join(swarmRoot, 'package.json')), true, `Swarm candidate missing: ${swarmRoot}`)
  assert.equal(existsSync(join(notebookRoot, 'package.json')), true, `Notebook candidate missing: ${notebookRoot}`)
  assert.equal(existsSync(privatePython), true, `private Python missing: ${privatePython}`)
  assert.equal(existsSync(join(privatePrefix, 'pyvenv.cfg')), true, `private Python prefix is not a venv: ${privatePrefix}`)
  const hostVersion = getHostVersion(sdkSource)
  assert.equal(hostVersion, '0.2.2-rc.3', `unsupported Host version ${hostVersion}`)
  const plan = readJson(join(repo, `patches/dsh-execution-boundary-${hostVersion}.json`))
  sourceSdkPlan = plan
  sdkHashesBefore = sourceSdkHashes(plan)
  stabilityEvidence = await waitForComponentStability()
  const componentsBefore = stabilityEvidence.snapshot
  assert.deepEqual(componentSnapshot(), componentsBefore, 'candidate changed immediately after stability check')
  const versions = getComponentVersions()
  processBaseline = captureScopedProcesses(getScopeRoots())
  baselineProcessIds = new Set(processBaseline.map(processInfo => processInfo.pid))
  const hasSwarmSource = existsSync(join(swarmRoot, 'src'))
  const gitWorktreeBaseline = hasSwarmSource
    ? run('git', ['-C', swarmRoot, 'rev-parse', '--show-toplevel']).trim()
    : null
  const sourceWorktreeList = hasSwarmSource
    ? run('git', ['-C', swarmRoot, 'worktree', 'list', '--porcelain']).trim().split('\n')
    : null
  if (hasSwarmSource) assert.equal(gitWorktreeBaseline, swarmRoot, 'shared Swarm tree must be the explicitly selected checkout')
  runtimeSourceFreshness = hasSwarmSource
    ? {
        mode: 'source',
        notebookContextSourceMtimeMs: statSync(join(swarmRoot, 'src/adapters/dsh-host/notebook-context.ts')).mtimeMs,
        notebookContextLibMtimeMs: statSync(join(swarmRoot, 'lib/adapters/dsh-host/notebook-context.js')).mtimeMs,
        sourceNewerThanLib: statSync(join(swarmRoot, 'src/adapters/dsh-host/notebook-context.ts')).mtimeMs
          > statSync(join(swarmRoot, 'lib/adapters/dsh-host/notebook-context.js')).mtimeMs
      }
    : {
        mode: 'package',
        sourceFreshnessApplicable: false,
        runtimeBytesHashed: true
      }

  stage = 'profile-and-repo'
  mkdirSync(work, { recursive: true, mode: 0o700 })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  mkdirSync(join(workspace, 'notebooks'), { recursive: true, mode: 0o700 })
  writePreload()
  writeProfile()
  writePatch()
  const repoFacts = initRepo()
  writeDurable(checkpointFile, {
    expectedHead: repoFacts.expectedHead,
    worktrees: repoFacts.worktrees,
    workspace,
    dshHome: home,
    singleWorktree: true,
    createdAt: new Date().toISOString()
  })

  stage = 'private-sdk-copy'
  mkdirSync(sdkModules, { recursive: true, mode: 0o700 })
  run('cp', ['-a', '--', `${sdkSource}/.`, `${sdkModules}/`])
  const installer = (...args) => run(process.execPath, [
    join(repo, 'scripts/apply-dsh-execution-boundary.mjs'),
    '--dsh',
    sdkModules,
    ...args
  ])
  installer('--restore')
  installer()
  assert.equal(getHostVersion(sdkModules), hostVersion)
  const patchedSdkHashes = Object.fromEntries(plan.files.map(entry => [
    entry.path,
    sha256File(join(sdkModules, entry.path))
  ]))

  stage = 'phase1-save-host-start'
  const phase1 = await runHost('save', hostVersion)
  const phase1Exit = await waitHostExit(phase1)
  stage = 'phase1-save-result'
  const phase1Result = readDriverResult(phase1ResultFile)
  const phase1Quiescent = await waitForNoScopedProcesses('phase1')
  const phase1Blocked = phase1Result.status === 'blocked'
  assert.equal(
    phase1Exit.code,
    phase1Result.status === 'passed' ? 0 : phase1Blocked ? 2 : phase1Exit.code,
    `phase1 Host exit=${String(phase1Exit.code)} signal=${String(phase1Exit.signal)}`
  )
  assert.ok(['passed', 'blocked'].includes(phase1Result.status), `phase1 driver failed: ${phase1Result.error ?? 'unknown'}`)
  assert.equal(phase1Quiescent.quiescent, true, `phase1 residual processes: ${JSON.stringify(phase1Quiescent.processes)}`)
  assert.equal(existsSync(metadataFile), true, 'phase1 metadata missing')
  const metadata = readJson(metadataFile)
  assert.equal(existsSync(metadata.savedPath), true, 'state.ipynb missing after phase1')
  assert.equal(existsSync(metadata.privateSnapshotPath), true, 'private snapshot missing after phase1')
  const retainedArtifacts = copyEvidenceArtifacts(metadata)
  writeDurable(checkpointFile, {
    ...readJson(checkpointFile),
    phase1: {
      hostExit: phase1Exit,
      driverStatus: phase1Result.status,
      quiescence: phase1Quiescent,
      metadata,
      dshHomeTreeSha256: sha256Tree(home),
      repoTrackedStateSha256: createHash('sha256').update(run('git', ['-C', workspace, 'status', '--porcelain=v1', '-z'])).digest('hex')
    },
    retainedArtifacts,
    phase2UsesSameDshHome: true,
    phase2UsesSameRepo: true
  })

  stage = 'phase2-restore-host-start'
  const phase2 = await runHost('restore', hostVersion)
  const httpProbePromise = completePhase2Http(phase2)
  const [httpProbe, phase2Exit] = await Promise.all([httpProbePromise, waitHostExit(phase2)])
  stage = 'phase2-restore-result'
  const phase2Result = readDriverResult(phase2ResultFile)
  const phase2Quiescent = await waitForNoScopedProcesses('phase2')
  assert.equal(phase2Exit.code, 0, `phase2 Host exit=${String(phase2Exit.code)} signal=${String(phase2Exit.signal)}`)
  assert.equal(phase2Result.status, 'passed', `phase2 driver failed: ${phase2Result.error ?? 'unknown'}`)
  assert.equal(phase2Quiescent.quiescent, true, `phase2 residual processes: ${JSON.stringify(phase2Quiescent.processes)}`)
  validateHttpProbeResult(httpProbe)

  stage = 'final-verification'
  const sdkHashesAfter = sourceSdkHashes(plan)
  const componentsAfter = componentSnapshot()
  assert.deepEqual(sdkHashesAfter, sdkHashesBefore, 'source SDK tracked files changed')
  assert.deepEqual(componentsAfter, componentsBefore, 'Swarm/Notebook candidate changed during fixture run')
  assert.equal(phase1Result.rootId, metadata.rootId)
  assert.equal(phase2Result.rootId, metadata.rootId)
  assert.equal(phase1Result.task?.task_id, metadata.taskId)
  if (phase1Blocked) {
    assert.ok(Array.isArray(phase1Result.blockers) && phase1Result.blockers.length > 0, 'blocked phase1 缺少 blockers')
  } else {
    assert.equal(phase1Result.sameHostAttemptB?.passed, true, 'phase1 同 Host attemptB 未通过')
    assert.equal(phase1Result.sameHostAttemptB?.read?.originAttemptA, metadata.attemptA)
  }
  assert.equal(phase2Result.restore?.attemptB !== metadata.attemptA, true)
  if (phase2Result.restore?.sameColdChild === true) {
    assert.equal(phase2Result.restore?.originAttemptA, metadata.attemptA)
  } else {
    assert.equal(phase2Result.restore?.freshColdChildIsolation, true)
    assert.equal(phase2Result.restore?.originAttemptA, null)
  }
  assert.equal(phase2Result.restore?.zeroKernelSpawn, true)
  assert.equal(phase2Result.crossTask?.zeroKernelSpawn, true)
  const processAfter = getScoped()
  assert.equal(processAfter.length, 0, `top-level scoped residual processes: ${JSON.stringify(processAfter)}`)

  const cleanupReceipt = cleanup()
  stage = 'complete'
  const finalStatus = phase1Blocked ? 'blocked' : 'passed'
  const summary = {
    status: finalStatus,
    runId,
    stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    cli: {
      dsh: sdkSource,
      swarm: swarmRoot,
      notebook: notebookRoot,
      python: privatePython,
      out: evidenceDir
    },
    versions,
    hostVersion,
    hostEvidenceKind: 'private copied SDK with execution-boundary bridge; detached loopback Host',
    profile: {
      name: profileName,
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-swarm', '@beihaizb/dsh-notebook'],
      driver,
      permission: 'workspace-write',
      approval: 'never',
      persistence: true,
      modelProvider: 'local deterministic mock only'
    },
    sourceSdk: {
      hashesBefore: sdkHashesBefore,
      hashesAfter: sdkHashesAfter,
      unchanged: true,
      privatePatchedHashes: patchedSdkHashes
    },
    components: {
      before: componentsBefore,
      after: componentsAfter,
      unchangedDuringRun: true,
      stability: stabilityEvidence,
      swarmKind: existsSync(join(swarmRoot, 'src')) ? 'source-tree-candidate' : 'exact-package-candidate',
      packageRuntimeClosure: componentsBefore.swarmRuntimeClosure ?? null,
      exactTarballProof: false
    },
    sourceWorktree: gitWorktreeBaseline === null ? null : {
      selectedRoot: gitWorktreeBaseline,
      worktrees: sourceWorktreeList,
      noNewWorktreeCreated: true
    },
    runtimeSourceFreshness,
    processEvidence: {
      baseline: processBaseline,
      phase1Quiescence: phase1Quiescent,
      phase2Quiescence: phase2Quiescent,
      finalScoped: processAfter,
      cleanup: cleanupReceipt
    },
    phase1: {
      hostExit: phase1Exit,
      driver: phase1Result,
      metadata,
      artifactCopies: retainedArtifacts
    },
    phase2: {
      hostExit: phase2Exit,
      httpProbe,
      driver: phase2Result
    },
    evidence: {
      summary: summaryFile,
      checkpoint: checkpointFile,
      metadata: metadataFile,
      phase1Result: phase1ResultFile,
      phase2Result: phase2ResultFile,
      phase1HostLog: phase1Log,
      phase2HostLog: phase2Log,
      httpProbe: httpResultFile,
      artifacts
    },
    limitations: [
      ...(phase1Blocked ? (phase1Result.blockers ?? []).map(blocker => `${blocker.code}: ${blocker.message}`) : []),
      ...(existsSync(join(swarmRoot, 'src'))
        ? ['当前 Swarm 参数是 source-tree candidate；未把 repo 运行当作 exact tgz 解包证明']
        : ['当前 Swarm 参数按 exact package 模式验证入口/runtime import 闭包与 lib bytes；tarball SHA 仍由发布前下载校验']),
      'Notebook 版本动态读取；未针对固定版本字符串做兼容判断',
      '同 repo 不同 worktree/目录替换负例沿用既有单测，本次私有 Host 未重复构造',
      '未部署、未重启生产服务、未发布资产'
    ]
  }
  writeDurable(summaryFile, summary)
  if (finalStatus !== 'passed') process.exitCode = 2
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    runId,
    summary: summaryFile,
    phase1: phase1Result.status,
    phase2: phase2Result.status,
    httpProbe: 'passed',
    sourceSdkUnchanged: true,
    candidateUnchangedDuringRun: true,
    workCleaned: cleanupReceipt.cleaned
  }, null, 2)}\n`)
}

try {
  await main()
} catch (error) {
  const termination = activeHost === undefined
    ? null
    : await terminateOwnedHost(activeHost, 'failure-cleanup').catch(cleanupError => ({
        attempted: true,
        cleanupError: redactSensitiveText(cleanupError?.stack ?? cleanupError)
      }))
  const residual = getScoped()
  const sdkHashesAtFailure = sourceSdkPlan === undefined ? null : sourceSdkHashes(sourceSdkPlan)
  const cleanupReceipt = residual.length === 0 ? cleanup() : {
    cleaned: false,
    retainedWork: work,
    reason: 'failure residual requires inspection'
  }
  workRetained = cleanupReceipt.cleaned !== true
  const failure = {
    status: 'failed',
    runId,
    stage,
    startedAt,
    finishedAt: new Date().toISOString(),
    error: describeError(error).message,
    errorDetail: describeError(error),
    termination,
    residual,
    sourceSdk: {
      hashesBefore: sdkHashesBefore ?? null,
      hashesAtFailure: sdkHashesAtFailure,
      unchangedDuringRun: sdkHashesBefore !== undefined
        && sdkHashesAtFailure !== null
        && JSON.stringify(sdkHashesAtFailure) === JSON.stringify(sdkHashesBefore)
    },
    runtimeSourceFreshness: runtimeSourceFreshness ?? null,
    cleanup: cleanupReceipt,
    workRetained,
    phaseResults: {
      phase1: readEvidenceJson(phase1ResultFile),
      phase2: readEvidenceJson(phase2ResultFile),
      metadata: readEvidenceJson(metadataFile),
      httpProbe: readEvidenceJson(httpResultFile)
    },
    evidence: {
      summary: summaryFile,
      phase1Result: phase1ResultFile,
      phase2Result: phase2ResultFile,
      phase1HostLog: phase1Log,
      phase2HostLog: phase2Log,
      httpProbe: httpResultFile
    }
  }
  writeDurable(summaryFile, failure)
  process.stderr.write(`${redactSensitiveText(error?.stack ?? error)}\n`)
  process.exitCode = 1
} finally {
  for (const file of [phase1Log, phase2Log]) {
    if (!existsSync(file)) continue
    const redacted = redactSensitiveText(readFileSync(file, 'utf8'))
    writeTextAtomic(file, redacted)
  }
  if (existsSync(httpResultFile)) {
    const redacted = redactSensitiveText(readFileSync(httpResultFile, 'utf8'))
    writeTextAtomic(httpResultFile, redacted)
  }
}
