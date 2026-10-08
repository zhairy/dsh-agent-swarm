import { describe, expect, it } from 'vitest'
import { inspectChildRecovery, inspectRootPreference } from '../../src/host-recovery.js'
const descriptor = { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: '探微·T-1' } }
const start = (turn: number) => ({ type: 'turn/start', data: { turn } })
const end = (turn: number, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const input = (events: unknown[], inheritedEventCount = 0) => ({ parentSessionId: 'root', childId: 'child', inspection: { meta: { id: 'child', parentSession: 'root' }, inheritedEventCount, events }, catalog: [{ id: 'child', mode: 'continuable' }] })
describe('durable root model preference', () => {
  const header = (model: string, reason = 'initial', defaults = false) => ({ type: 'request/header', data: { reason, header: { config: { provider: 'p', model, reasoningEffort: 'high' }, ...(defaults ? { adapterDefaults: { reasoningEffort: true } } : {}) } } })
  const inspect = (events: unknown[], inheritedEventCount = 0) => ({ meta: { id: 'root' }, inheritedEventCount, events })
  it('takes the latest explicit own selection, never the latest automatic request/header', () => {
    expect(inspectRootPreference(inspect([header('initial'), { type: 'model/selection', data: { provider: 'q', model: 'human', reasoningEffort: 'max' } }, header('fallback', 'change')]))).toEqual({ provider: 'q', model: 'human', reasoningEffort: 'max' })
    expect(inspectRootPreference(inspect([header('initial', 'initial', true), header('fallback', 'change')]))).toEqual({ provider: 'p', model: 'initial' })
    expect(inspectRootPreference(inspect([header('resumed', 'resume'), header('fallback', 'change')]))).toEqual({ provider: 'p', model: 'resumed', reasoningEffort: 'high' })
  })
  it('excludes inherited intent, child sessions and unproven change-only headers', () => {
    expect(inspectRootPreference(inspect([{ type: 'model/selection', data: { provider: 'p', model: 'inherited' } }, header('own')], 1))).toEqual({ provider: 'p', model: 'own', reasoningEffort: 'high' })
    expect(inspectRootPreference({ ...inspect([header('child')]), meta: { parentSession: 'parent' } })).toBeUndefined()
    expect(inspectRootPreference(inspect([header('fallback', 'change')]))).toBeUndefined()
    expect(inspectRootPreference(inspect([{ type: 'model/selection', data: { provider: '', model: 'bad' } }]))).toBeUndefined()
  })
})
describe('real Host cold-child lifecycle evidence', () => {
  it('requires both parent catalog and own descriptor, then proves an actually closed turn', () => {
    expect(inspectChildRecovery(input([start(0), descriptor, end(0, 'aborted')]))).toMatchObject({ continuable: true, settled: true, stopReason: 'aborted', turn: 0 })
    const wrongParent = input([start(0), descriptor, end(0)])
    wrongParent.inspection.meta.parentSession = 'other'
    expect(inspectChildRecovery(wrongParent)).toMatchObject({ continuable: false, settled: false })
    expect(inspectChildRecovery({ ...input([start(0), descriptor, end(0)]), catalog: [{ id: 'child', mode: 'one-shot' }] }).settled).toBe(false)
  })
  it('inherited descriptors cannot prove this child; the first own descriptor is authoritative', () => {
    expect(inspectChildRecovery(input([descriptor, start(0), end(0)], 1))).toMatchObject({ continuable: false, settled: false })
    expect(inspectChildRecovery(input([start(0), { ...descriptor, data: { ...descriptor.data, mode: 'one-shot' } }, descriptor, end(0)]))).toMatchObject({ continuable: false })
    expect(inspectChildRecovery(input([start(0), { ...descriptor, data: { ...descriptor.data, version: 99 } }, end(0)])).continuable).toBe(false)
  })
  it('open, orphan-synthesized, conflicting and unpaired turns never become quiescence evidence', () => {
    expect(inspectChildRecovery(input([start(0), descriptor]))).toMatchObject({ continuable: true, settled: false, reason: 'host-turn-still-open' })
    expect(inspectChildRecovery(input([start(0), descriptor, end(0, 'interrupted')]))).toMatchObject({ continuable: true, settled: false, reason: 'host-turn-requires-reconciliation' })
    expect(inspectChildRecovery(input([start(0), descriptor, start(1), end(1)])).settled).toBe(false)
    expect(inspectChildRecovery(input([descriptor, end(0)])).settled).toBe(false)
    expect(inspectChildRecovery(input([start(0), descriptor, end(1)])).settled).toBe(false)
  })
  it('an old closed turn cannot confirm a newly booked delegation, and later delivery remains unknown', () => {
    const closed = input([{ ...start(0), time: 10 }, descriptor, { ...end(0), time: 20 }])
    expect(inspectChildRecovery({ ...closed, notBefore: 30 })).toMatchObject({ settled: false, reason: 'last-closed-turn-predates-bound-delegation' })
    expect(inspectChildRecovery({ ...closed, notBefore: 5 })).toMatchObject({ settled: true, turnStartedAt: 10, settledAt: 20 })
    expect(inspectChildRecovery(input([...closed.inspection.events, { type: 'user/message', data: { source: { kind: 'agent-message' } } }]))).toMatchObject({ settled: false, reason: 'delivery-after-last-closed-turn' })
    expect(inspectChildRecovery(input([...closed.inspection.events, { type: 'user/message', data: { source: { kind: 'compact-checkpoint' } } }])).settled).toBe(true)
  })
})
