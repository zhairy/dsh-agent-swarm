import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import {
  EXECUTION_TOOLS,
  EXECUTION_BOUNDARY_CAPS_KEY,
  FILE_READ_TOOLS,
  FILE_WRITE_TOOLS,
  DEFAULT_NOTEBOOK_RESOURCE_LIMITS,
  MAX_NOTEBOOK_EXECUTION_SECONDS,
  assertNotebookPath,
  assertNotebookToolScope,
  buildNotebookSandboxPlan,
  getNotebookBoundaryScope,
  getNotebookComputeScopeKey,
  getNotebookExecutionTimeout,
  getNotebookToolClass,
  requiresNotebookSidecar,
  resolveNotebookResourceLimits,
  spawnNotebookRuntime,
  stopNotebookRuntime,
  type NotebookBoundaryCarrier,
  type NotebookBoundaryScope,
  type NotebookSubprocessHandle,
  type NotebookSubprocessSpec,
} from '../../src/adapters/dsh-host/notebook-runtime.ts'

const capsStore = globalThis as unknown as Record<symbol, unknown>
capsStore[EXECUTION_BOUNDARY_CAPS_KEY] = new Set(['subprocess-local/rc3'])

interface FakeEpoch {
  active: number
  unknown: boolean
  sealed: boolean
}

const createCarrier = (scope: NotebookBoundaryScope | undefined) => {
  const epochs = new Map<string, FakeEpoch>()
  const carrier: NotebookBoundaryCarrier = {
    storage: {
      getStore: () => scope,
      run: <T>(nextScope: NotebookBoundaryScope, next: () => T): T => {
        const previous = scope
        scope = nextScope
        try {
          return next()
        } finally {
          scope = previous
        }
      },
    },
    epochs,
    prepareSpawn: spec => ({
      spec,
      assertContainment: mode => {
        if (mode !== 'linux-scope') throw new Error('not native')
      },
      started: () => {},
    }),
    assertFilePath: path => {
      if (scope === undefined) return
      const allowed = scope.mode === 'write' && scope.writeScopes.some(root => path === root || path.startsWith(`${root}/`))
      if (!allowed) throw new Error('write outside task scope')
    },
  }
  return carrier
}

const createScope = (root: string, mode: NotebookBoundaryScope['mode'] = 'read-only'): NotebookBoundaryScope => ({
  taskId: 'T-notebook',
  agentId: 'agent-a',
  attemptId: 'attempt-a',
  mode,
  operation: mode === 'write' ? 'file' : 'shell',
  cwd: root,
  repositoryRoot: root,
  writeScopes: mode === 'write' ? [join(root, 'allowed')] : [],
  assertCurrent: () => {},
  epoch: { active: 0, unknown: false, sealed: false },
  anchor: { path: root, identity: 'anchor' },
  roots: [],
  launcher: '/launcher.js',
  bwrap: '/usr/bin/bwrap',
  onSettled: () => {},
})

