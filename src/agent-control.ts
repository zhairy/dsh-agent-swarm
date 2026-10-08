import type { RouteInfo } from './routes.js'
import { SwarmError } from './util/errors.js'

/** Manual controls are a pause/selection latch, not a second task scheduler. */
export type AgentControlPhase = 'idle' | 'running' | 'waiting' | 'stopping' | 'paused' | 'recovery-required'
export interface AgentControlBinding {
  childId: string
  parentSessionId: string
  taskId: string
  delegationId: string
  persistent: boolean
  needsSideEffectReview?: boolean
  requestRevision?: number
  cardRevision?: number
  workflowRevision?: number
}
export interface ActualAgentAttempt {
  attemptId: string
  /** Host attempt counters may restart on cold attachment of the same persistent child. */
  delegationId?: string
  route: RouteInfo
  observedAt: number
  state: 'running' | 'settled' | 'unknown'
  source: 'agent-loop-attempt'
}
export interface AgentControlRecord extends AgentControlBinding {
  revision: number
  phase: AgentControlPhase
  paused: boolean
  selectedNext?: RouteInfo
  /** Request assembly is separate from an observed dispatched attempt. */
  requestedRoute?: RouteInfo
  actual?: ActualAgentAttempt
  reason?: string
  updatedAt: number
}
export interface AgentControlAddress { parentSessionId: string; childId: string; expectedRevision: number }
export interface AgentControlDeps {
  validateRoute: (route: RouteInfo) => Promise<RouteInfo>
  interrupt: (binding: AgentControlBinding) => void | Promise<void>
  applyOverride: (childId: string, route: RouteInfo | undefined) => void
  setPaused: (childId: string, paused: boolean) => void
  /** The current task contract/lease is revalidated by the existing delegation pipeline. */
  resume: (binding: AgentControlBinding, input?: { steering?: string }) => Promise<{ accepted: true; delegationId?: string }>
  persist?: (records: AgentControlRecord[]) => void | Promise<void>
  /** A user-authorized, scoped one-time probe; never a provider-wide cache clear. */
  retryRoute?: (route: RouteInfo, childId: string, force: boolean) => void | Promise<void>
  cancelRetryRoute?: (childId: string) => void
  now?: () => number
}

const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
const id = (raw: unknown): raw is string => typeof raw === 'string' && raw.trim() !== '' && raw.length <= 512 && !/[\u0000-\u001f\u007f]/.test(raw)
const revision = (raw: unknown): raw is number => Number.isSafeInteger(raw) && Number(raw) > 0
const route = (raw: unknown): raw is RouteInfo => object(raw) && Object.keys(raw).every((key) => ['provider', 'model', 'reasoningEffort'].includes(key)) && id(raw.provider) && id(raw.model) && (raw.reasoningEffort === undefined || id(raw.reasoningEffort))
const publicRoute = (value: RouteInfo): RouteInfo => ({ provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) })
const clone = <T>(value: T): T => structuredClone(value)
const phase = new Set<AgentControlPhase>(['idle', 'running', 'waiting', 'stopping', 'paused', 'recovery-required'])

/** Durable state validation never imports an arbitrary browser-selected policy object. */
export const ValidateAgentControlRecords = (raw: unknown): raw is AgentControlRecord[] => {
  if (!Array.isArray(raw) || raw.length > 4096) return false
  const keys = new Set<string>()
  for (const value of raw) {
    if (!object(value) || !id(value.childId) || keys.has(value.childId) || !id(value.parentSessionId) || !id(value.taskId) || !id(value.delegationId)
      || typeof value.persistent !== 'boolean' || !revision(value.revision) || !phase.has(value.phase as AgentControlPhase) || typeof value.paused !== 'boolean'
      || (value.needsSideEffectReview !== undefined && typeof value.needsSideEffectReview !== 'boolean')
      || typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt) || value.updatedAt < 0
      || [value.requestRevision, value.cardRevision, value.workflowRevision].some((item) => item !== undefined && !revision(item))
      || (value.selectedNext !== undefined && !route(value.selectedNext)) || (value.requestedRoute !== undefined && !route(value.requestedRoute))
      || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > 256))) return false
    if (value.actual !== undefined && (!object(value.actual) || !id(value.actual.attemptId) || !route(value.actual.route) || value.actual.source !== 'agent-loop-attempt'
      || (value.actual.delegationId !== undefined && !id(value.actual.delegationId))
      || !['running', 'settled', 'unknown'].includes(String(value.actual.state)) || typeof value.actual.observedAt !== 'number' || !Number.isFinite(value.actual.observedAt))) return false
    keys.add(value.childId)
  }
  return true
}
export const validateAgentControlRecords = ValidateAgentControlRecords

