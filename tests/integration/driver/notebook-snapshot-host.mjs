import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  captureScopedProcesses,
  getAddedCellId,
  getExecutionStatus,
  getFirstCellId,
  getNotebookCellFacts,
  getResultText,
  getSnapshot,
  getStdout,
  isToolErrorResult,
  readJson,
  validateHttpProbeResult,
  waitFor,
  writeDurable
} from './notebook-snapshot-host-helpers.mjs'

const VALID_OUTPUTS = JSON.parse(readFileSync(new URL('../../fixtures/valid-outputs.json', import.meta.url), 'utf8'))
const NOTEBOOK_RUNTIME_KEY = Symbol.for('dsh-agent-swarm.notebook-runtime.v1')
const NOTEBOOK_SNAPSHOT_RUNTIME_KEY = Symbol.for('dsh-agent-swarm.notebook-snapshot.v1')
const EXECUTION_BOUNDARY_KEY = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
const EXECUTION_BOUNDARY_CAPS_KEY = Symbol.for('dsh-agent-swarm.execution-boundary-capabilities.v1')
const NOTEBOOK_TASK_BINDING_EVENT = 'plugin:swarm/notebook-task-binding'

const clip = (value, length = 2000) => String(value ?? '').slice(0, length)

const snapshotPathFor = (directory, sessionId) => join(
  directory,
  `${createHash('sha256').update(sessionId).digest('hex')}.json`
)

const getKernelProcesses = () => captureScopedProcesses([
  process.env.NOTEBOOK_SNAPSHOT_HOST_WORKSPACE,
  process.env.NOTEBOOK_SNAPSHOT_HOST_NOTEBOOK
].filter(Boolean)).filter(processInfo => processInfo.command.some(value => (
  value.includes('kernel_driver.py')
  || value.includes('ipykernel_launcher')
  || value.includes('jupyter_client')
)))

const getNotebookSpawnObservations = observations => observations.filter(observation => (
  observation.spec?.argv?.some(value => value.includes('kernel_driver.py')
    || value.includes('ipykernel_launcher')
    || value.includes('jupyter_client'))
))

const getToolErrorText = result => getResultText(result)

const getStructuredText = (role, mode) => {
  const output = role === 'zhu_jian'
    ? VALID_OUTPUTS.zhu_jian
    : VALID_OUTPUTS.suan_heng
  return `完成。\n\`\`\`json\n${JSON.stringify({ ...output, ...(mode === 'verify' ? { mode: 'verify' } : {}) })}\n\`\`\``
}

function* text(value) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: value }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: value } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* call(name, args) {
  const id = `notebook-snapshot-host-${randomUUID()}`
  const value = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: value }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: value } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

export const name = 'notebook-snapshot-host-driver'
export const inject = ['llm', 'agents', 'agentPresets', 'subagents', 'tools']

