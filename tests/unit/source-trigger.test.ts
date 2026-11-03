import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import { createSourceInstance } from '../../src/domain/sources/model.js'
import { createSourceTriggerRuntime, sourceTriggerFromSessionEvent } from '../../src/domain/sources/runtime.js'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const setup = (mode: 'off' | 'observe' | 'auto') => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-source-'))
  roots.push(root)
  const journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-source' })
  let at = 1000
  const runtime = createSourceTriggerRuntime({ journal, now: () => at, config: () => ({ proactive: { mode, rules: ['fix-ci'] } }) as never })
  runtime.configure(createSourceInstance({ id: 'github', kind: 'github', enabled: true, selfActor: 'bot:self', botActors: ['bot:ci'], allowedActors: ['human:alice'] }))
  return { journal, runtime, advance: (value: number) => { at = value } }
}
const botInput = { sourceId: 'github', externalId: 'event-1', threadId: 'pr-1', actorId: 'bot:ci', actorKind: 'bot' as const,
  addressed: true, preview: 'CI failed', topics: ['ci'], ruleIds: ['fix-ci'], mandate: {
    title: '修复 CI', goal: '定位并修复 CI 失败', acceptance: ['测试通过'], scope: [], flags: {}
  } }

describe('unified Source / Trigger path', () => {
  it('filters self messages, observes inferred candidates, auto-accepts rules and deduplicates external ids', () => {
    const observed = setup('observe')
    expect(observed.runtime.ingest('github', { ...botInput, externalId: 'self', actorId: 'bot:self' })).toMatchObject({ status: 'filtered', reason: 'self-message' })
    expect(observed.runtime.ingest('github', botInput)).toMatchObject({ status: 'would-accept', reason: 'observe-only' })
    expect(observed.runtime.ingest('github', botInput)).toMatchObject({ status: 'duplicate', reason: 'duplicate-external-id' })
    expect(observed.runtime.status()).toMatchObject({ counts: { received: 2, accepted: 0, observed: 1, filtered: 1 } })

    const automatic = setup('auto')
    expect(automatic.runtime.ingest('github', botInput)).toMatchObject({ status: 'accepted', reason: 'proactive-rule', outboxId: expect.stringMatching(/^effect-/) })
    expect(automatic.runtime.ingest('github', { ...botInput, externalId: 'event-2' })).toMatchObject({ status: 'ignored', reason: 'thread-already-active' })
    expect(automatic.runtime.status()).toMatchObject({ counts: { received: 2, accepted: 1 }, outboxPending: 1, outboxFailed: 0 })
  })

  it('reconstructs source configuration and decisions from the journal only', () => {
    const first = setup('off')
    first.runtime.ingest('github', { ...botInput, actorId: 'human:alice', actorKind: 'human', addressed: true })
    const restarted = createSourceTriggerRuntime({ journal: first.journal, now: () => 2000, config: () => ({ proactive: { mode: 'auto', rules: ['fix-ci'] } }) as never })
    expect(restarted.status()).toMatchObject({ sources: [expect.objectContaining({ id: 'github', kind: 'github', enabled: true })], counts: { received: 1, accepted: 1 } })
    expect(restarted.ingest('github', { ...botInput, actorId: 'human:alice', actorKind: 'human', addressed: true })).toMatchObject({ status: 'duplicate' })
  })

  it('reconstructs the single-admission claim so a restart cannot launch a second auto Ticket for one Thread', () => {
    const first = setup('auto')
    expect(first.runtime.ingest('github', botInput)).toMatchObject({ status: 'accepted', reason: 'proactive-rule' })
    const restarted = createSourceTriggerRuntime({ journal: first.journal, now: () => 2000, config: () => ({ proactive: { mode: 'auto', rules: ['fix-ci'] } }) as never })
    expect(restarted.ingest('github', { ...botInput, externalId: 'after-restart' })).toMatchObject({ status: 'ignored', reason: 'thread-already-active' })
  })

  it('requires a structured Mandate before auto mode creates a Ticket intent', () => {
    const { runtime, journal } = setup('auto')
    const { mandate: _mandate, ...withoutMandate } = botInput
    expect(runtime.ingest('github', withoutMandate)).toMatchObject({ status: 'ignored', reason: 'mandate-required', evalRequired: true })
    expect(runtime.status()).toMatchObject({ counts: { accepted: 0 }, outboxPending: 0 })
    expect(journal.query((event) => event.type === 'source/trigger-evaluated')).toHaveLength(1)
  })

  it('adapts only human DSH Session messages and preserves the Host event sequence as idempotence identity', () => {
    const event = { type: 'user/message', seq: 42, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'ship it' }] } }
    expect(sourceTriggerFromSessionEvent({ sessionId: 's1', event, sourceId: 'session' })).toMatchObject({ externalId: 'session-s1:42', threadId: 's1', actorKind: 'human', addressed: true })
    expect(sourceTriggerFromSessionEvent({ sessionId: 's1', sourceId: 'session', event: { ...event, data: { source: { kind: 'plugin:memory' } } } })).toEqual({ filtered: 'plugin-message' })
  })

  it('runs registered Source adapters before the same admission and idempotence path', () => {
    const { runtime } = setup('auto')
    const dispose = runtime.registerAdapter({ kind: 'github', normalize: ({ source, raw }) => ({
      ...botInput, sourceId: source.id, externalId: String((raw as { id: string }).id), preview: 'adapter event'
    }) })
    expect(runtime.ingestRaw('github', { id: 'adapter-1' })).toMatchObject({ status: 'accepted', reason: 'proactive-rule' })
    expect(runtime.ingestRaw('github', { id: 'adapter-1' })).toMatchObject({ status: 'duplicate' })
    dispose()
    expect(() => runtime.ingestRaw('github', { id: 'adapter-2' })).toThrow('not registered')
  })

  it('persists Threads and Subscriptions, fans out human follow-ups and releases them on unsubscribe', () => {
    const { runtime, journal } = setup('auto')
    const human = { ...botInput, externalId: 'human-1', actorId: 'human:alice', actorKind: 'human' as const }
    expect(runtime.ingest('github', human)).toMatchObject({ status: 'accepted', reason: 'explicit-request' })
    const subscription = runtime.subscribe({ sourceId: 'github', threadId: 'pr-1', ticketId: 'T-1' })
    expect(runtime.ingest('github', { ...human, externalId: 'human-2' })).toMatchObject({ status: 'accepted', reason: 'ticket-follow-up',
      fanoutTicketIds: ['T-1'], evalRequired: false, outboxId: expect.stringMatching(/^effect-/) })
    expect(runtime.status()).toMatchObject({ threads: 1, subscriptions: 1 })
    expect(createSourceTriggerRuntime({ journal, now: () => 3000, config: () => ({ proactive: { mode: 'auto', rules: ['fix-ci'] } }) as never }).status())
      .toMatchObject({ threads: 1, subscriptions: 1 })
    expect(runtime.unsubscribe(subscription.id)).toBe(true)
    expect(runtime.status().subscriptions).toBe(0)
  })

  it('does not let an RPC hint bypass an active Ticket and keeps context-only subscriptions from suppressing evaluation', () => {
    const { runtime } = setup('auto')
    runtime.subscribe({ sourceId: 'github', threadId: 'pr-1', ticketId: 'T-1', contextOnly: true })
    const explicit = runtime.ingest('github', { ...botInput, externalId: 'human-context', actorId: 'human:alice', actorKind: 'human' }, { hasActiveTicket: false })
    expect(explicit).toMatchObject({ status: 'accepted', reason: 'explicit-request', fanoutTicketIds: ['T-1'], evalRequired: true,
      outboxId: expect.stringMatching(/^effect-/) })
    runtime.subscribe({ sourceId: 'github', threadId: 'pr-1', ticketId: 'T-2' })
    expect(runtime.ingest('github', { ...botInput, externalId: 'human-active', actorId: 'human:alice', actorKind: 'human' }, { hasActiveTicket: false }))
      .toMatchObject({ status: 'accepted', reason: 'ticket-follow-up', evalRequired: false })
  })

  it('ends every active Subscription for a terminal Ticket exactly once', () => {
    const { runtime, journal } = setup('observe')
    runtime.subscribe({ sourceId: 'github', threadId: 'pr-1', ticketId: 'T-end' })
    runtime.subscribe({ sourceId: 'github', threadId: 'pr-2', ticketId: 'T-end' })
    runtime.subscribe({ sourceId: 'github', threadId: 'pr-3', ticketId: 'T-keep' })
    expect(runtime.unsubscribeTicket('T-end')).toBe(2)
    expect(runtime.unsubscribeTicket('T-end')).toBe(0)
    expect(runtime.status().subscriptions).toBe(1)
    expect(journal.query((event) => event.type === 'subscription/ended')).toHaveLength(2)
  })

  it('rejects new triggers after disposal', () => {
    const { runtime } = setup('auto')
    runtime.dispose()
    expect(() => runtime.ingest('github', botInput)).toThrow('closed')
  })

  it('updates Source configuration in the journal and does not open an orphan Thread for a duplicate external id', () => {
    const { runtime, journal } = setup('auto')
    runtime.ingest('github', botInput)
    runtime.ingest('github', { ...botInput, threadId: 'pr-2' })
    expect(runtime.status()).toMatchObject({ threads: 1, counts: { received: 1, accepted: 1 } })
    const disabled = runtime.configure(createSourceInstance({ id: 'github', kind: 'github', enabled: false, selfActor: 'bot:self', botActors: ['bot:ci'], allowedActors: ['human:alice'] }))
    expect(disabled.enabled).toBe(false)
    expect(runtime.ingest('github', { ...botInput, externalId: 'event-2' })).toMatchObject({ status: 'filtered', reason: 'source-off' })
    const recovered = createSourceTriggerRuntime({ journal, now: () => 2000, config: () => ({ proactive: { mode: 'auto', rules: ['fix-ci'] } }) as never })
    expect(recovered.status().sources).toEqual([expect.objectContaining({ id: 'github', enabled: false })])
  })

  it('rejects malformed RPC trigger and Mandate fields without throwing or persisting untrusted preview text', () => {
    const { runtime } = setup('auto')
    expect(runtime.ingest('github', null as never)).toMatchObject({ status: 'filtered', reason: 'invalid-trigger' })
    const malformed = { ...botInput, preview: { secret: 'not-a-string' }, mandate: { title: 'x', goal: 'y', acceptance: ['ok'], scope: [], flags: { changesCode: 'yes' } } }
    expect(runtime.ingest('github', malformed as never)).toMatchObject({ status: 'filtered', reason: 'invalid-trigger' })
    expect(runtime.ingest('github', { ...botInput, externalId: 'bad-mandate', mandate: { title: '', goal: 'y', acceptance: ['ok'], scope: [], flags: {} } }))
      .toMatchObject({ status: 'filtered', reason: 'invalid-mandate' })
  })

  it('does not launch a second explicit Ticket while the first admission claim is unresolved', () => {
    const { runtime } = setup('auto')
    expect(runtime.ingest('github', botInput)).toMatchObject({ status: 'accepted', reason: 'proactive-rule' })
    expect(runtime.ingest('github', { ...botInput, externalId: 'human-during-claim', actorId: 'human:alice', actorKind: 'human' }))
      .toMatchObject({ status: 'ignored', reason: 'thread-admission-pending', evalRequired: false })
  })
})