const withWorkspace = (next: (root: string, carrier: NotebookBoundaryCarrier, scope: NotebookBoundaryScope) => void | Promise<void>) => async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-'))
  try {
    mkdirSync(join(root, 'allowed'), { recursive: true })
    const scope = createScope(root)
    await next(root, createCarrier(scope), scope)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('notebook tools have an explicit execution class', () => {
  for (const name of EXECUTION_TOOLS) assert.equal(getNotebookToolClass(name), 'execution')
  for (const name of FILE_READ_TOOLS) assert.equal(getNotebookToolClass(name), 'file-read')
  for (const name of FILE_WRITE_TOOLS) assert.equal(getNotebookToolClass(name), 'file-write')
  assert.equal(getNotebookToolClass('nb_get'), 'control')
  assert.equal(getNotebookToolClass('bash'), undefined)
  assert.equal(requiresNotebookSidecar('nb_open'), true)
  assert.equal(requiresNotebookSidecar('nb_save'), true)
  assert.equal(requiresNotebookSidecar('nb_list'), false)
})

it('notebook access fails closed without an active DSH boundary', () => {
  const carrier = createCarrier(undefined)
  assert.throws(() => assertNotebookToolScope('nb_run_cell', carrier), /执行边界/)
  assert.throws(() => assertNotebookToolScope('nb_new', carrier), /执行边界/)
})

it('file scopes are valid for sidecar file actions while file namespace still cannot run compute itself', withWorkspace((root, carrier, scope) => {
  scope.operation = 'file'
  assert.equal(getNotebookBoundaryScope(carrier), scope)
  assert.throws(() => assertNotebookToolScope('nb_run_cell', carrier), /subprocess-boundary/)
  assert.doesNotThrow(() => assertNotebookToolScope('nb_save', carrier))
}))

it('compute reuse key includes the exact attempt and canonical workspace', withWorkspace((root, _carrier, scope) => {
  const first = getNotebookComputeScopeKey(scope)
  scope.attemptId = 'attempt-b'
  const second = getNotebookComputeScopeKey(scope)
  assert.notEqual(first, second)
  assert.match(first, /attempt-a/)
  assert.ok(first.includes(root))
}))

it('snapshot task identity must be a non-empty string when present', withWorkspace((_root, carrier, scope) => {
  scope.taskId = ' '
  assert.throws(() => getNotebookBoundaryScope(carrier), /scope 不完整/)
}))

it('path checks keep reads and writes inside the active workspace', withWorkspace((root, carrier) => {
  const inside = join(root, 'allowed', 'notebook.ipynb')
  const outside = join(tmpdir(), 'outside-notebook.ipynb')
  assert.doesNotThrow(() => assertNotebookPath(inside, 'read', carrier))
  assert.throws(() => assertNotebookPath(outside, 'read', carrier), /执行工作区/)
  assert.throws(() => assertNotebookPath(inside, 'write', carrier), /写入/)
}))

it('read-only kernel plan uses a minimal filesystem allowlist instead of host root', withWorkspace((root, carrier) => {
  const plugin = join(root, 'plugin')
  const python = join(plugin, 'runtime', 'venv', 'bin', 'python')
  const driver = join(plugin, 'python', 'kernel_driver.py')
  mkdirSync(join(plugin, 'runtime', 'venv', 'bin'), { recursive: true })
  mkdirSync(join(plugin, 'python'), { recursive: true })
  writeFileSync(join(plugin, 'pyvenv.cfg'), 'home = /usr/bin\n')
  writeFileSync(python, '')
  writeFileSync(driver, '')
  const scope = carrier.storage.getStore()!
  const plan = buildNotebookSandboxPlan({ scope, bwrap: '/usr/bin/bwrap', pythonExecutable: python, driverPath: driver, pluginRoot: plugin, runtimePrefix: plugin })
  assert.ok(plan.argv.includes('--unshare-all'))
  assert.ok(plan.argv.includes('--clearenv'))
  assert.ok(plan.argv.includes('--tmpfs'))
  assert.ok(plan.argv.includes('/tmp'))
  assert.ok(plan.argv.includes('--ro-bind'))
  assert.ok(plan.argv.includes('/usr/bin'))
  assert.ok(plan.argv.includes('/usr/lib'))
  assert.equal(plan.argv.some((value, index) => value === '--ro-bind' && plan.argv[index + 1] === '/etc' && plan.argv[index + 2] === '/etc'), false)
  for (const etcRoot of ['/etc/ld.so.cache', '/etc/passwd', '/etc/group', '/etc/localtime', '/etc/fonts']) {
    if (existsSync(etcRoot)) assert.ok(plan.argv.includes(etcRoot))
  }
  assert.equal(plan.argv.includes('/etc/ssh'), false)
  assert.equal(plan.argv.includes('/etc/ssl/private'), false)
  assert.ok(plan.argv.includes(root))
  assert.equal(plan.argv.some((value, index) => value === '--ro-bind' && plan.argv[index + 1] === '/' && plan.argv[index + 2] === '/'), false)
  assert.equal(plan.argv.includes('/var'), false)
  assert.equal(plan.argv.some((value, index) => value === '--ro-bind' && plan.argv[index + 1] === '/run'), false)
  assert.equal(plan.argv.includes('/home'), false)
  assert.equal(plan.network, 'deny')
  assert.equal(plan.env.TMPDIR, '/tmp')
  assert.equal(plan.env.HOME, '/tmp/home')
  assert.equal(plan.env.PYTHONNOUSERSITE, '1')
  assert.ok(!Object.keys(plan.env).some(name => /TOKEN|KEY|SECRET|PROXY/i.test(name)))
  assert.equal(plan.resourceLimits.addressSpaceBytes, DEFAULT_NOTEBOOK_RESOURCE_LIMITS.addressSpaceBytes)
  assert.equal(plan.env.DSH_NOTEBOOK_RLIMIT_AS_BYTES, String(DEFAULT_NOTEBOOK_RESOURCE_LIMITS.addressSpaceBytes))
  assert.equal(plan.env.DSH_NOTEBOOK_RLIMIT_CORE_BYTES, '0')
}))

it('resource limits are hard-capped and every private tmpfs has an explicit size', withWorkspace((root, carrier) => {
  const plugin = join(root, 'plugin')
  const python = join(plugin, 'runtime', 'venv', 'bin', 'python')
  const driver = join(plugin, 'python', 'kernel_driver.py')
  mkdirSync(join(plugin, 'runtime', 'venv', 'bin'), { recursive: true })
  mkdirSync(join(plugin, 'python'), { recursive: true })
  writeFileSync(join(plugin, 'pyvenv.cfg'), 'home = /usr/bin\n')
  writeFileSync(python, '')
  writeFileSync(driver, '')
  const scope = carrier.storage.getStore()!
  const plan = buildNotebookSandboxPlan({
    scope,
    bwrap: '/usr/bin/bwrap',
    pythonExecutable: python,
    driverPath: driver,
    pluginRoot: plugin,
    runtimePrefix: plugin,
    resourceLimits: {
      addressSpaceBytes: 256 * 1024 * 1024,
      nofile: 128,
      nproc: 32,
      fileSizeBytes: 16 * 1024 * 1024,
      rootTmpfsBytes: 2 * 1024 * 1024,
      privateTmpfsBytes: 1024 * 1024,
      runtimeTmpfsBytes: 512 * 1024,
    },
  })
  assert.deepEqual(plan.resourceLimits, {
    addressSpaceBytes: 256 * 1024 * 1024,
    nofile: 128,
    nproc: 32,
    fileSizeBytes: 16 * 1024 * 1024,
    rootTmpfsBytes: 2 * 1024 * 1024,
    privateTmpfsBytes: 1024 * 1024,
    runtimeTmpfsBytes: 512 * 1024,
  })
  const sizes: Record<string, number> = {}
  for (let index = 0; index < plan.argv.length; index++) {
    if (plan.argv[index] === '--size') sizes[plan.argv[index + 3]!] = Number(plan.argv[index + 1])
  }
  assert.equal(sizes['/'], 2 * 1024 * 1024, JSON.stringify(plan.argv))
  assert.equal(sizes['/tmp'], 1024 * 1024)
  assert.equal(sizes['/run'], 512 * 1024)
  const tmpfsTargets = plan.argv.flatMap((value, index) => value === '--tmpfs' ? [plan.argv[index + 1]!] : [])
  assert.ok(tmpfsTargets.every(target => sizes[target] !== undefined))
  assert.equal(plan.env.DSH_NOTEBOOK_RLIMIT_NOFILE, '128')
  assert.equal(plan.env.DSH_NOTEBOOK_RLIMIT_NPROC, '32')
  assert.equal(plan.env.DSH_NOTEBOOK_RLIMIT_FSIZE_BYTES, String(16 * 1024 * 1024))
  assert.deepEqual(resolveNotebookResourceLimits({
    addressSpaceBytes: DEFAULT_NOTEBOOK_RESOURCE_LIMITS.addressSpaceBytes * 4,
    privateTmpfsBytes: DEFAULT_NOTEBOOK_RESOURCE_LIMITS.privateTmpfsBytes * 4,
  }), DEFAULT_NOTEBOOK_RESOURCE_LIMITS)
}))

it('cell timeout is clamped to the trusted 180 second maximum', () => {
  assert.equal(getNotebookExecutionTimeout(undefined), MAX_NOTEBOOK_EXECUTION_SECONDS)
  assert.equal(getNotebookExecutionTimeout(1), 1)
  assert.equal(getNotebookExecutionTimeout(240), MAX_NOTEBOOK_EXECUTION_SECONDS)
  assert.equal(getNotebookExecutionTimeout(Number.POSITIVE_INFINITY), MAX_NOTEBOOK_EXECUTION_SECONDS)
})

it('write scopes cannot overlap plugin or runtime roots', withWorkspace((root, _carrier, scope) => {
  const plugin = join(root, 'plugin')
  const python = join(plugin, 'runtime', 'venv', 'bin', 'python')
  const driver = join(plugin, 'python', 'kernel_driver.py')
  mkdirSync(join(plugin, 'runtime', 'venv', 'bin'), { recursive: true })
  mkdirSync(join(plugin, 'python'), { recursive: true })
  writeFileSync(join(plugin, 'pyvenv.cfg'), 'home = /usr/bin\n')
  writeFileSync(python, '')
  writeFileSync(driver, '')
  scope.mode = 'write'
  scope.writeScopes = [root]
  assert.throws(() => buildNotebookSandboxPlan({
    scope,
    bwrap: '/usr/bin/bwrap',
    pythonExecutable: python,
    driverPath: driver,
    pluginRoot: plugin,
    runtimePrefix: plugin,
  }), /plugin\/runtime prefix/)
}))

it('independent runtime prefix is mounted read-only by exact path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-prefix-'))
  const external = mkdtempSync(join(tmpdir(), 'notebook-runtime-external-'))
  const kernelExternal = mkdtempSync(join(tmpdir(), 'notebook-runtime-kernel-'))
  try {
    const plugin = join(root, 'plugin')
    const runtimePrefix = join(external, 'home', '.venv')
    const kernelRuntimePrefix = join(kernelExternal, 'conda', 'science')
    const python = join(runtimePrefix, 'bin', 'python')
    const driver = join(plugin, 'python', 'kernel_driver.py')
    mkdirSync(join(runtimePrefix, 'bin'), { recursive: true })
    mkdirSync(join(kernelRuntimePrefix, 'conda-meta'), { recursive: true })
    mkdirSync(join(plugin, 'python'), { recursive: true })
    writeFileSync(join(runtimePrefix, 'pyvenv.cfg'), 'home = /usr/bin\n')
    writeFileSync(python, '')
    writeFileSync(driver, '')
    const scope = createScope(root)
    const carrier = createCarrier(scope)
    const plan = buildNotebookSandboxPlan({ scope, bwrap: '/usr/bin/bwrap', pythonExecutable: python, driverPath: driver, pluginRoot: plugin, runtimePrefix, kernelRuntimePrefix })
    assert.ok(plan.readRoots.includes(runtimePrefix))
    assert.ok(plan.readRoots.includes(kernelRuntimePrefix))
    assert.ok(plan.argv.some((value, index) => value === '--ro-bind' && plan.argv[index + 1] === runtimePrefix && plan.argv[index + 2] === runtimePrefix))
    assert.equal(plan.readRoots.includes(external), false)
    assert.equal(plan.readRoots.includes(kernelExternal), false)
    assert.equal(carrier.storage.getStore(), scope)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
    rmSync(kernelExternal, { recursive: true, force: true })
  }
})

