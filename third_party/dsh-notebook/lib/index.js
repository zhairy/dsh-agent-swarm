// Host half of dsh-notebook. Spawns python/kernel_driver.py as a persistent
// jupyter_client sidecar and registers nb_* tools + /nb/* HTTP routes.
// Per-session isolation: each DSH session owns its own kernel, cells, and cwd,
// keyed by sessionId (from the agent tool exec context or the HTTP _sid field).

import { defineTool } from "@deepseek-ai/dsh-tools"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { dirname, join, basename, extname, delimiter, resolve as pathResolve } from "node:path"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir, platform, cpus } from "node:os"
import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import {
  assertNotebookPath,
  assertNotebookToolScope,
  buildNotebookSandboxPlan,
  getNotebookBoundaryCarrier,
  getNotebookBoundaryScope,
  getNotebookComputeScopeKey,
  getNotebookExecutionTimeout,
  getNotebookKernelLifecycle,
  getNotebookToolClass,
  requiresNotebookSidecar,
  spawnNotebookRuntime,
  stopNotebookRuntime,
} from "./notebook-runtime.js"
import {
  activateFromSnapshot,
  adoptNotebookReadContext,
  applyPersistedNotebook,
  assertNotebookReadContextMatches,
  getNotebookSnapshotRuntime,
  invalidateNotebookSnapshot,
  isSameNotebookReadContext,
  markNotebookSnapshotSaved,
  persistNotebookSnapshot,
  resetNotebookReadContext,
  resolveNotebookReadContext,
  switchReadOnlyNotebookContext,
} from "./notebook-snapshot-bridge.js"
import { createNotebookHostContextResolver } from "./notebook-host-context.js"

const execFileP = promisify(execFile)

// Agent-facing envelope caps: the full outputs stay bounded in the driver
// (per-stream MAX_STREAM_CHARS in kernel_driver.py); this is the summary cut
// shown to the agent by default so long outputs cannot blow up context.
const ENVELOPE_STREAM_CAP = 6000
const MAX_EXECUTIONS_PER_CELL = 50

export const name = "dsh-notebook"
export const inject = ["tools", "webServer", "connection", "subprocess", "sandboxPolicy"]

const HERE = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(HERE, "..", "python", "kernel_driver.py")
const DOMPURIFY_MODULE_PATH = "/plugins/@beihaizb/dsh-notebook/vendor/dompurify.es.mjs"
const DOMPURIFY_MODULE_FILE = join(HERE, "vendor", "dompurify.es.mjs")
// Controller config is trusted deployment state, never model/tool payload.
// The stable default is provisioned by the Host; legacy env names keep the
// existing private candidate evidence compatible without becoming production defaults.
const CONTROLLER_RUNTIME_RELEASE = "notebook-py-8.10.0-7.4.0"
const trustedControllerPrefix = process.env.DSH_NOTEBOOK_CONTROLLER_RUNTIME_PREFIX
  || process.env.DSH_NOTEBOOK_PRIVATE_RUNTIME_PREFIX
  || undefined
const trustedControllerPython = process.env.DSH_NOTEBOOK_CONTROLLER_PYTHON
  || process.env.DSH_NOTEBOOK_PRIVATE_PYTHON
  || undefined
export const PRIVATE_RUNTIME_PREFIX = trustedControllerPrefix
  || (trustedControllerPython ? dirname(dirname(trustedControllerPython)) : join(process.env.DSH_HOME || join(homedir(), ".dsh"), "runtimes", CONTROLLER_RUNTIME_RELEASE))
export const PRIVATE_PYTHON = trustedControllerPython || join(PRIVATE_RUNTIME_PREFIX, "bin", "python")
export const NOTEBOOK_CONTROLLER_RUNTIME_PREFIX = PRIVATE_RUNTIME_PREFIX
export const NOTEBOOK_CONTROLLER_PYTHON = PRIVATE_PYTHON
const NOTEBOOK_RUNTIME_KEY = Symbol.for("dsh-agent-swarm.notebook-runtime.v1")
const MANAGED_AGENTS_KEY = Symbol.for("dsh-agent-swarm/managed-agents")
const ROOT_NOTEBOOK_TOOLS = new Set([
  "nb_new", "nb_add_cell", "nb_delete_cell", "nb_move_cell", "nb_edit_cell",
  "nb_apply_suggestion", "nb_clear_outputs", "nb_get", "nb_cell_history", "nb_revert_cell",
])
const READ_ONLY_SNAPSHOT_TOOLS = new Set([
  "nb_get", "nb_list", "nb_context", "nb_cell_history", "nb_error_context", "nb_kernel_list",
  "nb_new", "nb_open",
])
const READ_CONTEXT_RECHECK_TOOLS = new Set([
  "nb_get", "nb_list", "nb_context", "nb_cell_history", "nb_error_context", "nb_kernel_list",
])
const READ_CONTEXT_RECHECK_ROUTES = new Set([
  "get", "list", "kernelStatus", "syncSessionCwd", "cellHistory", "kernelList", "cpuInfo",
])

const isManagedAgent = agent => {
  try {
    return globalThis[MANAGED_AGENTS_KEY]?.isManaged(agent) === true
  } catch {
    return false
  }
}
// 可见性不读可能过期的 agentPreset。实际 Root/Worker 权限由可信 resolver
// 与 DSH execution boundary 在调用时决定，避免模式切换后工具面失真。
const isNotebookToolVisible = () => true
const samePath = (left, right) => pathResolve(left) === pathResolve(right)

/** Upper bound for /nb request bodies; larger requests are rejected and the
 * connection destroyed, so a runaway or hostile request cannot allocate
 * without limit. */
const MAX_BODY_BYTES = 32 * 1024 * 1024

function nowIso() {
  return new Date().toISOString()
}

function newId(prefix) {
  return prefix + "-" + Math.random().toString(36).slice(2, 10)
}

function sha256(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex")
}

function outputSummary(outputs) {
  const summary = { streams: 0, streamChars: 0, images: 0, display: 0, executeResults: 0, errors: 0 }
  for (const out of outputs || []) {
    if (!out) continue
    const typ = out.type || out.output_type
    if (typ === "stream") {
      summary.streams += 1
      summary.streamChars += String(out.text || "").length
    } else if (typ === "display_data" || typ === "execute_result") {
      if (typ === "display_data") summary.display += 1
      else summary.executeResults += 1
      const data = out.data || {}
      if (data["image/png"] || data["image/jpeg"] || data["image/gif"] || data["image/webp"] || data["image/svg+xml"]) summary.images += 1
    } else if (typ === "error" || out.error) {
      summary.errors += 1
    }
  }
  return summary
}

function lastErrorFromCell(cell) {
  for (let i = (cell.outputs || []).length - 1; i >= 0; i--) {
    const out = cell.outputs[i]
    if (out && (out.type === "error" || out.error)) return out.error || out
  }
  return null
}

function sourcePreview(source, maxLen = 220) {
  const text = String(source || "").replace(/\s+/g, " ").trim()
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text
}

function emptyNotebook(title) {
  return {
    cells: [
      {
        id: newId("cell"),
        cell_type: "code",
        source: "",
        outputs: [],
        metadata: { dsh: { suggestions: [], versions: [] } },
        execution_count: null,
        status: "idle",
      },
    ],
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
      dsh: { title: title || "untitled", createdAt: nowIso() },
    },
    nbformat: 4,
    nbformat_minor: 5,
    path: null,
    dirty: true,
  }
}

function ensureDshMeta(cell) {
  cell.metadata = cell.metadata || {}
  cell.metadata.dsh = cell.metadata.dsh || { suggestions: [], versions: [] }
  cell.metadata.dsh.suggestions = cell.metadata.dsh.suggestions || []
  cell.metadata.dsh.versions = cell.metadata.dsh.versions || []
  return cell
}

// --- Hybrid (big.LITTLE / P+E core) CPU detection, Windows only -------------
// The advice this feeds is per-process CPU affinity, which is an OS-level
// operation: Windows has it (ProcessorAffinity), macOS has no such API at all,
// and on Linux the only topology signal readable without extra tooling is
// unreliable. So the whole feature is Windows-scoped rather than shipping advice
// that cannot be acted on.
//
// Detection reads each physical core's EfficiencyClass via
// GetLogicalProcessorInformationEx - a physical topology fact, not a CPU-name
// whitelist - so new hybrid parts are recognized and homogeneous ones are not
// flagged. Read-only and best-effort: any failure means the UI stays silent.
//
// It also returns the P-core affinity mask, so the advice can name the exact
// number instead of making the user compute it.

const PY_CPU_PROBE = `
import json, platform
def detect():
    if platform.system() != 'Windows':
        return {'detected': False, 'platform': platform.system()}
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.windll.kernel32
        RELATION_PROCESSOR_CORE = 0
        size = wintypes.DWORD(0)
        k32.GetLogicalProcessorInformationEx(RELATION_PROCESSOR_CORE, None, ctypes.byref(size))
        if size.value <= 0:
            return {'detected': False, 'error': 'no topology'}
        buf = ctypes.create_string_buffer(size.value)
        if not k32.GetLogicalProcessorInformationEx(RELATION_PROCESSOR_CORE, buf, ctypes.byref(size)):
            return {'detected': False, 'error': 'topology query failed'}
        data = buf.raw
        cores, off = [], 0
        while off + 8 <= len(data):
            rel = int.from_bytes(data[off:off+4], 'little')
            rec = int.from_bytes(data[off+4:off+8], 'little')
            if rec <= 0:
                break
            if rel == RELATION_PROCESSOR_CORE and off + 40 <= len(data):
                eff = data[off + 9]                                  # EfficiencyClass
                mask = int.from_bytes(data[off + 32:off + 40], 'little')  # GroupMask[0].Mask
                cores.append((eff, mask))
            off += rec
        if not cores:
            return {'detected': False, 'error': 'no core records'}
        classes = sorted(e for e, _ in cores)
        highest = max(classes)
        p_mask = 0
        logical = 0
        for eff, mask in cores:
            logical |= mask
            if eff == highest:
                p_mask |= mask
        return {
            'detected': True,
            'hybrid': len(set(classes)) >= 2,
            'classes': sorted(set(classes)),
            'p_mask': p_mask,
            'logical': bin(logical).count('1'),
            # A single processor group holds at most 64 logical CPUs, so on a
            # bigger machine this mask cannot describe every core.
            'single_group': bin(logical).count('1') <= 64,
            'source': 'windows-efficiency-class',
        }
    except Exception as e:
        return {'detected': False, 'error': str(e)}
print(json.dumps(detect()))
`

async function detectHybridCpu(pythonPath) {
  // Windows only: see the block comment above.
  if (platform() !== "win32" || !pythonPath) return null
  try {
    const { stdout } = await execFileP(pythonPath, ["-c", PY_CPU_PROBE], { timeout: 15000, windowsHide: true })
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ""
    const parsed = JSON.parse(line)
    if (parsed && parsed.detected) {
      return { hybrid: !!parsed.hybrid, source: parsed.source || "unknown", detail: parsed }
    }
  } catch {
    /* detection is best-effort; failure => no modal */
  }
  return null
}