export const apply = ctx => {
  const phase = process.env.NOTEBOOK_SNAPSHOT_HOST_PHASE
  const output = process.env.NOTEBOOK_SNAPSHOT_HOST_OUT
  const metadataFile = process.env.NOTEBOOK_SNAPSHOT_HOST_METADATA
  const sentinelFile = process.env.NOTEBOOK_SNAPSHOT_HOST_SENTINEL
  const httpResultFile = process.env.NOTEBOOK_SNAPSHOT_HOST_HTTP_RESULT
  if (!['save', 'restore'].includes(phase)) throw new Error(`未知 phase: ${String(phase)}`)
  if (!output || !metadataFile || !sentinelFile || !httpResultFile) throw new Error('Notebook snapshot fixture environment is incomplete')

  const workspace = process.cwd()
  const candidateRoot = process.env.NOTEBOOK_SNAPSHOT_HOST_NOTEBOOK
  const expectedHead = process.env.NOTEBOOK_SNAPSHOT_HOST_EXPECTED_HEAD
  if (!workspace || !candidateRoot || !expectedHead) throw new Error('workspace/candidate/expectedHead 必须由 runner 提供')
  const initialMetadata = phase === 'restore' ? readJson(metadataFile) : undefined
  const state = {
    scenario: 'notebook-snapshot-host',
    phase,
    status: 'running',
    hostVersion: process.env.SWARM_DSH_VERSION ?? null,
    sdkModules: process.env.SWARM_DSH_MODULES ?? null,
    notebookVersion: JSON.parse(readFileSync(join(candidateRoot, 'package.json'), 'utf8')).version,
    workspace,
    candidateRoot,
    rootRequests: [],
    modelRequests: [],
    toolCalls: [],
    toolResults: [],
    toolErrors: [],
    markers: [],
    subagentEnds: [],
    spawnObservations: [],
    processCaptures: [],
    rootDraft: null,
    task: null,
    delegation: null,
    rootId: null,
    childSid: null,
    saved: null,
    markersAfterSave: [],
    restore: null,
    crossTask: null,
    authAnnouncement: null,
    rootTurns: [],
    rootDelegations: [],
    pendingRootDelegate: null
  }
  const steps = new Map()
  let root
  let handle
  let service
  let presetScope
  let restoreNotebookRuntime = () => {}
  let restoreBoundary = () => {}
  let finished = false
  let crossTaskReadRequested = false
  const blockers = []

  const finish = (status, error) => {
    if (finished) return
    finished = true
    state.status = status
    state.finishedAt = new Date().toISOString()
    if (error !== undefined) state.error = clip(error?.stack ?? error, 12000)
    writeDurable(output, state)
    setTimeout(() => process.exit(status === 'passed' ? 0 : status === 'blocked' ? 2 : 1), 100)
  }

  const adapter = {
    providerInfo: id => ({ id, name: 'Notebook snapshot Host local deterministic mock' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async () => [],
    resolveModel: async (provider, id) => ({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 32_000
    }),
    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },
    async *stream(options) {
      if (options.purpose !== undefined) {
        yield* text('notebook-snapshot-host-fixture')
        return
      }
      const sessionId = String(options.sessionId ?? 'unknown')
      const step = steps.get(sessionId) ?? 0
      steps.set(sessionId, step + 1)
      const request = {
        sessionId,
        model: options.model,
        step,
        purpose: options.purpose ?? null,
        tools: (options.tools ?? []).map(tool => tool.name)
      }
      state.modelRequests.push(request)
      if (state.rootId !== null && sessionId === state.rootId) {
        state.rootRequests.push(request)
        if (phase === 'save' && state.rootDraftCompleted !== true) {
          if (step === 0) {
            yield* call('nb_new', { title: 'root-draft' })
            return
          }
          if (step === 1) {
            yield* call('nb_get', {})
            return
          }
          if (step === 2) {
            yield* call('nb_run_cell', { cellId: state.rootFirstCell ?? 'missing-root-cell' })
            return
          }
          if (step === 3) {
            yield* call('nb_save', { path: 'notebooks/root-draft.ipynb' })
            return
          }
        }
        if (state.pendingRootDelegate !== null && state.pendingRootDelegate.sent !== true) {
          state.pendingRootDelegate.sent = true
          yield* call('swarm_delegate', state.pendingRootDelegate.arguments)
          return
        }
        yield* text('根会话 Notebook 草稿探针完成。')
        return
      }
      if (phase === 'save') {
        if (options.model !== 'zhu-jian') {
          yield* text('save phase has no expected child model route')
          return
        }
        if (state.sameHostAttemptB === true
          && sessionId === state.childSid
          && state.sameHostAttemptBReadRequested !== true) {
          state.sameHostAttemptBReadRequested = true
          yield* call('nb_get', {})
          return
        }
        if (step === 0) {
          yield* call('swarm_bind_primary_workspace', { expected_head: expectedHead })
          return
        }
        if (step === 1) {
          yield* call('nb_new', { title: 'notebook-snapshot-state' })
          return
        }
        if (step === 2) {
          yield* call('nb_edit_and_run_cell', {
            cellId: state.firstCell ?? 'missing-first-cell',
            source: 'x = 40'
          })
          return
        }
        if (step === 3) {
          yield* call('nb_add_cell', { cell_type: 'code', source: 'print(x + 2)' })
          return
        }
        if (step === 4) {
          yield* call('nb_run_cell', { cellId: state.secondCell ?? 'missing-second-cell' })
          return
        }
        if (step === 5) {
          yield* call('nb_save', { path: 'notebooks/state.ipynb' })
          return
        }
        yield* text(getStructuredText('zhu_jian'))
        return
      }

      if (!['suan-heng', 'zhu-jian'].includes(options.model)) {
        yield* text('restore phase has no expected child model route')
        return
      }
      const restoreRole = options.model === 'zhu-jian' ? 'zhu_jian' : 'suan_heng'
      const restoreMode = options.model === 'zhu-jian' ? undefined : 'research'
      if (state.crossTask !== null && state.crossTask.status === 'delegating' && !crossTaskReadRequested) {
        crossTaskReadRequested = true
        yield* call('nb_get', {})
        return
      }
      if (state.crossTask !== null && crossTaskReadRequested) {
        yield* text(getStructuredText(restoreRole, restoreMode))
        return
      }
      if (step === 0) {
        yield* call('nb_get', {})
        return
      }
      yield* text(getStructuredText(restoreRole, restoreMode))
    }
  }
  ctx.llm.registerAdapter(['notebook-snapshot-host-mock'], adapter)

  ctx.on('session/event', (_session, event) => {
    if (event?.type !== NOTEBOOK_TASK_BINDING_EVENT) return
    state.markers.push({
      sessionId: event.data?.sessionId ?? null,
      rootSessionId: event.data?.rootSessionId ?? null,
      taskId: event.data?.taskId ?? null,
      attemptId: event.data?.attemptId ?? null,
      seq: event.seq ?? null,
      at: new Date().toISOString()
    })
  })

  ctx.on('tools/execute', async (execution, next) => {
    if (execution.name.startsWith('nb_') || execution.name === 'swarm_bind_primary_workspace') {
      const boundary = globalThis[EXECUTION_BOUNDARY_KEY]?.storage?.getStore?.()
      state.toolCalls.push({
        name: execution.name,
        agentId: execution.agent?.id ?? null,
        arguments: execution.arguments,
        boundary: boundary === undefined ? null : {
          agentId: boundary.agentId,
          taskId: boundary.taskId ?? null,
          attemptId: boundary.attemptId,
          mode: boundary.mode,
          operation: boundary.operation,
          cwd: boundary.cwd
        }
      })
    }
    return next()
  })

  ctx.on('tools/result', (execution, result) => {
    if (!execution.name.startsWith('nb_')
      && execution.name !== 'swarm_bind_primary_workspace'
      && execution.name !== 'swarm_delegate') return
    const row = {
      name: execution.name,
      agentId: execution.agent?.id ?? null,
      arguments: execution.arguments,
      isError: isToolErrorResult(result),
      value: result?.value ?? result,
      text: clip(getResultText(result), 4000)
    }
    state.toolResults.push(row)
    if (row.isError) state.toolErrors.push({ name: row.name, agentId: row.agentId, error: row.text })
    if (execution.name === 'nb_new' && !row.isError) state.firstCell = getFirstCellId(row.value)
    if (execution.name === 'nb_new' && !row.isError && execution.agent?.id === state.rootId) {
      state.rootFirstCell = getFirstCellId(row.value)
    }
    if (execution.name === 'nb_add_cell' && !row.isError) state.secondCell = getAddedCellId(row.value)
    if (execution.name === 'nb_edit_and_run_cell' && !row.isError) {
      state.firstExecutionStatus = getExecutionStatus(row.value)
    }
    if (execution.name === 'nb_run_cell' && !row.isError) {
      state.finalExecutionStatus = getExecutionStatus(row.value)
      state.finalSnapshot = getSnapshot(row.value)
      state.finalStdout = getStdout(row.value)
    }
    if (execution.name === 'nb_save' && !row.isError) {
      state.saved = {
        value: row.value,
        path: row.value?.path ?? row.value?.current?.path ?? null,
        snapshot: row.value?.snapshot ?? null
      }
    }
    if (execution.name === 'nb_get' && !row.isError) {
      state.lastRead = {
        value: row.value,
        cells: getNotebookCellFacts(row.value)
      }
    }
    if (execution.name === 'swarm_delegate' && state.pendingRootDelegate !== null) {
      state.rootDelegations.push({
        label: state.pendingRootDelegate.label,
        result: row.value,
        isError: row.isError,
        text: row.text
      })
    }
  })

  ctx.on('subagent/end', info => {
    state.subagentEnds.push({
      id: info?.id ?? null,
      runId: info?.runId ?? null,
      stopReason: info?.stopReason ?? null,
      diagnostic: info?.diagnostic === undefined ? null : clip(info.diagnostic)
    })
  }, { prepend: true })

  const observeRuntime = () => {
    const runtimeHook = globalThis[NOTEBOOK_RUNTIME_KEY]
    if (runtimeHook === undefined || runtimeHook.version !== 1 || typeof runtimeHook.shutdownSession !== 'function') {
      throw new Error('Notebook runtime port is incomplete')
    }
    const originalShutdown = runtimeHook.shutdownSession.bind(runtimeHook)
    const originalGetState = runtimeHook.getState.bind(runtimeHook)
    const observedPort = Object.freeze({
      version: 1,
      getState: originalGetState,
      shutdownSession: async agentId => {
        const before = originalGetState(agentId)
        const result = await originalShutdown(agentId)
        const after = originalGetState(agentId)
        state.shutdownCalls ??= []
        state.shutdownCalls.push({
          agentId,
          before,
          after,
          result: result === undefined ? null : result,
          at: new Date().toISOString()
        })
        return result
      }
    })
    globalThis[NOTEBOOK_RUNTIME_KEY] = observedPort
    restoreNotebookRuntime = () => {
      if (globalThis[NOTEBOOK_RUNTIME_KEY] === observedPort) globalThis[NOTEBOOK_RUNTIME_KEY] = runtimeHook
    }
    return observedPort
  }

  const observeBoundary = () => {
    const carrier = globalThis[EXECUTION_BOUNDARY_KEY]
    if (carrier === undefined || typeof carrier.prepareSpawn !== 'function' || carrier.storage === undefined) return
    const originalPrepareSpawn = carrier.prepareSpawn
    carrier.prepareSpawn = spec => {
      const activeScope = carrier.storage.getStore()
      const observation = {
        at: new Date().toISOString(),
        phase,
        activeScope: activeScope === undefined ? null : {
          agentId: activeScope.agentId,
          taskId: activeScope.taskId ?? null,
          attemptId: activeScope.attemptId,
          mode: activeScope.mode,
          operation: activeScope.operation,
          cwd: activeScope.cwd
        },
        spec: {
          cwd: spec.cwd,
          argv: spec.argv,
          envKeys: Object.keys(spec.env ?? {}).sort()
        }
      }
      state.spawnObservations.push(observation)
      const ticket = originalPrepareSpawn.call(carrier, spec)
      if (ticket === undefined) return ticket
      return {
        ...ticket,
        assertContainment: mode => {
          observation.assertContainment = mode
          return ticket.assertContainment(mode)
        },
        started: processHandle => {
          observation.started = true
          return ticket.started(processHandle)
        }
      }
    }
    restoreBoundary = () => {
      if (carrier.prepareSpawn !== originalPrepareSpawn) carrier.prepareSpawn = originalPrepareSpawn
    }
  }

  const waitReady = async () => {
    await waitFor(async () => {
      try {
        await ctx.agentPresets.resolve('tian-shu')
        return ctx.get('agentSwarm') !== undefined
          && globalThis[NOTEBOOK_RUNTIME_KEY]?.version === 1
          && globalThis[NOTEBOOK_SNAPSHOT_RUNTIME_KEY]?.version === 1
      } catch {
        return false
      }
    }, 30_000, 100)
  }

  const rootComposition = async childCtx => {
    await ctx.agentPresets.mount(childCtx, 'tian-shu')
  }

  const createOrResumeRoot = async () => {
    presetScope = await ctx.agentPresets.acquireScope('tian-shu')
    if (phase === 'save') {
      handle = await ctx.agents.create({
        sessionId: `notebook-snapshot-root-${randomUUID()}`,
        meta: { cwd: workspace, agentPreset: 'tian-shu' },
        agentOptions: { provider: 'notebook-snapshot-host-mock', model: 'root' },
        setup: rootComposition
      })
    } else {
      handle = await ctx.agents.resume({
        resumeSessionId: initialMetadata.rootId,
        agentOptions: { provider: 'notebook-snapshot-host-mock', model: 'root' },
        setup: rootComposition
      })
    }
    root = handle.agent
    state.rootId = root.id
    service = ctx.get('agentSwarm')
    if (service === undefined) throw new Error('agentSwarm service unavailable')
    await service.WaitAgentReady(root)
  }

  const runRootDelegation = async (label, delegationArguments) => {
    const prompt = `Notebook snapshot ${label} ${randomUUID()}：继续当前任务，只读取恢复后的真实状态，不重放历史写操作。`
    state.pendingRootDelegate = { label, arguments: delegationArguments, sent: false }
    root.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' }
    })
    await root.whenIdle()
    state.rootTurns.push({ label, promptDigest: createHash('sha256').update(prompt).digest('hex'), at: new Date().toISOString() })
    const row = state.rootDelegations.findLast(item => item.label === label)
    state.pendingRootDelegate = null
    assert.ok(row, `root ${label} 未产生 swarm_delegate 结果`)
    assert.equal(row.isError, false, `root ${label} swarm_delegate failed: ${row.text}`)
    return row.result
  }

  const rootDraftProbe = async () => {
    root.followup({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: '只执行 Root Notebook 草稿探针：nb_new、nb_get、nb_run_cell、nb_save；不得委派其他专家。'
      }],
      source: { kind: 'user' }
    })
    await root.whenIdle()
    state.rootDraftCompleted = true
    const rootResults = state.toolResults.filter(row => row.agentId === root.id)
    const byName = Object.fromEntries(rootResults.map(row => [row.name, row]))
    const draftNew = byName.nb_new
    const draftGet = byName.nb_get
    const draftRun = byName.nb_run_cell
    const draftSave = byName.nb_save
    assert.ok(draftNew && draftGet && draftRun && draftSave, `Root Notebook tool sequence incomplete: ${JSON.stringify(rootResults)}`)
    state.rootDraft = {
      nbNew: { isError: draftNew.isError, value: draftNew.value, facts: getNotebookCellFacts(draftNew.value) },
      nbGet: { isError: draftGet.isError, value: draftGet.value, facts: getNotebookCellFacts(draftGet.value) },
      nbRun: { isError: draftRun.isError, text: draftRun.text },
      nbSave: { isError: draftSave.isError, text: draftSave.text },
      fileExists: existsSync(join(workspace, 'notebooks', 'root-draft.ipynb'))
    }
    assert.equal(state.rootDraft.nbNew.isError, false, `Root nb_new draft failed: ${draftNew.text}`)
    assert.equal(state.rootDraft.nbGet.isError, false, `Root nb_get draft failed: ${draftGet.text}`)
    assert.equal(state.rootDraft.nbRun.isError, true, 'Root nb_run_cell must be denied')
    assert.equal(state.rootDraft.nbSave.isError, true, 'Root nb_save must be denied')
    assert.equal(state.rootDraft.fileExists, false, 'Root nb_save wrote a file')
  }

  const runSavePhase = async () => {
    const exec = { agent: root, signal: new AbortController().signal }
    const task = await service.AddTaskCard({
      title: 'Notebook 跨重启数据快照',
      goal: '在唯一主工作树中通过真实 ToolRuntime 创建双 cell Notebook，保存实际 IPython 输出 42 与只读快照。',
      acceptance: ['notebooks/state.ipynb 已保存', '私有快照已登记', 'kernel 与 sidecar 停净'],
      scope: ['notebooks'],
      flags: {}
    }, exec)
    state.task = task
    const delegated = await service.delegate({
      task_id: task.task_id,
      role: 'zhu_jian',
      backend: 'api',
      session: 'new',
      request_id: 'notebook-snapshot-save-A',
      prompt: '先绑定唯一主工作树；创建双 cell Notebook：x = 40，随后真实 IPython 执行 print(x + 2)，必须输出 42；保存到 notebooks/state.ipynb。不得重放任何未知操作。'
    }, exec)
    state.delegation = {
      status: delegated.status,
      childId: delegated.childId ?? null,
      session: delegated.session ?? null,
      summary: delegated.summary,
      error: delegated.error ?? null,
      finalization: delegated.finalization ?? null
    }
    state.childSid = delegated.childId ?? delegated.session?.threadId ?? null
    assert.equal(delegated.status, 'completed', `save delegation ${delegated.status}: ${delegated.error ?? delegated.summary}`)
    assert.equal(typeof state.childSid, 'string')
    state.boundaryCapabilities = [...(globalThis[EXECUTION_BOUNDARY_CAPS_KEY] ?? [])]
    try {
      state.childReadContext = {
        value: await globalThis[NOTEBOOK_SNAPSHOT_RUNTIME_KEY].resolveReadContext(state.childSid)
      }
    } catch (error) {
      state.childReadContext = {
        error: {
          name: error?.name ?? null,
          code: error?.code ?? null,
          message: error?.message ?? String(error)
        }
      }
    }
    assert.deepEqual(
      state.toolCalls.filter(row => row.agentId === state.childSid).map(row => row.name),
      ['swarm_bind_primary_workspace', 'nb_new', 'nb_edit_and_run_cell', 'nb_add_cell', 'nb_run_cell', 'nb_save']
    )
    const saveToolErrors = state.toolErrors.filter(row => row.agentId === state.childSid)
    assert.deepEqual(saveToolErrors, [], `save tool errors: ${JSON.stringify(saveToolErrors)}; context=${JSON.stringify(state.childReadContext)}; caps=${JSON.stringify(state.boundaryCapabilities)}; markers=${JSON.stringify(state.markers)}`)
    assert.equal(state.firstExecutionStatus, 'ok')
    assert.equal(state.finalExecutionStatus, 'ok')
    const finalFacts = getNotebookCellFacts(state.finalSnapshot)
    assert.equal(finalFacts.cellCount, 2)
    assert.deepEqual(finalFacts.sources, ['x = 40', 'print(x + 2)'])
    assert.equal(String(state.finalStdout ?? '').trim(), '42')
    assert.equal(state.saved?.path, join(workspace, 'notebooks', 'state.ipynb'))
    assert.equal(state.saved?.snapshot?.saved, true)
    assert.equal(existsSync(state.saved.path), true)
    const marker = state.markers.findLast(row => row.sessionId === state.childSid && row.taskId === task.task_id)
    assert.ok(marker, `durable Notebook marker missing: ${JSON.stringify(state.markers)}`)
    assert.equal(marker.rootSessionId, root.id)
    const attemptA = marker.attemptId
    assert.equal(typeof attemptA, 'string')
    state.markersAfterSave = state.markers.filter(row => row.sessionId === state.childSid)
    const snapshotRuntime = globalThis[NOTEBOOK_SNAPSHOT_RUNTIME_KEY]
    const privateSnapshotPath = snapshotPathFor(snapshotRuntime.directory, state.childSid)
    assert.equal(existsSync(privateSnapshotPath), true)
    const persisted = readJson(privateSnapshotPath)
    assert.equal(persisted.record.task.id, task.task_id)
    assert.equal(persisted.record.task.agentId, state.childSid)
    assert.equal(persisted.record.task.attemptId, attemptA)
    assert.equal(persisted.record.view.mode, 'read-only')
    assert.equal(persisted.record.view.kernelAlive, false)
    const resolved = await snapshotRuntime.resolveReadContext(state.childSid)
    assert.equal(resolved.taskId, task.task_id)
    assert.equal(resolved.attemptId, attemptA)
    const notebookRuntime = globalThis[NOTEBOOK_RUNTIME_KEY]
    state.processCaptures.push({ stage: 'before-final-shutdown', processes: getKernelProcesses(), at: new Date().toISOString() })
    const shutdownResult = await notebookRuntime.shutdownSession(state.childSid)
    const runtimeState = notebookRuntime.getState(state.childSid)
    const certificates = [
      ...(Array.isArray(shutdownResult?.certificates) ? shutdownResult.certificates : []),
      ...(Array.isArray(runtimeState?.lastShutdown?.certificates) ? runtimeState.lastShutdown.certificates : [])
    ]
    const certificate = certificates.find(candidate => candidate?.stopped === true
      && candidate?.quiescent === true
      && candidate?.ownershipQuiescent === true)
    assert.ok(certificate, `kernel/sidecar quiescence certificate missing: ${JSON.stringify(runtimeState)}`)
    assert.equal(runtimeState?.compute ?? null, null)
    state.processCaptures.push({ stage: 'after-final-shutdown', processes: getKernelProcesses(), at: new Date().toISOString() })
    assert.equal(state.processCaptures.at(-1).processes.length, 0)
    const sessionApi = ctx.get('sessions')
    if (typeof sessionApi?.flush === 'function') {
      await sessionApi.flush(root.session)
      const childSession = sessionApi.get?.(state.childSid)
      if (childSession !== undefined) await sessionApi.flush(childSession)
    }
    writeDurable(metadataFile, {
      phase: 'phase1-saved',
      hostVersion: state.hostVersion,
      notebookVersion: state.notebookVersion,
      rootId: root.id,
      taskId: task.task_id,
      childSid: state.childSid,
      attemptA,
      marker,
      expectedHead,
      savedPath: state.saved.path,
      privateSnapshotPath,
      privateSnapshotDigest: persisted.digest,
      savedSnapshotReceipt: state.saved.snapshot,
      shutdownCertificate: certificate,
      runtimeState,
      processCaptures: state.processCaptures,
      createdAt: new Date().toISOString()
    })
    state.saved = {
      ...state.saved,
      privateSnapshotPath,
      privateSnapshotDigest: persisted.digest,
      attemptA,
      marker
    }
    try {
      await rootDraftProbe()
      state.rootDraft.passed = true
    } catch (error) {
      state.rootDraft = {
        ...(state.rootDraft ?? {}),
        passed: false,
        error: clip(error?.stack ?? error, 8000)
      }
      blockers.push({
        code: 'ROOT_NOTEBOOK_DRAFT_BOUNDARY',
        message: 'RootTian nb_new/nb_get 草稿未取得可信 routerDraft context',
        detail: getToolErrorText(state.toolResults.findLast?.(row => row.agentId === root.id && row.name === 'nb_new') ?? {})
      })
    }
    const attemptBSpawnStart = getNotebookSpawnObservations(state.spawnObservations).length
    const attemptBResultStart = state.toolResults.length
    state.sameHostAttemptB = true
    state.sameHostAttemptBReadRequested = false
    const attemptB = await runRootDelegation('same-host-attempt-B', {
      task_id: task.task_id,
      role: 'zhu_jian',
      backend: 'api',
      session: 'continue',
      request_id: 'notebook-snapshot-same-host-read-B',
      prompt: '同一 Host 的合法新 attemptB：只调用 nb_get 读取刚保存的纯数据快照，保留 originAttemptA，不启动 kernel，不执行、不编辑、不保存。'
    })
    const attemptBChild = attemptB.childId ?? attemptB.session?.threadId ?? null
    assert.equal(attemptB.status, 'completed', `same-host attemptB ${attemptB.status}: ${attemptB.error ?? attemptB.summary}`)
    assert.equal(attemptBChild, state.childSid, 'same-host continue 未追加原 child')
    assert.equal(attemptB.session?.appended, true, `same-host continue 未 append: ${JSON.stringify(attemptB.session)}`)
    const attemptBMarker = state.markers.findLast(row => row.sessionId === state.childSid
      && row.taskId === task.task_id
      && row.attemptId !== attemptA)
    assert.ok(attemptBMarker, `attemptB marker missing: ${JSON.stringify(state.markers)}`)
    const attemptBRead = state.toolResults
      .slice(attemptBResultStart)
      .findLast(row => row.agentId === state.childSid && row.name === 'nb_get')
    assert.ok(attemptBRead && !attemptBRead.isError, `attemptB nb_get failed: ${JSON.stringify(attemptBRead)}`)
    const attemptBFacts = getNotebookCellFacts(attemptBRead.value)
    assert.equal(attemptBFacts.cellCount, 2)
    assert.deepEqual(attemptBFacts.sources, ['x = 40', 'print(x + 2)'])
    assert.match(attemptBFacts.outputText, /(?:^|\n|\[)42(?:\n|\]|$)/)
    assert.equal(attemptBFacts.readOnly, true)
    assert.equal(attemptBFacts.kernelAlive, false)
    const attemptBSnapshot = getSnapshot(attemptBRead.value)
    const attemptBOrigin = attemptBSnapshot.snapshotProvenance?.originAttemptId ?? null
    const attemptBSpawns = getNotebookSpawnObservations(state.spawnObservations).slice(attemptBSpawnStart)
    assert.equal(attemptBSpawns.length, 0, `same-host attemptB spawned Notebook compute: ${JSON.stringify(attemptBSpawns)}`)
    const attemptBShutdown = await notebookRuntime.shutdownSession(state.childSid)
    state.sameHostAttemptB = {
      delegation: {
        status: attemptB.status,
        childId: attemptBChild,
        session: attemptB.session ?? null,
        attemptId: attemptBMarker.attemptId
      },
      read: {
        facts: attemptBFacts,
        originAttemptA: attemptBOrigin,
        persistedSnapshotAt: attemptBSnapshot.persistedSnapshotAt ?? null
      },
      notebookSpawnObservations: attemptBSpawns,
      shutdown: attemptBShutdown,
      passed: attemptBOrigin === attemptA
    }
    if (attemptBOrigin !== attemptA) {
      blockers.push({
        code: 'NOTEBOOK_SAME_HOST_ATTEMPT_PROVENANCE_LOST',
        message: 'Notebook .8 同一 Host 新 attempt 已读回纯数据，但 originAttemptA provenance 丢失',
        expectedOriginAttempt: attemptA,
        actualOriginAttempt: attemptBOrigin,
        persistedSnapshotAt: attemptBSnapshot.persistedSnapshotAt ?? null
      })
    }
    writeDurable(metadataFile, {
      ...readJson(metadataFile),
      sameHostAttemptB: state.sameHostAttemptB
    })
  }

  const announceAuthUrl = async () => {
    const connection = ctx.get('connection')
    const webServer = ctx.get('webServer')
    const origin = webServer?.getOrigin?.() ?? `http://127.0.0.1:${process.env.NOTEBOOK_SNAPSHOT_HOST_PORT}`
    if (typeof connection?.authenticatedUrl !== 'function') throw new Error('Host authenticatedUrl unavailable')
    const authUrl = connection.authenticatedUrl(`${origin}/`)
    if (typeof authUrl !== 'string' || authUrl === '') throw new Error('Host authenticated URL is empty')
    if (typeof process.send !== 'function') throw new Error('Host IPC unavailable for in-memory auth URL handoff')
    await new Promise((resolveSend, rejectSend) => {
      process.send({
        type: 'notebook-snapshot-auth-url',
        authUrl,
        origin,
        rootId: initialMetadata.rootId,
        taskId: initialMetadata.taskId,
        childSid: initialMetadata.childSid,
        attemptA: initialMetadata.attemptA
      }, error => error === null ? resolveSend() : rejectSend(error))
    })
    state.authAnnouncement = {
      sent: true,
      childSid: initialMetadata.childSid,
      taskId: initialMetadata.taskId,
      origin
    }
    await waitFor(() => existsSync(sentinelFile), 90_000, 100)
    const sentinel = readJson(sentinelFile)
    if (sentinel.ok !== true) throw new Error(`runner HTTP probe failed: ${String(sentinel.error ?? 'unknown')}`)
    const httpProbe = readJson(httpResultFile)
    validateHttpProbeResult(httpProbe)
    state.httpProbe = httpProbe
  }

  const runRestorePhase = async () => {
    assert.equal(existsSync(initialMetadata.privateSnapshotPath), true)
    state.processCaptures.push({ stage: 'before-http-probe', processes: getKernelProcesses(), at: new Date().toISOString() })
    await announceAuthUrl()
    state.processCaptures.push({ stage: 'after-http-probe', processes: getKernelProcesses(), at: new Date().toISOString() })
    assert.equal(state.processCaptures.at(-1).processes.length, 0, 'HTTP recovery spawned a kernel')
    assert.equal(state.spawnObservations.length, 0, 'HTTP recovery reached subprocess containment')

    await createOrResumeRoot()
    const exec = { agent: root, signal: new AbortController().signal }
    const restored = await runRootDelegation('restore-attempt-b', {
      task_id: initialMetadata.taskId,
      role: 'zhu_jian',
      backend: 'api',
      session: 'continue',
      request_id: 'notebook-snapshot-read-B',
      prompt: '同一任务的新 attempt：只调用 nb_get 读取历史纯数据，确认双 cell 与输出 42；禁止运行、编辑、保存，禁止启动 kernel，保留 originAttemptA。'
    })
    state.restore = {
      delegation: {
        status: restored.status,
        childId: restored.childId ?? null,
        session: restored.session ?? null,
        summary: restored.summary,
        error: restored.error ?? null
      },
      lastRead: state.lastRead ?? null,
      processCapture: getKernelProcesses()
    }
    assert.equal(restored.status, 'completed', `restore delegation ${restored.status}: ${restored.error ?? restored.summary}`)
    const coldChild = restored.childId ?? restored.session?.threadId ?? null
    assert.equal(typeof coldChild, 'string')
    const sameColdChild = coldChild === initialMetadata.childSid
    const restoreTools = state.toolCalls.filter(row => row.agentId === coldChild).map(row => row.name)
    assert.deepEqual(restoreTools, ['nb_get'])
    const restoredFacts = getNotebookCellFacts(state.lastRead?.value)
    assert.equal(restoredFacts.kernelAlive, false)
    const restoredSnapshot = getSnapshot(state.lastRead?.value)
    if (sameColdChild) {
      assert.equal(restoredFacts.readOnly, true)
      assert.equal(restoredFacts.cellCount, 2)
      assert.deepEqual(restoredFacts.sources, ['x = 40', 'print(x + 2)'])
      assert.match(restoredFacts.outputText, /(?:^|\n|\[)42(?:\n|\]|$)/)
      assert.equal(restoredSnapshot.snapshotProvenance?.originAttemptId, initialMetadata.attemptA)
    } else {
      assert.equal(restored.session?.appended, false, 'fresh cold child 不应声称 append 原会话')
      assert.equal(restoredFacts.readOnly, false)
      assert.equal(restoredFacts.cellCount, 1)
      assert.deepEqual(restoredFacts.sources, [''])
      assert.equal(restoredSnapshot.snapshotProvenance, null)
    }
    const latestMarker = state.markers.findLast(row => row.sessionId === coldChild && row.taskId === initialMetadata.taskId)
    assert.ok(latestMarker)
    assert.notEqual(latestMarker.attemptId, initialMetadata.attemptA)
    state.restore.attemptB = latestMarker.attemptId
    state.restore.originAttemptA = restoredSnapshot.snapshotProvenance?.originAttemptId ?? null
    state.restore.coldChild = coldChild
    state.restore.sameColdChild = sameColdChild
    state.restore.freshColdChildIsolation = !sameColdChild
    const restoreSpawns = getNotebookSpawnObservations(state.spawnObservations)
    state.restore.notebookSpawnObservations = restoreSpawns
    state.restore.zeroKernelSpawn = restoreSpawns.length === 0 && state.restore.processCapture.length === 0
    assert.equal(state.restore.zeroKernelSpawn, true)

    const task2 = await service.AddTaskCard({
      title: 'Notebook 跨任务隔离',
      goal: '在复用连续子会话时确保新任务不能读取旧任务快照。',
      acceptance: ['旧 T1 快照读取被拒绝', '不启动 kernel'],
      scope: ['notebooks'],
      flags: {}
    }, exec)
    state.crossTask = { taskId: task2.task_id, status: 'delegating' }
    crossTaskReadRequested = false
    const cross = await runRootDelegation('cross-task-T2', {
      task_id: task2.task_id,
      role: 'zhu_jian',
      backend: 'api',
      session: 'continue',
      request_id: 'notebook-snapshot-cross-task-T2',
      prompt: '这是新的 T2。只在同一连续子会话中调用 nb_get；旧 T1 快照必须因 task scope 不符而拒绝，不得读取正文或启动 kernel。'
    })
    state.crossTask.status = 'completed'
    state.crossTask.delegation = {
      status: cross.status,
      childId: cross.childId ?? null,
      session: cross.session ?? null,
      summary: cross.summary,
      error: cross.error ?? null
    }
    state.crossTask.toolResults = state.toolResults.filter(row => row.agentId === coldChild && row.name === 'nb_get').slice(-1)
    const crossRead = state.crossTask.toolResults.at(-1)
    assert.ok(crossRead, 'T2 nb_get result missing')
    assert.equal(crossRead.isError, true, `T2 read unexpectedly succeeded: ${crossRead.text}`)
    assert.match(crossRead.text, /task|任务|scope|快照|owner/i)
    const t2Marker = state.markers.findLast(row => row.sessionId === coldChild && row.taskId === task2.task_id)
    assert.ok(t2Marker, `T2 marker was not written to the shared child session: ${JSON.stringify(state.markers)}`)
    state.crossTask.marker = t2Marker
    state.crossTask.processCapture = getKernelProcesses()
    state.crossTask.notebookSpawnObservations = getNotebookSpawnObservations(state.spawnObservations)
    state.crossTask.zeroKernelSpawn = state.crossTask.notebookSpawnObservations.length === 0
      && state.crossTask.processCapture.length === 0
    assert.equal(state.crossTask.zeroKernelSpawn, true, 'T2 rejection spawned a kernel')
    await service.dispose()
    service = undefined
    await handle.dispose()
    handle = undefined
  }

  const run = async () => {
    await waitReady()
    observeRuntime()
    observeBoundary()
    if (phase === 'save') {
      await createOrResumeRoot()
      await runSavePhase()
      await service.dispose()
      service = undefined
      await handle.dispose()
      handle = undefined
    } else {
      await runRestorePhase()
    }
    state.finishedProcesses = getKernelProcesses()
    assert.equal(state.finishedProcesses.length, 0, 'owned Notebook processes remained before Host exit')
    if (blockers.length > 0) {
      state.blockers = blockers
      finish('blocked', new Error(blockers.map(blocker => `${blocker.code}: ${blocker.message}`).join('; ')))
    } else {
      finish('passed')
    }
  }

  setTimeout(() => {
    void run().catch(error => finish('failed', error))
  }, 300)
  setTimeout(() => finish('failed', new Error('Notebook snapshot Host driver timed out')), 240_000).unref()

  ctx.effect(() => () => {
    restoreNotebookRuntime()
    restoreBoundary()
  })
}
