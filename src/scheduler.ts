/** A bounded execution queue. It schedules requests; workflow admission remains authoritative. */
export const SCHEDULING_STRATEGIES = ['fifo', 'priority', 'roundRobin'] as const
export type SchedulingStrategy = typeof SCHEDULING_STRATEGIES[number]
export interface SchedulingOptions { strategy: SchedulingStrategy; maxActive: number; maxPending: number }
export const DEFAULT_SCHEDULING_OPTIONS: SchedulingOptions = Object.freeze({ strategy: 'fifo', maxActive: 8, maxPending: 128 })
export class SchedulerError extends Error {
  constructor (readonly code: 'SCHEDULER_FULL' | 'SCHEDULER_CLOSED' | 'SCHEDULER_INVALID', message: string) { super(message); this.name = 'SchedulerError' }
}
interface Job {
  group: string
  priority: number
  signal?: AbortSignal
  start: () => void
  reject: (error: unknown) => void
  abort?: () => void
}
export interface DelegationScheduler {
  run: <T>(work: () => T | Promise<T>, input: { group: string; priority?: number; signal?: AbortSignal }) => Promise<T>
  status: () => { strategy: SchedulingStrategy; active: number; pending: number; maxActive: number; maxPending: number; disposed: boolean }
  /** Cancels only queued requests; already started work remains owned by its original signal. */
  dispose: () => void
}

export const createDelegationScheduler = (input: { getOptions?: () => SchedulingOptions } = {}): DelegationScheduler => {
  const queue: Job[] = []
  const groups = new Map<string, { ordinal: number; count: number }>()
  let active = 0, nextOrdinal = 0, lastGroupOrdinal = -1, disposed = false
  const options = (): SchedulingOptions => {
    const value = input.getOptions?.() ?? DEFAULT_SCHEDULING_OPTIONS
    if (!SCHEDULING_STRATEGIES.includes(value.strategy) || !Number.isSafeInteger(value.maxActive) || value.maxActive < 1 || value.maxActive > 64
      || !Number.isSafeInteger(value.maxPending) || value.maxPending < 1 || value.maxPending > 1024) throw new SchedulerError('SCHEDULER_INVALID', 'Invalid bounded scheduling configuration')
    return value
  }
  const releaseGroup = (group: string) => {
    const state = groups.get(group)!
    if (--state.count === 0) groups.delete(group)
    if (groups.size === 0) { nextOrdinal = 0; lastGroupOrdinal = -1 }
  }
  const detach = (job: Job) => { if (job.abort !== undefined) job.signal?.removeEventListener('abort', job.abort) }
  const choose = (strategy: SchedulingStrategy): number => {
    if (strategy === 'fifo') return 0
    if (strategy === 'priority') {
      let best = 0
      for (let i = 1; i < queue.length; i++) if (queue[i]!.priority > queue[best]!.priority) best = i
      return best
    }
    let next = -1, wrap = 0
    for (let i = 0; i < queue.length; i++) {
      const ordinal = groups.get(queue[i]!.group)!.ordinal
      if (ordinal < groups.get(queue[wrap]!.group)!.ordinal) wrap = i
      if (ordinal > lastGroupOrdinal && (next === -1 || ordinal < groups.get(queue[next]!.group)!.ordinal)) next = i
    }
    return next === -1 ? wrap : next
  }
  const pump = () => {
    if (disposed) return
    // Reconfiguration changes future admission, never cancels active work.
    let current: SchedulingOptions
    try { current = options() } catch (error) {
      for (const job of queue.splice(0)) { detach(job); releaseGroup(job.group); job.reject(error) }
      return
    }
    while (active < current.maxActive && queue.length > 0) {
      const [job] = queue.splice(choose(current.strategy), 1)
      detach(job!)
      if (job!.signal?.aborted) { releaseGroup(job!.group); job!.reject(new DOMException('Delegation cancelled while queued', 'AbortError')); continue }
      lastGroupOrdinal = groups.get(job!.group)!.ordinal
      active++; job!.start()
    }
  }
  return {
    run: <T>(work: () => T | Promise<T>, request: { group: string; priority?: number; signal?: AbortSignal }): Promise<T> => {
      if (disposed) return Promise.reject(new SchedulerError('SCHEDULER_CLOSED', 'Delegation scheduler is closed'))
      if (request.signal?.aborted) return Promise.reject(new DOMException('Delegation cancelled before queue admission', 'AbortError'))
      if (typeof request.group !== 'string' || request.group.length < 1 || request.group.length > 128 || !Number.isSafeInteger(request.priority ?? 0)
        || (request.priority ?? 0) < -100 || (request.priority ?? 0) > 100) return Promise.reject(new SchedulerError('SCHEDULER_INVALID', 'Invalid delegation scheduling group or priority'))
      let current: SchedulingOptions
      try { current = options() } catch (error) { return Promise.reject(error) }
      pump()
      if (queue.length >= current.maxPending) return Promise.reject(new SchedulerError('SCHEDULER_FULL', `Delegation queue is full (${current.maxPending}); no task or model call was started`))
      return new Promise<T>((resolve, reject) => {
        let state = groups.get(request.group)
        if (state === undefined) { state = { ordinal: nextOrdinal++, count: 0 }; groups.set(request.group, state) }
        state.count++
        const job: Job = { group: request.group, priority: request.priority ?? 0, signal: request.signal, reject, start: () => {
          // Promise.resolve().then handles both synchronous throws and asynchronous rejection.
          const finish = () => { active--; releaseGroup(job.group); pump() }
          Promise.resolve().then(() => {
            if (request.signal?.aborted) throw new DOMException('Delegation cancelled before execution', 'AbortError')
            return work()
          }).then((value) => { finish(); resolve(value) }, (error) => { finish(); reject(error) })
        } }
        job.abort = () => {
          const index = queue.indexOf(job)
          if (index === -1) return
          queue.splice(index, 1); detach(job); releaseGroup(job.group)
          reject(new DOMException('Delegation cancelled while queued', 'AbortError')); pump()
        }
        request.signal?.addEventListener('abort', job.abort, { once: true })
        queue.push(job); pump()
      })
    },
    status: () => ({ ...options(), active, pending: queue.length, disposed }),
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const job of queue.splice(0)) { detach(job); releaseGroup(job.group); job.reject(new SchedulerError('SCHEDULER_CLOSED', 'Delegation scheduler closed before request started')) }
    }
  }
}
