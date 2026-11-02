import { describe, expect, it } from 'vitest'
import { createDelegationScheduler, type SchedulingOptions, type SchedulingStrategy } from '../../src/scheduler.js'

const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>((done) => { resolve = done }), done: () => resolve() } }
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const create = (strategy: SchedulingStrategy, maxActive = 1, maxPending = 128) => createDelegationScheduler({ getOptions: () => ({ strategy, maxActive, maxPending }) })

describe('bounded delegation scheduling before admission', () => {
  it.each(['fifo', 'priority', 'roundRobin'] as const)('keeps %s work below configured concurrency and bounds its waiting queue', async (strategy) => {
    const scheduler = create(strategy, 2, 2), hold = deferred()
    let active = 0, maximum = 0
    const work = async () => { active++; maximum = Math.max(maximum, active); await hold.promise; active--; return 'done' }
    const tasks = Array.from({ length: 4 }, (_, index) => scheduler.run(work, { group: String(index % 2) }))
    await expect(scheduler.run(() => { throw new Error('must not start') }, { group: 'overflow' })).rejects.toMatchObject({ code: 'SCHEDULER_FULL' })
    expect(scheduler.status()).toMatchObject({ active: 2, pending: 2 })
    hold.done(); expect(await Promise.all(tasks)).toEqual(['done', 'done', 'done', 'done'])
    expect(maximum).toBe(2); expect(scheduler.status()).toMatchObject({ active: 0, pending: 0 })
  })
  it('preserves FIFO arrival order independently of group and priority', async () => {
    const scheduler = create('fifo'), hold = deferred(), order: number[] = []
    const first = scheduler.run(() => hold.promise, { group: 'first' })
    const jobs = [1, 2, 3].map((value) => scheduler.run(() => { order.push(value) }, { group: String(value), priority: value * 10 }))
    hold.done(); await Promise.all([first, ...jobs]); expect(order).toEqual([1, 2, 3])
  })
  it('chooses highest queued priority with stable ties without preempting active work', async () => {
    const scheduler = create('priority'), hold = deferred(), order: string[] = []
    const first = scheduler.run(() => hold.promise, { group: 'active', priority: -100 })
    const jobs = [['low', -1], ['high1', 10], ['high2', 10], ['middle', 0]].map(([group, priority]) =>
      scheduler.run(() => { order.push(String(group)) }, { group: String(group), priority: Number(priority) }))
    expect(scheduler.status().active).toBe(1)
    hold.done(); await Promise.all([first, ...jobs]); expect(order).toEqual(['high1', 'high2', 'middle', 'low'])
  })
  it('round robins groups while preserving FIFO within each group', async () => {
    const scheduler = create('roundRobin'), hold = deferred(), order: string[] = []
    const first = scheduler.run(() => hold.promise, { group: 'A' })
    const jobs = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map((name) => scheduler.run(() => { order.push(name) }, { group: name[0]! }))
    hold.done(); await Promise.all([first, ...jobs]); expect(order).toEqual(['B1', 'C1', 'A1', 'B2', 'C2', 'A2'])
  })
  it('removes cancelled queued work and never enters its admission callback', async () => {
    const scheduler = create('fifo'), hold = deferred(), controller = new AbortController()
    const first = scheduler.run(() => hold.promise, { group: 'active' })
    let called = false
    const waiting = scheduler.run(() => { called = true }, { group: 'cancelled', signal: controller.signal })
    controller.abort(); await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    expect(scheduler.status().pending).toBe(0); hold.done(); await first; expect(called).toBe(false)
    await expect(scheduler.run(() => { called = true }, { group: 'pre-cancelled', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('checks cancellation between queue selection and callback execution', async () => {
    const scheduler = create('fifo'), controller = new AbortController()
    let called = false
    const work = scheduler.run(() => { called = true }, { group: 'A', signal: controller.signal })
    controller.abort(); await expect(work).rejects.toMatchObject({ name: 'AbortError' }); expect(called).toBe(false)
    expect(scheduler.status().active).toBe(0)
  })
  it('releases active capacity after synchronous throws and asynchronous rejection', async () => {
    const scheduler = create('fifo')
    await expect(scheduler.run(() => { throw new Error('sync') }, { group: 'A' })).rejects.toThrow('sync')
    await expect(scheduler.run(() => Promise.reject(new Error('async')), { group: 'A' })).rejects.toThrow('async')
    expect(await scheduler.run(() => 42, { group: 'B' })).toBe(42); expect(scheduler.status().active).toBe(0)
  })
  it('dispose rejects queued work and does not report active side effects as cancelled', async () => {
    const scheduler = create('fifo'), hold = deferred()
    const active = scheduler.run(async () => { await hold.promise; return 'actual-result' }, { group: 'A' })
    await tick()
    const queued = scheduler.run(() => 'never', { group: 'B' })
    scheduler.dispose(); scheduler.dispose()
    await expect(queued).rejects.toMatchObject({ code: 'SCHEDULER_CLOSED' })
    await expect(scheduler.run(() => 0, { group: 'C' })).rejects.toMatchObject({ code: 'SCHEDULER_CLOSED' })
    expect(scheduler.status()).toMatchObject({ active: 1, pending: 0, disposed: true })
    hold.done(); expect(await active).toBe('actual-result'); expect(scheduler.status().active).toBe(0)
  })
  it('new lower capacity never interrupts old active work or inflates itself to clear a queue', async () => {
    let options: SchedulingOptions = { strategy: 'fifo', maxActive: 2, maxPending: 4 }
    const scheduler = createDelegationScheduler({ getOptions: () => options }), first = deferred(), second = deferred(), order: string[] = []
    const a = scheduler.run(() => first.promise, { group: 'A' }), b = scheduler.run(() => second.promise, { group: 'B' })
    options = { ...options, maxActive: 1 }
    const c = scheduler.run(() => { order.push('C') }, { group: 'C' })
    first.done(); await a; expect(order).toEqual([]); expect(scheduler.status()).toMatchObject({ active: 1, pending: 1 })
    second.done(); await Promise.all([b, c]); expect(order).toEqual(['C'])
  })
  it('rejects invalid configuration and arguments without leaking slots', async () => {
    const scheduler = create('fifo')
    await expect(scheduler.run(() => 1, { group: 'A', priority: NaN })).rejects.toMatchObject({ code: 'SCHEDULER_INVALID' })
    await expect(scheduler.run(() => 1, { group: '', priority: 0 })).rejects.toMatchObject({ code: 'SCHEDULER_INVALID' })
    const invalid = createDelegationScheduler({ getOptions: () => ({ strategy: 'fifo', maxActive: 0, maxPending: 10 }) })
    await expect(invalid.run(() => 1, { group: 'A' })).rejects.toMatchObject({ code: 'SCHEDULER_INVALID' })
    expect(scheduler.status()).toMatchObject({ active: 0, pending: 0 })
  })
})