export const createAgentControl = (deps: AgentControlDeps) => {
  const now = deps.now ?? Date.now
  const records = new Map<string, AgentControlRecord>()
  const locks = new Map<string, Promise<unknown>>()
  let persistTail: Promise<void> = Promise.resolve()
  const Export = (parentSessionId?: string) => [...records.values()].filter((record) => parentSessionId === undefined || record.parentSessionId === parentSessionId).map(clone)
  const requireRecord = (parentSessionId: string, childId: string): AgentControlRecord => {
    const record = records.get(childId)
    if (record === undefined || record.parentSessionId !== parentSessionId) throw new SwarmError('PERMISSION_DENIED', '只能控制已登记的百工直属子会话')
    return record
  }
  const requireRevision = (input: AgentControlAddress) => {
    const record = requireRecord(input.parentSessionId, input.childId)
    if (!revision(input.expectedRevision) || record.revision !== input.expectedRevision) throw new SwarmError('STALE_EVIDENCE', '子会话状态已改变，请刷新后重试')
    return record
  }
  const patch = (record: AgentControlRecord, value: Partial<AgentControlRecord>) => {
    const next = { ...record, ...value, revision: record.revision + 1, updatedAt: now() }
    records.set(next.childId, next)
    return next
  }
  const locked = async <T>(childId: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(childId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(action)
    locks.set(childId, result)
    try { return await result } finally { if (locks.get(childId) === result) locks.delete(childId) }
  }
  const persist = (): Promise<void> => {
    const next = persistTail.catch(() => undefined).then(async () => { await deps.persist?.(Export()) })
    persistTail = next
    return next
  }
  const commit = async (previous: AgentControlRecord, next: AgentControlRecord) => {
    try { await persist() } catch (error) {
      deps.cancelRetryRoute?.(previous.childId)
      // Never erase an observation arriving while the durable write was pending.
      if (records.get(next.childId)?.revision === next.revision) records.set(previous.childId, previous)
      else patch(records.get(next.childId)!, { phase: 'recovery-required', paused: true, reason: 'control-persist-failed' })
      deps.setPaused(previous.childId, records.get(previous.childId)?.paused ?? true)
      throw error
    }
  }
  const stopAndSelect = async (input: AgentControlAddress, selection?: RouteInfo, interruptRunning = true, retry = false, force = false) => locked(input.childId, async () => {
    let current = requireRevision(input)
    if (selection !== undefined && !current.persistent) throw new SwarmError('INVALID_ARGS', '一次性子智能体的模型由本轮委派决定')
    const selected = selection === undefined ? undefined : publicRoute(await deps.validateRoute(publicRoute(selection)))
    if (selected !== undefined && !route(selected)) throw new SwarmError('INVALID_ARGS', '宿主未返回合法模型配置')
    // validateRoute is asynchronous; a new attempt/settlement invalidates an old browser CAS.
    current = requireRevision(input)
    if (current.phase === 'recovery-required') {
      deps.setPaused(current.childId, true)
      const next = patch(current, { ...(selected === undefined ? {} : { selectedNext: clone(selected) }), paused: true, phase: 'recovery-required', reason: selected === undefined ? 'manual-cancel-awaiting-reconciliation' : 'manual-selection-awaiting-reconciliation' })
      await commit(current, next)
      if (selected !== undefined) deps.applyOverride(current.childId, clone(selected))
      else {
        try { await deps.interrupt(clone(next)) } catch { throw new SwarmError('RECOVERY_REQUIRED', '宿主未接受中断；仍保留待核对状态') }
      }
      return clone(requireRecord(input.parentSessionId, input.childId))
    }
    const running = ['running', 'waiting', 'stopping'].includes(current.phase)
    if (running && !interruptRunning) throw new SwarmError('INVALID_ARGS', '运行中切换需要先取消当前调用；取消完成后才能安全继续')
    // Fence existing execution before an asynchronous retry intent can become visible.
    deps.setPaused(current.childId, true)
    if (retry && selected !== undefined) {
      try {
        if (deps.retryRoute === undefined || deps.cancelRetryRoute === undefined) throw new SwarmError('SERVICE_UNAVAILABLE', '当前宿主不支持可撤销的受控路由重试')
        await deps.retryRoute(selected, current.childId, force)
        current = requireRevision(input)
      } catch (error) {
        deps.cancelRetryRoute?.(current.childId)
        deps.setPaused(current.childId, records.get(current.childId)?.paused ?? current.paused)
        throw error
      }
    }
    const paused = selected === undefined || running ? true : current.paused
    deps.setPaused(current.childId, true)
    const next = patch(current, { ...(selected === undefined ? {} : { selectedNext: clone(selected) }), paused,
      phase: running ? 'stopping' : paused ? 'paused' : 'idle', reason: running ? 'manual-cancel-requested' : selected === undefined ? 'manual-paused' : 'manual-model-selected' })
    try { await commit(current, next) } catch (error) { if (retry) deps.cancelRetryRoute?.(current.childId); throw error }
    if (selected !== undefined) deps.applyOverride(current.childId, clone(selected))
    deps.setPaused(current.childId, paused)
    if (running && current.phase !== 'stopping') {
      try { await deps.interrupt(clone(next)) } catch {
        const live = records.get(current.childId)!
        patch(live, { phase: 'recovery-required', paused: true, reason: 'host-interrupt-failed' })
        await persist()
        throw new SwarmError('RECOVERY_REQUIRED', '宿主未确认取消请求；保持暂停，先核对运行状态')
      }
    }
    return clone(requireRecord(input.parentSessionId, input.childId))
  })

  return {
    Export,
    getView: (parentSessionId: string, childId: string) => clone(requireRecord(parentSessionId, childId)),
    get: (childId: string) => { const value = records.get(childId); return value === undefined ? undefined : clone(value) },
    isPaused: (childId: string) => records.get(childId)?.paused === true,
    Register: (binding: AgentControlBinding) => {
      if (![binding.childId, binding.parentSessionId, binding.taskId, binding.delegationId].every(id)) throw new SwarmError('INVALID_ARGS', '子会话控制绑定缺少真实身份')
      const current = records.get(binding.childId)
      if (current !== undefined && (current.parentSessionId !== binding.parentSessionId || current.persistent !== binding.persistent)) throw new SwarmError('PERMISSION_DENIED', '不能把子会话重新绑定到其他父会话或模式')
      const next = current === undefined ? { ...clone(binding), revision: 1, phase: 'idle' as const, paused: false, updatedAt: now() } : patch(current, clone(binding))
      records.set(binding.childId, next)
      if (next.selectedNext !== undefined) deps.applyOverride(binding.childId, clone(next.selectedNext))
      deps.setPaused(binding.childId, next.paused)
      return clone(next)
    },
    Restore: (raw: unknown, parentSessionId: string) => {
      if (!ValidateAgentControlRecords(raw) || raw.some((value) => value.parentSessionId !== parentSessionId || !value.persistent)) throw new SwarmError('RECOVERY_REQUIRED', '子会话控制快照无效或越过根会话边界')
      for (const value of raw) {
        if (records.has(value.childId)) throw new SwarmError('RECOVERY_REQUIRED', '子会话控制状态已经登记，不能覆盖')
      }
      for (const value of raw) {
        const uncertain = ['running', 'waiting', 'stopping', 'recovery-required'].includes(value.phase)
        const restored = { ...clone(value), revision: value.revision + 1, ...(uncertain ? { phase: 'recovery-required' as const, paused: true, reason: 'restart-requires-host-reconciliation' } : {}), ...(value.actual === undefined ? {} : { actual: { ...clone(value.actual), state: uncertain ? 'unknown' as const : 'settled' as const } }), updatedAt: now() }
        records.set(value.childId, restored)
        if (restored.selectedNext !== undefined) deps.applyOverride(value.childId, clone(restored.selectedNext))
        deps.setPaused(value.childId, restored.paused)
      }
    },
    ObserveRequest: (childId: string, requestedRoute: RouteInfo) => {
      const current = records.get(childId)
      if (current !== undefined) patch(current, { requestedRoute: publicRoute(requestedRoute) })
    },
    ObserveSelection: (childId: string, selectedNext: RouteInfo) => {
      const current = records.get(childId)
      const next = publicRoute(selectedNext)
      if (current !== undefined && JSON.stringify(current.selectedNext) !== JSON.stringify(next)) patch(current, { selectedNext: next, reason: 'host-model-selection' })
    },
    MarkAttemptStarted: (childId: string, attemptId: string, effectiveRoute?: RouteInfo) => {
      const current = records.get(childId)
      if (current === undefined || !id(attemptId) || (current.actual?.attemptId === attemptId && current.actual.delegationId === current.delegationId && current.actual.state === 'running')) return
      const actualRoute = effectiveRoute ?? current.requestedRoute
      patch(current, { phase: current.paused ? 'stopping' : 'running', ...(actualRoute === undefined ? {} : { actual: { attemptId, delegationId: current.delegationId, route: publicRoute(actualRoute), observedAt: now(), state: 'running', source: 'agent-loop-attempt' } }) })
    },
    MarkWaiting: (childId: string, waiting: boolean) => {
      const current = records.get(childId)
      if (current !== undefined && !current.paused) patch(current, { phase: waiting ? 'waiting' : 'running' })
    },
    /** Only the final allowed mutation tool boundary calls this; role names alone are insufficient. */
    MarkSideEffectRisk: (childId: string) => {
      const current = records.get(childId)
      if (current !== undefined && current.needsSideEffectReview !== true) patch(current, { needsSideEffectReview: true })
    },
    MarkBlocked: (childId: string, reason: string) => {
      const current = records.get(childId)
      if (current !== undefined) { deps.setPaused(childId, true); patch(current, { phase: 'stopping', paused: true, reason: reason.slice(0, 256) }) }
    },
    MarkAttemptSettled: (childId: string, attemptId: string) => {
      const current = records.get(childId)
      if (current?.actual?.attemptId === attemptId && current.actual.state !== 'settled') patch(current, { actual: { ...current.actual, state: 'settled' } })
    },
    MarkRunSettled: (childId: string, stopReason?: string) => {
      let current = records.get(childId)
      if (current !== undefined && stopReason === 'completed' && current.needsSideEffectReview === true) current = patch(current, { needsSideEffectReview: false })
      if (current?.persistent === true && stopReason !== undefined && stopReason !== 'completed' && !current.paused) {
        deps.setPaused(childId, true)
        current = patch(current, { paused: true, reason: `host-run-failed:${stopReason}`.slice(0, 256) })
      }
      if (current !== undefined && (current.phase !== (current.paused ? 'paused' : 'idle') || (current.actual !== undefined && current.actual.state !== 'settled'))) patch(current, { phase: current.paused ? 'paused' : 'idle', ...(current.actual === undefined ? {} : { actual: { ...current.actual, state: 'settled' } }) })
    },
    /** Trusted host reconciliation only, never a browser's claim that cancellation finished. */
    ReconcileIdle: (childId: string) => {
      const current = records.get(childId)
      if (current !== undefined && (current.phase !== (current.paused ? 'paused' : 'idle') || (current.actual !== undefined && current.actual.state !== 'settled'))) patch(current, { phase: current.paused ? 'paused' : 'idle', reason: 'host-confirmed-idle', ...(current.actual === undefined ? {} : { actual: { ...current.actual, state: 'settled' } }) })
    },
    Select: (input: AgentControlAddress & { route: RouteInfo; interruptRunning?: boolean; retryRoute?: boolean; forceRetry?: boolean }) => stopAndSelect(input, input.route, input.interruptRunning === true, input.retryRoute === true, input.forceRetry === true),
    Stop: (input: AgentControlAddress) => stopAndSelect(input),
    Continue: (input: AgentControlAddress & { confirmSafeToContinue?: boolean; steering?: string }) => locked(input.childId, async () => {
      const current = requireRevision(input)
      if (current.needsSideEffectReview === true && input.confirmSafeToContinue !== true) throw new SwarmError('RECOVERY_REQUIRED', '继续前必须先核对取消后的副作用与当前任务进度；确认不替代工作区恢复检查')
      if (input.steering !== undefined && (typeof input.steering !== 'string' || input.steering.length > 8000)) throw new SwarmError('INVALID_ARGS', '继续说明必须是有界文本')
      if (!current.persistent) throw new SwarmError('INVALID_ARGS', '一次性子智能体不能继续同一会话')
      if (current.phase !== 'paused') throw new SwarmError('RECOVERY_REQUIRED', '只有宿主已确认沉寂的暂停会话才能继续')
      const next = patch(current, { phase: 'idle', paused: false, reason: 'manual-continue-requested' })
      await commit(current, next)
      deps.setPaused(current.childId, false)
      try {
        const receipt = await deps.resume(clone(next), input.steering === undefined ? {} : { steering: input.steering })
        if (receipt.accepted !== true) throw new Error('resume not accepted')
        return { ...receipt, control: clone(requireRecord(input.parentSessionId, input.childId)) }
      } catch (error) {
        const live = records.get(current.childId)!
        patch(live, { paused: true, phase: live.actual?.state === 'running' ? 'recovery-required' : 'paused', reason: 'continue-not-admitted' })
        deps.setPaused(current.childId, true)
        await persist()
        throw error
      }
    })
  }
}
export type AgentControl = ReturnType<typeof createAgentControl>
