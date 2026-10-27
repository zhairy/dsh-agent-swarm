// 展示缓存不是执行控制面：同一连接/根/任务只有一个在途读取，取消不合作时不补开请求。
const EMPTY = Object.freeze({ value: null, status: 'idle', error: null, updatedAt: null })
const HISTORICAL = Object.freeze({ value: null, status: 'historical', error: null, updatedAt: null })
const CAPACITY = Object.freeze({ value: null, status: 'unavailable', error: '任务视图缓存已满；旧读取尚未结束。请等待传输结算后刷新，必要时重新加载页面。', updatedAt: null })
const sharedStores = new WeakMap()
const ACTIVE_EVOLUTION_PHASES = new Set(['shadow', 'canary', 'reconcile-required'])
const ACTIVE_NODE_STATUSES = new Set(['ready', 'running'])
const isTerminal = (value) => {
  const settledAcceptance = value?.acceptance?.status === 'accepted' || value?.acceptance?.decision === 'incomplete'
  const nodes = value?.flow?.state?.nodes ?? value?.workflowState?.nodes ?? {}
  const activeNodes = Object.values(nodes).some((node) => ACTIVE_NODE_STATUSES.has(node?.status))
  const activeDelegations = Array.isArray(value?.delegations) && value.delegations.some((record) =>
    ['queued', 'running'].includes(record?.status) || record?.finalization === 'processing')
  return settledAcceptance && !activeNodes && !activeDelegations
    && value?.blockedRecovery?.active !== true && !ACTIVE_EVOLUTION_PHASES.has(value?.evolution?.phase)
}
const errorOf = (error) => error instanceof Error ? error : new Error(String(error))
const isDenied = (error) => /(?:unauthorized|forbidden|permission.denied|access.denied|\b40[13]\b)/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)
const REVISION_KEYS = ['cardRevision', 'workflowRevision', 'requestRevision']
const getBinding = (value) => value !== null && value !== undefined && REVISION_KEYS.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 1)
  ? { ...Object.fromEntries(REVISION_KEYS.map((key) => [key, value[key]])), evolutionRevision: Number.isSafeInteger(value.evolutionRevision) && value.evolutionRevision >= 0 ? value.evolutionRevision : 0 }
  : undefined
const isBehindBinding = (value, binding) => binding !== undefined && (getBinding(value) === undefined || [...REVISION_KEYS, 'evolutionRevision'].some((key) => (value[key] ?? 0) < binding[key]))
const mergeBinding = (previous, next) => previous === undefined ? next : next === undefined ? previous
  : Object.fromEntries([...REVISION_KEYS, 'evolutionRevision'].map((key) => [key, Math.max(previous[key], next[key])]))

