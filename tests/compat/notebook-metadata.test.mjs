import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import childProcess from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

// 显式指向离线插件及运行环境；本文件只验元信息，不启动 Python/Jupyter。
for (const key of ['NOTEBOOK_PLUGIN_ROOT', 'NOTEBOOK_TEST_PYTHON']) {
  if (!process.env[key]?.trim()) throw new Error(`${key} is required for the offline Notebook metadata test`)
}
const pluginRoot = resolve(process.env.NOTEBOOK_PLUGIN_ROOT)
const testPython = resolve(process.env.NOTEBOOK_TEST_PYTHON)
assert.ok(fs.existsSync(testPython), 'NOTEBOOK_TEST_PYTHON must exist')

test('Notebook 未核验环境的展示与执行保持分离', async t => {
  const fixture = fs.mkdtempSync(join(os.tmpdir(), 'notebook-metadata-test-'))
  const testDshHome = join(fixture, 'dsh')
  const workspace = join(fixture, 'workspace')
  const unknownPython = join(fixture, 'unverified', 'bin', 'python')
  fs.mkdirSync(testDshHome, { recursive: true })
  fs.mkdirSync(join(workspace, 'notebooks'), { recursive: true })
  fs.mkdirSync(dirname(unknownPython), { recursive: true })
  fs.writeFileSync(unknownPython, '', { mode: 0o600 })
  const root = { id: 'metadata-root', session: { id: 'metadata-root', header: { cwd: workspace, agentPreset: 'tian-shu' } } }
  const worker = { id: 'metadata-worker', session: { id: 'metadata-worker', header: { cwd: workspace, parentSession: root.id } } }
  const envselFile = join(testDshHome, 'envsel-state.json')
  const selection = JSON.stringify({ version: 1, selections: { [root.id]: { python: { pythonCommand: unknownPython } } } })
  fs.writeFileSync(envselFile, selection, { mode: 0o600 })
  const env = {
    DSH_HOME: testDshHome, DSH_ENV_PYTHON: undefined, JUPYTER_PATH: undefined, APPDATA: undefined,
    DSH_NOTEBOOK_CONTROLLER_PYTHON: testPython,
    DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX: dirname(dirname(testPython)),
  }
  const oldEnv = new Map(Object.keys(env).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const boundaryKey = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
  const managedKey = Symbol.for('dsh-agent-swarm/managed-agents')
  const runtimeKey = Symbol.for('dsh-agent-swarm.notebook-runtime.v1')
  const snapshotRuntimeKey = Symbol.for('dsh-agent-swarm.notebook-snapshot.v1')
  const oldGlobals = new Map([boundaryKey, managedKey, runtimeKey, snapshotRuntimeKey].map(key => [key, globalThis[key]]))
  const effects = []
  t.after(async () => {
    try { for (const dispose of effects.reverse()) await dispose?.() }
    finally {
      for (const [key, value] of oldGlobals) {
        if (value === undefined) delete globalThis[key]
        else globalThis[key] = value
      }
      for (const [key, value] of oldEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  })
  let rawSpawns = 0
  let nativeSpawns = 0
  let notebookReads = 0
  let failSelectionLookup = false
  const notebooksDir = join(workspace, 'notebooks')
  const guardNotebookRead = path => {
    const file = resolve(String(path))
    if (file === notebooksDir || file.startsWith(notebooksDir + sep)) {
      notebookReads += 1
      throw new Error('metadata route must not read workspace/notebooks')
    }
  }
  // 隔离用户目录和配置读取；意外 raw spawn 直接阻断，不能执行宿主命令。
  t.mock.method(os, 'homedir', () => testDshHome)
  t.mock.method(childProcess, 'spawn', () => { rawSpawns += 1; throw new Error('unexpected raw spawn') })
  const originalRead = fs.readFileSync
  t.mock.method(fs, 'readFileSync', (path, ...args) => {
    guardNotebookRead(path)
    const file = String(path)
    if (file.endsWith('envsel-state.json')) assert.equal(resolve(file), envselFile)
    if (file.endsWith('kernel.json') && !file.startsWith(fixture)) throw new Error('external kernelspec disabled in fixture')
    return originalRead(path, ...args)
  })
  const originalExists = fs.existsSync
  t.mock.method(fs, 'existsSync', path => {
    guardNotebookRead(path)
    if (failSelectionLookup && String(path) === unknownPython) throw Object.assign(new Error('unrelated metadata failure'), { code: 'TEST_OTHER_ERROR' })
    return originalExists(path)
  })
  for (const method of ['readdirSync', 'statSync', 'lstatSync']) {
    const original = fs[method]
    t.mock.method(fs, method, (path, ...args) => { guardNotebookRead(path); return original(path, ...args) })
  }
  syncBuiltinESMExports()
  const storage = new AsyncLocalStorage()
  globalThis[boundaryKey] = { storage }
  globalThis[managedKey] = { version: 1, isManaged: agent => [root.id, worker.id].includes(agent?.id) }
  const readContexts = new Map([
    [root.id, {
      schemaVersion: 1, sessionId: root.id, managed: false, taskId: null, agentId: root.id,
      attemptId: null, rootSessionId: null, cwd: workspace, directoryIdentity: 'fixture-root',
      source: 'host-session', routerDraft: true,
    }],
    [worker.id, {
      schemaVersion: 1, sessionId: worker.id, managed: true, taskId: 'T-metadata', agentId: worker.id,
      attemptId: 'metadata-attempt', rootSessionId: root.id, cwd: workspace, directoryIdentity: 'fixture-worker',
      source: 'swarm-marker',
    }],
  ])
  globalThis[snapshotRuntimeKey] = {
    version: 1,
    save: async () => ({ saved: true, digest: '0'.repeat(64), bytes: 1 }),
    load: async () => undefined,
    resolveReadContext: async sessionId => readContexts.get(sessionId),
  }
  const tools = new Map()
  let handler
  const { apply } = await import(pathToFileURL(join(pluginRoot, 'lib', 'index.js')).href)
  apply({
    get: name => ({
      sandboxPolicy: { workspaceRoot: workspace },
      agents: { get: id => [root, worker].find(agent => agent.id === id) },
      subprocess: { spawn: () => { nativeSpawns += 1; throw new Error('unexpected native spawn') } },
    })[name],
    effect: execute => { const dispose = execute(); effects.push(dispose); return dispose },
    on: () => () => {},
    tools: { register: tool => { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    webServer: { register: entry => { handler = entry.handler; return () => {} } },
  })
  const invoke = (agent, name, args = {}) => tools.get(name).execute(args, { agent })
  const http = async (sid, route, args = {}) => {
    const request = Readable.from([JSON.stringify({ ...args, _sid: sid })])
    request.method = 'POST'
    request.url = '/nb/' + route
    let body
    const response = { statusCode: 200, setHeader: () => {}, end: value => { body = JSON.parse(String(value)) } }
    await handler(request, response)
    return { status: response.statusCode, body }
  }
  const assertUnavailable = snapshot => {
    assert.ok(snapshot.cells.length > 0)
    assert.equal(snapshot.kernel.available, false)
    assert.equal(snapshot.kernel.alive, false)
    assert.ok(snapshot.kernel.selectionError)
    assert.equal(snapshot.kernel.interpreter, unknownPython)
  }

  await t.test('Root 草稿、get 和 UI 内核列表返回 cells，保留未核验选择', async () => {
    const created = await invoke(root, 'nb_new', { title: 'metadata draft' })
    assertUnavailable(created)
    await invoke(root, 'nb_edit_cell', { cellId: created.cells[0].id, source: 'x = 40' })
    const snapshot = await invoke(root, 'nb_get')
    assertUnavailable(snapshot)
    assert.equal(snapshot.cells[0].source, 'x = 40')
    const response = await http(root.id, 'kernelList')
    assert.equal(response.status, 200)
    assertUnavailable(response.body.current)
    assert.equal(response.body.current.cells[0].source, 'x = 40')
    assert.ok(response.body.kernels.some(kernel => kernel.id === 'swarm-private-python'))
    assert.equal(fs.readFileSync(envselFile, 'utf8'), selection)
  })

  await t.test('Worker 继承未核验选择时计算仍拒绝，展示不能覆盖实际选择或启动进程', async () => {
    const scope = {
      taskId: 'T-metadata', agentId: worker.id, attemptId: 'metadata-attempt', cwd: workspace, repositoryRoot: workspace,
      mode: 'read-only', operation: 'shell', writeScopes: [], epoch: {}, assertCurrent: () => {},
    }
    assertUnavailable(await storage.run(scope, () => invoke(worker, 'nb_get')))
    const result = await storage.run(scope, () => invoke(worker, 'nb_run_all', { wait: true }))
    assert.equal(result.results[0].status, 'error')
    assert.match(result.results[0].error.evalue, /不在已核验运行池/)
    assert.equal(globalThis[runtimeKey].getState(worker.id).compute, null)
    assert.equal(rawSpawns, 0)
    assert.equal(nativeSpawns, 0)
    assert.equal(fs.readFileSync(envselFile, 'utf8'), selection)
  })

  await t.test('snapshotPublic 不吞掉未核验选择以外的异常', async () => {
    failSelectionLookup = true
    try { await assert.rejects(() => invoke(root, 'nb_get'), { code: 'TEST_OTHER_ERROR' }) }
    finally { failSelectionLookup = false }
    assert.equal(rawSpawns, 0)
    assert.equal(nativeSpawns, 0)
  })

  await t.test('Root 首屏和 inactive list 只返回元信息，无 scope 文件操作及未知 sid 保持 403', async () => {
    const assertMetadataList = response => {
      assert.equal(response.status, 200)
      assert.equal(response.body.metadataOnly, true)
      assert.deepEqual(response.body.notebooks, [])
      assert.equal(response.body.dir, workspace)
      assert.equal(response.body.current.cells[0].source, 'x = 40')
      assert.equal(notebookReads, 0)
    }
    assertMetadataList(await http(root.id, 'list'))
    for (const route of ['open', 'save']) {
      const response = await http(root.id, route, { path: join(notebooksDir, 'must-not-touch.ipynb') })
      assert.equal(response.status, 403, route)
    }
    for (const route of ['list', 'open', 'save', 'runCell']) {
      const response = await http('unknown-metadata-session', route, { path: join(notebooksDir, 'must-not-touch.ipynb') })
      assert.equal(response.status, 403, `unknown ${route}`)
    }
    await globalThis[runtimeKey].shutdownSession(root.id)
    assertMetadataList(await http(root.id, 'list'))
    assert.equal(globalThis[runtimeKey].getState(root.id).compute, null)
    assert.equal(notebookReads, 0)
    assert.equal(rawSpawns, 0)
    assert.equal(nativeSpawns, 0)
  })
})
