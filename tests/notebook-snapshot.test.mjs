import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import createDOMPurify from '../third_party/dsh-notebook/lib/vendor/dompurify.es.mjs'
import { JSDOM } from 'jsdom'
import {
  createNotebookSnapshotStore,
  installNotebookSnapshotRuntime
} from '../src/notebook-snapshot.ts'

const pluginRoot = resolve(process.env.NOTEBOOK_PLUGIN_ROOT || 'third_party/dsh-notebook')
const testPython = process.env.NOTEBOOK_TEST_PYTHON || '/usr/bin/python3'
assert.ok(existsSync(testPython), 'NOTEBOOK_TEST_PYTHON must exist')

const loadPluginClient = () => {
  const client = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  let definition
  const context = {
    console,
    localStorage: { getItem: () => null },
    window: {
      __ModuleLoader__: {
        load: value => { definition = value }
      }
    }
  }
  vm.runInNewContext(client, context, { timeout: 2000 })
  assert.ok(definition)
  const fakeReact = { createElement: () => null }
  return {
    client,
    context,
    pluginClient: definition.factory(name => {
      if (name === 'react') return fakeReact
      throw new Error(`unexpected client dependency: ${name}`)
    })
  }
}

const writeNotebook = (path, cells) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells }, null, 2), { mode: 0o600 })
}

const getDirectoryIdentity = path => {
  const stat = lstatSync(path, { bigint: true })
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
}

const createHostReadContext = ({
  sessionId,
  managed = false,
  taskId = null,
  attemptId = null,
  rootSessionId = null,
  agentId = sessionId,
  cwd,
  directoryIdentity = getDirectoryIdentity(cwd),
  source = managed ? 'swarm-marker' : 'host-session',
  routerDraft,
}) => ({
  schemaVersion: 1,
  sessionId,
  managed,
  taskId,
  agentId,
  attemptId,
  rootSessionId,
  cwd,
  directoryIdentity,
  source,
  ...(routerDraft === undefined ? {} : { routerDraft }),
})

const createFakeSidecar = () => {
  const child = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  child.stdin = stdin
  child.stdout = stdout
  child.stderr = stderr
  let exited = false
  const terminate = () => {
    if (exited) return
    exited = true
    setImmediate(() => child.emit('exit', 0, null))
  }
  child.kill = () => {
    terminate()
    return true
  }
  child.done = new Promise(resolveDone => {
    child.once('exit', code => resolveDone({ exitCode: code ?? 0, signal: null }))
  })
  child.terminate = child.kill
  child.waitForExit = async () => {
    child.kill()
    await child.done
    return true
  }
  let buffered = ''
  stdin.on('data', chunk => {
    buffered += String(chunk)
    for (;;) {
      const newline = buffered.indexOf('\n')
      if (newline < 0) break
      const line = buffered.slice(0, newline)
      buffered = buffered.slice(newline + 1)
      if (line.trim() === '') continue
      const request = JSON.parse(line)
      let response
      try {
        if (request.cmd === 'load_ipynb') {
          const notebook = JSON.parse(readFileSync(request.path, 'utf8'))
          response = { id: request.id, ok: true, ...notebook }
        } else if (request.cmd === 'start') {
          response = {
            id: request.id,
            ok: true,
            language: request.kernel_language || 'python',
            interpreter: request.interpreter,
          }
        } else if (request.cmd === 'save_ipynb') {
          writeNotebook(request.path, request.cells.map(cell => {
            const copy = { ...cell }
            delete copy.status
            delete copy.queuedAt
            delete copy.startedAt
            return copy
          }))
          response = { id: request.id, ok: true }
        } else if (request.cmd === 'execute') {
          response = {
            id: request.id,
            ok: true,
            status: 'ok',
            outputs: [{ type: 'stream', name: 'stdout', text: '42\n' }],
            execution_count: 1,
          }
        } else if (request.cmd === 'stop') {
          response = { id: request.id, ok: true }
        } else {
          response = { id: request.id, ok: false, error: `unexpected command: ${request.cmd}` }
        }
      } catch (error) {
        response = { id: request.id, ok: false, error: String(error?.message ?? error) }
      }
      stdout.write(`${JSON.stringify(response)}\n`)
    }
  })
  return child
}

const createPlugin = async ({ workspace, agent, services = {}, moduleKey }) => {
  const tools = new Map()
  const effects = []
  const routes = new Map()
  const eventHandlers = new Map()
  let handler
  const moduleUrl = pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href
  const { apply } = await import(moduleKey === undefined ? moduleUrl : `${moduleUrl}?fixture=${encodeURIComponent(moduleKey)}`)
  apply({
    get: name => ({
      sandboxPolicy: { workspaceRoot: workspace },
      agents: { get: id => agent !== undefined && id === agent.id ? agent : undefined },
      ...services,
    })[name],
    effect: execute => {
      const dispose = execute()
      effects.push(dispose)
      return dispose
    },
    on: (event, callback) => {
      let handlers = eventHandlers.get(event)
      if (!handlers) {
        handlers = new Set()
        eventHandlers.set(event, handlers)
      }
      handlers.add(callback)
      return () => {
        handlers.delete(callback)
        if (handlers.size === 0) eventHandlers.delete(event)
      }
    },
    tools: {
      register: tool => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      }
    },
    webServer: {
      register: entry => {
        routes.set(`${entry.kind}:${entry.path}`, entry.handler)
        if (entry.kind === 'prefix' && entry.path === '/nb') handler = entry.handler
        return () => {
          routes.delete(`${entry.kind}:${entry.path}`)
          if (entry.kind === 'prefix' && entry.path === '/nb') handler = undefined
        }
      }
    }
  })
  const invoke = (name, args) => tools.get(name).execute(args, { agent })
  const http = async (sid, route, args = {}) => {
    const request = Readable.from([JSON.stringify({ ...args, _sid: sid })])
    request.method = 'POST'
    request.url = `/nb/${route}`
    let body
    const response = {
      statusCode: 200,
      setHeader: () => {},
      end: value => { body = JSON.parse(String(value)) }
    }
    await handler(request, response)
    return { status: response.statusCode, body }
  }
  const dispose = async () => {
    for (const effect of effects.reverse()) await effect?.()
  }
  const emit = async (event, payload) => {
    for (const callback of [...(eventHandlers.get(event) || [])]) await callback(payload)
  }
  const vendor = async () => {
    const route = routes.get('exact:/plugins/@beihaizb/dsh-notebook/vendor/dompurify.es.mjs')
    assert.equal(typeof route, 'function')
    const request = Readable.from([])
    request.method = 'GET'
    request.url = '/plugins/@beihaizb/dsh-notebook/vendor/dompurify.es.mjs'
    let body
    const headers = new Map()
    const response = {
      statusCode: 200,
      setHeader: (name, value) => { headers.set(name.toLowerCase(), value) },
      end: value => { body = value },
    }
    await route(request, response)
    return {
      status: response.statusCode,
      headers,
      body: Buffer.isBuffer(body) ? body.toString('utf8') : String(body ?? ''),
    }
  }
  return { invoke, http, vendor, emit, dispose }
}

