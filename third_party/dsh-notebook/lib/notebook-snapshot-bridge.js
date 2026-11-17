const NOTEBOOK_SNAPSHOT_RUNTIME_KEY = Symbol.for("dsh-agent-swarm.notebook-snapshot.v1")

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)

export const getNotebookSnapshotRuntime = () => {
  const value = globalThis[NOTEBOOK_SNAPSHOT_RUNTIME_KEY]
  return isRecord(value) && value.version === 1 && typeof value.save === "function" && typeof value.load === "function"
    && (value.resolveReadContext === undefined || typeof value.resolveReadContext === "function")
    ? value
    : undefined
}

const cloneData = value => JSON.parse(JSON.stringify(value))

const contextError = (code, message) => Object.assign(new Error(message), { code })
const isTime = value => typeof value === "string" && Number.isFinite(Date.parse(value))

const requireContextText = (name, value) => {
  if (typeof value !== "string" || value.trim() === "") throw contextError("NOTEBOOK_CONTEXT_INVALID", `Notebook 可信 context 缺少 ${name}`)
  return value
}

const validateReadContext = (value, sessionId) => {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.sessionId !== sessionId
    || typeof value.managed !== "boolean"
    || !(value.taskId === null || typeof value.taskId === "string")
    || !(value.attemptId === null || typeof value.attemptId === "string")
    || !(value.rootSessionId === null || typeof value.rootSessionId === "string")
    || !(value.source === "swarm-marker" || value.source === "host-session")
    || !(value.routerDraft === undefined || value.routerDraft === true)) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook Host resolver 返回的 context 结构无效")
  }
  requireContextText("agentId", value.agentId)
  requireContextText("cwd", value.cwd)
  requireContextText("directoryIdentity", value.directoryIdentity)
  if (value.managed && (typeof value.taskId !== "string" || typeof value.attemptId !== "string")) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook managed context 缺少 task 或 attempt")
  }
  if (value.routerDraft === true
    && (value.managed !== false
      || value.source !== "host-session"
      || value.taskId !== null
      || value.attemptId !== null
      || value.rootSessionId !== null)) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook routerDraft context 与 Host session 身份不一致")
  }
  return value
}

export const assertNotebookReadContextMatches = (resolved, trustedScope) => {
  if (trustedScope === undefined) return resolved
  if (resolved.routerDraft === true) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook routerDraft 不能携带 Worker execution scope")
  }
  if (trustedScope.agentId !== resolved.agentId) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook resolver agent 与执行 scope 不一致")
  }
  if (trustedScope.taskId !== undefined && trustedScope.taskId !== resolved.taskId) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook resolver task 与执行 scope 不一致")
  }
  if (resolved.managed && trustedScope.taskId !== resolved.taskId) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook managed resolver 缺少当前任务 scope")
  }
  if (trustedScope.cwd !== resolved.cwd) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook resolver cwd 与执行 scope 不一致")
  }
  if (trustedScope.expectedDirectoryIdentity !== undefined
    && trustedScope.expectedDirectoryIdentity !== resolved.directoryIdentity) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook resolver 目录身份与执行 scope 不一致")
  }
  return resolved
}

export const resolveNotebookReadContext = async (sessionId, trustedScope, fallbackResolver, signal) => {
  const runtime = getNotebookSnapshotRuntime()
  const runtimeResolver = typeof runtime?.resolveReadContext === "function"
    ? runtime.resolveReadContext
    : undefined
  if (runtimeResolver === undefined && typeof fallbackResolver !== "function") {
    throw contextError("NOTEBOOK_CONTEXT_UNAVAILABLE", "Notebook Host context resolver 未安装")
  }
  const raw = runtimeResolver === undefined
    ? await fallbackResolver(sessionId, signal)
    : await runtimeResolver.call(runtime, sessionId, signal)
  const resolved = validateReadContext(raw, sessionId)
  return assertNotebookReadContextMatches(resolved, trustedScope)
}

export const isSameNotebookReadContext = (left, right) => left !== null && typeof left === "object"
  && left.schemaVersion === right.schemaVersion
  && left.sessionId === right.sessionId
  && left.managed === right.managed
  && left.taskId === right.taskId
  && left.agentId === right.agentId
  && left.attemptId === right.attemptId
  && left.rootSessionId === right.rootSessionId
  && left.cwd === right.cwd
  && left.directoryIdentity === right.directoryIdentity
  && left.routerDraft === right.routerDraft

export const adoptNotebookReadContext = (state, resolved, options) => {
  if (isSameNotebookReadContext(state.readContext, resolved)) return state
  if (state.readContext !== null && state.readContext !== undefined) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook 缓存属于其他任务或项目；请显式新建或打开")
  }
  if (options?.initialize !== true) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook 缓存缺少可信任务/项目身份")
  }
  state.readContext = cloneData(resolved)
  return state
}

export const resetNotebookReadContext = (state, resolved) => {
  state.readContext = cloneData(resolved)
  state.readOnlySnapshot = false
  state.persistedSnapshotAt = null
  state.snapshotProvenance = null
  state.snapshotOriginState = "not-saved"
  return state
}

export const switchReadOnlyNotebookContext = (state, resolved) => {
  state.readContext = cloneData(resolved)
  state.inactive = true
  state.readOnlySnapshot = true
  return state
}

