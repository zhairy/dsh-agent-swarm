import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import { appendWithOutbox, dispatchOutbox, getOutboxRecords, makeOutboxIntent } from '../../src/outbox.js'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-outbox-'))
  roots.push(root)
  const journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-outbox' })
  const intent = makeOutboxIntent({ identity: 'accepted-trigger-1', kind: 'ticket-intent', createdAt: 1000, payload: { triggerId: 'T-1' }, maxAttempts: 3 })
  appendWithOutbox(journal, { eventId: 'source-1', idempotencyKey: 'source-1', type: 'source/trigger-evaluated',
    actor: { kind: 'host', id: 'test' }, payload: { decision: 'accepted' } }, intent)
  return { journal, intent }
}

describe('durable outbox', () => {
  it('reconstructs pending work from the enabling event and marks delivery idempotently', async () => {
    const { journal, intent } = setup()
    expect(journal.read().events).toHaveLength(1)
    expect(journal.read().events[0]).toMatchObject({ type: 'source/trigger-evaluated', payload: { outbox: { id: intent.id } } })
    expect(getOutboxRecords(journal)).toEqual([expect.objectContaining({ id: intent.id, kind: 'ticket-intent', status: 'pending', attempts: 0 })])
    const handler = vi.fn(async () => undefined)
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 2000 })).toEqual({ delivered: 1, failed: 0, skipped: 0 })
    expect(handler).toHaveBeenCalledOnce()
    expect(getOutboxRecords(journal)[0]).toMatchObject({ status: 'delivered', deliveredAt: 2000 })
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 3000 })).toEqual({ delivered: 0, failed: 0, skipped: 0 })
    expect(handler).toHaveBeenCalledOnce()
  })

  it('records bounded retry state and dispatches again after the due time', async () => {
    const { journal } = setup()
    const handler = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(undefined)
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 2000 })).toEqual({ delivered: 0, failed: 1, skipped: 0 })
    expect(getOutboxRecords(journal)[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: 'handler-failed', nextAt: 3000 })
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 2999 })).toEqual({ delivered: 0, failed: 0, skipped: 0 })
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 3000 })).toEqual({ delivered: 1, failed: 0, skipped: 0 })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('stops at the declared maximum and supports bounded maximum-length effect ids', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-outbox-max-')); roots.push(root)
    const journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-outbox-max' })
    const intent = makeOutboxIntent({ identity: 'max', kind: 'ticket-intent', createdAt: 1000, payload: {}, maxAttempts: 1 })
    appendWithOutbox(journal, { eventId: 'source-max', idempotencyKey: 'source-max', type: 'source/trigger-evaluated',
      actor: { kind: 'host', id: 'test' }, payload: {} }, intent)
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', () => { throw new Error('failed') }]]), { now: () => 2000 })).toMatchObject({ failed: 1 })
    expect(getOutboxRecords(journal)[0]).toMatchObject({ status: 'failed', attempts: 1, nextAt: Number.MAX_SAFE_INTEGER, lastError: 'max-attempts' })

    const longId = `effect-${'a'.repeat(120)}`
    const longIntent = { ...intent, id: longId, maxAttempts: 1 }
    appendWithOutbox(journal, { eventId: 'source-long', idempotencyKey: 'source-long', type: 'source/trigger-evaluated',
      actor: { kind: 'host', id: 'test' }, payload: {} }, longIntent)
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', async () => undefined]]), { now: () => 4000 })).toMatchObject({ delivered: 1 })
  })

  it('blocks recovery-required effects until an explicit restart or dispatch pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarm-outbox-blocked-')); roots.push(root)
    const journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-outbox-blocked' })
    const intent = makeOutboxIntent({ identity: 'blocked', kind: 'ticket-intent', createdAt: 1000, payload: {}, maxAttempts: 1 })
    appendWithOutbox(journal, { eventId: 'source-blocked', idempotencyKey: 'source-blocked', type: 'source/trigger-evaluated',
      actor: { kind: 'host', id: 'test' }, payload: {} }, intent)
    const recoveryError = Object.assign(new Error('reconcile'), { code: 'RECOVERY_REQUIRED' })
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', () => { throw recoveryError }]]), { now: () => 2000 })).toMatchObject({ failed: 1 })
    expect(getOutboxRecords(journal)[0]).toMatchObject({ status: 'blocked', attempts: 1, nextAt: Number.MAX_SAFE_INTEGER, lastError: 'recovery-required' })
    const handler = vi.fn(async () => undefined)
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 3000 })).toMatchObject({ delivered: 0 })
    expect(await dispatchOutbox(journal, new Map([['ticket-intent', handler]]), { now: () => 3000, includeBlocked: true })).toMatchObject({ delivered: 1 })
  })
})
