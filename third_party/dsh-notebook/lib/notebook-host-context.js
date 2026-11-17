import { lstat, realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"

const NOTEBOOK_TASK_BINDING_EVENT = "plugin:swarm/notebook-task-binding"
const NOTEBOOK_TASK_BINDING_SCHEMA_VERSION = 1
const MAX_NOTEBOOK_MARKER_SCAN_EVENTS = 4096
const MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS = 3
const MAX_IDENTITY_CHARS = 1024

const contextError = (code, message, cause) => Object.assign(new Error(message), {
  code,
  ...(cause === undefined ? {} : { cause }),
})

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value)

const requireText = (name, value) => {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_IDENTITY_CHARS || value.includes("\0")) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", `Notebook Host context 的 ${name} 必须是非空可信文本`)
  }
  return value
}

const requireNonNegativeInteger = (name, value) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw contextError("NOTEBOOK_CONTEXT_INVALID", `Notebook Host context 的 ${name} 必须是非负安全整数`)
  }
  return value
}

const isSessionQuery = value => isRecord(value)
  && typeof value.observeSession === "function"
  && typeof value.inspectSession === "function"

const isWorkingDirectory = value => isRecord(value) && typeof value.get === "function"

const isSessions = value => isRecord(value) && typeof value.get === "function"

const isFs = value => isRecord(value)
  && typeof value.lstat === "function"
  && typeof value.resolve === "function"
  && typeof value.stat === "function"
  && typeof value.processPath === "function"
  && typeof value.processPathFromHostPath === "function"

const getService = (ctx, name, validate) => {
  const value = ctx.get(name)
  if (!validate(value)) {
    throw contextError("NOTEBOOK_CONTEXT_UNAVAILABLE", `Notebook Host context 缺少 ${name} 服务`)
  }
  return value
}

const isNotFound = error => error?.code === "SESSION_QUERY_SESSION_NOT_FOUND"
  || error?.name === "SessionPersistenceNotFoundError"

const parseMarker = (event, sessionId, rootSessionId, minimumSeq, maximumSeq) => {
  if (rootSessionId === undefined || !isRecord(event)) return undefined
  if (!Number.isSafeInteger(event.seq)
    || event.seq < minimumSeq
    || event.seq > maximumSeq
    || !isRecord(event.data)
    || event.data.schemaVersion !== NOTEBOOK_TASK_BINDING_SCHEMA_VERSION
    || event.data.sessionId !== sessionId
    || event.data.rootSessionId !== rootSessionId
    || typeof event.data.taskId !== "string"
    || event.data.taskId.trim() === ""
    || typeof event.data.attemptId !== "string"
    || event.data.attemptId.trim() === "") {
    return undefined
  }
  return {
    schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
    sessionId,
    managed: true,
    taskId: event.data.taskId,
    agentId: sessionId,
    attemptId: event.data.attemptId,
    rootSessionId,
    cwd: "",
    directoryIdentity: "",
    source: "swarm-marker",
  }
}

const getVerifiedHostDirectoryIdentity = async (fs, cwd, signal) => {
  if (!isAbsolute(cwd)) throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook Host cwd 必须是绝对路径")
  signal?.throwIfAborted()
  const pathInfo = await fs.lstat(cwd, undefined, signal)
  signal?.throwIfAborted()
  if (pathInfo?.type !== "directory") {
    throw contextError("NOTEBOOK_CONTEXT_NOT_HOST_FS", "Notebook cwd 不是 Host 目录")
  }
  const target = await fs.resolve(cwd, { signal })
  const targetInfo = await fs.stat(target, signal)
  signal?.throwIfAborted()
  if (targetInfo?.type !== "directory") {
    throw contextError("NOTEBOOK_CONTEXT_NOT_HOST_FS", "Notebook Host fs target 不是目录")
  }
  const mapped = fs.processPathFromHostPath(cwd)
  if (mapped === undefined) {
    throw contextError("NOTEBOOK_CONTEXT_NOT_HOST_FS", "Notebook fs 不能映射当前 Host 物理目录")
  }
  const processPath = fs.processPath(target)
  let canonicalHost
  let canonicalMapped
  let canonicalProcess
  try {
    canonicalHost = await realpath(cwd)
    canonicalMapped = await realpath(mapped)
    canonicalProcess = await realpath(processPath)
  } catch (error) {
    throw contextError("NOTEBOOK_CONTEXT_NOT_HOST_FS", "Notebook Host 目录身份解析失败", error)
  }
  if (canonicalMapped !== canonicalHost || canonicalProcess !== canonicalHost) {
    throw contextError("NOTEBOOK_CONTEXT_NOT_HOST_FS", "Notebook fs 执行世界不是当前 Host 物理目录")
  }
  const stat = await lstat(canonicalHost, { bigint: true })
  signal?.throwIfAborted()
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw contextError("NOTEBOOK_CONTEXT_NOT_HOST_FS", "Notebook Host cwd 不是稳定物理目录")
  }
  return [stat.dev, stat.ino, stat.birthtimeNs].join(":")
}