const emptyKernel = () => ({
  alive: false,
  language: null,
  interpreter: null,
  driverPython: null,
  entry: null,
  name: null,
  id: null,
  starting: false,
  stopState: null,
})

export const applyPersistedNotebook = (state, snapshot, readContext) => {
  if (!snapshot || snapshot.view?.mode !== "read-only" || snapshot.view.kernelAlive !== false) {
    throw new Error("Notebook 持久快照未标记为只读数据视图")
  }
  state.managed = snapshot.task.managed === true
  state.inactive = true
  state.readOnlySnapshot = true
  state.persistedSnapshotAt = snapshot.recordedAt
  state.snapshotProvenance = {
    mode: "read-only-snapshot",
    originTaskId: snapshot.task.id,
    originAgentId: snapshot.task.agentId,
    originAttemptId: snapshot.task.attemptId,
    savedAt: snapshot.savedAt,
    recordedAt: snapshot.recordedAt,
  }
  state.snapshotOriginState = "saved-clean"
  state.notebook = {
    cells: snapshot.notebook.cells.map(cell => {
      const outputs = Array.isArray(cell.outputs) ? cell.outputs : []
      return {
        ...cloneData(cell),
        status: outputs.some(output => output?.type === "error" || output?.output_type === "error" || output?.error)
          ? "error"
          : cell.execution_count ? "ok" : "idle",
        queuedAt: null,
        startedAt: null,
      }
    }),
    metadata: cloneData(snapshot.notebook.metadata || {}),
    nbformat: snapshot.notebook.nbformat,
    nbformat_minor: snapshot.notebook.nbformat_minor,
    path: snapshot.savedPath,
    dirty: false,
  }
  state.cellExtras = Object.assign(Object.create(null), cloneData(snapshot.cellExtras || {}))
  state.kernel = emptyKernel()
  state.cwd = snapshot.project.cwd
  state.cwdSource = "snapshot"
  state.workspaceRoot = snapshot.project.cwd
  state.savedAt = Date.parse(snapshot.savedAt)
  state.lastShutdown = null
  state.readContext = cloneData(readContext)
  return state
}

export const activateFromSnapshot = state => {
  state.inactive = false
  state.readOnlySnapshot = false
  state.persistedSnapshotAt = null
  state.snapshotProvenance = null
  state.snapshotOriginState = "not-saved"
}

export const markNotebookSnapshotSaved = (state, producer, receipt) => {
  if (receipt?.saved !== true || !isTime(receipt.savedAt) || !isTime(receipt.recordedAt)) {
    state.persistedSnapshotAt = null
    state.snapshotProvenance = null
    state.snapshotOriginState = "not-saved"
    return false
  }
  state.persistedSnapshotAt = receipt.recordedAt
  state.snapshotProvenance = {
    mode: "read-only-snapshot",
    originTaskId: producer?.taskId ?? null,
    originAgentId: producer?.agentId ?? null,
    originAttemptId: producer?.attemptId ?? null,
    savedAt: receipt.savedAt,
    recordedAt: receipt.recordedAt,
  }
  state.snapshotOriginState = "saved-clean"
  return true
}

export const invalidateNotebookSnapshot = (state, snapshotOriginState = "not-saved") => {
  state.persistedSnapshotAt = null
  state.snapshotProvenance = null
  state.snapshotOriginState = snapshotOriginState
}

export const persistNotebookSnapshot = async ({ sessionId, state, scope, savedPath, managed }) => {
  const runtime = getNotebookSnapshotRuntime()
  if (runtime === undefined) {
    return managed
      ? {
          saved: false,
          code: "NOTEBOOK_SNAPSHOT_UNAVAILABLE",
          error: "跨重启只读快照端口未安装；.ipynb 文件已保存",
        }
      : {
          saved: false,
          code: "NOTEBOOK_SNAPSHOT_OPTIONAL_UNAVAILABLE",
          error: "当前标准会话未安装持久快照端口；.ipynb 文件已保存",
        }
  }
  const cells = state.notebook.cells.map(cell => {
    const copy = { ...cell }
    delete copy._runJob
    return copy
  })
  try {
    const receipt = await runtime.save({
      sessionId,
      savedAt: new Date(state.savedAt || Date.now()).toISOString(),
      savedPath,
      notebook: {
        cells,
        metadata: state.notebook.metadata || {},
        nbformat: state.notebook.nbformat || 4,
        nbformat_minor: state.notebook.nbformat_minor || 5,
      },
      cellExtras: state.cellExtras || {},
      task: {
        id: scope?.taskId || null,
        agentId: scope?.agentId || null,
        attemptId: scope?.attemptId || null,
        managed: managed === true,
      },
      project: {
        cwd: scope?.cwd || state.cwd,
        repositoryRoot: scope?.repositoryRoot || state.workspaceRoot || state.cwd,
        directoryIdentity: scope?.expectedDirectoryIdentity || null,
      },
      boundary: scope
        ? {
            mode: scope.mode,
            operation: scope.operation,
            writeScopes: [...(scope.writeScopes || [])],
          }
        : null,
    })
    return {
      ...receipt,
      readOnlyRestore: true,
    }
  } catch (error) {
    return {
      saved: false,
      code: error?.code || "NOTEBOOK_SNAPSHOT_SAVE_FAILED",
      error: "显式 .ipynb 已保存，但跨重启只读快照写入失败",
    }
  }
}