const createTaskViewStore = ({ request, validateTask = (value) => value, generationSource, document: document_ = globalThis.document, intervalMs = 5000, timeoutMs = 15000, maxEntries = 8, now = Date.now }) => {
  const entries = new Map()
  const observers = new Set()
  let disposed = false
  let access = 0
  let generation = generationSource?.getSnapshot?.()?.id ?? (generationSource === undefined ? 0 : undefined)
  const visible = () => document_?.visibilityState !== 'hidden'
  const connected = () => generation !== undefined
  const emit = (entry, patch) => {
    entry.snapshot = Object.freeze({ ...entry.snapshot, ...patch })
    for (const observer of observers) if (observer.root === entry.root && observer.task === entry.task) observer.listener()
  }
  const clear = (entry) => { clearTimeout(entry.timer); clearTimeout(entry.deadline); entry.timer = undefined; entry.deadline = undefined }
  const hasActiveObserver = (root, task) => [...observers].some((observer) => !observer.passive && observer.root === root && observer.task === task)
  const active = (entry) => !disposed && connected() && entry.generation === generation && visible() && hasActiveObserver(entry.root, entry.task)
  const invalidate = (entry, status = 'stale') => {
    clear(entry)
    if (entry.pending !== undefined) { entry.pending.obsolete = true; entry.pending.controller.abort() }
    emit(entry, { status: entry.snapshot.value === null ? status : 'stale' })
  }
  const trim = (reserve = 0) => {
    const removable = [...entries].filter(([, entry]) => entry.pending === undefined && !hasActiveObserver(entry.root, entry.task)).sort((a, b) => a[1].access - b[1].access)
    for (const [key, entry] of removable) {
      if (entries.size + reserve <= maxEntries) break
      clear(entry); entries.delete(key)
    }
  }
  const getEntry = (root, task, create = true) => {
    const key = JSON.stringify([generation ?? 'offline', root, task])
    let entry = entries.get(key)
    if (entry === undefined) {
      if (!create) return undefined
      trim(1)
      if (entries.size >= maxEntries) return { root, task, generation, snapshot: CAPACITY, capacityBlocked: true }
      entry = { root, task, generation, snapshot: EMPTY, failures: 0, pending: undefined, timer: undefined, deadline: undefined, access: ++access,
        minimumBinding: task === null ? undefined : getEntry(root, null, false)?.bindings?.get(task) }
      entries.set(key, entry)
    }
    if (create) entry.access = ++access
    return entry
  }
  const schedule = (entry, delay) => {
    clearTimeout(entry.timer)
    if (active(entry)) entry.timer = setTimeout(() => refreshEntry(entry), delay)
  }
  const applyMinimumBinding = (entry, binding) => {
    const next = mergeBinding(entry.minimumBinding, binding)
    if (next === undefined || (entry.minimumBinding !== undefined && [...REVISION_KEYS, 'evolutionRevision'].every((key) => next[key] === entry.minimumBinding[key]))) return
    entry.minimumBinding = next
    if (!isBehindBinding(entry.snapshot.value, next)) return
    emit(entry, { status: 'stale', error: '任务目录已更新，等待当前版本的正文快照。' })
    // 不并发补开读取：旧transport必须先结算，之后最多立即补读一次。
    if (entry.pending !== undefined) entry.pending.bindingChanged = true
    else if (active(entry)) schedule(entry, 0)
  }
  const terminalCurrent = (entry) => entry.snapshot.status === 'live' && isTerminal(entry.snapshot.value) && !isBehindBinding(entry.snapshot.value, entry.minimumBinding)
  const refreshEntry = (entry, force = false) => {
    if (entry.capacityBlocked) return Promise.resolve(null)
    if (!active(entry)) return Promise.resolve(entry.snapshot.value)
    if (entry.pending !== undefined) return entry.pending.promise
    if (!force && entry.task !== null && terminalCurrent(entry)) return Promise.resolve(entry.snapshot.value)
    clearTimeout(entry.timer)
    const pending = { controller: new AbortController(), obsolete: false, timedOut: false, promise: undefined }
    entry.pending = pending
    emit(entry, { status: entry.snapshot.value === null ? 'loading' : 'refreshing', error: null })
    entry.deadline = setTimeout(() => {
      if (entry.pending !== pending) return
      pending.obsolete = true; pending.timedOut = true; pending.controller.abort()
      entry.failures += 1
      emit(entry, { status: entry.snapshot.value === null ? 'unavailable' : 'stale', error: '读取超时；等待传输结束或连接恢复，不会重启业务任务。' })
    }, timeoutMs)
    pending.promise = Promise.resolve().then(() => request(entry.task === null ? 'taskIndex' : 'taskView', entry.task === null ? { sessionId: entry.root } : { sessionId: entry.root, taskId: entry.task }, pending.controller.signal)).then((value) => {
      if (pending.obsolete || !active(entry)) return entry.snapshot.value
      if (entry.task === null) {
        if (value?.rootSessionId !== entry.root || !Array.isArray(value.tasks) || value.tasks.some((task) => typeof task?.taskId !== 'string' || typeof task.title !== 'string' || getBinding(task) === undefined)) throw new Error('Task directory identity mismatch')
        if (value.tasks.some((task) => isBehindBinding(task, entry.bindings?.get(task.taskId)))) throw new Error('Task directory revision regressed')
        entry.bindings = new Map(value.tasks.map((task) => [task.taskId, getBinding(task)]))
        for (const current of entries.values()) if (current.root === entry.root && current.generation === generation && current.task !== null) applyMinimumBinding(current, entry.bindings.get(current.task))
      } else {
        if (value?.task_id !== entry.task || value.rootSessionId !== entry.root) throw new Error('Task response identity mismatch')
        if (isBehindBinding(value, entry.minimumBinding)) {
          entry.failures += 1
          emit(entry, { status: 'stale', error: '已丢弃低于当前目录版本的迟到正文；等待传输结算后重新读取。' })
          return entry.snapshot.value
        }
        value = validateTask(value)
        entry.minimumBinding = mergeBinding(entry.minimumBinding, getBinding(value))
      }
      entry.failures = 0
      emit(entry, { value, status: 'live', error: null, updatedAt: now() })
      return value
    }).catch((error) => {
      if (!pending.obsolete && active(entry)) {
        entry.failures += 1
        emit(entry, { status: entry.snapshot.value === null ? 'unavailable' : 'stale', error: errorOf(error).message })
        pending.denied = isDenied(error)
      }
      return entry.snapshot.value
    }).finally(() => {
      clearTimeout(entry.deadline)
      if (entry.pending !== pending) return
      entry.pending = undefined
      // 只有真实传输已结算才能释放单飞；永久不合作的取消始终保留pending。
      if (!active(entry) || pending.denied) return
      if (pending.bindingChanged && isBehindBinding(entry.snapshot.value, entry.minimumBinding)) { schedule(entry, 0); return }
      if (pending.obsolete && !pending.timedOut) { schedule(entry, 0); return }
      if (entry.task !== null && terminalCurrent(entry)) return
      schedule(entry, entry.failures > 0 || pending.timedOut ? [2000, 5000, 15000][Math.min(Math.max(entry.failures - 1, 0), 2)] : intervalMs)
    })
    return pending.promise
  }
  const handle = (root, task, passive = false) => ({
    getSnapshot: () => getEntry(root, task, !passive)?.snapshot ?? HISTORICAL,
    subscribe: (listener) => {
      const observer = { root, task, listener, passive }; observers.add(observer)
      const entry = getEntry(root, task, !passive)
      if (!passive && entry !== undefined && active(entry)) refreshEntry(entry, true)
      return () => {
        observers.delete(observer)
        const current = getEntry(root, task, false)
        if (!passive && current !== undefined && !hasActiveObserver(root, task)) invalidate(current)
        trim()
      }
    },
    refresh: passive ? undefined : () => refreshEntry(getEntry(root, task), true),
    readPreference: () => preferences.get(JSON.stringify([root, task])),
    setPreference: (value) => {
      const key = JSON.stringify([root, task]); const previous = preferences.get(key); preferences.delete(key); preferences.set(key, { ...previous, ...value })
      if (preferences.size > maxEntries) preferences.delete(preferences.keys().next().value)
    }
  })
  const preferences = new Map()
  const onVisibility = () => {
    for (const entry of entries.values()) if (visible()) { if (active(entry)) refreshEntry(entry, true) } else invalidate(entry)
  }
  const onGeneration = () => {
    const next = generationSource.getSnapshot()?.id
    if (next === generation) return
    generation = next
    for (const entry of entries.values()) invalidate(entry, 'offline')
    for (const observer of observers) { observer.listener(); if (!observer.passive && connected()) refreshEntry(getEntry(observer.root, observer.task), true) }
    trim()
  }
  document_?.addEventListener?.('visibilitychange', onVisibility)
  const unsubscribe = generationSource?.subscribe?.(onGeneration)
  return {
    task: (root, task, options) => handle(root, task, options?.passive === true),
    index: (root) => handle(root, null),
    dispose: () => {
      disposed = true; document_?.removeEventListener?.('visibilitychange', onVisibility); unsubscribe?.()
      for (const entry of entries.values()) invalidate(entry)
      observers.clear(); entries.clear(); preferences.clear()
    },
    diagnostics: () => ({ cachedEntries: entries.size, observers: observers.size, inFlight: [...entries.values()].filter((entry) => entry.pending !== undefined).length })
  }
}

const retainTaskViewStore = (connection, validateTask) => {
  let value = sharedStores.get(connection)
  if (value === undefined) {
    value = { owners: 0, store: createTaskViewStore({
      generationSource: connection.generation,
      validateTask,
      request: async (method, payload, signal) => {
        const result = await connection.rpc.call('/api', `swarm.${method}`, payload, signal)
        if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? 'Task RPC unavailable'), { code: result?.error?.code })
        return result.value
      }
    }) }
    sharedStores.set(connection, value)
  }
  value.owners += 1
  let released = false
  return { store: value.store, release: () => {
    if (released) return
    released = true; value.owners -= 1
    if (value.owners === 0) { value.store.dispose(); sharedStores.delete(connection) }
  } }
}

exports.createTaskViewStore = createTaskViewStore
exports.retainTaskViewStore = retainTaskViewStore
exports.isTerminal = isTerminal