it('kernel spawn fails closed without the SDK containment preparation hook', withWorkspace((root, carrier) => {
  const previousCaps = capsStore[EXECUTION_BOUNDARY_CAPS_KEY]
  delete capsStore[EXECUTION_BOUNDARY_CAPS_KEY]
  assert.throws(() => spawnNotebookRuntime({
    carrier,
    subprocess: { spawn: () => assert.fail('spawn must not run') },
    plan: { argv: ['/usr/bin/bwrap'], cwd: root, env: {}, network: 'deny' },
    lifecycle: 'persistent',
  }), /capability/)
  capsStore[EXECUTION_BOUNDARY_CAPS_KEY] = previousCaps
  carrier.prepareSpawn = undefined
  const handle: NotebookSubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: () => {},
    waitForExit: async () => true,
  }
  assert.throws(() => spawnNotebookRuntime({
    carrier,
    subprocess: { spawn: () => handle },
    plan: { argv: ['/usr/bin/bwrap'], cwd: root, env: {}, network: 'deny' },
    lifecycle: 'persistent',
  }), /containment/)
}))

it('persistent read kernel gets a synthetic boundary epoch and leaves the writer epoch untouched', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-spawn-'))
  try {
    const scope = createScope(root)
    scope.operation = 'file'
    const carrier = createCarrier(scope)
    let spawned = false
    const handle: NotebookSubprocessHandle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: async () => true,
    }
    const runtime = { spawn: () => { spawned = true; return handle } }
    const record = spawnNotebookRuntime({
      carrier,
      subprocess: runtime,
      plan: { argv: ['/usr/bin/bwrap'], cwd: root, env: {}, network: 'deny' },
      lifecycle: 'persistent',
    })
    assert.equal(spawned, true)
    assert.equal(scope.epoch.active, 0)
    assert.equal(record.lifecycle, 'persistent')
    assert.notEqual(record.epochKey, undefined)
    assert.equal(record.epoch?.active, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('write kernel requires native managed range and only certifies a real exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-stop-'))
  try {
    const scope = createScope(root, 'write')
    const carrier = createCarrier(scope)
    let containment = 'fallback'
    const handle: NotebookSubprocessHandle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: async () => false,
    }
    carrier.prepareSpawn = (spec: NotebookSubprocessSpec) => ({
      spec,
      assertContainment: mode => {
        if (mode !== 'linux-scope') throw new Error('not native')
      },
      started: value => {
        const current = carrier.storage.getStore()
        if (current !== undefined) current.epoch.active += 1
        void value
      },
    })
    const runtime = {
      spawn: (spec: NotebookSubprocessSpec) => {
        const ticket = carrier.prepareSpawn!(spec)
        ticket.assertContainment(containment)
        ticket.started(handle)
        return handle
      },
    }
    assert.throws(() => spawnNotebookRuntime({
      carrier,
      subprocess: runtime,
      plan: { argv: ['/usr/bin/bwrap'], cwd: root, env: {}, network: 'deny' },
      lifecycle: 'ephemeral',
    }), /not native/)
    containment = 'linux-scope'
    const record = spawnNotebookRuntime({
      carrier,
      subprocess: runtime,
      plan: { argv: ['/usr/bin/bwrap'], cwd: root, env: {}, network: 'deny' },
      lifecycle: 'ephemeral',
    })
    const certificate = await stopNotebookRuntime(record, { carrier, timeoutMs: 100 })
    assert.equal(certificate.stopped, false)
    assert.equal(certificate.quiescent, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('one known active writer job survives fileSidecar exit without sealing the epoch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-runtime-shared-epoch-'))
  try {
    const scope = createScope(root, 'write')
    scope.epoch.active = 1
    const carrier = createCarrier(scope)
    const handle: NotebookSubprocessHandle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: async () => true,
    }
    carrier.prepareSpawn = (spec: NotebookSubprocessSpec) => ({
      spec,
      assertContainment: mode => {
        if (mode !== 'linux-scope') throw new Error('not native')
      },
      started: () => {
        scope.epoch.active += 1
      },
    })
    const runtime = {
      spawn: (spec: NotebookSubprocessSpec) => {
        const ticket = carrier.prepareSpawn!(spec)
        ticket.assertContainment('linux-scope')
        ticket.started(handle)
        void handle.done.then(() => { scope.epoch.active -= 1 })
        return handle
      },
    }
    const record = spawnNotebookRuntime({
      carrier,
      subprocess: runtime,
      plan: { argv: ['/usr/bin/bwrap'], cwd: root, env: {}, network: 'deny' },
      lifecycle: 'ephemeral',
    })
    assert.equal(scope.epoch.active, 2)
    const certificate = await stopNotebookRuntime(record, { carrier, timeoutMs: 1000 })
    assert.deepEqual({
      stopped: certificate.stopped,
      quiescent: certificate.quiescent,
      ownershipQuiescent: certificate.ownershipQuiescent,
      epochQuiescent: certificate.epochQuiescent,
      sharedEpochActive: certificate.sharedEpochActive,
    }, {
      stopped: true,
      quiescent: true,
      ownershipQuiescent: true,
      epochQuiescent: null,
      sharedEpochActive: 1,
    })
    assert.equal(scope.epoch.active, 1)
    assert.equal(scope.epoch.unknown, false)
    assert.equal(scope.epoch.sealed, false)
    assert.equal(carrier.epochs.size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