test('显式 nb_save 持久化 cell/输出，重启后只读恢复且不启动内核', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-plugin-snapshot-'))
  const dshHome = join(root, 'dsh')
  const workspace = join(root, 'workspace')
  const notebooks = join(workspace, 'notebooks')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(notebooks, { recursive: true })
  const sourcePath = join(notebooks, 'source.ipynb')
  const savedPath = join(notebooks, 'saved.ipynb')
  writeNotebook(sourcePath, [
    {
      id: 'cell-code',
      cell_type: 'code',
      source: 'print(42)',
      execution_count: 1,
      metadata: {},
      outputs: [{ output_type: 'stream', name: 'stdout', text: '42\n' }]
    },
    {
      id: 'cell-markdown',
      cell_type: 'markdown',
      source: '# persisted result',
      metadata: {},
      outputs: []
    }
  ])

  const oldEnvironment = new Map()
  for (const [key, value] of Object.entries({
    DSH_HOME: dshHome,
    DSH_ENV_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX: dirname(dirname(testPython)),
    JUPYTER_PATH: undefined,
    APPDATA: undefined
  })) {
    oldEnvironment.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  let spawnCount = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCount += 1
    return createFakeSidecar()
  })
  syncBuiltinESMExports()

  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const runtimeKey = Symbol.for('dsh-agent-swarm.notebook-runtime.v1')
  const previousGlobals = new Map([boundaryKey, managedKey, runtimeKey].map(key => [key, globalThis[key]]))
  const agent = {
    id: 'session-snapshot',
    session: {
      id: 'session-snapshot',
      header: { cwd: workspace }
    }
  }
  const storage = new AsyncLocalStorage()
  const scope = {
    agentId: agent.id,
    attemptId: 'attempt-snapshot',
    mode: 'write',
    operation: 'file',
    cwd: workspace,
    repositoryRoot: workspace,
    writeScopes: [notebooks],
    epoch: { active: 0, unknown: false, sealed: false },
    assertCurrent: () => {}
  }
  globalThis[boundaryKey] = {
    storage,
    epochs: new Map(),
    assertFilePath: path => {
      if (!path.startsWith(`${notebooks}/`)) throw new Error('write outside snapshot fixture')
    }
  }
  globalThis[managedKey] = { version: 1, isManaged: () => false }

  const snapshotStore = createNotebookSnapshotStore({ dshHome })
  const readContexts = new Map()
  const uninstallSnapshot = installNotebookSnapshotRuntime({
    ...snapshotStore,
    resolveReadContext: async sessionId => readContexts.get(sessionId),
  })
  readContexts.set(agent.id, createHostReadContext({
    sessionId: agent.id,
    cwd: workspace,
  }))
  let firstPlugin
  let secondPlugin
  let thirdPlugin
  try {
    firstPlugin = await createPlugin({ workspace, agent })
    await storage.run(scope, () => firstPlugin.invoke('nb_open', { path: sourcePath }))
    const saved = await storage.run(scope, () => firstPlugin.invoke('nb_save', { path: savedPath }))
    assert.equal(saved.ok, true)
    assert.equal(saved.path, savedPath)
    assert.equal(saved.snapshot?.saved, true)

    const persisted = await snapshotStore.load(agent.id)
    assert.ok(persisted, 'nb_save 必须登记跨重启只读快照')
    assert.equal(persisted.notebook.cells.length, 2)
    assert.equal(persisted.notebook.cells[0].outputs[0].text, '42\n')
    assert.equal(persisted.task.managed, false)
    assert.equal(persisted.view.mode, 'read-only')

    await firstPlugin.dispose()
    firstPlugin = undefined
    const spawnsAfterRestart = spawnCount
    secondPlugin = await createPlugin({ workspace, agent })

    const restored = await secondPlugin.http(agent.id, 'get')
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(restored.body.readOnly, true)
    assert.equal(restored.body.kernel.alive, false)
    assert.equal(restored.body.kernel.available, false)
    assert.equal(restored.body.cells.length, 2)
    assert.equal(restored.body.cells[0].source, 'print(42)')
    assert.equal(restored.body.cells[0].outputs[0].text, '42\n')
    const toolSnapshot = await secondPlugin.invoke('nb_get', {})
    assert.equal(toolSnapshot.readOnly, true)
    assert.equal(toolSnapshot.cells.length, 2)
    assert.equal(toolSnapshot.kernel.alive, false)

    for (const [route, args] of [
      ['runCell', { cellId: 'cell-code' }],
      ['editCell', { cellId: 'cell-code', source: 'print(99)' }],
      ['save', { path: savedPath }]
    ]) {
      const response = await secondPlugin.http(agent.id, route, args)
      assert.equal(response.status, 403, route)
    }
    await assert.rejects(() => secondPlugin.invoke('nb_edit_cell', {
      cellId: 'cell-code',
      source: 'print(99)'
    }), /只读/)
    const unknown = await secondPlugin.http('unknown-session', 'get')
    assert.equal(unknown.status, 403)
    assert.equal(spawnCount, spawnsAfterRestart, '只读恢复不得启动任何 Notebook 进程')
    await secondPlugin.dispose()
    secondPlugin = undefined
    const foreignWorkspace = join(root, 'foreign-project')
    mkdirSync(foreignWorkspace, { recursive: true })
    agent.session.header.cwd = foreignWorkspace
    readContexts.set(agent.id, createHostReadContext({
      sessionId: agent.id,
      cwd: foreignWorkspace,
    }))
    thirdPlugin = await createPlugin({ workspace: foreignWorkspace, agent })
    const wrongProject = await thirdPlugin.http(agent.id, 'get')
    assert.equal(wrongProject.status, 403)
    assert.equal(spawnCount, spawnsAfterRestart, '跨项目恢复不得读取其他项目的持久快照')
    const fresh = await thirdPlugin.invoke('nb_new', { title: 'fresh' })
    assert.equal(fresh.readOnly, false)
    assert.equal(fresh.cwd, foreignWorkspace)
  } finally {
    await firstPlugin?.dispose()
    await secondPlugin?.dispose()
    await thirdPlugin?.dispose()
    uninstallSnapshot()
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

const createManagedRetainedFixture = async (t, label) => {
  const root = mkdtempSync(join(tmpdir(), `notebook-retained-${label}-`))
  const dshHome = join(root, 'dsh')
  const repositoryRoot = join(root, 'shared-repository')
  const workspace = join(repositoryRoot, 'worktree-a')
  const notebooks = join(workspace, 'notebooks')
  const sourcePath = join(notebooks, 'source.ipynb')
  const savedPath = join(notebooks, 'saved.ipynb')
  const runtimePrefix = join(root, 'runtime')
  const runtimePython = join(runtimePrefix, 'bin', 'python3')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(notebooks, { recursive: true })
  mkdirSync(dirname(runtimePython), { recursive: true })
  copyFileSync(testPython, runtimePython)
  chmodSync(runtimePython, 0o755)
  writeFileSync(join(runtimePrefix, 'pyvenv.cfg'), `home = ${dirname(testPython)}\n`, { mode: 0o600 })
  writeNotebook(sourcePath, [
    {
      id: 'cell-code',
      cell_type: 'code',
      source: 'x = 40',
      execution_count: 1,
      metadata: {},
      outputs: [],
    },
    {
      id: 'cell-output',
      cell_type: 'code',
      source: 'print(x + 2)',
      execution_count: 2,
      metadata: {},
      outputs: [{ output_type: 'stream', name: 'stdout', text: '42\n' }],
    },
  ])

  const oldEnvironment = new Map()
  for (const [key, value] of Object.entries({
    DSH_HOME: dshHome,
    DSH_ENV_PYTHON: runtimePython,
    DSH_NOTEBOOK_CONTROLLER_PYTHON: runtimePython,
    DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX: runtimePrefix,
    JUPYTER_PATH: undefined,
    APPDATA: undefined
  })) {
    oldEnvironment.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  let spawnCount = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCount += 1
    return createFakeSidecar()
  })
  syncBuiltinESMExports()

  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const boundaryCapsKey = Symbol.for('dsh-agent-swarm.execution-boundary-capabilities.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const runtimeKey = Symbol.for('dsh-agent-swarm.notebook-runtime.v1')
  const previousGlobals = new Map([boundaryKey, boundaryCapsKey, managedKey, runtimeKey].map(key => [key, globalThis[key]]))
  const agent = {
    id: `retained-${label}`,
    session: {
      id: `retained-${label}`,
      header: { cwd: workspace, parentSession: 'retained-root' },
    },
  }
  const storage = new AsyncLocalStorage()
  const makeScope = (attemptId, taskId = 'T-1') => ({
    taskId,
    agentId: agent.id,
    attemptId,
    mode: 'write',
    operation: 'file',
    cwd: workspace,
    repositoryRoot,
    writeScopes: [notebooks],
    expectedDirectoryIdentity: getDirectoryIdentity(workspace),
    epoch: { active: 0, unknown: false, sealed: false },
    assertCurrent: () => {},
  })
  const scopeA = makeScope('attempt-A')
  const scopeB = makeScope('attempt-B')
  globalThis[boundaryKey] = {
    storage,
    epochs: new Map(),
    prepareSpawn: spec => ({
      spec,
      assertContainment: mode => {
        if (mode !== 'linux-scope') throw new Error('managed Notebook fixture requires linux-scope')
      },
      started: () => {},
    }),
    assertFilePath: path => {
      if (!path.startsWith(`${workspace}/`)) throw new Error('managed path outside worktree')
    },
  }
  globalThis[boundaryCapsKey] = new Set(['subprocess-local/rc3'])
  globalThis[managedKey] = { version: 1, isManaged: candidate => candidate === agent }

  const snapshotStore = createNotebookSnapshotStore({ dshHome })
  const readContexts = new Map()
  const setContext = overrides => {
    readContexts.set(agent.id, createHostReadContext({
      sessionId: agent.id,
      managed: true,
      taskId: 'T-1',
      attemptId: 'attempt-A',
      rootSessionId: 'retained-root',
      cwd: workspace,
      ...overrides,
    }))
  }
  setContext()
  const uninstallSnapshot = installNotebookSnapshotRuntime({
    ...snapshotStore,
    resolveReadContext: async sessionId => readContexts.get(sessionId),
  })

  let plugin
  const cleanup = async () => {
    await plugin?.dispose()
    uninstallSnapshot()
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }

  return {
    agent,
    notebooks,
    savedPath,
    sourcePath,
    scopeA,
    scopeB,
    setContext,
    cleanup,
    startPlugin: async () => {
      const subprocess = {
        resolveExecutable: async command => command === 'bwrap' ? '/usr/bin/bwrap' : command,
        spawn: spec => {
          const ticket = globalThis[boundaryKey].prepareSpawn(spec)
          ticket.assertContainment('linux-scope')
          const child = createFakeSidecar()
          ticket.started(child)
          return child
        },
      }
      plugin = await createPlugin({
        workspace,
        agent,
        services: { subprocess },
        moduleKey: `retained-${label}-${Date.now()}`,
      })
      return plugin
    },
    getSpawnCount: () => spawnCount,
    runWithScope: (scope, callback) => storage.run(scope, callback),
  }
}

test('managed clean save 在 confirmed-stopped retained 中保留 producer A，并允许同 task 新 attempt 只读恢复', async t => {
  const fixture = await createManagedRetainedFixture(t, 'clean')
  try {
    const plugin = await fixture.startPlugin()
    await fixture.runWithScope(fixture.scopeA, () => plugin.invoke('nb_open', { path: fixture.sourcePath }))
    const saved = await fixture.runWithScope(fixture.scopeA, () => plugin.invoke('nb_save', {
      path: fixture.savedPath,
    }))
    assert.equal(saved.snapshot.saved, true)
    assert.match(saved.snapshot.savedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(saved.snapshot.recordedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal(saved.current.dirty, false)
    assert.equal(saved.current.snapshotProvenance.originAttemptId, 'attempt-A')
    assert.equal(saved.current.snapshotOriginState, 'saved-clean')

    const spawnsAfterSave = fixture.getSpawnCount()
    const stopped = await plugin.http(fixture.agent.id, 'shutdownKernel')
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    await plugin.emit('session/disposed', { id: fixture.agent.id })

    fixture.setContext({ attemptId: 'attempt-B' })
    const restored = await fixture.runWithScope(fixture.scopeB, () => plugin.invoke('nb_get', {}))
    assert.equal(restored.readOnly, true)
    assert.equal(restored.readOnlySnapshot, true)
    assert.equal(restored.dirty, false)
    assert.equal(restored.kernel.alive, false)
    assert.equal(restored.cells.length, 2)
    assert.equal(restored.cells[1].source, 'print(x + 2)')
    assert.equal(restored.cells[1].outputs[0].text, '42\n')
    assert.equal(restored.snapshotOriginState, 'saved-clean')
    assert.deepEqual({
      ...restored.snapshotProvenance,
      recordedAt: undefined,
    }, {
      mode: 'read-only-snapshot',
      originTaskId: 'T-1',
      originAgentId: fixture.agent.id,
      originAttemptId: 'attempt-A',
      savedAt: saved.snapshot.savedAt,
      recordedAt: undefined,
    })
    assert.equal(restored.snapshotProvenance.recordedAt, saved.snapshot.recordedAt)
    assert.equal(restored.persistedSnapshotAt, saved.snapshot.recordedAt)
    assert.equal(fixture.getSpawnCount(), spawnsAfterSave, 'retained 只读恢复不得启动 kernel/sidecar')
  } finally {
    await fixture.cleanup()
  }
})

test('managed save 后的 edit/dirty retained 不冒充旧 producer A，并显式标记 unsaved-changes', async t => {
  const fixture = await createManagedRetainedFixture(t, 'dirty')
  try {
    const plugin = await fixture.startPlugin()
    await fixture.runWithScope(fixture.scopeA, () => plugin.invoke('nb_open', { path: fixture.sourcePath }))
    const saved = await fixture.runWithScope(fixture.scopeA, () => plugin.invoke('nb_save', {
      path: fixture.savedPath,
    }))
    assert.equal(saved.snapshot.saved, true)
    assert.equal(saved.current.snapshotProvenance.originAttemptId, 'attempt-A')

    const edited = await fixture.runWithScope(fixture.scopeA, () => plugin.invoke('nb_edit_cell', {
      cellId: 'cell-code',
      source: 'x = 99',
    }))
    assert.equal(edited.current.dirty, true)
    assert.equal(edited.current.snapshotProvenance, null)
    assert.equal(edited.current.persistedSnapshotAt, null)
    assert.equal(edited.current.snapshotOriginState, 'unsaved-changes')

    const spawnsAfterSave = fixture.getSpawnCount()
    const stopped = await plugin.http(fixture.agent.id, 'shutdownKernel')
    assert.equal(stopped.status, 200, JSON.stringify(stopped.body))
    await plugin.emit('session/disposed', { id: fixture.agent.id })

    fixture.setContext({ attemptId: 'attempt-B' })
    const restored = await fixture.runWithScope(fixture.scopeB, () => plugin.invoke('nb_get', {}))
    assert.equal(restored.readOnly, true)
    assert.equal(restored.readOnlySnapshot, true)
    assert.equal(restored.dirty, true)
    assert.equal(restored.cells[0].source, 'x = 99')
    assert.equal(restored.snapshotProvenance, null, 'dirty retained 不得显示旧 A provenance')
    assert.equal(restored.persistedSnapshotAt, null)
    assert.equal(restored.snapshotOriginState, 'unsaved-changes')
    assert.equal(restored.kernel.alive, false)
    assert.equal(fixture.getSpawnCount(), spawnsAfterSave, 'dirty retained 只能做零 spawn 只读展示')
  } finally {
    await fixture.cleanup()
  }
})

test('无 Swarm runtime 时非 default SID 仍由 Host sessionQuery/fs 驱动标准 Notebook，冷会话不启动 kernel', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-standalone-context-'))
  const dshHome = join(root, 'dsh')
  const workspace = join(root, 'workspace')
  const notebooks = join(workspace, 'notebooks')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(notebooks, { recursive: true })

  const oldEnvironment = new Map()
  for (const [key, value] of Object.entries({
    DSH_HOME: dshHome,
    DSH_ENV_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX: dirname(dirname(testPython)),
    JUPYTER_PATH: undefined,
    APPDATA: undefined
  })) {
    oldEnvironment.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  let spawnCount = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCount += 1
    return createFakeSidecar()
  })
  syncBuiltinESMExports()

  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const snapshotRuntimeKey = Symbol.for('dsh-agent-swarm.notebook-snapshot.v1')
  const previousGlobals = new Map([boundaryKey, managedKey, snapshotRuntimeKey].map(key => [key, globalThis[key]]))
  delete globalThis[boundaryKey]
  delete globalThis[managedKey]
  delete globalThis[snapshotRuntimeKey]

  const sessionId = 'standalone-standard-session-42'
  const session = {
    id: sessionId,
    header: { id: sessionId, cwd: workspace },
    firstLiveSeq: 0,
    seq: 1,
  }
  let disposeCount = 0
  const observation = {
    source: 'prepared',
    header: session.header,
    inheritedEventCount: 0,
    events: [],
    cursor: -1,
    retain: () => observation,
    [Symbol.dispose]: () => { disposeCount += 1 },
  }
  const hostServices = {
    sessions: { get: () => undefined },
    sessionQuery: {
      observeSession: async candidate => {
        if (candidate !== sessionId) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return observation
      },
      inspectSession: async (_candidate, read) => read(session),
    },
    workingDirectory: { get: () => workspace },
    fs: {
      lstat: async () => ({ type: 'directory' }),
      resolve: async path => ({ targetKey: path, displayPath: path }),
      stat: async () => ({ type: 'directory' }),
      processPath: target => target.targetKey,
      processPathFromHostPath: hostPath => hostPath,
    },
  }
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: { cwd: workspace },
    },
  }

  let plugin
  let coldPlugin
  try {
    plugin = await createPlugin({ workspace, agent, services: hostServices })
    const created = await plugin.invoke('nb_new', { title: 'standalone draft' })
    assert.equal(created.readOnly, false)
    const cellId = created.cells[0].id
    await plugin.invoke('nb_edit_cell', { cellId, source: 'print(42)' })
    const live = await plugin.invoke('nb_get', {})
    assert.equal(live.cells[0].source, 'print(42)')

    const execution = await plugin.invoke('nb_run_all', { wait: true })
    assert.equal(execution.results[0].status, 'ok')
    assert.equal(execution.results[0].stdout, '42\n')

    const savedPath = join(notebooks, 'standalone.ipynb')
    const saved = await plugin.invoke('nb_save', { path: savedPath })
    assert.equal(saved.ok, true)
    assert.equal(saved.fileSaved, true)
    assert.equal(saved.snapshot.saved, false)
    assert.equal(saved.snapshot.code, 'NOTEBOOK_SNAPSHOT_OPTIONAL_UNAVAILABLE')
    assert.equal(saved.current.snapshotProvenance, null)
    assert.equal(saved.current.persistedSnapshotAt, null)
    assert.equal(saved.current.snapshotOriginState, 'not-saved')
    assert.equal(existsSync(savedPath), true)
    assert.equal(JSON.parse(readFileSync(savedPath, 'utf8')).cells[0].source, 'print(42)')
    assert.ok(disposeCount >= 1)

    await plugin.dispose()
    plugin = undefined
    const spawnsBeforeCold = spawnCount
    coldPlugin = await createPlugin({ workspace, services: hostServices })
    for (const route of ['new', 'addCell', 'editCell', 'runCell', 'save']) {
      const response = await coldPlugin.http(sessionId, route, {
        cellId,
        source: 'print(99)',
        cell_type: 'code',
        path: join(notebooks, 'must-not-exist.ipynb'),
      })
      assert.equal(response.status, 403, route)
    }
    assert.equal(spawnCount, spawnsBeforeCold, '冷 known SID 无快照不得启动 standard kernel')
    assert.equal(existsSync(join(notebooks, 'must-not-exist.ipynb')), false)
  } finally {
    await plugin?.dispose()
    await coldPlugin?.dispose()
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('无 Swarm runtime 的 fallback 读到 marker 时仍按 managed scope 拒绝，不降级为 standard', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-fallback-marker-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const snapshotRuntimeKey = Symbol.for('dsh-agent-swarm.notebook-snapshot.v1')
  const previousGlobals = new Map([boundaryKey, managedKey, snapshotRuntimeKey].map(key => [key, globalThis[key]]))
  delete globalThis[boundaryKey]
  delete globalThis[managedKey]
  delete globalThis[snapshotRuntimeKey]

  const sessionId = 'fallback-marker-child'
  const rootSessionId = 'fallback-marker-root'
  const session = {
    id: sessionId,
    header: { id: sessionId, cwd: workspace, parentSession: rootSessionId },
    firstLiveSeq: 1,
    seq: 2,
  }
  const marker = {
    type: 'plugin:swarm/notebook-task-binding',
    seq: 0,
    time: 1,
    ignorable: true,
    data: {
      schemaVersion: 1,
      sessionId,
      rootSessionId,
      taskId: 'T-marker',
      attemptId: 'attempt-marker',
    },
  }
  let disposeCount = 0
  const observation = {
    source: 'prepared',
    header: session.header,
    inheritedEventCount: 0,
    events: [marker],
    cursor: 0,
    retain: () => observation,
    [Symbol.dispose]: () => { disposeCount += 1 },
  }
  const hostServices = {
    sessions: { get: () => undefined },
    sessionQuery: {
      observeSession: async candidate => {
        if (candidate !== sessionId) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
        return observation
      },
      inspectSession: async (_candidate, read) => read(session),
    },
    workingDirectory: { get: () => workspace },
    fs: {
      lstat: async () => ({ type: 'directory' }),
      resolve: async path => ({ targetKey: path, displayPath: path }),
      stat: async () => ({ type: 'directory' }),
      processPath: target => target.targetKey,
      processPathFromHostPath: hostPath => hostPath,
    },
  }
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: session.header,
    },
  }
  let spawnCount = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCount += 1
    return createFakeSidecar()
  })
  syncBuiltinESMExports()
  let plugin
  try {
    plugin = await createPlugin({ workspace, agent, services: hostServices })
    await assert.rejects(plugin.invoke('nb_get', {}), /执行边界|授权|scope|缺少/)
    marker.data.rootSessionId = 'wrong-root'
    await assert.rejects(plugin.invoke('nb_get', {}), /无效|过期|降级/)
    assert.equal(disposeCount, 2)
    assert.equal(spawnCount, 0)
  } finally {
    await plugin?.dispose()
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed task marker 支持重启只读恢复，并拒绝旧任务、linked worktree 和目录替换', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-plugin-managed-context-'))
  const dshHome = join(root, 'dsh')
  const repositoryRoot = join(root, 'shared-repository')
  const workspaceA = join(repositoryRoot, 'worktree-a')
  const workspaceB = join(repositoryRoot, 'worktree-b')
  const notebooks = join(workspaceA, 'notebooks')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(notebooks, { recursive: true })
  mkdirSync(workspaceB, { recursive: true })
  const sourcePath = join(notebooks, 'managed-source.ipynb')
  const savedPath = join(notebooks, 'managed-saved.ipynb')
  writeNotebook(sourcePath, [{
    id: 'cell-managed',
    cell_type: 'code',
    source: '21 * 2',
    execution_count: 1,
    metadata: {},
    outputs: [{ output_type: 'stream', name: 'stdout', text: '42\n' }]
  }])
  writeNotebook(savedPath, [{
    id: 'cell-managed',
    cell_type: 'code',
    source: '21 * 2',
    execution_count: 1,
    metadata: {},
    outputs: [{ output_type: 'stream', name: 'stdout', text: '42\n' }]
  }])

  const oldEnvironment = new Map()
  for (const [key, value] of Object.entries({
    DSH_HOME: dshHome,
    DSH_ENV_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX: dirname(dirname(testPython)),
    JUPYTER_PATH: undefined,
    APPDATA: undefined
  })) {
    oldEnvironment.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  let spawnCount = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCount += 1
    return createFakeSidecar()
  })
  syncBuiltinESMExports()

  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const runtimeKey = Symbol.for('dsh-agent-swarm.notebook-runtime.v1')
  const previousGlobals = new Map([boundaryKey, managedKey, runtimeKey].map(key => [key, globalThis[key]]))
  const agent = {
    id: 'managed-child',
    session: {
      id: 'managed-child',
      header: { cwd: workspaceA, parentSession: 'managed-root' }
    }
  }
  const storage = new AsyncLocalStorage()
  const makeScope = (taskId, attemptId, cwd = workspaceA) => ({
    taskId,
    agentId: agent.id,
    attemptId,
    mode: 'write',
    operation: 'file',
    cwd,
    repositoryRoot,
    writeScopes: [join(cwd, 'notebooks')],
    expectedDirectoryIdentity: getDirectoryIdentity(cwd),
    epoch: { active: 0, unknown: false, sealed: false },
    assertCurrent: () => {}
  })
  const scopeT1 = makeScope('T-1', 'attempt-1')
  const scopeT1B = makeScope('T-1', 'attempt-1b')
  const scopeT2 = makeScope('T-2', 'attempt-2')
  globalThis[boundaryKey] = {
    storage,
    epochs: new Map(),
    assertFilePath: path => {
      if (!path.startsWith(`${workspaceA}/`)) throw new Error('managed path outside current worktree')
    }
  }
  globalThis[managedKey] = { version: 1, isManaged: candidate => candidate === agent }

  const snapshotStore = createNotebookSnapshotStore({ dshHome })
  const readContexts = new Map()
  const setContext = overrides => {
    readContexts.set(agent.id, createHostReadContext({
      sessionId: agent.id,
      managed: true,
      taskId: 'T-1',
      attemptId: 'attempt-1',
      rootSessionId: 'managed-root',
      cwd: workspaceA,
      ...overrides,
    }))
  }
  setContext()
  const uninstallSnapshot = installNotebookSnapshotRuntime({
    ...snapshotStore,
    resolveReadContext: async sessionId => readContexts.get(sessionId),
  })

  let restartPlugin
  let toolPlugin
  let guardPlugin
  try {
    const persisted = await snapshotStore.save({
      sessionId: agent.id,
      savedAt: '2026-11-17T09:30:00.000Z',
      savedPath,
      notebook: {
        cells: [{
          id: 'cell-managed',
          cell_type: 'code',
          source: '21 * 2',
          outputs: [{ type: 'stream', text: '42\n' }],
          execution_count: 1,
          metadata: {}
        }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      },
      cellExtras: {},
      task: {
        id: 'T-1',
        agentId: agent.id,
        attemptId: 'attempt-1',
        managed: true
      },
      project: {
        cwd: workspaceA,
        repositoryRoot,
        directoryIdentity: getDirectoryIdentity(workspaceA)
      },
      boundary: {
        mode: 'write',
        operation: 'file',
        writeScopes: scopeT1.writeScopes
      }
    })
    assert.equal(persisted.saved, true)
    const spawnsAfterRestart = spawnCount

    // No active Agent: sessionQuery marker context plus persisted snapshot restores read-only data.
    restartPlugin = await createPlugin({ workspace: workspaceA })
    const restored = await restartPlugin.http(agent.id, 'get')
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(restored.body.readOnly, true)
    assert.equal(restored.body.kernel.alive, false)
    assert.equal(restored.body.cells[0].source, '21 * 2')
    assert.equal(restored.body.cells[0].outputs[0].text, '42\n')

    // A same-task successor attempt may read A's pure data after current scope B is verified.
    setContext({ attemptId: 'attempt-1b' })
    const nextAttemptRestore = await restartPlugin.http(agent.id, 'get')
    assert.equal(nextAttemptRestore.status, 200, JSON.stringify(nextAttemptRestore.body))
    assert.equal(nextAttemptRestore.body.readOnly, true)
    assert.equal(nextAttemptRestore.body.readOnlySnapshot, true)
    assert.equal(nextAttemptRestore.body.cells[0].source, '21 * 2')
    assert.deepEqual({
      ...nextAttemptRestore.body.snapshotProvenance,
      recordedAt: undefined,
    }, {
      mode: 'read-only-snapshot',
      originTaskId: 'T-1',
      originAgentId: agent.id,
      originAttemptId: 'attempt-1',
      savedAt: '2026-11-17T09:30:00.000Z',
      recordedAt: undefined,
    })
    assert.match(nextAttemptRestore.body.snapshotProvenance.recordedAt, /^\d{4}-\d{2}-\d{2}T/)

    // Retained/persisted readonly state is still checked against the current marker.
    setContext({ taskId: 'T-2', attemptId: 'attempt-2' })
    const staleAfterRestart = await restartPlugin.http(agent.id, 'get')
    assert.equal(staleAfterRestart.status, 403)
    setContext()
    await restartPlugin.dispose()
    restartPlugin = undefined

    // The tool path uses the same resolver and returns the persisted double-cell output.
    toolPlugin = await createPlugin({ workspace: workspaceA, agent })
    const toolRestored = await storage.run(scopeT1, () => toolPlugin.invoke('nb_get', {}))
    assert.equal(toolRestored.readOnly, true)
    assert.equal(toolRestored.kernel.alive, false)
    assert.equal(toolRestored.cells[0].source, '21 * 2')
    assert.equal(toolRestored.cells[0].outputs[0].text, '42\n')

    setContext({ attemptId: 'attempt-1b' })
    const toolRestoredB = await storage.run(scopeT1B, () => toolPlugin.invoke('nb_get', {}))
    assert.equal(toolRestoredB.readOnly, true)
    assert.equal(toolRestoredB.readOnlySnapshot, true)
    assert.equal(toolRestoredB.snapshotProvenance.originAttemptId, 'attempt-1')
    setContext()

    // A live T1 cache cannot be reused after the child Session appends under T2.
    await storage.run(scopeT1, () => toolPlugin.invoke('nb_new', { title: 'live-t1' }))
    await storage.run(scopeT1, () => toolPlugin.invoke('nb_add_cell', {
      cell_type: 'code',
      source: 'print("T1 only")'
    }))
    setContext({ taskId: 'T-2', attemptId: 'attempt-2' })
    await assert.rejects(
      storage.run(scopeT2, () => toolPlugin.invoke('nb_get', {})),
      /task|任务|不一致|拒绝/
    )
    const liveMismatch = await toolPlugin.http(agent.id, 'get')
    assert.equal(liveMismatch.status, 403)
    setContext()
    await toolPlugin.dispose()
    toolPlugin = undefined

    // Same repositoryRoot is insufficient: linked worktree B is a different physical cwd.
    setContext({ cwd: workspaceB, directoryIdentity: getDirectoryIdentity(workspaceB) })
    agent.session.header.cwd = workspaceB
    guardPlugin = await createPlugin({ workspace: workspaceB, agent })
    const linkedMismatch = await guardPlugin.http(agent.id, 'get')
    assert.equal(linkedMismatch.status, 403)
    await guardPlugin.dispose()
    guardPlugin = undefined

    // Replacing the directory at the same path changes dev/ino/birthtimeNs.
    const replacedPath = workspaceA
    const oldPath = join(root, 'worktree-a-old')
    renameSync(workspaceA, oldPath)
    mkdirSync(join(replacedPath, 'notebooks'), { recursive: true })
    agent.session.header.cwd = replacedPath
    setContext({ cwd: replacedPath, directoryIdentity: getDirectoryIdentity(replacedPath) })
    guardPlugin = await createPlugin({ workspace: replacedPath, agent })
    const replacedMismatch = await guardPlugin.http(agent.id, 'get')
    assert.equal(replacedMismatch.status, 403)

    assert.equal(spawnCount, spawnsAfterRestart, '跨重启只读恢复不得启动 kernel/sidecar')
  } finally {
    await restartPlugin?.dispose()
    await toolPlugin?.dispose()
    await guardPlugin?.dispose()
    uninstallSnapshot()
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    for (const [key, value] of oldEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('可信 routerDraft 允许 Root 纯内存草稿，stale preset 头不能让 Worker 冒充 Root', async t => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-router-draft-'))
  const dshHome = join(root, 'dsh')
  const workspace = join(root, 'workspace')
  const notebooks = join(workspace, 'notebooks')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(notebooks, { recursive: true })

  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const snapshotRuntimeKey = Symbol.for('dsh-agent-swarm.notebook-snapshot.v1')
  const previousGlobals = new Map([boundaryKey, managedKey, snapshotRuntimeKey].map(key => [key, globalThis[key]]))
  delete globalThis[boundaryKey]

  const rootId = 'router-root-session'
  const workerId = 'router-worker-session'
  const rootAgent = {
    id: rootId,
    session: {
      id: rootId,
      header: { cwd: workspace, agentPreset: 'standard' },
    },
  }
  const workerAgent = {
    id: workerId,
    session: {
      id: workerId,
      header: { cwd: workspace, parentSession: rootId, agentPreset: 'tian-shu' },
    },
  }
  globalThis[managedKey] = {
    version: 1,
    isManaged: candidate => candidate === rootAgent || candidate === workerAgent,
  }
  const readContexts = new Map([
    [rootId, createHostReadContext({
      sessionId: rootId,
      cwd: workspace,
      routerDraft: true,
    })],
    [workerId, createHostReadContext({
      sessionId: workerId,
      managed: true,
      taskId: 'T-worker',
      attemptId: 'attempt-worker',
      rootSessionId: rootId,
      cwd: workspace,
    })],
  ])
  const store = createNotebookSnapshotStore({ dshHome })
  const uninstallSnapshot = installNotebookSnapshotRuntime({
    ...store,
    resolveReadContext: async sessionId => readContexts.get(sessionId),
  })

  let spawnCount = 0
  t.mock.method(childProcess, 'spawn', () => {
    spawnCount += 1
    return createFakeSidecar()
  })
  syncBuiltinESMExports()

  let rootPlugin
  let workerPlugin
  try {
    rootPlugin = await createPlugin({ workspace, agent: rootAgent })
    const created = await rootPlugin.invoke('nb_new', { title: 'root-only draft' })
    const cellId = created.cells[0].id
    await rootPlugin.invoke('nb_edit_cell', { cellId, source: 'draft = 42' })
    await rootPlugin.invoke('nb_add_cell', { cell_type: 'markdown', source: '# Root draft' })
    const draft = await rootPlugin.invoke('nb_get', {})
    assert.equal(draft.cells[0].source, 'draft = 42')
    assert.equal(draft.cells[1].source, '# Root draft')

    const httpNew = await rootPlugin.http(rootId, 'new', { title: 'root ui draft' })
    assert.equal(httpNew.status, 200, JSON.stringify(httpNew.body))
    const httpCellId = httpNew.body.cells[0].id
    assert.equal((await rootPlugin.http(rootId, 'addCell', {
      cell_type: 'markdown',
      source: '**kept**',
    })).status, 200)
    assert.equal((await rootPlugin.http(rootId, 'editCell', {
      cellId: httpCellId,
      source: 'draft = 7',
    })).status, 200)
    const httpGet = await rootPlugin.http(rootId, 'get')
    assert.equal(httpGet.status, 200)
    assert.equal(httpGet.body.cells[0].source, 'draft = 7')

    await assert.rejects(rootPlugin.invoke('nb_run_all', { wait: true }), /执行边界|授权|scope|缺少/)
    await assert.rejects(rootPlugin.invoke('nb_save', {
      path: join(notebooks, 'root-must-not-save.ipynb'),
    }), /执行边界|授权|scope|缺少/)
    assert.equal((await rootPlugin.http(rootId, 'runAll', {})).status, 403)
    assert.equal((await rootPlugin.http(rootId, 'save', {
      path: join(notebooks, 'root-must-not-save.ipynb'),
    })).status, 403)
    assert.equal(existsSync(join(notebooks, 'root-must-not-save.ipynb')), false)

    await rootPlugin.dispose()
    rootPlugin = undefined
    workerPlugin = await createPlugin({ workspace, agent: workerAgent })
    await assert.rejects(workerPlugin.invoke('nb_new', { title: 'must fail' }), /执行边界|授权|scope|缺少/)
    assert.equal(spawnCount, 0, 'Root 草稿和拒绝路径不得启动 kernel/sidecar')
  } finally {
    await rootPlugin?.dispose()
    await workerPlugin?.dispose()
    uninstallSnapshot()
    for (const [key, value] of previousGlobals) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
    t.mock.restoreAll()
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  }
})

test('插件桥保留 managed task、项目和执行边界元数据', async () => {
  const { persistNotebookSnapshot } = await import(
    pathToFileURL(join(pluginRoot, 'lib', 'notebook-snapshot-bridge.js')).href
  )
  const root = mkdtempSync(join(tmpdir(), 'notebook-snapshot-managed-'))
  const dshHome = join(root, 'dsh')
  const workspace = join(root, 'workspace')
  const notebooks = join(workspace, 'notebooks')
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(notebooks, { recursive: true })
  const savedPath = join(notebooks, 'managed.ipynb')
  writeNotebook(savedPath, [{ id: 'cell-1', cell_type: 'code', source: '6 * 7', outputs: [], metadata: {} }])
  const state = {
    savedAt: Date.parse('2026-11-17T09:00:00.000Z'),
    cwd: workspace,
    workspaceRoot: workspace,
    notebook: {
      cells: [{ id: 'cell-1', cell_type: 'code', source: '6 * 7', outputs: [{ type: 'stream', text: '42\n' }] }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5
    },
    cellExtras: {}
  }
  const scope = {
    taskId: 'T-managed',
    agentId: 'agent-managed',
    attemptId: 'attempt-managed',
    mode: 'write',
    operation: 'file',
    cwd: workspace,
    repositoryRoot: workspace,
    writeScopes: [notebooks],
    expectedDirectoryIdentity: getDirectoryIdentity(workspace)
  }
  const store = createNotebookSnapshotStore({ dshHome })
  const uninstall = installNotebookSnapshotRuntime(store)
  try {
    const receipt = await persistNotebookSnapshot({
      sessionId: 'session-managed',
      state,
      scope,
      savedPath,
      managed: true
    })
    assert.equal(receipt.saved, true)
    const restored = await store.load('session-managed', createHostReadContext({
      sessionId: 'session-managed',
      managed: true,
      taskId: 'T-managed',
      attemptId: 'attempt-managed',
      rootSessionId: 'root-managed',
      agentId: 'agent-managed',
      cwd: workspace,
    }))
    assert.deepEqual(restored.task, {
      id: 'T-managed',
      agentId: 'agent-managed',
      attemptId: 'attempt-managed',
      managed: true
    })
    assert.deepEqual(restored.project, {
      cwd: workspace,
      repositoryRoot: workspace,
      directoryIdentity: getDirectoryIdentity(workspace)
    })
    assert.deepEqual(restored.boundary, {
      mode: 'write',
      operation: 'file',
      writeScopes: [notebooks]
    })
    const missingTaskIdentity = await persistNotebookSnapshot({
      sessionId: 'session-managed-without-scope',
      state,
      savedPath,
      managed: true
    })
    assert.deepEqual(missingTaskIdentity, {
      saved: false,
      code: 'NOTEBOOK_SNAPSHOT_INVALID',
      error: '显式 .ipynb 已保存，但跨重启只读快照写入失败'
    })
  } finally {
    uninstall()
    rmSync(root, { recursive: true, force: true })
  }
})

test('客户端只读快照显示标识、关闭编辑并禁用执行/保存入口', () => {
  const client = readFileSync(join(pluginRoot, 'lib', 'client.js'), 'utf8')
  assert.match(client, /dnb-readonly/)
  assert.match(client, /cm\.EditorState\.readOnly\.of\(props\.readOnly === true\)/)
  assert.match(client, /cm\.EditorView\.editable\.of\(props\.readOnly !== true\)/)
  assert.match(client, /disabled: nb\.busy \|\| readOnly/)
  assert.match(client, /isCode && props\.selected && !readOnly/)
  assert.match(client, /key: c\.id \+ \(readOnly \? ":read-only" : ":editable"\)/)
})

test('DOMPurify ESM 由 package 内 exact route 提供，不依赖宿主裸依赖', async () => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-dompurify-route-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const plugin = await createPlugin({ workspace })
  try {
    const response = await plugin.vendor()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.match(response.body, /DOMPurify 3\.4\.18/)
    assert.match(response.body, /export \{ purify_default as default \}/)
  } finally {
    await plugin.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('exact-file 补丁清单与候选包逐文件 SHA 一致', () => {
  const sha = bytes => createHash('sha256').update(bytes).digest('hex')
  const planPath = resolve('patches/dsh-notebook-0.4.2-rc3-snapshot.json')
  const patchPath = resolve('patches/dsh-notebook-0.4.2-rc3-snapshot.patch')
  const plan = JSON.parse(readFileSync(planPath, 'utf8'))
  assert.equal(plan.packageName, '@beihaizb/dsh-notebook')
  assert.equal(plan.targetVersion, '0.4.2+rc3.sandbox.9')
  assert.equal(sha(readFileSync(patchPath)), plan.patchSha256)
  assert.match(readFileSync(join(pluginRoot, 'lib', 'index.js'), 'utf8'), /持久快照读取缺少可信 Host context/)
  assert.match(readFileSync(join(pluginRoot, 'package.json'), 'utf8'), /"lib\/vendor"/)
  assert.ok(plan.files.some(entry => entry.path === 'lib/vendor/dompurify.es.mjs'))
  assert.ok(plan.files.some(entry => entry.path === 'lib/vendor/DOMPurify.LICENSE'))
  for (const entry of plan.files) {
    assert.equal(sha(readFileSync(join(pluginRoot, entry.path))), entry.afterSha256, entry.path)
  }
})

test('只读恢复把恶意 SVG/HTML 输出作为惰性文本，不进入 dangerouslySetInnerHTML', () => {
  const { client, context, pluginClient } = loadPluginClient()
  const svg = '<svg><script>globalThis.__dnbPwned=1</script><image href="x"/></svg>'
  const html = '<img src=x onerror="globalThis.__dnbPwned=1">'
  assert.equal(pluginClient.getSafeReadOnlyOutputText(svg), svg)
  assert.equal(pluginClient.getSafeReadOnlyOutputText(html), html)
  assert.match(client, /props\.readOnly && data\["image\/svg\+xml"\]/)
  assert.match(client, /props\.readOnly && data\["text\/html"\]/)
  assert.match(client, /outputs: cell\.outputs, readOnly: readOnly/)
  assert.equal(context.globalThis?.__dnbPwned, undefined)
})

test('DOMPurify ESM 清除 Markdown 属性与 javascript URL，并保留普通静态富内容', () => {
  const { pluginClient } = loadPluginClient()
  const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.invalid/' })
  const purify = createDOMPurify(browser.window)
  assert.equal(typeof pluginClient.renderMarkdown, 'function')
  assert.equal(typeof pluginClient.sanitizeStaticMarkup, 'function')

  const markdown = [
    '[hover](x" onmouseover="globalThis.__dnbPwned=1)',
    '[unsafe](javascript:globalThis.__dnbPwned=1)',
    '**safe bold**',
    '[docs](https://example.com/report)'
  ].join('\n\n')
  const rendered = pluginClient.renderMarkdown(markdown, purify)
  assert.doesNotMatch(rendered, /onmouseover/i)
  assert.doesNotMatch(rendered, /href="javascript:/i)
  assert.match(rendered, /<strong>safe bold<\/strong>/)
  assert.match(rendered, /href="https:\/\/example\.com\/report"/)

  const markdownDom = new JSDOM(`<!doctype html><body>${rendered}</body>`, {
    runScripts: 'dangerously',
    url: 'https://dsh.invalid/'
  })
  markdownDom.window.__dnbPwned = undefined
  for (const anchor of markdownDom.window.document.querySelectorAll('a')) {
    anchor.dispatchEvent(new markdownDom.window.MouseEvent('mouseover', { bubbles: true }))
  }
  assert.equal(markdownDom.window.__dnbPwned, undefined)

  const richHtml = '<section data-keep="yes"><h2>Report</h2><img src="https://example.com/chart.png" onerror="globalThis.__dnbPwned=1"></section>'
  const richSvg = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" onmouseover="globalThis.__dnbPwned=1"></circle><script>globalThis.__dnbPwned=1</script></svg>'
  const cleanHtml = pluginClient.sanitizeStaticMarkup(richHtml, purify)
  const cleanSvg = pluginClient.sanitizeStaticMarkup(richSvg, purify)
  assert.match(cleanHtml, /<section/)
  assert.match(cleanHtml, /<h2>Report<\/h2>/)
  assert.match(cleanHtml, /https:\/\/example\.com\/chart\.png/)
  assert.doesNotMatch(cleanHtml, /onerror/i)
  assert.match(cleanSvg, /<svg/)
  assert.match(cleanSvg, /<circle/)
  assert.doesNotMatch(cleanSvg, /script|onmouseover/i)
})