/**
 * 独立 Notebook 插件使用的最小 Host context reader。
 *
 * 只有全局 Snapshot runtime 没有 resolver 时才会调用这里。它只走 rc3
 * sessionQuery 的公开冷读接口，并用 Host fs 证明 cwd 是同一物理目录；
 * 不读取私有日志、不解析模型参数，也不创建 Notebook kernel。
 */
export const createNotebookHostContextResolver = ctx => async (rawSessionId, signal) => {
  const sessionId = requireText("sessionId", rawSessionId)
  const sessionQuery = getService(ctx, "sessionQuery", isSessionQuery)
  const sessions = getService(ctx, "sessions", isSessions)
  const workingDirectory = getService(ctx, "workingDirectory", isWorkingDirectory)
  const fs = getService(ctx, "fs", isFs)

  const readCut = async observation => {
    signal?.throwIfAborted()
    if (!isRecord(observation?.header) || observation.header.id !== sessionId) {
      throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook observeSession 返回错误 Session")
    }
    if (observation.source !== "live" && observation.source !== "prepared") {
      throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook observation source 无效")
    }
    const observationCursor = Number(observation.cursor)
    const inheritedEventCount = requireNonNegativeInteger(
      "observation.inheritedEventCount",
      observation.inheritedEventCount,
    )
    if (!Number.isSafeInteger(observationCursor) || observationCursor < -1) {
      throw contextError("NOTEBOOK_CONTEXT_INVALID", "Notebook observation cursor 无效")
    }
    const inspected = await sessionQuery.inspectSession(sessionId, session => {
      const live = sessions.get(sessionId) === session
      return {
        header: session.header,
        cwd: workingDirectory.get(session),
        source: live ? "live" : "prepared",
        cursor: Number(live ? session.seq : session.firstLiveSeq) - 1,
      }
    }, signal)
    signal?.throwIfAborted()
    if (inspected.header.id !== sessionId
      || inspected.source !== observation.source
      || inspected.cursor !== observationCursor
      || inspected.header.parentSession !== observation.header.parentSession) {
      throw contextError("NOTEBOOK_CONTEXT_CURSOR_MISMATCH", "Notebook session 在 observe 与 inspect 间发生变化")
    }
    const cwd = requireText("workingDirectory", inspected.cwd)
    const directoryIdentity = await getVerifiedHostDirectoryIdentity(fs, cwd, signal)
    const rootSessionId = inspected.header.parentSession
    const minimumSeq = Math.max(inheritedEventCount, observationCursor - MAX_NOTEBOOK_MARKER_SCAN_EVENTS + 1)
    const events = Array.isArray(observation.events) ? observation.events : []
    const scanStart = Math.max(0, events.length - MAX_NOTEBOOK_MARKER_SCAN_EVENTS)
    for (let index = events.length - 1; index >= scanStart; index -= 1) {
      const candidate = events[index]
      if (!isRecord(candidate) || candidate.type !== NOTEBOOK_TASK_BINDING_EVENT) continue
      const marker = parseMarker(candidate, sessionId, rootSessionId, minimumSeq, observationCursor)
      if (marker === undefined) {
        throw contextError(
          "NOTEBOOK_CONTEXT_INVALID",
          "Notebook 会话含无效或过期的 Swarm task marker；拒绝降级为 standard",
        )
      }
      return { ...marker, cwd, directoryIdentity }
    }
    return {
      schemaVersion: NOTEBOOK_TASK_BINDING_SCHEMA_VERSION,
      sessionId,
      managed: false,
      taskId: null,
      agentId: sessionId,
      attemptId: null,
      rootSessionId: rootSessionId ?? null,
      cwd,
      directoryIdentity,
      source: "host-session",
    }
  }

  for (let attempt = 1; attempt <= MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted()
    let observation
    try {
      observation = await sessionQuery.observeSession(sessionId, {
        projectionMode: "none",
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw contextError("NOTEBOOK_CONTEXT_UNAVAILABLE", "Notebook Host session 冷读失败", error)
    }

    let result
    let cutFailure
    try {
      result = await readCut(observation)
    } catch (error) {
      cutFailure = error
    }

    let disposeFailure
    try {
      observation?.[Symbol.dispose]?.()
    } catch (error) {
      disposeFailure = error
    }
    if (disposeFailure !== undefined) {
      if (cutFailure !== undefined) {
        throw new AggregateError(
          [cutFailure, disposeFailure],
          "Notebook session 读取和 observation dispose 均失败",
        )
      }
      throw contextError("NOTEBOOK_CONTEXT_UNAVAILABLE", "Notebook session observation dispose 失败", disposeFailure)
    }
    if (cutFailure === undefined) return result

    const cursorChanged = cutFailure?.code === "NOTEBOOK_CONTEXT_CURSOR_MISMATCH"
    if (cursorChanged && attempt < MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS) continue
    if (cursorChanged) {
      throw contextError(
        "NOTEBOOK_CONTEXT_CURSOR_MISMATCH",
        `Notebook session 连续 ${MAX_NOTEBOOK_CONTEXT_READ_ATTEMPTS} 次 fresh cut 仍不稳定；拒绝旧 marker`,
        cutFailure,
      )
    }
    throw cutFailure
  }
  throw contextError("NOTEBOOK_CONTEXT_CURSOR_MISMATCH", "Notebook session context 未能取得稳定 fresh cut")
}