export function apply(ctx) {
  const tools = ctx.tools
  const webServer = ctx.webServer
  const connection = ctx.connection
  if (!tools) return

  const initialWorkspaceRoot = (ctx.get("sandboxPolicy") && ctx.get("sandboxPolicy").workspaceRoot) || process.cwd()
  const resolveFallbackNotebookContext = createNotebookHostContextResolver(ctx)

  // ---- per-session state registry ----
  const sessions = new Map()
  const shutdownTombstones = new Map()
  const MAX_SHUTDOWN_TOMBSTONES = 256
  // emitDisposed unloads a Host session; it does not delete the user's cells.
  // Retain only JSON data, never promises/handles/kernels, with a strict LRU budget.
  const retainedNotebooks = new Map()
  const MAX_RETAINED_NOTEBOOKS = 64
  const MAX_RETAINED_NOTEBOOK_BYTES = 16 * 1024 * 1024
  let retainedNotebookBytes = 0
  function forgetRetainedNotebook(sessionId) {
    const old = retainedNotebooks.get(sessionId)
    if (old) retainedNotebookBytes -= old.bytes
    retainedNotebooks.delete(sessionId)
  }
  function readRetainedNotebook(sessionId) {
    const entry = retainedNotebooks.get(sessionId)
    if (!entry) return undefined
    retainedNotebooks.delete(sessionId)
    retainedNotebooks.set(sessionId, entry)
    return JSON.parse(entry.json)
  }
  function rememberNotebook(st) {
    const json = JSON.stringify({
      managed: st.managed, inactive: true,
      notebook: st.notebook, cellExtras: st.cellExtras,
      kernel: { ...st.kernel, alive: false, starting: false },
      cwd: st.cwd, cwdSource: st.cwdSource, workspaceRoot: st.workspaceRoot,
      savedAt: st.savedAt, lastShutdown: st.lastShutdown,
      readOnlySnapshot: st.readOnlySnapshot, persistedSnapshotAt: st.persistedSnapshotAt,
      snapshotProvenance: st.snapshotProvenance,
      snapshotOriginState: st.snapshotOriginState,
      readContext: st.readContext,
    }, (key, value) => key === "_runJob" ? undefined : value)
    const bytes = Buffer.byteLength(json, "utf8")
    forgetRetainedNotebook(st.sessionId)
    if (bytes > MAX_RETAINED_NOTEBOOK_BYTES) return
    retainedNotebooks.set(st.sessionId, { json, bytes })
    retainedNotebookBytes += bytes
    while (retainedNotebooks.size > MAX_RETAINED_NOTEBOOKS || retainedNotebookBytes > MAX_RETAINED_NOTEBOOK_BYTES) {
      forgetRetainedNotebook(retainedNotebooks.keys().next().value)
    }
  }
  function rememberShutdown(sessionId, managed, lastShutdown) {
    if (!lastShutdown) return
    shutdownTombstones.delete(sessionId)
    shutdownTombstones.set(sessionId, {
      managed: managed === true,
      lastShutdown,
    })
    while (shutdownTombstones.size > MAX_SHUTDOWN_TOMBSTONES) {
      shutdownTombstones.delete(shutdownTombstones.keys().next().value)
    }
  }
  /**
   * One session's notebook state.
   * @param {string} sessionId - owning session.
   * @param {string} [cwdHint] - the session's real cwd (SessionHeader.cwd).
   *   `initialWorkspaceRoot` is read once at plugin activation, so a session
   *   created later - or after a `dsh web` restart - would otherwise start in a
   *   stale `process.cwd()` and immediately "sync" to the real one on the first
   *   view mount, which used to kill the kernel.
   */
  function createState(sessionId, cwdHint) {
    let root = initialWorkspaceRoot
    if (typeof cwdHint === "string" && cwdHint.trim() !== "") {
      try {
        const abs = pathResolve(cwdHint)
        if (existsSync(abs) && statSync(abs).isDirectory()) root = abs
      } catch {
        /* keep the activation-time root */
      }
    }
    return {
      sessionId: sessionId,
      managed: null,
      inactive: false,
      readOnlySnapshot: false,
      persistedSnapshotAt: null,
      snapshotProvenance: null,
      snapshotOriginState: "not-saved",
      readContext: null,
      notebook: emptyNotebook("untitled"),
      sidecar: null,
      fileSidecar: null,
      kernel: {
        alive: false,
        language: null,
        interpreter: null,
        driverPython: null,
        entry: null,
        name: null,
        id: null,
        starting: false,
        stopState: null,
      },
      workspaceRoot: root,
      cwd: root,
      cwdSource: "default",
      execQueue: Promise.resolve(),
      probeActive: false,
      probeDone: null,
      runGen: 0,
      savedAt: null,
      autosaveTimer: null,
      lastShutdown: null,
      // Cell fields this plugin does not model (markdown `attachments`, vendor
      // extensions), keyed by cell id. Kept out of the cell objects so they
      // never travel to the browser in every snapshot, and merged back only
      // when the notebook is written.
      cellExtras: Object.create(null),
    }
  }
  function getSession(sessionId, cwdHint) {
    sessionId = sessionId || "default"
    if (!sessions.has(sessionId)) {
      const retained = readRetainedNotebook(sessionId)
      const st = Object.assign(createState(sessionId, cwdHint), retained)
      if (!retained && shutdownTombstones.get(sessionId)?.managed === true) st.managed = true
      forgetRetainedNotebook(sessionId)
      sessions.set(sessionId, st)
    }
    return sessions.get(sessionId)
  }
  const persistedLoads = new Map()
  /**
   * Load a data-only snapshot only when no live in-memory session can answer.
   * This path never creates a kernel, sidecar, or file handle.
   */
  async function loadPersistedSession(sessionId, cwdHint, readContext) {
    if (!readContext || typeof readContext !== "object") {
      throw new Error("Notebook 持久快照读取缺少可信 Host context")
    }
    sessionId = sessionId || "default"
    if (sessions.has(sessionId)) return sessions.get(sessionId)
    if (retainedNotebooks.has(sessionId) || shutdownTombstones.has(sessionId)) return undefined
    const runtime = getNotebookSnapshotRuntime()
    if (!runtime) return undefined
    if (persistedLoads.has(sessionId)) return persistedLoads.get(sessionId)
    const pending = (async () => {
      const snapshot = await runtime.load(sessionId, readContext)
      if (!snapshot) return undefined
      const st = createState(sessionId, cwdHint)
      applyPersistedNotebook(st, snapshot, readContext)
      st.managed = readContext.managed === true
      sessions.set(sessionId, st)
      return st
    })()
    persistedLoads.set(sessionId, pending)
    try {
      return await pending
    } finally {
      if (persistedLoads.get(sessionId) === pending) persistedLoads.delete(sessionId)
    }
  }
  async function stopForContextReset(st) {
    if (!st) return
    if (st.sidecar || st.fileSidecar) await stopSessionSidecar(st, "all")
    st.kernel = {
      alive: false,
      language: null,
      interpreter: null,
      driverPython: null,
      entry: null,
      name: null,
      id: null,
      starting: false,
      stopState: null,
    }
  }
  function hasConfirmedStoppedReadOnlyData(st) {
    const sidecars = [st.sidecar, st.fileSidecar]
    const stoppedSidecars = sidecars.every(sc => sc === null || sc === undefined
      || (sc.exited === true && !sc.stopping))
    const stoppedKernel = !st.kernel.alive && !st.kernel.starting && st.kernel.stopState !== "unknown"
    return stoppedSidecars && stoppedKernel
      && (st.readOnlySnapshot === true || (st.inactive === true && st.lastShutdown !== null))
  }
  function isSameReadOnlyDataOwner(st, next) {
    const prior = st.readContext
    if (!prior || !hasConfirmedStoppedReadOnlyData(st)) return false
    if (next.sessionId !== prior.sessionId
      || next.agentId !== prior.agentId
      || next.cwd !== prior.cwd
      || next.directoryIdentity !== prior.directoryIdentity) return false
    const provenance = st.snapshotProvenance
    if (prior.managed === true || provenance !== null && provenance !== undefined) {
      const taskId = provenance?.originTaskId || prior.taskId
      const agentId = provenance?.originAgentId || prior.agentId
      return next.managed === true
        && next.taskId === taskId
        && next.agentId === agentId
        && next.rootSessionId === prior.rootSessionId
    }
    return next.managed !== true
  }
  async function prepareNotebookContext(st, readContext, options) {
    if (readContext === undefined) return st
    if (isSameNotebookReadContext(st.readContext, readContext)) return st
    if (options && options.allowReset === true) {
      await stopForContextReset(st)
      resetNotebookReadContext(st, readContext)
      st.managed = readContext.managed === true
      st.cwd = readContext.cwd
      st.workspaceRoot = readContext.cwd
      st.cwdSource = "session"
      return st
    }
    if (isSameReadOnlyDataOwner(st, readContext)) {
      await stopForContextReset(st)
      switchReadOnlyNotebookContext(st, readContext)
      st.managed = readContext.managed === true
      st.cwd = readContext.cwd
      st.workspaceRoot = readContext.cwd
      st.cwdSource = "session"
      return st
    }
    adoptNotebookReadContext(st, readContext, { initialize: options && options.initialize === true })
    return st
  }
  async function assertNotebookContextCurrent(sessionId, scope, expected, signal) {
    if (expected === undefined) return
    const current = await resolveNotebookReadContext(sessionId, scope, resolveFallbackNotebookContext, signal)
    if (!isSameNotebookReadContext(current, expected)) {
      throw Object.assign(new Error("Notebook Host task/project context 在读取期间发生变化"), {
        code: "NOTEBOOK_CONTEXT_STALE",
      })
    }
  }
  function stopOneSidecar(st, slot) {
    if (!st || !st[slot]) return Promise.resolve(undefined)
    const sc = st[slot]
    if (sc.stopping) return sc.stopping
    sc.stopping = (async () => {
      try {
        sc.child.stdin?.write(JSON.stringify({ id: "bye", cmd: "stop" }) + "\n")
      } catch {
        /* termination below remains authoritative */
      }
      const certificate = await stopNotebookRuntime(sc.runtime, { carrier: getNotebookBoundaryCarrier(), timeoutMs: 15000 })
      if (!certificate.stopped) {
        if (slot === "sidecar") st.kernel.stopState = "unknown"
        throw new Error("Notebook sidecar 未取得真实 exit/停净证明：" + (certificate.error || "unknown"))
      }
      if (st[slot] === sc) st[slot] = null
      if (slot === "sidecar") {
        st.kernel.alive = false
        st.kernel.stopState = "stopped"
      }
      return certificate
    })().catch((error) => {
      sc.stopping = null
      throw error
    })
    return sc.stopping
  }
  async function stopSessionSidecar(st, slot = "all") {
    if (slot !== "all") return stopOneSidecar(st, slot)
    const results = await Promise.allSettled([stopOneSidecar(st, "sidecar"), stopOneSidecar(st, "fileSidecar")])
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason)
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Notebook sidecars 未能全部停净")
    return results.map(result => result.status === "fulfilled" ? result.value : undefined)
  }
  function killSessionSidecar(st) {
    return stopSessionSidecar(st, "all")
  }
  function activeKernelsAll() {
    const out = []
    for (const [sid, st] of sessions) {
      if (st.kernel && (st.kernel.alive || st.kernel.starting)) {
        out.push({
          sessionId: sid,
          name: st.kernel.name || null,
          alive: !!st.kernel.alive,
          starting: !!st.kernel.starting,
          interpreter: st.kernel.interpreter || null,
        })
      }
    }
    return { kernels: out, total: out.length }
  }
  function activeKernelsFor(sessionId) {
    const all = activeKernelsAll()
    const kernels = all.kernels.filter(kernel => kernel.sessionId === sessionId)
    return { kernels, total: kernels.length }
  }

  // ---- kernel discovery (session-independent catalog, session-aware default) ----
  // envsel keeps its per-session choices in a machine-local JSON store. The
  // authoritative fact is DSH_ENV_PYTHON, but that exists only inside a shell
  // call's own environment: the harness resolves shell facts per execution and
  // never writes them into this process, so reading process.env here can never
  // see a selection and the store is the only thing available at spawn time.
  const ENVSEL_STATE_VERSION = 1
  const ENVSEL_STATE_TTL_MS = 2000
  const ENVSEL_MAX_HOPS = 8
  let envselCache = null
  /** Session id -> the session it was delegated from, as observed on tool calls. */
  const sessionParents = new Map()

  /** Absolute path of envsel's selection store under the DSH home. */
  function envselStatePath() {
    const home = process.env.DSH_HOME || join(homedir(), ".dsh")
    return join(home, "envsel-state.json")
  }

  /**
   * Read envsel's selection store, memoized briefly so status polling does not
   * touch the disk on every snapshot. A missing, unreadable, or foreign-version
   * document reads as null: this plugin must never guess at a schema it does
   * not own.
   */
  function envselSelections() {
    const now = Date.now()
    if (envselCache && now - envselCache.at < ENVSEL_STATE_TTL_MS) return envselCache.selections
    let selections = null
    try {
      const doc = JSON.parse(readFileSync(envselStatePath(), "utf8"))
      if (doc && doc.version === ENVSEL_STATE_VERSION && doc.selections && typeof doc.selections === "object") {
        selections = doc.selections
      }
    } catch {
      /* envsel state is optional */
    }
    envselCache = { at: now, selections }
    return selections
  }

  /** The python invocation of one stored selection, when it is usable. */
  function envselPythonOf(selection) {
    const py = selection && selection.python
    const cmd = py && (py.pythonCommand || py.python)
    return cmd && existsSync(cmd) ? cmd : null
  }

  /**
   * The python the addressed session should run, resolved the way envsel
   * resolves it: the session's own choice first, then the nearest choice owned
   * by a session it descends from. A delegated subagent runs in its own session
   * and normally has no choice of its own, so without the walk its notebook
   * silently landed in whichever environment happened to be stored last.
   * @param {string} sessionId - the session whose notebook is resolving an interpreter.
   * @returns {string|null} an absolute python path, or null when nothing applies.
   */
  function envselPython(sessionId) {
    if (process.env.DSH_ENV_PYTHON && existsSync(process.env.DSH_ENV_PYTHON)) {
      return process.env.DSH_ENV_PYTHON
    }
    const selections = envselSelections()
    if (selections === null) return null
    const seen = new Set()
    let cursor = sessionId
    for (let hops = 0; cursor && hops <= ENVSEL_MAX_HOPS; hops++) {
      const key = String(cursor)
      if (seen.has(key)) break
      seen.add(key)
      const found = envselPythonOf(selections[key])
      if (found) return found
      cursor = sessionParents.get(key) || null
    }
    return null
  }

  function pythonFromPrefix(prefix) {
    const cands = [
      join(prefix, "python.exe"),
      join(prefix, "Scripts", "python.exe"),
      join(prefix, "bin", "python.exe"),
      join(prefix, "bin", "python"),
      join(prefix, "bin", "python3"),
    ]
    for (const c of cands) if (existsSync(c)) return c
    return null
  }

  function sitePackagesDirs(prefix) {
    const dirs = [
      join(prefix, "Lib", "site-packages"),
      join(prefix, "lib", "site-packages"),
    ]
    return dirs.filter((d) => existsSync(d))
  }

  function hasPackage(prefix, name) {
    for (const dir of sitePackagesDirs(prefix)) {
      if (existsSync(join(dir, name))) return true
    }
    const lib = join(prefix, "lib")
    if (!existsSync(lib)) return false
    try {
      for (const n of readdirSync(lib)) {
        if (n.indexOf("python") === 0 && existsSync(join(lib, n, "site-packages", name))) return true
      }
    } catch {
      /* ignore unreadable lib dir */
    }
    return false
  }

  function hasIpykernel(prefix) {
    return hasPackage(prefix, "ipykernel")
  }

  // jupyter_client is what the *sidecar* needs; it is a different requirement
  // from ipykernel (what the kernel needs), and an env can have one without
  // the other.
  function hasJupyterClient(prefix) {
    return hasPackage(prefix, "jupyter_client")
  }

  function condaPrefixes() {
    const out = []
    const seen = new Set()
    function add(p) {
      if (!p) return
      const n = String(p).replace(/[\\/]+$/, "")
      const key = n.toLowerCase()
      if (seen.has(key) || !existsSync(n)) return
      seen.add(key)
      out.push(n)
    }
    const envTxt = join(homedir(), ".conda", "environments.txt")
    if (existsSync(envTxt)) {
      for (const line of readFileSync(envTxt, "utf8").split(/\r?\n/)) add(line.trim())
    }
    const envsDir = join(homedir(), ".conda", "envs")
    if (existsSync(envsDir)) {
      try {
        for (const n of readdirSync(envsDir)) add(join(envsDir, n))
      } catch {
        /* ignore */
      }
    }
    add("C:\\ProgramData\\anaconda3")
    add(join(homedir(), "anaconda3"))
    add(join(homedir(), "miniconda3"))
    return out
  }

  function kernelIdFor(prefix, python) {
    const base = prefix ? String(prefix).split(/[\\/]/).filter(Boolean).pop() : "python"
    return "conda:" + base + ":" + String(python || "").slice(-24)
  }

  // ---- R kernels -----------------------------------------------------------
  // R kernels are discovered the way Jupyter itself discovers them, from three
  // independent sources:
  //   1. kernelspecs in the user data dir (~/AppData/Roaming/jupyter/kernels),
  //   2. kernelspecs shipped inside a conda env (<env>/share/jupyter/kernels),
  //   3. nothing but an IRkernel package in a conda env's R library - those are
  //      synthesised, so an env that was never `installspec()`-ed still works.
  //
  // A conda R also has to be started with its env's DLL directories on PATH.
  // Without that it dies instantly with 0xC0000135 (DLL not found), because the
  // R binary lives in <env>/lib/R/bin/x64 and needs <env>/Library/bin beside it.
  // Note the kernelspec a conda env ships usually says argv[0] = "R", which only
  // resolves while that env is activated - so the absolute binary is substituted.

  /** Directories that hold `<name>/kernel.json`. */
  function kernelSpecDirs() {
    const out = []
    const seen = new Set()
    const add = (dir) => {
      if (!dir) return
      const abs = String(dir).replace(/[\\/]+$/, "")
      if (!abs) return
      const key = abs.toLowerCase()
      if (seen.has(key) || !existsSync(abs)) return
      seen.add(key)
      out.push(abs)
    }
    for (const entry of String(process.env.JUPYTER_PATH || "").split(delimiter)) {
      if (entry.trim()) add(join(entry.trim(), "kernels"))
    }
    if (platform() === "win32") {
      const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      add(join(appData, "jupyter", "kernels"))
    } else {
      add(join(homedir(), ".local", "share", "jupyter", "kernels"))
      add("/usr/local/share/jupyter/kernels")
      add("/usr/share/jupyter/kernels")
    }
    return out
  }

  function readKernelSpec(dir, name) {
    const file = join(dir, name, "kernel.json")
    if (!existsSync(file)) return null
    try {
      const spec = JSON.parse(readFileSync(file, "utf8"))
      return spec && Array.isArray(spec.argv) && spec.argv.length > 0 ? spec : null
    } catch {
      return null
    }
  }

  /** Walk up from an R binary to the directory that owns `library/base`. */
  function rHomeFromExe(rExe) {
    let dir = dirname(String(rExe))
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, "library", "base", "DESCRIPTION"))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  /** The conda env that owns an R home (`<env>/lib/R`), when there is one. */
  function condaPrefixOf(rHome) {
    const parent = dirname(rHome)
    if (basename(rHome).toUpperCase() === "R" && basename(parent).toLowerCase() === "lib") {
      return dirname(parent)
    }
    return null
  }

  /** `{ rHome, rExe }` for a conda env or a plain R install, else null. */
  function rInstall(prefix) {
    const homes = [join(prefix, "lib", "R"), prefix]
    for (const rHome of homes) {
      if (!existsSync(join(rHome, "library"))) continue
      for (const rExe of [
        join(rHome, "bin", "x64", "R.exe"),
        join(rHome, "bin", "R.exe"),
        join(rHome, "bin", "R"),
      ]) {
        if (existsSync(rExe)) return { rHome, rExe }
      }
    }
    return null
  }

  function rVersionOf(rHome) {
    const desc = join(rHome, "library", "base", "DESCRIPTION")
    if (!existsSync(desc)) return null
    try {
      const match = /^Version:\s*(\S+)/m.exec(readFileSync(desc, "utf8"))
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  function hasIRkernel(rHome) {
    return (
      existsSync(join(rHome, "library", "IRkernel")) ||
      existsSync(join(rHome, "site-library", "IRkernel"))
    )
  }

  /** The PATH/R_HOME a conda activation would have set, without a shell. */
  function rActivationEnv(prefix, rHome) {
    const env = { R_HOME: rHome }
    const parts = prefix
      ? [
          prefix,
          join(prefix, "Library", "mingw-w64", "bin"),
          join(prefix, "Library", "usr", "bin"),
          join(prefix, "Library", "bin"),
          join(prefix, "Scripts"),
          join(prefix, "bin"),
        ]
      : []
    parts.push(join(rHome, "bin", "x64"), join(rHome, "bin"))
    const existing = process.env.PATH || ""
    const usable = parts.filter((p) => existsSync(p))
    if (usable.length > 0) env.PATH = usable.join(delimiter) + delimiter + existing
    return env
  }

  function rKernelId(rExe, fallback) {
    return "r:" + (fallback || "R") + ":" + String(rExe || "").slice(-24)
  }

  function rKernelEntries(prefixes) {
    const out = []
    const seen = new Set()
    const pathKey = (p) => String(p || "").replace(/\//g, "\\").toLowerCase()
    const push = (entry) => {
      const key = pathKey(entry.interpreter || (entry.argv && entry.argv[0]))
      if (!key || seen.has(key)) return
      seen.add(key)
      out.push(entry)
    }

    const specDirs = kernelSpecDirs().map((dir) => ({ dir, prefix: null }))
    for (const prefix of prefixes) {
      specDirs.push({ dir: join(prefix, "share", "jupyter", "kernels"), prefix })
    }
    for (const { dir, prefix } of specDirs) {
      let names = []
      try {
        if (!existsSync(dir)) continue
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        const spec = readKernelSpec(dir, name)
        if (!spec) continue
        if (String(spec.language || "").toLowerCase() !== "r") continue
        const argv = spec.argv.map((a) => String(a))
        let rExe = argv[0]
        // Windows kernelspecs often omit the ".exe" (CreateProcess appends it,
        // existsSync does not) - resolve it so the path can be used verbatim.
        if (!existsSync(rExe) && existsSync(rExe + ".exe")) rExe = rExe + ".exe"
        if (!existsSync(rExe)) {
          const guess = prefix ? rInstall(prefix) : null
          if (!guess) continue
          rExe = guess.rExe
        }
        // One canonical spelling, so ids, equality checks and R_HOME stay
        // stable no matter whether the kernelspec wrote C:/x or C:\\x.
        if (platform() === "win32") rExe = rExe.replace(/\//g, "\\")
        const rHome = rHomeFromExe(rExe)
        if (!rHome) continue
        argv[0] = rExe
        const condaPrefix = prefix || condaPrefixOf(rHome)
        const version = rVersionOf(rHome)
        const envName = condaPrefix ? basename(condaPrefix) : null
        const kernelLabel = envName || String(spec.display_name || name)
        push({
          id: rKernelId(rExe, kernelLabel),
          name: kernelLabel,
          kind: "r",
          language: "r",
          prefix: condaPrefix || rHome,
          rHome,
          interpreter: rExe,
          argv,
          env: rActivationEnv(condaPrefix, rHome),
          version,
          hasIpykernel: false,
          hasKernel: true,
          display: "R" + (version ? " " + version : "") + " · " + kernelLabel,
        })
      }
    }

    for (const prefix of prefixes) {
      const install = rInstall(prefix)
      if (!install || !hasIRkernel(install.rHome)) continue
      const version = rVersionOf(install.rHome)
      const label = basename(prefix) || "R"
      push({
        id: rKernelId(install.rExe, label),
        name: label,
        kind: "r",
        language: "r",
        prefix,
        rHome: install.rHome,
        interpreter: install.rExe,
        argv: [install.rExe, "--slave", "-e", "IRkernel::main()", "--args", "{connection_file}"],
        env: rActivationEnv(prefix, install.rHome),
        version,
        hasIpykernel: false,
        hasKernel: true,
        display: "R" + (version ? " " + version : "") + " · " + label,
      })
    }
    return out
  }

  let kernelCache = { at: 0, managed: null, legacy: null }
  function listKernels(managed = false) {
    if (kernelCache.managed && managed && Date.now() - kernelCache.at < 15000) return kernelCache.managed
    if (kernelCache.legacy && !managed && Date.now() - kernelCache.at < 15000) return kernelCache.legacy
    if (managed) {
      const controller = {
        id: "swarm-private-python",
        name: "swarm-private-python",
        kind: "private",
        language: "python",
        prefix: PRIVATE_RUNTIME_PREFIX,
        runtimePrefix: PRIVATE_RUNTIME_PREFIX,
        python: PRIVATE_PYTHON,
        interpreter: PRIVATE_PYTHON,
        hasIpykernel: existsSync(PRIVATE_PYTHON),
        hasJupyterClient: existsSync(PRIVATE_PYTHON),
        hasKernel: existsSync(PRIVATE_PYTHON),
        display: "swarm-private-python · " + PRIVATE_PYTHON,
        managedController: true,
      }
      const prefixes = condaPrefixes()
      const kernels = [controller]
      for (const prefix of prefixes) {
        const python = pythonFromPrefix(prefix)
        if (!python || !hasIpykernel(prefix)) continue
        if (samePath(prefix, PRIVATE_RUNTIME_PREFIX)) continue
        const name = String(prefix).split(/[\\/]/).filter(Boolean).pop() || prefix
        kernels.push({
          id: kernelIdFor(prefix, python),
          name,
          kind: "conda",
          language: "python",
          prefix,
          runtimePrefix: prefix,
          python,
          interpreter: python,
          hasIpykernel: true,
          hasJupyterClient: hasJupyterClient(prefix),
          hasKernel: true,
          display: name + "  ·  " + python,
        })
      }
      kernels.push(...rKernelEntries(prefixes).filter(entry => entry.hasKernel && entry.prefix))
      kernelCache = { at: Date.now(), managed: kernels, legacy: kernelCache.legacy }
      return kernelCache.managed
    }
    const kernels = []
    const prefixes = condaPrefixes()
    for (const prefix of prefixes) {
      const python = pythonFromPrefix(prefix)
      if (!python) continue
      const hasJc = hasJupyterClient(prefix)
      const hasIpy = hasIpykernel(prefix)
      const name = String(prefix).split(/[\\/]/).filter(Boolean).pop() || prefix
      kernels.push({
        id: kernelIdFor(prefix, python),
        name,
        kind: "conda",
        language: "python",
        prefix,
        python,
        interpreter: python,
        hasIpykernel: hasIpy,
        hasJupyterClient: hasJc,
        hasKernel: hasIpy && hasJc,
        display: name + "  ·  " + python,
      })
    }
    kernels.sort((a, b) => {
      if (a.hasIpykernel !== b.hasIpykernel) return a.hasIpykernel ? -1 : 1
      return String(a.name).localeCompare(String(b.name))
    })
    kernelCache = { at: Date.now(), managed: kernelCache.managed, legacy: kernels.concat(rKernelEntries(prefixes)) }
    return kernelCache.legacy
  }

  /**
   * The part of a catalog entry that leaves the host: enough to render the
   * picker and to act on a selection, without the R launch spec (argv, the
   * activation PATH, R_HOME) that only the driver needs.
   */
  function publicKernel(entry) {
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      language: entry.language || "python",
      display: entry.display || entry.name,
      python: entry.python || null,
      interpreter: entry.interpreter || entry.python || null,
      version: entry.version || null,
      hasIpykernel: !!entry.hasIpykernel,
      hasKernel: entry.hasKernel !== undefined ? !!entry.hasKernel : !!entry.hasIpykernel,
    }
  }

  /**
   * The interpreter a session runs by default when it has not picked one.
   * @param {string} [sessionId] - the session whose envsel choice (or the
   *   nearest inherited one) should win; omitted for session-independent probes.
   */
  function defaultKernelEntry(sessionId, managed = false) {
    const kernels = listKernels(managed)
    const envsel = envselPython(sessionId)
    if (envsel) {
      const hit = kernels.find((k) => k.python && k.python.toLowerCase() === envsel.toLowerCase())
      if (hit) return hit
      if (managed) throw Object.assign(new Error("Managed Notebook 所选 kernel 不在已核验运行池，拒绝静默替换: " + envsel), { code: "NOTEBOOK_KERNEL_UNVERIFIED" })
      return {
        id: "envsel",
        name: "envsel",
        kind: "envsel",
        language: "python",
        prefix: dirname(envsel),
        python: envsel,
        interpreter: envsel,
        hasIpykernel: true,
        hasKernel: true,
        display: envsel,
      }
    }
    const fallbackPython = existsSync(PRIVATE_PYTHON) ? PRIVATE_PYTHON : "python"
    return kernels.find((k) => k.hasIpykernel) || kernels[0] || {
      id: "python",
      name: "python",
      kind: "system",
      language: "python",
      prefix: "",
      python: fallbackPython,
      interpreter: fallbackPython,
      hasIpykernel: true,
      hasKernel: true,
      display: fallbackPython,
    }
  }

  async function cpuInfoRoute(sessionId) {
    // Windows only: per-process affinity is the advice, and it is the only
    // platform here that exposes it (see the detection block above).
    if (platform() !== "win32") {
      return { platform: platform(), detected: false, hybrid: false, source: null, detail: null }
    }
    const methods = createSessionMethods(sessionId)
    const entry = methods.kernelEntry()
    const language = (entry && entry.language) || "python"
    // The probe needs a Python interpreter even when the kernel is R; the
    // sidecar's interpreter is the one guaranteed to exist.
    const python = language === "r" ? methods.driverPython() : (entry && entry.python)
    const result = await detectHybridCpu(python)
    const detail = (result && result.detail) || null
    const singleGroup = !!(detail && detail.single_group !== false)
    return {
      platform: platform(),
      detected: !!result,
      hybrid: !!(result && result.hybrid),
      source: (result && result.source) || null,
      detail,
      // Which kernel this session would pin, and the mask to pin it to.
      language,
      kernelName: (entry && entry.name) || null,
      kernelExe: (entry && (entry.interpreter || entry.python)) || null,
      pCoreMask: detail && singleGroup && Number.isFinite(detail.p_mask) ? detail.p_mask : null,
      logicalCpus: detail && Number.isFinite(detail.logical) ? detail.logical : null,
      singleGroup,
    }
  }

  // ---- per-session methods factory ----
  // All notebook logic closes over one session's `state` (returned by
  // getSession). The factory is cheap to call; the cached state object is
  // shared across calls for the same sessionId.
  function createSessionMethods(sessionId, retainedState) {
    const state = retainedState || getSession(sessionId)

    function notebooksDir() {
      return join(state.workspaceRoot || initialWorkspaceRoot, "notebooks")
    }

    function kernelEntry() {
      return state.kernel.entry || defaultKernelEntry(sessionId, state.managed === true)
    }

    function pythonExe() {
      const kernel = state.kernel || {}
      // The sidecar is always Python even when the kernel is R: it needs
      // jupyter_client, which no R environment has.
      if ((kernel.language || "python") === "r") return driverPython()
      return kernel.driverPython || kernel.interpreter || defaultKernelEntry(sessionId, state.managed === true).python
    }

    /**
     * The interpreter that hosts the sidecar for an R kernel. Prefers the
     * session's envsel python, but never one that cannot import jupyter_client -
     * that would fail at kernel start instead of falling back sensibly.
     */
    function driverPython() {
      if (state.managed === true) return PRIVATE_PYTHON
      if (state.kernel && state.kernel.driverPython) return state.kernel.driverPython
      const pythons = listKernels(false).filter((k) => (k.language || "python") === "python")
      const envsel = envselPython(sessionId)
      if (envsel && existsSync(envsel)) {
        const hit = pythons.find((k) => k.python.toLowerCase() === envsel.toLowerCase())
        if (hit ? hit.hasJupyterClient !== false : true) return envsel
      }
      const usable = pythons.find((k) => k.hasIpykernel && k.hasJupyterClient !== false)
      return (usable && usable.python) || (pythons[0] && pythons[0].python) || envsel || (existsSync(PRIVATE_PYTHON) ? PRIVATE_PYTHON : "python")
    }

    function killSidecar() {
      return killSessionSidecar(state)
    }

    function ensureLegacySidecar(slot, current, exe) {
      const child = spawn(exe, [DRIVER], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        cwd: state.cwd || state.workspaceRoot || initialWorkspaceRoot,
        env: Object.assign({}, process.env, {
          PYTHONUTF8: "1",
          PYTHONIOENCODING: "utf-8",
          PYTHONLEGACYWINDOWSSTDIO: "0",
        }),
      })
      const done = new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }))
      })
      const handle = {
        stdin: child.stdin || undefined,
        stdout: child.stdout || undefined,
        stderr: child.stderr || undefined,
        done,
        terminate: () => child.kill(),
        waitForExit: async () => {
          try { await done; return true } catch { return false }
        },
      }
      if (!handle.stdin || !handle.stdout || !handle.stderr) throw new Error("legacy Notebook sidecar 缺少协议管道")
      const runtime = { handle, lifecycle: "legacy", syntheticEpoch: false, ownership: { active: 1, unknown: false } }
      return attachSidecar(slot, runtime, handle, JSON.stringify([state.sessionId, state.cwd, "legacy"]))
    }

    function attachSidecar(slot, runtime, handle, scopeKey) {
      const pending = new Map()
      if (handle.stdout.setEncoding) handle.stdout.setEncoding("utf8")
      if (handle.stderr.setEncoding) handle.stderr.setEncoding("utf8")
      if (handle.stdin.setDefaultEncoding) handle.stdin.setDefaultEncoding("utf8")
      const sidecar = {
        child: handle,
        pending,
        runtime,
        scopeKey,
        exited: false,
        stopping: null,
        request(cmd, args, timeoutMs, opts) {
          const id = newId("req")
          const payload = Object.assign({ id, cmd }, args || {})
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              reject(new Error("sidecar timeout: " + cmd))
            }, timeoutMs || 180000)
            pending.set(id, {
              onProgress: opts && opts.onProgress,
              resolve: (msg) => {
                clearTimeout(timer)
                resolve(msg)
              },
            })
            try {
              handle.stdin.write(JSON.stringify(payload) + "\n", "utf8")
            } catch (error) {
              clearTimeout(timer)
              pending.delete(id)
              reject(error)
            }
          })
        },
      }
      const rl = createInterface({ input: handle.stdout })
      rl.on("line", (line) => {
        const text = String(line || "").trim()
        if (!text) return
        let msg
        try {
          msg = JSON.parse(text)
        } catch {
          return
        }
        const item = msg && msg.id && pending.get(msg.id)
        if (msg && msg.event === "progress") {
          if (item && item.onProgress) {
            try { item.onProgress(msg) } catch { /* progress is best-effort */ }
          }
          return
        }
        if (item) {
          pending.delete(msg.id)
          item.resolve(msg)
        }
      })
      handle.done.then((outcome) => {
        sidecar.exited = true
        for (const { resolve } of pending.values()) resolve({ ok: false, error: "sidecar exited" })
        pending.clear()
        if (slot === "sidecar" && state.sidecar === sidecar) {
          state.kernel.alive = false
          state.kernel.lastExit = outcome
        }
      }, (error) => {
        sidecar.exited = true
        for (const { resolve } of pending.values()) resolve({ ok: false, error: String(error) })
        pending.clear()
        if (slot === "sidecar" && state.sidecar === sidecar) state.kernel.alive = false
      })
      handle.stderr.on("data", () => {})
      if (slot === "sidecar") state.kernel.stopState = null
      state[slot] = sidecar
      return sidecar
    }

    async function ensureSidecar(slot = "sidecar") {
      if (state.inactive) throw new Error("Notebook 会话已停止；历史 Notebook 仅可查看")
      const current = slot === "sidecar" ? state.sidecar : state.fileSidecar
      if (state.managed !== true) {
        if (current && !current.exited && !current.stopping) return current
        if (current) await stopOneSidecar(state, slot)
        return ensureLegacySidecar(slot, current, pythonExe())
      }
      const reusablePersistent = slot === "sidecar" && current && !current.exited && !current.stopping
        && current.runtime && current.runtime.lifecycle === "persistent"
      let scope
      try {
        scope = getNotebookBoundaryScope()
      } catch (error) {
        if (reusablePersistent && current) return current
        throw error
      }
      const lifecycle = getNotebookKernelLifecycle(scope)
      const scopeKey = slot === "sidecar"
        ? getNotebookComputeScopeKey(scope)
        : JSON.stringify([getNotebookComputeScopeKey(scope), scope.mode, scope.operation, "file"])
      if (current && !current.exited && !current.stopping && current.scopeKey === scopeKey) {
        return current
      }
      if (current) await stopOneSidecar(state, slot)
      if (!existsSync(PRIVATE_PYTHON)) throw new Error("Notebook controller Python 不存在；请配置 DSH_NOTEBOOK_CONTROLLER_PYTHON/RUNTIME_PREFIX")
      const service = ctx.get("subprocess")
      if (!service || typeof service.spawn !== "function" || typeof service.resolveExecutable !== "function") {
        throw new Error("DSH subprocess service 不可用，Notebook kernel 保持封闭")
      }
      const bwrap = await service.resolveExecutable("bwrap")
      if (state.inactive) throw new Error("Notebook 会话已停止；拒绝在卸载期间启动 kernel")
      const selected = kernelEntry()
      const kernelRuntimePrefix = selected && (selected.runtimePrefix || selected.prefix)
      if (!kernelRuntimePrefix) throw new Error("所选 Notebook kernel 缺少可核验 runtime prefix")
      const plan = buildNotebookSandboxPlan({
        scope,
        bwrap,
        pythonExecutable: PRIVATE_PYTHON,
        driverPath: DRIVER,
        pluginRoot: join(HERE, ".."),
        runtimePrefix: PRIVATE_RUNTIME_PREFIX,
        kernelRuntimePrefix,
      })
      const carrier = getNotebookBoundaryCarrier()
      if (!carrier) throw new Error("DSH execution boundary carrier 不可用，Notebook kernel 保持封闭")
      const runtime = spawnNotebookRuntime({ carrier, subprocess: service, plan, lifecycle })
      const child = runtime.handle
      if (!child.stdin || !child.stdout || !child.stderr) {
        await stopNotebookRuntime(runtime, { carrier, timeoutMs: 15000 })
        throw new Error("DSH subprocess handle 缺少 Notebook 协议管道")
      }
      if (slot === "sidecar") state.cwd = scope.cwd
      if (child.stdout && child.stdout.setEncoding) child.stdout.setEncoding("utf8")
      if (child.stderr && child.stderr.setEncoding) child.stderr.setEncoding("utf8")
      if (child.stdin && child.stdin.setDefaultEncoding) child.stdin.setDefaultEncoding("utf8")
      const pending = new Map()
      const rl = createInterface({ input: child.stdout })
      const sidecar = {
        child,
        pending,
        runtime,
        scopeKey,
        exited: false,
        stopping: null,
        request(cmd, args, timeoutMs, opts) {
          const id = newId("req")
          const payload = Object.assign({ id, cmd }, args || {})
          return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pending.delete(id)
              reject(new Error("sidecar timeout: " + cmd))
            }, timeoutMs || 180000)
            pending.set(id, {
              onProgress: opts && opts.onProgress,
              resolve: (msg) => {
                clearTimeout(timer)
                resolve(msg)
              },
            })
            try {
              child.stdin.write(JSON.stringify(payload) + "\n", "utf8")
            } catch (err) {
              clearTimeout(timer)
              pending.delete(id)
              reject(err)
            }
          })
        },
      }
      rl.on("line", (line) => {
        const text = String(line || "").trim()
        if (!text) return
        let msg
        try {
          msg = JSON.parse(text)
        } catch {
          return
        }
        const id = msg && msg.id
        const item = id && pending.get(id)
        if (msg && msg.event === "progress") {
          if (item && item.onProgress) {
            try { item.onProgress(msg) } catch { /* progress is best-effort */ }
          }
          return
        }
        if (item) {
          pending.delete(id)
          item.resolve(msg)
        }
      })
      child.done.then((outcome) => {
        sidecar.exited = true
        for (const { resolve } of pending.values()) {
          resolve({ ok: false, error: "sidecar exited" })
        }
        pending.clear()
        if (slot === "sidecar" && state.sidecar === sidecar) {
          state.kernel.alive = false
          state.kernel.lastExit = outcome
        }
      }, (error) => {
        sidecar.exited = true
        for (const { resolve } of pending.values()) resolve({ ok: false, error: String(error) })
        pending.clear()
        if (slot === "sidecar" && state.sidecar === sidecar) state.kernel.alive = false
      })
      child.stderr.on("data", () => {})
      if (slot === "sidecar") state.kernel.stopState = null
      state[slot] = sidecar
      return sidecar
    }

    function friendlyKernelError(err) {
      const msg = String((err && err.message) || err || "")
      const isR = (state.kernel.language || "python") === "r"
      const exe = (isR ? state.kernel.driverPython : state.kernel.interpreter) || "python"
      if (/No module named ['"]?jupyter_client/i.test(msg)) {
        return "该环境缺少 jupyter_client —— notebook 的后台进程需要它才能启动内核：\n" +
          exe + " -m pip install jupyter_client\n" +
          "（或 conda install -c conda-forge jupyter_client）\n原始错误：" + msg.slice(0, 200)
      }
      if (/No module named ['"]?ipykernel/i.test(msg)) {
        return "该环境缺少 ipykernel，请先安装：\n" + exe + " -m pip install ipykernel\n（原始错误：" + msg.slice(0, 200) + "）"
      }
      if (isR && /IRkernel|0xc0000135|DLL|cannot open/i.test(msg)) {
        return "R 内核启动失败：该 R 环境需要 IRkernel 包。\n" +
          "检查：Rscript -e \"library(IRkernel)\"\n原始错误：" + msg.slice(0, 400)
      }
      if (/ENOENT|spawn .* ENOENT|not found/i.test(msg)) {
        return (isR ? "找不到 R/Python 解释器：" : "找不到 Python 解释器：") + "\n" + exe +
          "\n请在内核下拉框里重新选择环境。"
      }
      if (/timed? ?out|timeout/i.test(msg)) {
        return "内核启动超时（60 秒）。可能是该环境较慢或损坏，请换一个环境试试。"
      }
      return "内核启动失败：" + (msg.slice(0, 300) || "未知错误")
    }

    async function ensureKernel() {
      if (state.inactive) throw new Error("Notebook 会话已停止；历史 Notebook 仅可查看")
      if (state.kernel.alive) return { ok: true, interpreter: state.kernel.interpreter }
      if (state.kernel.starting) {
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 200))
          if (state.kernel.alive) return { ok: true, interpreter: state.kernel.interpreter }
        }
      }
      state.kernel.starting = true
      try {
        const entry = state.kernel.entry || defaultKernelEntry(sessionId, state.managed === true)
        const isR = (entry.language || "python") === "r"
        state.kernel.entry = entry
        state.kernel.language = entry.language || "python"
        state.kernel.interpreter = state.kernel.interpreter || entry.interpreter || entry.python
        state.kernel.name = state.kernel.name || entry.name
        state.kernel.id = state.kernel.id || entry.id
        if (isR) state.kernel.driverPython = driverPython()
        const sc = await ensureSidecar()
        const payload = {
          interpreter: pythonExe(),
          cwd: state.cwd || state.workspaceRoot || initialWorkspaceRoot,
        }
        if (isR) {
          // The driver builds a throwaway kernelspec from this argv, so a conda
          // kernelspec that just says "R" still works when the env is inactive.
          payload.kernel_argv = entry.argv
          payload.kernel_display = entry.display
          payload.kernel_language = "r"
          payload.kernel_env = entry.env
        } else if (state.managed === true) {
          payload.kernel_argv = [entry.interpreter || entry.python, "-m", "ipykernel_launcher", "-f", "{connection_file}"]
          payload.kernel_display = entry.display
          payload.kernel_language = "python"
        }
        const res = await sc.request("start", payload, 120000)
        if (!res || !res.ok) throw new Error((res && res.error) || "kernel start failed")
        state.kernel.alive = true
        state.kernel.language = res.language || state.kernel.language
        state.kernel.interpreter = isR
          ? (entry.interpreter || state.kernel.interpreter)
          : (res.interpreter || state.kernel.interpreter)
        return { ok: true, interpreter: state.kernel.interpreter, language: state.kernel.language }
      } catch (e) {
        throw new Error(friendlyKernelError(e))
      } finally {
        state.kernel.starting = false
      }
    }

    function findCell(cellId) {
      return (state.notebook.cells || []).find((c) => c.id === cellId)
    }

    function snapshotPublic(opts) {
      opts = opts || {}
      const includeKernels = opts.includeKernels !== false && !state.inactive
      let displayKernel = state.kernel
      let selectionError = null
      if (!state.inactive && (!state.kernel.id || !state.kernel.interpreter)) {
        try {
          const entry = defaultKernelEntry(sessionId, state.managed === true)
          state.kernel.interpreter = state.kernel.interpreter || entry.python
          state.kernel.name = state.kernel.name || entry.name
          state.kernel.id = state.kernel.id || entry.id
        } catch (error) {
          if (state.managed !== true || error?.code !== "NOTEBOOK_KERNEL_UNVERIFIED") throw error
          // 草稿读取不启动内核，也不能把展示时的替代项写成真实选择。
          // 执行仍由 defaultKernelEntry/ensureKernel 严格检查原环境。
          selectionError = "当前环境尚未获准用于 Notebook 计算；可查看笔记，计算前请显式选择可用内核。"
          displayKernel = { ...state.kernel, interpreter: envselPython(sessionId) || null, name: "未核验环境", id: "unverified-envsel" }
        }
      }
      const snap = {
        path: state.notebook.path,
        dirty: !!state.notebook.dirty,
        savedAt: state.savedAt || null,
        readOnly: state.inactive === true || state.readOnlySnapshot === true,
        readOnlySnapshot: state.readOnlySnapshot === true,
        persistedSnapshotAt: state.notebook.dirty ? null : state.persistedSnapshotAt || null,
        snapshotProvenance: state.notebook.dirty ? null : state.snapshotProvenance || null,
        snapshotOriginState: state.notebook.dirty
          ? "unsaved-changes"
          : state.snapshotOriginState || (state.snapshotProvenance ? "saved-clean" : "not-saved"),
        metadata: state.notebook.metadata,
        // LOCAL PATCH: `_runJob` holds a live Promise while a cell is
        // queued/running. The GUI's HTTP path silently stringifies it away,
        // but the agent-tool pipeline validates lossless JSON and correctly
        // rejects a Promise — strip it from every snapshot so nb_get /
        // nb_edit_cell / background nb_run_cell cannot fail serialization
        // while any cell is in flight.
        cells: (state.notebook.cells || []).map(function (cell) {
          const copy = Object.assign({}, cell)
          delete copy._runJob
          return copy
        }),
        kernel: {
          alive: state.kernel.alive,
          language: displayKernel.language || "python",
          interpreter: displayKernel.interpreter,
          driverPython: (displayKernel.language || "python") === "r" ? displayKernel.driverPython : null,
          name: displayKernel.name,
          id: displayKernel.id,
          available: !state.inactive && selectionError === null,
          selectionError: state.inactive
            ? "历史 Notebook 数据视图只读；未恢复活内核或变量"
            : selectionError,
          starting: !!state.kernel.starting,
          busy: (state.notebook.cells || []).some((c) => c.status === "running" || c.status === "queued"),
        },
        cwd: state.cwd,
        cwdSource: state.cwdSource || "default",
        workspaceRoot: state.workspaceRoot || initialWorkspaceRoot,
      }
      if (includeKernels) {
        const kernels = listKernels(state.managed === true).slice()
        const language = displayKernel.language || "python"
        const known = kernels.some((k) =>
          k.id === displayKernel.id ||
          (k.interpreter && k.interpreter === displayKernel.interpreter) ||
          (k.python && k.python === displayKernel.interpreter)
        )
        if (displayKernel.interpreter && !known) {
          kernels.unshift({
            id: displayKernel.id || "current",
            name: displayKernel.name || "current",
            kind: "current",
            language,
            prefix: "",
            python: displayKernel.interpreter,
            interpreter: displayKernel.interpreter,
            hasIpykernel: selectionError === null && language !== "r",
            hasKernel: selectionError === null,
            display: displayKernel.interpreter,
          })
        }
        snap.kernels = kernels.map(publicKernel)
      }
      return snap
    }

    function snapshotFast() {
      return snapshotPublic({ includeKernels: false })
    }

    async function listDir(args) {
      const raw = String((args && args.dir) || state.cwd || notebooksDir() || state.workspaceRoot || initialWorkspaceRoot)
      const abs = assertNotebookPath(pathResolve(raw), "read")
      if (!existsSync(abs)) throw new Error("directory not found: " + abs)
      let names = []
      try {
        names = readdirSync(abs)
      } catch (e) {
        throw new Error("cannot read directory: " + abs)
      }
      const dirs = []
      const notebooks = []
      for (const n of names) {
        if (n === "." || n === "..") continue
        const p = join(abs, n)
        let st
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (st.isDirectory()) dirs.push({ name: n, path: p })
        else if (n.toLowerCase().endsWith(".ipynb")) {
          notebooks.push({ name: n, path: p, mtime: st.mtime.toISOString() })
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name))
      notebooks.sort((a, b) => a.name.localeCompare(b.name))
      const parent = dirname(abs)
      return {
        dir: abs,
        parent: parent !== abs ? parent : null,
        dirs,
        notebooks,
        current: snapshotPublic(),
      }
    }

    async function listNotebooks(args) {
      const dir = (args && args.dir) || notebooksDir()
      const guarded = assertNotebookPath(pathResolve(dir), "read")
      if (!existsSync(guarded)) return { dir: guarded, parent: dirname(guarded), dirs: [], notebooks: [], current: snapshotPublic() }
      return listDir({ dir })
    }

    async function setCwd(args) {
      const raw = String((args && args.dir) || "").trim()
      if (!raw) throw new Error("dir required")
      const abs = assertNotebookPath(pathResolve(raw), "read")
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error("not a directory: " + abs)
      if (abs !== state.cwd) await stopSessionSidecar(state, "all")
      state.cwd = abs
      state.cwdSource = "manual"
      return snapshotPublic()
    }

    async function syncSessionCwd(args) {
      const raw = String((args && args.cwd) || "").trim()
      if (!raw) return snapshotFast()
      if (!getNotebookBoundaryCarrier()?.storage.getStore()) return snapshotFast()
      const abs = assertNotebookPath(pathResolve(raw), "read")
      if (!existsSync(abs) || !statSync(abs).isDirectory()) return snapshotFast()
      state.workspaceRoot = abs
      if (state.cwdSource === "default" || state.cwdSource === "session") {
        if (state.cwd !== abs) {
          await stopSessionSidecar(state, "all")
          state.cwd = abs
          state.cwdSource = "session"
        } else {
          state.cwdSource = "session"
        }
      }
      return snapshotPublic()
    }

    async function newNotebook(args) {
      const title = (args && args.title) || "untitled"
      activateFromSnapshot(state)
      state.notebook = emptyNotebook(title)
      state.cellExtras = Object.create(null)
      state.savedAt = null
      if (state.workspaceRoot && (state.cwdSource === "default" || state.cwdSource === "session")) {
        if (state.cwd !== state.workspaceRoot) await stopOneSidecar(state, "sidecar")
        state.cwd = state.workspaceRoot
        state.cwdSource = "session"
      }
      return snapshotPublic()
    }

    async function openNotebook(args) {
      const raw = String((args && args.path) || "")
      if (!raw) throw new Error("path required")
      const previousInactive = state.inactive
      const previousReadOnly = state.readOnlySnapshot
      const previousSnapshotAt = state.persistedSnapshotAt
      const previousSnapshotProvenance = state.snapshotProvenance
      const previousSnapshotOriginState = state.snapshotOriginState
      activateFromSnapshot(state)
      try {
        const abs = assertNotebookPath(pathResolve(raw), "read")
        const sc = await ensureSidecar("fileSidecar")
        const res = await sc.request("load_ipynb", { path: abs }, 30000)
        if (!res || !res.ok) throw new Error((res && res.error) || "failed to load ipynb")
        const cells = (res.cells || []).map((c, i) => {
          const cell = ensureDshMeta({
            id: c.id || newId("cell"),
            cell_type: c.cell_type || "code",
            source: c.source || "",
            outputs: c.outputs || [],
            metadata: c.metadata || {},
            execution_count: c.execution_count || null,
            status: (c.outputs || []).some((o) => o.type === "error" || o.output_type === "error" || o.error)
              ? "error"
              : (c.execution_count ? "ok" : "idle"),
          })
          if (!cell.id) cell.id = newId("cell") + "-" + i
          return cell
        })
        // Anything the driver could not model (e.g. markdown attachments) is
        // replayed verbatim on save, so opening + saving a notebook is lossless.
        state.cellExtras = Object.create(null)
        ;(res.cells || []).forEach((c, i) => {
          if (c && c.extras && cells[i]) state.cellExtras[cells[i].id] = c.extras
        })
        if (cells.length === 0) cells.push(emptyNotebook().cells[0])
        state.notebook = {
          cells,
          metadata: res.metadata || {},
          nbformat: res.nbformat || 4,
          nbformat_minor: res.nbformat_minor || 5,
          path: abs,
          dirty: false,
        }
        const savedCwd = res.metadata && res.metadata.dsh && res.metadata.dsh.cwd
        const nextCwd = savedCwd && existsSync(savedCwd) ? assertNotebookPath(savedCwd, "read") : dirname(abs)
        if (nextCwd) {
          state.cwdSource = "notebook"
          if (nextCwd !== state.cwd) {
            await stopOneSidecar(state, "sidecar")
            state.cwd = nextCwd
          }
        }
        return snapshotPublic()
      } catch (error) {
        state.inactive = previousInactive
        state.readOnlySnapshot = previousReadOnly
        state.persistedSnapshotAt = previousSnapshotAt
        state.snapshotProvenance = previousSnapshotProvenance
        state.snapshotOriginState = previousSnapshotOriginState
        throw error
      }
    }

    async function saveNotebook(args) {
      let dest = (args && args.path) || state.notebook.path
      if (!dest) {
        const dir = (args && args.dir) || state.cwd || notebooksDir()
        let title = String((args && args.name) || (state.notebook.metadata && state.notebook.metadata.dsh && state.notebook.metadata.dsh.title) || "untitled")
        title = title.replace(/\.ipynb$/i, "").replace(/[<>:\"|?*]+/g, "_").slice(0, 80) || "untitled"
        dest = join(dir, title + ".ipynb")
      }
      dest = pathResolve(dest)
      if (!String(dest).toLowerCase().endsWith(".ipynb")) dest = dest + ".ipynb"
      dest = assertNotebookPath(dest, "write")
      if (state.notebook.metadata && state.notebook.metadata.dsh) {
        state.notebook.metadata.dsh.title = basename(dest).replace(/\.ipynb$/i, "")
        state.notebook.metadata.dsh.cwd = state.cwd
      }
      const sc = await ensureSidecar("fileSidecar")
      const payloadCells = state.notebook.cells.map((c) => {
        const extra = state.cellExtras && state.cellExtras[c.id]
        return extra ? Object.assign({}, c, { extras: extra }) : c
      })
      const res = await sc.request(
        "save_ipynb",
        {
          path: dest,
          cells: payloadCells,
          metadata: state.notebook.metadata,
        },
        30000
      )
      if (!res || !res.ok) throw new Error((res && res.error) || "failed to save ipynb")
      state.notebook.path = dest
      state.notebook.dirty = false
      state.savedAt = Date.now()
      if (state.autosaveTimer) { clearTimeout(state.autosaveTimer); state.autosaveTimer = null }
      const scope = getNotebookBoundaryCarrier()?.storage.getStore()
      const snapshot = await persistNotebookSnapshot({
        sessionId,
        state,
        scope,
        savedPath: dest,
        managed: state.managed === true,
      })
      if (snapshot.saved === true) {
        markNotebookSnapshotSaved(state, scope, snapshot)
      } else {
        invalidateNotebookSnapshot(state, "not-saved")
      }
      const ok = state.managed !== true || snapshot.saved === true
      return {
        ok,
        fileSaved: true,
        path: dest,
        current: snapshotPublic(),
        snapshot,
        ...(ok ? {} : { error: "Notebook 文件已保存，但跨重启只读快照未登记；请检查快照端口和 task 身份" }),
      }
    }

    async function addCell(args) {
      const after = args && args.after
      const cellType = args && args.cell_type === "markdown" ? "markdown" : "code"
      const cell = ensureDshMeta({
        id: newId("cell"),
        cell_type: cellType,
        source: (args && args.source) || "",
        outputs: [],
        metadata: {},
        execution_count: null,
        status: "idle",
      })
      const cells = state.notebook.cells
      const idx = after ? cells.findIndex((c) => c.id === after) : cells.length - 1
      const at = idx >= 0 ? idx + 1 : cells.length
      cells.splice(at, 0, cell)
      markDirty()
      return { cell, index: at, current: snapshotPublic() }
    }

    async function deleteCell(args) {
      const cellId = args && args.cellId
      const cells = state.notebook.cells
      const idx = cells.findIndex((c) => c.id === cellId)
      if (idx < 0) throw new Error("cell not found: " + cellId)
      if (cells.length === 1) throw new Error("cannot delete the last cell")
      const removed = cells.splice(idx, 1)[0]
      markDirty()
      return { deleted: removed.id, current: snapshotPublic() }
    }

    async function moveCell(args) {
      const cellId = args && args.cellId
      const dir = (args && args.dir) || 0
      const cells = state.notebook.cells
      const idx = cells.findIndex((c) => c.id === cellId)
      if (idx < 0) throw new Error("cell not found: " + cellId)
      const to = idx + (dir > 0 ? 1 : -1)
      if (to < 0 || to >= cells.length) return { moved: false, current: snapshotPublic() }
      const tmp = cells[idx]
      cells[idx] = cells[to]
      cells[to] = tmp
      markDirty()
      return { moved: true, from: idx, to, current: snapshotPublic() }
    }

    function pushCellVersion(cell, reason, extra) {
      ensureDshMeta(cell)
      cell.metadata.dsh.versions.push(Object.assign({
        at: nowIso(),
        reason: reason || "edit",
        source: cell.source || "",
        source_sha256: sha256(cell.source || ""),
        cell_type: cell.cell_type || "code",
        execution_count: cell.execution_count == null ? null : cell.execution_count,
        status: cell.status || "idle",
        durationMs: cell.durationMs == null ? null : cell.durationMs,
        outputs_summary: outputSummary(cell.outputs || []),
        last_error: lastErrorFromCell(cell),
      }, extra || {}))
      if (cell.metadata.dsh.versions.length > 50) cell.metadata.dsh.versions.shift()
    }

    async function editCell(args) {
      const cell = findCell(args && args.cellId)
      if (!cell) throw new Error("cell not found: " + (args && args.cellId))
      ensureDshMeta(cell)
      if (args && args.source !== undefined) {
        pushCellVersion(cell, (args && args.reason) || "edit", { action: "edit" })
        cell.source = String(args.source)
      }
      if (args && args.cell_type) cell.cell_type = args.cell_type
      markDirty()
      return { cell, current: snapshotPublic() }
    }

    function cellHistory(args) {
      const cell = findCell(args && args.cellId)
      if (!cell) throw new Error("cell not found: " + (args && args.cellId))
      ensureDshMeta(cell)
      const includeSource = !!(args && args.includeSource)
      const versions = (cell.metadata.dsh.versions || []).map((v, i) => {
        const row = {
          index: i,
          at: v.at || v.ts || null,
          reason: v.reason || "",
          action: v.action || "edit",
          source_sha256: v.source_sha256 || sha256(v.source || ""),
          source_preview: sourcePreview(v.source || ""),
          cell_type: v.cell_type || cell.cell_type,
          execution_count: v.execution_count == null ? null : v.execution_count,
          status: v.status || null,
          outputs_summary: v.outputs_summary || null,
          last_error: v.last_error || null,
        }
        if (includeSource) row.source = v.source || ""
        return row
      })
      return {
        cellId: cell.id,
        versions,
        executions: (cell.metadata && cell.metadata.dsh && cell.metadata.dsh.executions) || [],
        current_source_sha256: sha256(cell.source || ""),
        current: snapshotPublic(),
      }
    }

    async function revertCell(args) {
      const cell = findCell(args && args.cellId)
      if (!cell) throw new Error("cell not found: " + (args && args.cellId))
      ensureDshMeta(cell)
      const versions = cell.metadata.dsh.versions || []
      const idx = Number(args && args.versionIndex)
      if (!Number.isInteger(idx) || idx < 0 || idx >= versions.length) throw new Error("invalid versionIndex")
      const target = versions[idx]
      pushCellVersion(cell, (args && args.reason) || ("revert to version " + idx), { action: "revert", reverted_to: idx })
      cell.source = String(target.source || "")
      if (target.cell_type) cell.cell_type = target.cell_type
      cell.status = cell.execution_count ? "ok" : "idle"
      markDirty()
      return { ok: true, cell, reverted_to: idx, current: snapshotPublic() }
    }

    function bumpRunGen() {
      state.runGen += 1
      return state.runGen
    }

    function markDirty() {
      state.notebook.dirty = true
      invalidateNotebookSnapshot(state, "unsaved-changes")
      scheduleAutoSave()
    }
    function scheduleAutoSave() {
      if (state.inactive || !state.notebook.path) return
      if (state.autosaveTimer) clearTimeout(state.autosaveTimer)
      state.autosaveTimer = setTimeout(function () {
        state.autosaveTimer = null
        if (!state.notebook.dirty || !state.notebook.path) return
        const busy = (state.notebook.cells || []).some((c) => c.status === "queued" || c.status === "running")
        if (busy) { scheduleAutoSave(); return }
        saveNotebook({ path: state.notebook.path }).catch(function () {})
      }, 2500)
    }

    function applyOutputs(cell, outputs) {
      cell.outputs = Array.isArray(outputs) ? outputs.slice() : []
      markDirty()
    }

    // ---- structured execution envelope (#2) ----

    // Merge stream outputs into single stdout/stderr strings. The agent-facing
    // summary keeps head+tail (tail carries tracebacks / latest output, head
    // the beginning of a run) with an explicit omission marker in the middle.
    // When truncated, the FULL merged text is spilled to disk next to the
    // notebook (see persistStreamText) and the envelope carries the path, so
    // the agent reads details on demand instead of pulling bytes into context.
    function mergeStreams(outputs, capLen) {
      capLen = capLen || ENVELOPE_STREAM_CAP
      let stdout = ""
      let stderr = ""
      let streamTruncated = false
      for (const out of outputs || []) {
        if (out && out.type === "stream") {
          const text = String(out.text || "")
          if (out.name === "stderr") stderr += text
          else stdout += text
          if (out.truncated) streamTruncated = true
        }
      }
      // The summary is cut when the merged text exceeds the envelope cap, even
      // if the driver's own (much larger) cap was never hit.
      const summaryTruncated = stdout.length > capLen || stderr.length > capLen
      const smart = function (s) {
        const text = String(s || "")
        if (text.length <= capLen) return text
        const half = Math.floor((capLen - 40) / 2)
        const n = text.length - capLen
        return (
          text.slice(0, half) +
          "\n...[中间省略 " + n + " 字符, " + (text.match(/\n/g) || []).length + " 行]...\n" +
          text.slice(-half)
        )
      }
      return { stdout: smart(stdout), stderr: smart(stderr), truncated: streamTruncated, summaryTruncated }
    }

    // Spill the FULL merged stream text to <nbname>_files/ when the summary
    // was truncated, so the agent can read details on demand.
    async function spillStreamText(cell, outputs, wasTruncated) {
      const out = { stdout_path: null, stderr_path: null }
      if (!wasTruncated) return out
      let stdout = ""
      let stderr = ""
      for (const o of outputs || []) {
        if (o && o.type === "stream") {
          if (o.name === "stderr") stderr += String(o.text || "")
          else stdout += String(o.text || "")
        }
      }
      if (!stdout && !stderr) return out
      const nbPath = state.notebook && state.notebook.path
      let dir
      if (nbPath) {
        dir = join(dirname(nbPath), basename(nbPath, extname(nbPath)) + "_files")
      } else {
        dir = join(notebooksDir(), String(state.sessionId || "session") + "_files")
      }
      try {
        dir = assertNotebookPath(dir, "write")
        await mkdir(dir, { recursive: true })
        if (stdout) {
          const p = join(dir, cell.id + "_stdout.txt")
          await writeFile(p, stdout, "utf8")
          out.stdout_path = p
        }
        if (stderr) {
          const p = join(dir, cell.id + "_stderr.txt")
          await writeFile(p, stderr, "utf8")
          out.stderr_path = p
        }
      } catch {
        /* best-effort spill */
      }
      return out
    }

    // Write display_data / execute_result images to disk next to the notebook
    // (Jupyter <nbname>_files/ convention) so the agent gets a path instead of
    // base64 in context. cell.outputs keeps the base64 for the UI.
    async function persistImages(cell, outputs) {
      const saved = []
      if (!outputs || !outputs.length) return saved
      const nbPath = state.notebook && state.notebook.path
      let dir
      if (nbPath) {
        dir = join(dirname(nbPath), basename(nbPath, extname(nbPath)) + "_files")
      } else {
        dir = join(notebooksDir(), String(state.sessionId || "session") + "_files")
      }
      try {
        dir = assertNotebookPath(dir, "write")
        await mkdir(dir, { recursive: true })
      } catch {
        return saved
      }
      const mimeOrder = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"]
      const extFor = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" }
      let idx = 0
      for (const out of outputs) {
        if (out && (out.type === "display_data" || out.type === "execute_result")) {
          const data = out.data || {}
          for (const mime of mimeOrder) {
            const raw = data[mime]
            if (raw == null) continue
            const fname = cell.id + "_" + idx + "." + extFor[mime]
            const fpath = join(dir, fname)
            try {
              if (mime === "image/svg+xml") await writeFile(fpath, String(raw), "utf8")
              else await writeFile(fpath, Buffer.from(String(raw), "base64"))
              saved.push({ index: idx, mime, path: fpath, bytes: statSync(fpath).size })
            } catch {
              /* best-effort */
            }
          }
        }
        idx++
      }
      return saved
    }

    // Persist one execution record per cell (feeds #3 history UI and #6 replay).
    function recordExecution(cell, envelope) {
      ensureDshMeta(cell)
      const execs = (cell.metadata.dsh.executions = cell.metadata.dsh.executions || [])
      execs.push({
        at: nowIso(),
        execution_count: envelope.execution_count,
        status: envelope.status,
        duration_ms: envelope.duration_ms,
        kernel_state: envelope.kernel_state,
        outputs_summary: envelope.outputs_summary,
        truncated: !!envelope.truncated,
        error: envelope.error ? { ename: envelope.error.ename, evalue: envelope.error.evalue } : null,
      })
      if (execs.length > MAX_EXECUTIONS_PER_CELL) execs.splice(0, execs.length - MAX_EXECUTIONS_PER_CELL)
      markDirty()
      return execs.length - 1
    }

    // Build the canonical execution envelope returned by every run tool.
    async function buildEnvelope(cell, res, opts) {
      opts = opts || {}
      const outputs = res.outputs || cell.outputs || []
      const merged = mergeStreams(outputs)
      const images = await persistImages(cell, outputs)
      // Full merged text spills to disk when the summary was cut (envelope cap)
      // OR the driver itself truncated (500k cap).
      const spill = await spillStreamText(cell, outputs, merged.summaryTruncated || merged.truncated)
      const err = res.error || lastErrorFromCell(cell)
      const status = cell.status || res.status || (err ? "error" : "ok")
      const kernel_state =
        res.kernel_state ||
        (state.kernel.alive ? (status === "ok" ? "idle" : "error") : "dead")
      const envelope = {
        ok: status === "ok",
        cell_id: cell.id,
        execution_count: cell.execution_count == null ? null : cell.execution_count,
        status,
        duration_ms: cell.durationMs == null ? null : cell.durationMs,
        kernel_state,
        stdout: merged.stdout,
        stderr: merged.stderr,
        stdout_path: spill.stdout_path,
        stderr_path: spill.stderr_path,
        outputs_summary: outputSummary(outputs),
        images,
        error: err
          ? { ename: err.ename || "Error", evalue: err.evalue || "", traceback_preview: (err.traceback || []).slice(-3) }
          : null,
        traceback_text: err && err.traceback ? String(err.traceback.join("\n")) : null,
        truncated: merged.summaryTruncated || merged.truncated || !!(res.truncated),
      }
      if (opts.includeOutputs) envelope.outputs = outputs
      envelope.execution_index = recordExecution(cell, envelope)
      // Backward-compatible fields (UI / older callers).
      envelope.cell = compactCell(cell)
      envelope.current = compactContext(false)
      return envelope
    }

    function cancelQueuedCells() {
      for (const cell of state.notebook.cells || []) {
        if (cell.status === "queued") {
          cell.status = cell.execution_count ? "ok" : "idle"
          cell.queuedAt = null
          cell.startedAt = null
        }
      }
    }

    async function executeOne(cell, args) {
      const gen = state.runGen
      await ensureKernel()
      if (state.runGen !== gen || cell.status !== "queued") return { cell, current: snapshotFast() }
      cell.status = "running"
      cell.startedAt = Date.now()
      cell.outputs = []
      markDirty()
      const sc = await ensureSidecar()
      const timeout = getNotebookExecutionTimeout(args && args.timeout)
      const t0 = Date.now()
      let res
      try {
        res = await sc.request(
          "execute",
          { code: cell.source, timeout },
          (timeout + 15) * 1000,
          {
            onProgress: function (msg) {
              if (state.runGen !== gen || cell.status !== "running") return
              if (msg && msg.outputs) applyOutputs(cell, msg.outputs)
            },
          }
        )
      } catch (error) {
        if (state.managed !== true || !/^sidecar timeout: execute$/.test(String(error && error.message || error))) throw error
        const certificate = await stopOneSidecar(state, "sidecar")
        state.kernel.alive = false
        throw new Error("Notebook execute sidecar timed out; forced stop certificate=" + JSON.stringify(certificate))
      }
      if (state.runGen !== gen) return { cell, current: snapshotFast() }
      cell.durationMs = Date.now() - t0
      cell.startedAt = null
      cell.queuedAt = null
      if (!res || !res.ok) {
        if (state.managed === true) {
          try {
            await stopOneSidecar(state, "sidecar")
          } catch (stopError) {
            throw new AggregateError([new Error((res && res.error) || "execute failed"), stopError], "Notebook execute failed and sidecar stop was not certified")
          }
        }
        state.kernel.alive = false
        cell.status = "error"
        applyOutputs(cell, [{ type: "error", error: { ename: "SidecarError", evalue: (res && res.error) || "execute failed", traceback: [] } }])
        return buildEnvelope(cell, { status: "error", error: (res && res.error) ? { ename: "SidecarError", evalue: res.error, traceback: [] } : null }, args)
      }
      cell.status = res.status === "ok" ? "ok" : "error"
      if (res.kernel_state === "dead") state.kernel.alive = false
      applyOutputs(cell, res.outputs || [])
      if (res.error && !(cell.outputs || []).some((o) => o.type === "error" || o.error)) {
        cell.outputs.push({ type: "error", error: res.error })
      }
      if (res.execution_count != null) cell.execution_count = res.execution_count
      return buildEnvelope(cell, res, args)
    }

    // LOCAL PATCH: in-flight run jobs live in this side Map keyed by cell id.
    // Upstream stored the Promise on `cell._runJob`, which leaked a live
    // Promise into snapshots and tool returns — the agent-tool pipeline
    // validates lossless JSON and correctly rejects it.
    const runJobs = new Map()

    function enqueueRun(cell, args) {
      if (cell.status === "queued" || cell.status === "running") {
        // Same cell already queued/running: wait for the in-flight job so a
        // wait:true caller receives the real envelope, not an immediate stub.
        const inFlight = runJobs.get(cell.id)
        if (inFlight) return inFlight
        return Promise.resolve({ cell, current: snapshotFast() })
      }
      cell.status = "queued"
      cell.queuedAt = Date.now()
      cell.startedAt = null
      const queuedGen = state.runGen
      const job = state.execQueue.then(async function () {
        // A variable probe that started first owns the kernel briefly; queue the
        // user's cell behind it rather than letting both commands overlap.
        if (state.probeActive && state.probeDone) await state.probeDone
        if (state.runGen !== queuedGen || cell.status !== "queued") return { cell, current: snapshotFast() }
        return executeOne(cell, args)
      }).catch(function (err) {
        cell.status = "error"
        cell.startedAt = null
        cell.queuedAt = null
        applyOutputs(cell, [{ type: "error", error: { ename: "SidecarError", evalue: String(err && err.message ? err.message : err), traceback: [] } }])
        return buildEnvelope(cell, { status: "error", error: { ename: "SidecarError", evalue: String(err && err.message ? err.message : err), traceback: [] } }, args)
      })
      runJobs.set(cell.id, job)
      job.then(
        function () { if (runJobs.get(cell.id) === job) runJobs.delete(cell.id) },
        function () { if (runJobs.get(cell.id) === job) runJobs.delete(cell.id) }
      )
      state.execQueue = job.then(function () {}, function () {})
      return job
    }

    async function runCell(args) {
      const cell = findCell(args && args.cellId)
      if (!cell) throw new Error("cell not found: " + (args && args.cellId))
      if (cell.cell_type !== "code") return { cell, skipped: true, current: snapshotFast() }
      const wait = !!(args && args.wait)
      const job = enqueueRun(cell, args)
      if (wait) return job
      return { queued: true, cellId: cell.id, current: snapshotFast() }
    }

    async function runAll(args) {
      const wait = !!(args && args.wait)
      const jobs = []
      for (const cell of state.notebook.cells) {
        if (cell.cell_type !== "code") continue
        jobs.push(enqueueRun(cell, args))
      }
      const settle = async function () {
        const results = []
        for (const job of jobs) {
          const r = await job
          results.push(r && r.cell_id ? r : { cell_id: r.cell && r.cell.id, status: r.cell && r.cell.status, current: r.current })
          if (r && r.cell && r.cell.status === "error") {
            cancelQueuedCells()
            bumpRunGen()
            break
          }
        }
        return { results, current: snapshotFast() }
      }
      if (wait) return settle()
      settle().catch(function () {})
      return { queued: true, current: snapshotFast() }
    }

    async function recordSuggestion(args) {
      const cell = findCell(args && args.cellId)
      if (!cell) throw new Error("cell not found: " + (args && args.cellId))
      ensureDshMeta(cell)
      const text = String((args && args.text) || "").trim()
      if (!text) throw new Error("empty suggestion")
      cell.metadata.dsh.suggestions.push({ at: nowIso(), text })
      markDirty()
      return { ok: true, cell, current: snapshotPublic() }
    }

    async function applySuggestion(args) {
      const rec = await recordSuggestion(args)
      return {
        ok: true,
        prompt:
          "[notebook] 对 cell `" +
          (args && args.cellId) +
          "` 的修改意见：" +
          String((args && args.text) || "").trim() +
          "。请优先用 nb_edit_and_run_cell 按意见安全修改并立即重跑该 cell；如需分步调试，再用 nb_edit_cell 后接 nb_run_cell。当前代码：\n```python\n" +
          rec.cell.source +
          "\n```",
        current: snapshotPublic(),
      }
    }

    function resetPendingCells() {
      bumpRunGen()
      for (const cell of state.notebook.cells || []) {
        if (cell.status === "queued" || cell.status === "running") {
          cell.status = cell.execution_count ? "ok" : "idle"
          cell.startedAt = null
          cell.queuedAt = null
        }
      }
    }

    function clearAllOutputs() {
      bumpRunGen()
      for (const cell of state.notebook.cells || []) {
        if (cell.cell_type !== "code") continue
        cell.status = "idle"
        cell.execution_count = null
        cell.outputs = []
        cell.durationMs = null
        cell.startedAt = null
        cell.queuedAt = null
      }
      markDirty()
      return snapshotPublic()
    }

    async function kernelRestart() {
      resetPendingCells()
      const sc = await ensureSidecar()
      try {
        await sc.request("interrupt", {}, 4000)
      } catch {
        /* interrupt is best-effort before restart */
      }
      if (state.kernel.alive) {
        await sc.request("restart", {}, 30000)
      } else {
        await ensureKernel()
      }
      state.kernel.alive = true
      return { ok: true, current: snapshotPublic() }
    }

    async function kernelInterrupt() {
      if (!state.kernel.alive) return { ok: false, error: "kernel not running", current: snapshotPublic() }
      const sc = await ensureSidecar()
      await sc.request("interrupt", {}, 10000)
      return { ok: true, current: snapshotPublic() }
    }

    async function kernelRestartAndRunAll(args) {
      await kernelRestart()
      return runAll(args || {})
    }

    async function kernelRestartAndClear() {
      const snap = clearAllOutputs()
      await kernelRestart()
      return { ok: true, current: snapshotPublic() || snap }
    }

    async function kernelStatus() {
      return snapshotPublic()
    }

    async function completeCode(args) {
      await ensureKernel()
      const sc = await ensureSidecar()
      const code = String((args && args.code) || "")
      const cursorPos = args && args.cursor_pos != null ? Number(args.cursor_pos) : code.length
      const res = await sc.request(
        "complete",
        { code, cursor_pos: cursorPos, timeout: (args && args.timeout) || 5 },
        8000
      )
      if (!res || !res.ok) throw new Error((res && res.error) || "complete failed")
      return {
        matches: res.matches || [],
        items: res.items || [],
        cursor_start: res.cursor_start,
        cursor_end: res.cursor_end,
        status: res.status || "ok",
      }
    }

    async function inspectCode(args) {
      await ensureKernel()
      const sc = await ensureSidecar()
      const code = String((args && args.code) || "")
      const cursorPos = args && args.cursor_pos != null ? Number(args.cursor_pos) : code.length
      const res = await sc.request(
        "inspect",
        {
          code,
          cursor_pos: cursorPos,
          detail_level: (args && args.detail_level) || 0,
          timeout: (args && args.timeout) || 5,
        },
        8000
      )
      if (!res || !res.ok) throw new Error((res && res.error) || "inspect failed")
      return {
        found: !!res.found,
        data: res.data || {},
        status: res.status || "ok",
      }
    }

    function variableProbeBlockReason() {
      if (state.managed === true && getNotebookBoundaryCarrier()?.storage.getStore()?.operation !== "shell") {
        return { status: "scope_required", error: "shell_scope_required", message: "Live variable inspection requires the current Notebook shell scope; no kernel request was sent." }
      }
      if (!state.kernel.alive || !state.sidecar || state.sidecar.exited || state.sidecar.stopping) {
        return { status: "not_started", error: "kernel_not_started", message: "Notebook kernel is not running; variable inspection will not start one automatically." }
      }
      if (state.kernel.starting) {
        return { status: "busy", error: "kernel_starting", message: "Notebook kernel is starting; retry after it becomes ready." }
      }
      if (state.probeActive) {
        return { status: "busy", error: "probe_busy", message: "A variable inspection is already running; retry shortly." }
      }
      const activeCell = (state.notebook.cells || []).find((cell) => cell.status === "running" || cell.status === "queued")
      if (activeCell) {
        return { status: "busy", error: "kernel_busy", message: "Notebook kernel is executing cell " + activeCell.id + "; variable inspection was not queued." }
      }
      return null
    }

    async function listVars(args) {
      const blocked = variableProbeBlockReason()
      if (blocked) return Object.assign({ vars: [], total: 0, offset: 0, next_offset: null, truncated: false }, blocked)
      const opts = args || {}
      state.probeActive = true
      let releaseProbe
      state.probeDone = new Promise((resolve) => { releaseProbe = resolve })
      try {
        const sc = state.sidecar
        const res = await sc.request("list_vars", {
          pattern: opts.pattern,
          offset: opts.offset,
          limit: opts.limit,
          max_chars: opts.max_chars,
        }, 15000)
        if (!res || !res.ok) return { status: (res && res.status) || "error", error: (res && res.error) || "list_vars failed", vars: [], total: 0, offset: 0, next_offset: null, truncated: false }
        return {
          status: res.status || "ok",
          source: res.source || "kernel_snapshot",
          kernel_state: res.kernel_state || state.kernel.language || "unknown",
          vars: res.vars || [],
          total: Number.isFinite(res.total) ? res.total : (res.vars || []).length,
          offset: Number.isFinite(res.offset) ? res.offset : 0,
          next_offset: Number.isFinite(res.next_offset) ? res.next_offset : null,
          truncated: !!res.truncated,
          message: res.message || null,
        }
      } catch (e) {
        return { status: "error", error: String(e && e.message ? e.message : e), vars: [], total: 0, offset: 0, next_offset: null, truncated: false }
      } finally {
        state.probeActive = false
        state.probeDone = null
        releaseProbe()
      }
    }

    async function inspectObject(args) {
      const name = String((args && args.name) || "").trim()
      if (!name) return { status: "error", found: false, error: "name_required" }
      if (name.length > 256 || /[\u0000-\u001f]/.test(name)) return { status: "error", found: false, name: name.slice(0, 256), error: "invalid_name" }
      const blocked = variableProbeBlockReason()
      if (blocked) return Object.assign({ found: false, name }, blocked)
      const opts = args || {}
      state.probeActive = true
      let releaseProbe
      state.probeDone = new Promise((resolve) => { releaseProbe = resolve })
      try {
        const sc = state.sidecar
        const res = await sc.request("inspect_object", {
          name,
          preview: opts.preview === true,
          rows: opts.rows,
          columns: opts.columns,
          max_chars: opts.max_chars,
        }, 20000)
        if (!res || !res.ok) return { status: (res && res.status) || "error", found: false, name, error: (res && res.error) || "inspect_object failed" }
        const out = Object.assign({}, res)
        delete out.ok
        return out
      } catch (e) {
        return { status: "error", found: false, name, error: String(e && e.message ? e.message : e) }
      } finally {
        state.probeActive = false
        state.probeDone = null
        releaseProbe()
      }
    }

    function compactCell(cell) {
      const err = lastErrorFromCell(cell)
      return {
        id: cell.id,
        cell_type: cell.cell_type || "code",
        execution_count: cell.execution_count == null ? null : cell.execution_count,
        status: cell.status || "idle",
        durationMs: cell.durationMs == null ? null : cell.durationMs,
        source_sha256: sha256(cell.source || ""),
        source_preview: sourcePreview(cell.source || ""),
        outputs_summary: outputSummary(cell.outputs || []),
        last_error: err ? { ename: err.ename || "Error", evalue: err.evalue || "", traceback_preview: (err.traceback || []).slice(-3) } : null,
        versions: (((cell.metadata || {}).dsh || {}).versions || []).length,
        executions: (((cell.metadata || {}).dsh || {}).executions || []).length,
        suggestions: (((cell.metadata || {}).dsh || {}).suggestions || []).length,
      }
    }

    function recentError() {
      for (let i = (state.notebook.cells || []).length - 1; i >= 0; i--) {
        const cell = state.notebook.cells[i]
        const err = lastErrorFromCell(cell)
        if (err) return { cellId: cell.id, execution_count: cell.execution_count == null ? null : cell.execution_count, error: err }
      }
      return null
    }

    function compactContext(includeVariables, variables) {
      const out = {
        path: state.notebook.path || null,
        dirty: !!state.notebook.dirty,
        savedAt: state.savedAt || null,
        cwd: state.cwd || null,
        cwdSource: state.cwdSource || "default",
        workspaceRoot: state.workspaceRoot || initialWorkspaceRoot || null,
        kernel: {
          alive: !!state.kernel.alive,
          interpreter: state.kernel.interpreter || null,
          name: state.kernel.name || null,
          id: state.kernel.id || null,
          starting: !!state.kernel.starting,
          busy: (state.notebook.cells || []).some((c) => c.status === "running" || c.status === "queued"),
        },
        cells: (state.notebook.cells || []).map(compactCell),
        recent_error: recentError(),
      }
      if (includeVariables) out.variables = variables || []
      return out
    }

    async function notebookContext(args) {
      const includeVariables = !(args && args.includeVariables === false)
      let variables = []
      let variableInspection = null
      const liveProbeBlocked = state.managed === true && getNotebookBoundaryCarrier()?.storage.getStore()?.operation !== "shell"
      if (includeVariables && liveProbeBlocked) {
        variableInspection = { status: "scope_required", message: "Live variables require the current Notebook shell scope; notebook metadata was returned without a kernel request." }
      } else if (includeVariables) {
        try {
          const got = await listVars(args)
          variables = got.vars || []
          variableInspection = {
            status: got.status || "ok",
            source: got.source || null,
            total: got.total || 0,
            offset: got.offset || 0,
            next_offset: got.next_offset == null ? null : got.next_offset,
            truncated: !!got.truncated,
            message: got.message || got.error || null,
          }
        } catch (e) {
          variableInspection = { status: "error", message: String(e && e.message ? e.message : e) }
        }
      }
      const out = compactContext(includeVariables, variables)
      if (includeVariables) out.variable_inspection = variableInspection
      return out
    }

    async function errorContext(args) {
      const requested = args && args.cellId ? findCell(args.cellId) : null
      let cell = requested
      if (!cell) {
        const rec = recentError()
        if (rec) cell = findCell(rec.cellId)
      }
      if (!cell) throw new Error("no error cell found")
      const err = lastErrorFromCell(cell)
      if (!err) throw new Error("cell has no error output: " + cell.id)
      let variables = []
      if (state.managed !== true || getNotebookBoundaryCarrier()?.storage.getStore()?.operation === "shell") {
        try {
          const got = await listVars()
          variables = got.vars || []
        } catch (e) {
          variables = [{ error: String(e && e.message ? e.message : e) }]
        }
      }
      const idx = (state.notebook.cells || []).findIndex((c) => c.id === cell.id)
      const previous_cells = (state.notebook.cells || []).slice(Math.max(0, idx - 5), idx).map(compactCell)
      const next_cells = (state.notebook.cells || []).slice(idx + 1, idx + 3).map(compactCell)
      return {
        cellId: cell.id,
        execution_count: cell.execution_count == null ? null : cell.execution_count,
        source: cell.source || "",
        source_sha256: sha256(cell.source || ""),
        error: err,
        traceback_text: (err.traceback || []).join("\n"),
        previous_cells,
        next_cells,
        variables,
        current: compactContext(false),
      }
    }

    async function editAndRunCell(args) {
      await editCell(args)
      return runCell(Object.assign({}, args || {}, { wait: true }))
    }

    function listSessionKernels() {
      return listKernels(state.managed === true).map(publicKernel)
    }

    async function selectKernel(args) {
      const kernels = listKernels(state.managed === true)
      let entry = null
      if (state.managed === true) {
        if (args && args.id) entry = kernels.find((k) => k.id === args.id)
        if (!entry && args && (args.python || args.interpreter)) {
          const wanted = args.python || args.interpreter
          entry = kernels.find((k) => k.python === wanted || k.interpreter === wanted)
        }
        if (!entry && args && args.name) entry = kernels.find((k) => k.name === args.name)
        if (!entry && !(args && (args.id || args.name || args.python || args.interpreter))) entry = kernels[0]
      }
      else {
        if (args && args.id) entry = kernels.find((k) => k.id === args.id)
        if (!entry && args && (args.python || args.interpreter)) {
          const wanted = args.python || args.interpreter
          entry = kernels.find((k) => k.python === wanted || k.interpreter === wanted)
        }
        if (!entry && args && args.name) entry = kernels.find((k) => k.name === args.name)
        if (!entry && args && args.python && existsSync(args.python)) {
          entry = {
            id: "custom:" + args.python,
            name: basename(args.python),
            kind: "custom",
            language: "python",
            prefix: dirname(args.python),
            python: args.python,
            interpreter: args.python,
            hasIpykernel: true,
            hasKernel: true,
            display: args.python,
          }
        }
      }
      if (!entry) throw new Error("kernel not found")
      const requested = args && (args.id || args.name || args.python || args.interpreter)
      if (state.managed === true && requested && requested !== entry.id && requested !== entry.name && requested !== entry.python && requested !== entry.interpreter) throw new Error("只允许选择当前已核验 Notebook kernel")
      resetPendingCells()
      await killSidecar()
      state.kernel = {
        alive: false,
        starting: false,
        entry,
        language: entry.language || "python",
        interpreter: entry.interpreter || entry.python,
        driverPython: null,
        name: entry.name,
        id: entry.id,
        stopState: null,
      }
      await ensureKernel()
      if (state.notebook.metadata) {
        state.notebook.metadata.kernelspec = {
          display_name: entry.name,
          language: entry.language || "python",
          name: entry.name,
        }
        markDirty()
      }
      return snapshotPublic()
    }

    return {
      notebooksDir, pythonExe, driverPython, kernelEntry, killSidecar, ensureSidecar, ensureKernel, findCell,
      snapshotPublic, snapshotFast, listDir, listNotebooks, setCwd, syncSessionCwd,
      newNotebook, openNotebook, saveNotebook, addCell, deleteCell, moveCell,
      pushCellVersion, editCell, cellHistory, revertCell, bumpRunGen, markDirty,
      scheduleAutoSave, applyOutputs, cancelQueuedCells, executeOne, enqueueRun,
      runCell, runAll, recordSuggestion, applySuggestion, resetPendingCells,
      clearAllOutputs, kernelRestart, kernelInterrupt, kernelRestartAndRunAll,
      kernelRestartAndClear, kernelStatus, completeCode, inspectCode, listVars,
      inspectObject, compactCell, recentError, compactContext, notebookContext,
      errorContext, editAndRunCell, selectKernel,
      listSessionKernels,
    }
  }

  function registerTool(name, description, parameters, execute) {
    const tool = defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: "json" },
        render: function (_args, value) {
          return [{ type: "text", text: JSON.stringify(value, null, 2) }]
        },
      },
      execute: async function (args, exec) {
        const callingAgent = exec && exec.agent
        const session = callingAgent && callingAgent.session
        const hostManaged = isManagedAgent(callingAgent)
        let managed = hostManaged
        const rawSid = session && session.id
        if (managed && (typeof rawSid !== "string" || rawSid.trim() === "")) {
          throw new Error("托管 Notebook 工具缺少可信 session id，拒绝回退到 default")
        }
        const sid = typeof rawSid === "string" && rawSid.trim() !== "" ? rawSid : "default"
        const cwdHint = session && session.header && session.header.cwd
        const toolKind = getNotebookToolClass(name)
        const explicitReplace = name === "nb_new" || name === "nb_open"
        const hadState = sessions.has(sid) || retainedNotebooks.has(sid)
        const readContext = sid === "default"
          ? undefined
          : await resolveNotebookReadContext(sid, undefined, resolveFallbackNotebookContext, exec?.signal)
        const routerDraft = readContext?.routerDraft === true
        const contextManaged = readContext?.managed === true
        managed = hostManaged || contextManaged || routerDraft
        const managedRootMemory = managed && routerDraft
          && ROOT_NOTEBOOK_TOOLS.has(name) && toolKind === "control" && !requiresNotebookSidecar(name)
        if (managed && !managedRootMemory && readContext === undefined) {
          throw new Error("托管 Notebook 缺少可信 Host session context；拒绝作为当前任务执行")
        }
        const scope = managed && !managedRootMemory ? assertNotebookToolScope(name) : undefined
        if (scope !== undefined) assertNotebookReadContextMatches(readContext, scope)
        if (managed && !managedRootMemory && contextManaged !== true) {
          throw new Error("托管 Notebook 缺少当前任务 marker；拒绝把普通 Host session 当作当前任务")
        }
        let initial
        if (!explicitReplace && readContext !== undefined) {
          initial = await loadPersistedSession(sid, cwdHint, readContext)
        }
        const st = initial || getSession(sid, cwdHint)
        await prepareNotebookContext(st, readContext, {
          allowReset: explicitReplace,
          initialize: !hadState,
        })
        // A missing/temporarily unloaded Host agent must never erase managed provenance.
        managed = readContext === undefined ? managed || st.managed === true : managed
        if (st.managed !== managed) {
          await stopForContextReset(st)
          st.managed = managed
        }
        // Remember the delegating session so a subagent's default kernel can
        // inherit the environment its parent chose, matching what envsel does
        // for the shell tools.
        const parent = session && session.header && session.header.parentSession
        if (parent) sessionParents.set(String(sid), String(parent))
        // Seed a brand-new state with the calling session's real cwd. Doing it
        // here means one change instead of threading a hint through every
        // registerTool call site.
        if ((st.inactive || st.readOnlySnapshot) && !READ_ONLY_SNAPSHOT_TOOLS.has(name)) {
          throw new Error("历史 Notebook 数据视图只读；请新建或显式打开 .ipynb 后再编辑或计算")
        }
        if (name === "nb_new" && (st.inactive || st.readOnlySnapshot)) {
          const nextCwd = managed && !managedRootMemory ? scope.cwd : (cwdHint || initialWorkspaceRoot)
          st.cwd = nextCwd
          st.workspaceRoot = nextCwd
          st.cwdSource = "session"
        }
        if (managed && !managedRootMemory) {
          const computeScopeKey = getNotebookComputeScopeKey(scope)
          if (st.sidecar && !st.sidecar.exited && !st.sidecar.stopping && st.sidecar.scopeKey !== computeScopeKey) {
            await stopOneSidecar(st, "sidecar")
          }
        }
        if (st.cwdSource === "default" || st.cwdSource === "session") {
          st.cwd = managed && !managedRootMemory ? scope.cwd : (cwdHint || st.workspaceRoot || initialWorkspaceRoot)
          st.workspaceRoot = st.cwd
          st.cwdSource = "session"
        }
        const toolClass = toolKind || "control"
        const requestedPath = args && (args.path || args.dir)
        if (managed && !managedRootMemory && requestedPath !== undefined && toolClass !== "control") {
          assertNotebookPath(pathResolve(String(requestedPath)), toolClass === "file-write" ? "write" : "read")
        }
        try {
          const result = await execute(args, sid, exec, scope)
          if (READ_CONTEXT_RECHECK_TOOLS.has(name)) {
            await assertNotebookContextCurrent(sid, scope, readContext, exec?.signal)
          }
          return result
        } finally {
          if (managed && !managedRootMemory && (toolClass === "file-read" || toolClass === "file-write")) await stopOneSidecar(st, "fileSidecar")
          else if (managed && !managedRootMemory && toolClass === "execution" && scope.mode === "write") await stopOneSidecar(st, "sidecar")
        }
      },
    })
    ctx.effect(function () {
      return ctx.tools.register(tool, { when: function (context) { return isNotebookToolVisible(name, context && context.agent) } })
    })
  }

  registerTool(
    "nb_list",
    "List .ipynb files under the workspace notebooks/ directory and return the current in-memory notebook snapshot.",
    {},
    (args, sid) => createSessionMethods(sid).listNotebooks(args)
  )
  registerTool(
    "nb_new",
    "Create a new empty in-memory notebook (one blank code cell). Does not write disk until nb_save.",
    { title: { type: "string", description: "Optional notebook title." } },
    (args, sid) => createSessionMethods(sid).newNotebook(args)
  )
  registerTool(
    "nb_open",
    "Open a .ipynb file into the current notebook editor (replaces the in-memory notebook).",
    { path: { type: "string", required: true, description: "Absolute or workspace-relative .ipynb path." } },
    (args, sid) => createSessionMethods(sid).openNotebook(args)
  )
  registerTool(
    "nb_save",
    "Save the current notebook as a standard .ipynb (cell.metadata.dsh keeps suggestion/version history).",
    {
      path: { type: "string", description: "Destination path; defaults to last opened path or notebooks/<title>.ipynb." },
      name: { type: "string", description: "File name without directory (used when path is omitted)." },
      dir: { type: "string", description: "Directory to save into when path is omitted." },
    },
    (args, sid) => createSessionMethods(sid).saveNotebook(args)
  )
  registerTool(
    "nb_add_cell",
    "Insert a code or markdown cell after a given cell (or at the end).",
    {
      after: { type: "string", description: "Insert after this cell id; omit to append." },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type; defaults to code." },
      source: { type: "string", description: "Initial cell source." },
    },
    (args, sid) => createSessionMethods(sid).addCell(args)
  )
  registerTool(
    "nb_delete_cell",
    "Delete a cell by id. Refuses to delete the last remaining cell.",
    { cellId: { type: "string", required: true, description: "Cell id to delete." } },
    (args, sid) => createSessionMethods(sid).deleteCell(args)
  )
  registerTool(
    "nb_move_cell",
    "Move a cell up (dir = -1) or down (dir = 1) in the notebook ordering.",
    {
      cellId: { type: "string", required: true, description: "Cell id to move." },
      dir: { type: "integer", description: "1 to move down, -1 to move up." },
    },
    (args, sid) => createSessionMethods(sid).moveCell(args)
  )
  registerTool(
    "nb_edit_cell",
    "Replace a cell's source (records a version snapshot in cell.metadata.dsh.versions). Use after a user modification suggestion.",
    {
      cellId: { type: "string", required: true, description: "Cell id to edit." },
      source: { type: "string", required: true, description: "Full replacement source." },
      reason: { type: "string", description: "Why this edit happened (e.g. the user suggestion)." },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Optionally change cell type." },
    },
    (args, sid) => createSessionMethods(sid).editCell(args)
  )
  registerTool(
    "nb_run_cell",
    "Execute one code cell against the live Jupyter kernel (Python/ipykernel, or an R kernel such as IRkernel). State persists across cells. Returns a structured execution envelope: status, execution_count, duration_ms, kernel_state, merged stdout/stderr (head+tail, capped), outputs_summary, image paths (saved to <notebook>_files/), error + traceback_text, and execution_index. Long stream output is spilled to stdout_path/stderr_path files - read those files for full output instead of requesting include_outputs.",
    {
      cellId: { type: "string", required: true, description: "Cell id to run." },
      timeout: { type: "integer", description: "Seconds; defaults to 180. Values above 180 are clamped." },
      includeOutputs: { type: "boolean", description: "Include the full raw outputs array in the envelope (large; prefer reading stdout_path/stderr_path). Defaults to false." },
    },
    (args, sid) => createSessionMethods(sid).runCell(Object.assign({}, args || {}, { wait: true }))
  )
  registerTool(
    "nb_run_all",
    "Run every code cell from top to bottom against the live Jupyter kernel. On error, remaining queued cells are cancelled (VS Code jupyter.stopOnError). Returns an array of per-cell execution envelopes (results[].status / cell_id / error / stdout / stderr / images).",
    { includeOutputs: { type: "boolean", description: "Include full raw outputs in each envelope. Defaults to false." } },
    (args, sid) => createSessionMethods(sid).runAll(Object.assign({}, args || {}, { wait: true }))
  )
  registerTool(
    "nb_apply_suggestion",
    "Record a per-cell modification suggestion and return a prompt the agent should follow: edit that cell then rerun it.",
    {
      cellId: { type: "string", required: true, description: "Target cell id." },
      text: { type: "string", required: true, description: "The user's modification suggestion." },
    },
    (args, sid) => createSessionMethods(sid).applySuggestion(args)
  )
  registerTool(
    "nb_kernel_restart",
    "Restart the live Jupyter kernel (clears all variables). Cancels queued/running cells but keeps completed outputs, like VS Code Restart Kernel.",
    {},
    (args, sid) => createSessionMethods(sid).kernelRestart()
  )
  registerTool(
    "nb_kernel_restart_and_run_all",
    "Restart the kernel then run every code cell from top to bottom.",
    {},
    (args, sid) => createSessionMethods(sid).kernelRestartAndRunAll(args)
  )
  registerTool(
    "nb_kernel_restart_and_clear",
    "Restart the kernel and clear all cell outputs and execution counts (VS Code Restart & Clear Output).",
    {},
    (args, sid) => createSessionMethods(sid).kernelRestartAndClear()
  )
  registerTool(
    "nb_clear_outputs",
    "Clear all code-cell outputs and execution counts without restarting the kernel.",
    {},
    (args, sid) => ({ ok: true, current: createSessionMethods(sid).clearAllOutputs() })
  )
  registerTool(
    "nb_kernel_interrupt",
    "Interrupt the currently executing cell.",
    {},
    (args, sid) => createSessionMethods(sid).kernelInterrupt()
  )
  registerTool(
    "nb_kernel_list",
    "List discoverable kernels and report each one's language: Python conda envs (with whether ipykernel and jupyter_client are installed) and R kernels (IRkernel found via a user or conda kernelspec, or synthesised from an env's R library). `language` is \"python\" or \"r\"; `hasKernel` says whether the kernel can actually start.",
    {},
    (args, sid) => ({
      kernels: createSessionMethods(sid).listSessionKernels(),
      current: createSessionMethods(sid).snapshotPublic(),
    })
  )
  registerTool(
    "nb_kernel_select",
    "Select and start a Jupyter kernel by kernel id, conda env name, or interpreter path. Works for Python and R kernels alike; the notebook's kernelspec language is updated to match. Restarts the sidecar.",
    {
      id: { type: "string", description: "Kernel id from nb_kernel_list." },
      name: { type: "string", description: "Conda env name (as listed by nb_kernel_list)." },
      python: { type: "string", description: "Absolute python.exe path." },
    },
    (args, sid) => createSessionMethods(sid).selectKernel(args)
  )
  registerTool(
    "nb_get",
    "Return the current in-memory notebook (cells, outputs, kernel status, path).",
    {},
    (args, sid) => createSessionMethods(sid).snapshotPublic()
  )
  registerTool(
    "nb_context",
    "Return a compact AI-oriented summary of the notebook: path, kernel, cell states, output summaries, recent error, and live variables.",
    { includeVariables: { type: "boolean", description: "Include live kernel variables; defaults to true." } },
    (args, sid) => createSessionMethods(sid).notebookContext(args)
  )
  registerTool(
    "nb_list_vars",
    "List a bounded page of lightweight live-kernel variable metadata (name, exact type, shape). Does not call repr() or read variable values. Requires an already-running, idle kernel; never starts or interrupts a kernel.",
    {
      pattern: { type: "string", description: "Optional literal, case-insensitive substring filter on variable names." },
      offset: { type: "integer", description: "Zero-based offset for pagination; defaults to 0." },
      limit: { type: "integer", description: "Maximum variables to return (1-200; defaults to 100)." },
      max_chars: { type: "integer", description: "Approximate response text budget (1024-64000; defaults to 16000)." },
    },
    (args, sid) => createSessionMethods(sid).listVars(args)
  )
  registerTool(
    "nb_inspect_object",
    "Inspect one live variable without arbitrary repr/eval. Default returns type/shape only. Set preview=true for a bounded preview of supported exact data types (for example pandas DataFrame or R data.frame); unknown types remain metadata-only. Requires an already-running, idle kernel; never starts or interrupts a kernel.",
    {
      name: { type: "string", required: true, description: "Exact live variable name, e.g. df or adata." },
      preview: { type: "boolean", description: "Explicitly request a small allowlisted preview; defaults to false." },
      rows: { type: "integer", description: "Preview row limit (1-20; defaults to 5)." },
      columns: { type: "integer", description: "Preview column limit (1-50; defaults to 10)." },
      max_chars: { type: "integer", description: "Approximate response text budget (1024-64000; defaults to 16000)." },
    },
    (args, sid) => createSessionMethods(sid).inspectObject(args)
  )
  registerTool(
    "nb_cell_history",
    "Return a cell's DSH version history. Source is omitted by default; pass includeSource=true for full previous code.",
    {
      cellId: { type: "string", required: true, description: "Cell id to inspect." },
      includeSource: { type: "boolean", description: "Include full historical source text; defaults to false." },
    },
    (args, sid) => createSessionMethods(sid).cellHistory(args)
  )
  registerTool(
    "nb_revert_cell",
    "Revert a cell to a previous DSH version by index while recording the current state as a new version.",
    {
      cellId: { type: "string", required: true, description: "Cell id to revert." },
      versionIndex: { type: "integer", required: true, description: "Version index from nb_cell_history." },
      reason: { type: "string", description: "Optional reason recorded in history." },
    },
    (args, sid) => createSessionMethods(sid).revertCell(args)
  )
  registerTool(
    "nb_error_context",
    "Return the latest error (or a specified cell error) with source, traceback, nearby cells, and live variables for an AI repair loop.",
    { cellId: { type: "string", description: "Optional errored cell id. Defaults to the most recent error cell." } },
    (args, sid) => createSessionMethods(sid).errorContext(args)
  )
  registerTool(
    "nb_edit_and_run_cell",
    "Safely replace a cell's source, record a rich version snapshot, then immediately execute that cell and return the structured execution envelope.",
    {
      cellId: { type: "string", required: true, description: "Cell id to edit and run." },
      source: { type: "string", required: true, description: "Full replacement source." },
      reason: { type: "string", description: "Why this edit happened." },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Optionally change cell type." },
      timeout: { type: "integer", description: "Seconds; defaults to 180. Values above 180 are clamped." },
      includeOutputs: { type: "boolean", description: "Include the full raw outputs array in the envelope (large; prefer reading stdout_path/stderr_path). Defaults to false." },
    },
    (args, sid) => createSessionMethods(sid).editAndRunCell(args)
  )
  registerTool(
    "nb_set_cwd",
    "Set the Jupyter kernel working directory (os.getcwd / relative paths). A running kernel is chdir-ed in place, so variables and imports survive; no restart.",
    { dir: { type: "string", required: true, description: "Absolute directory path." } },
    (args, sid) => createSessionMethods(sid).setCwd(args)
  )

  if (webServer) {
    const send = function (res, value, status) {
      res.statusCode = status || 200
      res.setHeader("Content-Type", "application/json; charset=utf-8")
      res.end(JSON.stringify(value))
    }
    ctx.effect(function () {
      return webServer.register({
        kind: "exact",
        path: DOMPURIFY_MODULE_PATH,
        handler: function (req, res) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.statusCode = 405
            res.setHeader("Allow", "GET, HEAD")
            return res.end()
          }
          let body
          try {
            body = readFileSync(DOMPURIFY_MODULE_FILE)
          } catch {
            res.statusCode = 404
            return res.end()
          }
          res.statusCode = 200
          res.setHeader("Content-Type", "text/javascript; charset=utf-8")
          res.setHeader("Cache-Control", "no-cache")
          res.setHeader("X-Content-Type-Options", "nosniff")
          if (req.method === "HEAD") return res.end()
          return res.end(body)
        },
      })
    })
    ctx.effect(function () {
      return webServer.register({
        kind: "prefix",
        path: "/nb",
        handler: async function (req, res) {
          try {
            // Auth fence: the same Host/Origin + session-cookie rejection the
            // platform applies to its own routes (connection.requestRejection,
            // as /api and the open-in-app routes do). Without this, any local
            // process — or any website via a cross-origin form POST — can
            // drive the kernel and execute arbitrary Python.
            if (connection) {
              const rejection = connection.requestRejection(req)
              if (rejection !== undefined) {
                res.statusCode = rejection
                res.end()
                return
              }
            }
            const url = new URL(req.url, "http://localhost")
            const name = url.pathname.replace(/^\/nb\/?/, "")
            if ((req.method === "GET" || req.method === "HEAD") && name === "cm.js") {
              const vendor = join(HERE, "cm-vendor.js")
              if (!existsSync(vendor)) return send(res, { error: "cm vendor missing" }, 404)
              const body = readFileSync(vendor)
              res.statusCode = 200
              res.setHeader("Content-Type", "application/javascript; charset=utf-8")
              res.setHeader("Cache-Control", "no-cache")
              if (req.method === "HEAD") return res.end()
              return res.end(body)
            }
            const body = req.method === "POST" ? await readJson(req) : {}
            const rawSid = name === "shutdownKernel" ? (body.sessionId || body._sid) : body._sid
            const sid = typeof rawSid === "string" && rawSid.trim() !== "" ? rawSid : ""
            if (sid === "") return send(res, { error: "Notebook session id is required" }, 400)
            const sessionAgent = ctx.get("agents")?.get?.(sid)
            const knownAgent = sessionAgent?.id === sid
            const hostManaged = knownAgent && isManagedAgent(sessionAgent)
            const boundaryScope = getNotebookBoundaryCarrier()?.storage.getStore()
            let readContext
            try {
              readContext = await resolveNotebookReadContext(sid, boundaryScope, resolveFallbackNotebookContext)
            } catch (error) {
              return send(res, { error: String(error?.message || error), code: error?.code || "NOTEBOOK_CONTEXT_UNAVAILABLE" }, 403)
            }
            if (readContext === undefined) {
              return send(res, { error: "未知 Notebook session；Host sessionQuery 未找到该会话", code: "NOTEBOOK_CONTEXT_SESSION_NOT_FOUND" }, 403)
            }
            const routerDraft = readContext.routerDraft === true
            const contextManaged = readContext.managed === true
            if (hostManaged && !routerDraft && !contextManaged) {
              return send(res, { error: "托管 Notebook 缺少当前任务 marker；拒绝恢复旧视图", code: "NOTEBOOK_CONTEXT_INVALID" }, 403)
            }
            if (name === "activeKernels") return send(res, activeKernelsFor(sid), 200)
            const explicitReplace = name === "new" || name === "open"
            let existing = sessions.get(sid)
            const retained = readRetainedNotebook(sid)
            if (!existing && !retained) {
              try {
                existing = await loadPersistedSession(
                  sid,
                  readContext.cwd,
                  readContext,
                )
              } catch (error) {
                return send(res, { error: "Notebook 数据快照损坏；拒绝启动 kernel 或访问文件" }, 403)
              }
            }
            if (!existing && !retained && knownAgent) {
              existing = getSession(sid, readContext.cwd)
              await prepareNotebookContext(existing, readContext, { initialize: true })
            } else if ((existing || retained) && !explicitReplace) {
              const state = existing || getSession(sid, readContext.cwd)
              try {
                await prepareNotebookContext(state, readContext, { initialize: false })
              } catch (error) {
                return send(res, { error: String(error?.message || error), code: error?.code || "NOTEBOOK_CONTEXT_INVALID" }, 403)
              }
              existing = state
            }
            if (!existing && !retained && !(explicitReplace && knownAgent)) {
              return send(res, { error: "未知 Notebook session；拒绝启动 kernel 或访问文件" }, 403)
            }
            const managedSession = hostManaged || contextManaged || routerDraft
            if (name === "shutdownKernel") {
              await shutdownNotebookSession(sid)
              const viewSid = typeof body._sid === "string" && body._sid.trim() !== "" ? body._sid : sid
              return send(res, activeKernelsFor(viewSid), 200)
            }
            if (explicitReplace) {
              const state = existing || getSession(sid, readContext.cwd)
              await prepareNotebookContext(state, readContext, { allowReset: true, initialize: true })
              existing = state
            }
            if (!explicitReplace && (!knownAgent || retained || existing?.inactive)) {
              try {
                await assertNotebookContextCurrent(sid, boundaryScope, readContext)
              } catch (error) {
                return send(res, { error: String(error?.message || error), code: error?.code || "NOTEBOOK_CONTEXT_STALE" }, 403)
              }
              const readonly = retained || existing
              if (!readonly) return send(res, { error: "Notebook 快照已过期；该会话仅可查看，不能启动 kernel" }, 403)
              if (!["get", "list", "kernelStatus", "syncSessionCwd", "cellHistory", "kernelList", "cpuInfo"].includes(name)) {
                return send(res, { error: "Notebook 会话已停止；历史 Notebook 仅可查看，不能执行、编辑或保存" }, 403)
              }
              const view = createSessionMethods(sid, readonly)
              if (name === "list") return send(res, { dir: readonly.cwd, notebooks: [], current: view.snapshotFast(), metadataOnly: true }, 200)
              if (name === "cellHistory") return send(res, await view.cellHistory(body), 200)
              if (name === "kernelList") return send(res, { kernels: [], current: view.snapshotFast() }, 200)
              if (name === "cpuInfo") return send(res, { platform: platform(), detected: false, hybrid: false, source: null, detail: null }, 200)
              // syncSessionCwd from the view mount is an observation after unload.
              return send(res, view.snapshotFast(), 200)
            }
            if (name === "cpuInfo") {
              try {
                await assertNotebookContextCurrent(sid, boundaryScope, readContext)
              } catch (error) {
                return send(res, { error: String(error?.message || error), code: error?.code || "NOTEBOOK_CONTEXT_STALE" }, 403)
              }
              if (managedSession) return send(res, { platform: platform(), detected: false, hybrid: false, source: null, detail: null }, 200)
              return send(res, await cpuInfoRoute(sid), 200)
            }
            const sessionStateForMode = getSession(sid, sessionAgent?.session?.header?.cwd)
            if (sessionStateForMode.managed !== managedSession) {
              if (sessionStateForMode.sidecar || sessionStateForMode.fileSidecar) await stopSessionSidecar(sessionStateForMode, "all")
              sessionStateForMode.managed = managedSession
              sessionStateForMode.kernel = {
                alive: false,
                language: null,
                interpreter: null,
                driverPython: null,
                entry: null,
                name: null,
                id: null,
                starting: false,
                stopState: null,
              }
            }
            const routeBoundary = {
              list: "nb_list",
              listDir: "nb_list",
              setCwd: "nb_set_cwd",
              open: "nb_open",
              save: "nb_save",
              runCell: "nb_run_cell",
              runAll: "nb_run_all",
              kernelRestart: "nb_kernel_restart",
              kernelInterrupt: "nb_kernel_interrupt",
              kernelRestartAndRunAll: "nb_kernel_restart_and_run_all",
              kernelRestartAndClear: "nb_kernel_restart_and_clear",
              kernelSelect: "nb_kernel_select",
              editAndRunCell: "nb_edit_and_run_cell",
            }
            // 客户端挂载时先请求 list；没有工具 scope 只返回现有视图，
            // 不把加载页面变成目录遍历，也不把正常的权限限制报成 500。
            if (managedSession && name === "list" && !getNotebookBoundaryCarrier()?.storage.getStore()) {
              try {
                await assertNotebookContextCurrent(sid, boundaryScope, readContext)
              } catch (error) {
                return send(res, { error: String(error?.message || error), code: error?.code || "NOTEBOOK_CONTEXT_STALE" }, 403)
              }
              return send(res, { dir: sessionStateForMode.cwd, notebooks: [], current: createSessionMethods(sid).snapshotFast(), metadataOnly: true }, 200)
            }
            const persistentKernelRoutes = new Set(["runCell", "runAll", "kernelRestart", "kernelInterrupt", "kernelRestartAndRunAll", "kernelRestartAndClear", "editAndRunCell", "complete", "inspect", "listVars", "inspectObject"])
            const sessionState = sessions.get(sid)
            const hasPersistentSidecar = sessionState && sessionState.sidecar && !sessionState.sidecar.exited && !sessionState.sidecar.stopping
              && sessionState.kernel.alive && !sessionState.kernel.starting && !sessionState.inactive
              && sessionState.sidecar.runtime && sessionState.sidecar.runtime.lifecycle === "persistent" && !routerDraft
            const fallbackManagedMutation = contextManaged && !hostManaged
              ? {
                  new: "nb_new",
                  addCell: "nb_add_cell",
                  deleteCell: "nb_delete_cell",
                  moveCell: "nb_move_cell",
                  editCell: "nb_edit_cell",
                  applySuggestion: "nb_apply_suggestion",
                  clearOutputs: "nb_clear_outputs",
                  revertCell: "nb_revert_cell",
                }[name]
              : undefined
            if (fallbackManagedMutation !== undefined) {
              if (!boundaryScope) {
                return send(res, {
                  error: "Host marker 证明这是托管 Notebook，但当前调用没有 execution scope；拒绝降级为 standard",
                  code: "NOTEBOOK_CONTEXT_INVALID",
                }, 403)
              }
              try {
                assertNotebookToolScope(fallbackManagedMutation)
                assertNotebookReadContextMatches(readContext, boundaryScope)
              } catch (error) {
                return send(res, { error: String(error?.message || error), code: error?.code || "NOTEBOOK_CONTEXT_INVALID" }, 403)
              }
            }
            if (managedSession && (routeBoundary[name] || persistentKernelRoutes.has(name)) && !(hasPersistentSidecar && persistentKernelRoutes.has(name))) {
              if (persistentKernelRoutes.has(name)) {
                return send(res, { error: "当前托管会话没有运行中的只读专家 Notebook；owner UI 不会启动 kernel，请切换到已委派的专家 Notebook。" }, 403)
              }
              if (!getNotebookBoundaryCarrier()?.storage.getStore()) return send(res, { error: "文件操作需要当前专家工具的授权；此视图仅展示 Notebook。" }, 403)
              assertNotebookToolScope(routeBoundary[name])
            }
            const m = createSessionMethods(sid)
            const routeMap = {
              list: m.listNotebooks,
              listDir: m.listDir,
              setCwd: m.setCwd,
              syncSessionCwd: m.syncSessionCwd,
              get: async () => m.snapshotFast(),
              new: m.newNotebook,
              open: m.openNotebook,
              save: m.saveNotebook,
              addCell: m.addCell,
              deleteCell: m.deleteCell,
              moveCell: m.moveCell,
              editCell: m.editCell,
              runCell: m.runCell,
              runAll: m.runAll,
              recordSuggestion: m.recordSuggestion,
              applySuggestion: m.applySuggestion,
              kernelRestart: m.kernelRestart,
              kernelInterrupt: m.kernelInterrupt,
              kernelRestartAndRunAll: m.kernelRestartAndRunAll,
              kernelRestartAndClear: m.kernelRestartAndClear,
              clearOutputs: async () => ({ ok: true, current: m.clearAllOutputs() }),
              kernelStatus: m.kernelStatus,
              kernelList: async () => ({
                kernels: m.listSessionKernels(),
                current: m.snapshotPublic(),
              }),
              kernelSelect: m.selectKernel,
              complete: m.completeCode,
              inspect: m.inspectCode,
              context: m.notebookContext,
              listVars: m.listVars,
              inspectObject: m.inspectObject,
              cellHistory: m.cellHistory,
              revertCell: m.revertCell,
              errorContext: m.errorContext,
              editAndRunCell: m.editAndRunCell,
            }
            const fn = routeMap[name]
            if (!fn) return send(res, { error: "unknown endpoint: " + name }, 404)
            const result = await fn(body)
            if (READ_CONTEXT_RECHECK_ROUTES.has(name)) {
              await assertNotebookContextCurrent(sid, boundaryScope, readContext)
            }
            send(res, result, 200)
          } catch (e) {
            send(res, { error: String(e && e.message ? e.message : e) }, 500)
          }
        },
      })
    })
  }

  // Disposal unloads the Host object. Stop its processes, retain bounded data.
  const getNotebookSessionState = (sessionId) => {
    const st = sessions.get(sessionId)
    if (!st) {
      const tombstone = shutdownTombstones.get(sessionId)
      return tombstone === undefined
        ? { managed: null, compute: null, file: null, lastShutdown: null }
        : { managed: tombstone.managed, compute: null, file: null, lastShutdown: tombstone.lastShutdown }
    }
    const summarize = sc => sc === null ? null : {
      lifecycle: sc.runtime?.lifecycle || null,
      exited: sc.exited === true,
      stopping: Boolean(sc.stopping),
      stopState: sc === st.sidecar ? st.kernel.stopState || null : null,
    }
    return {
      managed: st.managed === true,
      compute: summarize(st.sidecar),
      file: summarize(st.fileSidecar),
      lastShutdown: st.lastShutdown,
    }
  }
  const shutdownNotebookSession = async (sessionId) => {
    if (typeof sessionId !== "string" || sessionId.length === 0) throw new Error("Notebook shutdownSession 需要有效 session id")
    const st = sessions.get(sessionId)
    if (!st) {
      const tombstone = shutdownTombstones.get(sessionId)
      return {
        stopped: true,
        certificates: tombstone?.lastShutdown?.certificates || [],
      }
    }
    st.inactive = true
    st.runGen += 1
    if (st.autosaveTimer) { clearTimeout(st.autosaveTimer); st.autosaveTimer = null }
    const certificates = await killSessionSidecar(st)
    // Queued work observes inactive/runGen and cannot resurrect a stopped kernel.
    await st.execQueue
    st.kernel.starting = false
    for (const cell of st.notebook.cells || []) {
      if (cell.status === "queued" || cell.status === "running") {
        cell.status = cell.execution_count ? "ok" : "idle"
        cell.queuedAt = null
        cell.startedAt = null
      }
    }
    const actual = certificates.filter(Boolean)
    if (actual.length > 0 || !st.lastShutdown) {
      st.lastShutdown = {
        at: new Date().toISOString(),
        certificates: actual,
      }
    }
    rememberShutdown(sessionId, st.managed, st.lastShutdown)
    return { stopped: true, certificates: st.lastShutdown.certificates }
  }
  const stopNotebookSession = async (sessionId) => {
    const st = sessions.get(sessionId)
    const result = await shutdownNotebookSession(sessionId)
    if (st && sessions.get(sessionId) === st && st.inactive) {
      rememberNotebook(st)
      sessions.delete(sessionId)
      sessionParents.delete(sessionId)
    }
    return result
  }
  ctx.effect(function () {
    if (globalThis[NOTEBOOK_RUNTIME_KEY] !== undefined) throw new Error("Notebook runtime registry 已被占用")
    const hooks = Object.freeze({ version: 1, shutdownSession: shutdownNotebookSession, getState: getNotebookSessionState })
    globalThis[NOTEBOOK_RUNTIME_KEY] = hooks
    return function () {
      if (globalThis[NOTEBOOK_RUNTIME_KEY] !== hooks) throw new Error("Notebook runtime registry ownership 已变化，拒绝卸载他方实例")
      delete globalThis[NOTEBOOK_RUNTIME_KEY]
    }
  })

  ctx.effect(function () {
    return ctx.on("subagent/end", async function (info) {
      const id = info && info.id
      if (typeof id === "string") await stopNotebookSession(id)
    }, { global: true })
  })

  ctx.effect(function () {
    return ctx.on("session/disposed", async function (session) {
      await stopNotebookSession(session.id)
    }, { global: true })
  })

  ctx.effect(function () {
    return ctx.on("agent/disposed", async function (payload) {
      const id = payload && payload.agent && payload.agent.id
      if (typeof id === "string") await stopNotebookSession(id)
    }, { global: true })
  })

  // On plugin teardown, kill every session's sidecar.
  ctx.effect(function () {
    return async function () {
      await Promise.all([...sessions.values()].map((st) => killSessionSidecar(st)))
      sessions.clear()
      retainedNotebooks.clear()
      retainedNotebookBytes = 0
    }
  })
}

function readJson(req) {
  // Bounded body: the unbounded accumulator let a request of any size
  // allocate without limit.
  return new Promise(function (resolve, reject) {
    let data = ""
    let size = 0
    let settled = false
    req.on("data", function (c) {
      if (settled) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        reject(new Error("request body too large"))
        req.destroy()
        return
      }
      data += c
    })
    req.on("end", function () {
      if (settled) return
      settled = true
      if (!data) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", function (e) {
      if (settled) return
      settled = true
      reject(e)
    })
  })
}
