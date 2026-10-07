import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { createAgentBindingRegistry, type BindingInput } from '../../src/agent-binding.js'
import { createMessageBus, type MessageState } from '../../src/message-bus.js'
import { createHash } from 'node:crypto'

const dirs: string[] = []; const stores: DurableStateStore<MessageState>[] = []
const initial = (): MessageState => ({ bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {} })
const input = (agentId: string, overrides: Partial<BindingInput> = {}): BindingInput => ({ agentId, rootSessionId: 'root', workspaceId: 'workspace', taskId: 'task', nodeId: 'node-' + agentId, attemptId: 'attempt-' + agentId, threadId: 'thread-' + agentId, role: 'suan_heng', cardRevision: 1, workflowRevision: 1, permissions: ['message-send', 'message-read'], ...overrides })
const setup = async (extra: { maxPendingPerTask?: number; now?: () => number } = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-bus-test-')); dirs.push(directory)
  const store = await createDurableStateStore({ directory, initialState: initial() }); stores.push(store)
  const bindings = createAgentBindingRegistry(store)
  await bindings.bind(input('a')); await bindings.bind(input('b'))
  const bus = createMessageBus({ store, bindings, ...extra })
  return { directory, store, bindings, bus }
}
afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.dispose().catch(() => undefined))); await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('private pull-based peer message bus', () => {
  it('delivers directly at least once, durably deduplicates IDs, and restores ACKs', async () => {
    const { directory, store, bindings, bus } = await setup()
    const id = '12345678-1234-4234-8234-123456789012'
    const args = { toAgentId: 'b', taskId: 'task', kind: 'question' as const, summary: 'Check this invariant', messageId: id }
    const message = await bus.send('a', args)
    expect(message.fromAgentId).toBe('a')
    expect(await bus.send('a', args)).toEqual(message)
    expect((await bus.pull('b')).messages).toHaveLength(1)
    expect((await bus.pull('b')).messages).toHaveLength(1)
    await bindings.revoke('a', 'completed')
    expect((await bus.pull('b')).messages).toHaveLength(1)
    await bus.ack('b', { messageIds: [id] })
    expect((await bus.pull('b')).messages).toHaveLength(0)
    await store.dispose()
    const reopened = await createDurableStateStore({ directory, initialState: initial() }); stores.push(reopened)
    const resumedBus = createMessageBus({ store: reopened, bindings: createAgentBindingRegistry(reopened) })
    expect((await resumedBus.pull('b')).messages).toHaveLength(0)
    expect(Object.keys(reopened.read().messages)).toEqual([id])
  })

  it('rejects spoofed sender identity, cross-scope peers, unauthorized refs and blind review', async () => {
    const { bindings, bus } = await setup()
    const args = { toAgentId: 'b', taskId: 'task', kind: 'finding' as const, summary: 'Finding' }
    await expect(bus.send('a', { ...args, senderRole: 'tian_shu' } as typeof args)).rejects.toMatchObject({ code: 'MESSAGE_INVALID' })
    await expect(bus.send('a', { ...args, artifactRefs: ['private-proof'] })).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
    await bindings.bind(input('b', { taskId: 'other-task' }))
    await expect(bus.send('a', args)).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
    await bindings.bind(input('b', { blindReview: true }))
    await expect(bus.send('a', args)).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
    await expect(bus.pull('b')).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
    await bindings.completeBlindReview('b')
    await expect(bus.send('a', args)).resolves.toMatchObject({ fromAgentId: 'a' })
    await bindings.suspend('a')
    await expect(bus.send('a', args)).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
  })

  it('keeps generations and versions fenced while rejecting cancelled/untrusted sender history', async () => {
    const { bindings, bus } = await setup()
    const args = { toAgentId: 'b', taskId: 'task', kind: 'answer' as const, summary: 'Bound answer' }
    const first = await bus.send('a', args)
    await bindings.revoke('a', 'cancelled')
    expect(await bus.pull('b')).toEqual({ messages: [], stale: [first.id] })
    const newSender = await bindings.bind(input('a', { attemptId: 'next-attempt' }))
    expect(newSender.generation).toBe(2)
    const second = await bus.send('a', args)
    await bindings.bind(input('b', { cardRevision: 2, workflowRevision: 2 }))
    expect((await bus.pull('b')).messages).toHaveLength(0)
    await expect(bus.ack('b', { messageIds: [second.id] })).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
  })

  it('bounds pending messages and TTL without forcing coordinator forwarding', async () => {
    let now = 1000
    const { bus } = await setup({ maxPendingPerTask: 1, now: () => now })
    const first = await bus.send('a', { toAgentId: 'b', taskId: 'task', kind: 'question', summary: 'One', ttlMs: 100 })
    await expect(bus.send('a', { toAgentId: 'b', taskId: 'task', kind: 'question', summary: 'Two' })).rejects.toMatchObject({ code: 'MESSAGE_LIMIT' })
    now = 1101
    expect(await bus.pull('b')).toEqual({ messages: [], stale: [first.id] })
    await expect(bus.send('a', { toAgentId: 'b', taskId: 'task', kind: 'question', summary: 'Two' })).resolves.toBeDefined()
    await expect(bus.send('a', { toAgentId: '../outside', taskId: 'task', kind: 'question', summary: 'bad' })).rejects.toMatchObject({ code: 'RECEIVER_UNAVAILABLE' })
  })

  it('fails closed for corrupted committed files and ephemeral storage', async () => {
    const { directory, bus } = await setup()
    const message = await bus.send('a', { toAgentId: 'b', taskId: 'task', kind: 'question', summary: 'Honest' })
    const threadHash = createHash('sha256').update(JSON.stringify('thread-b')).digest('hex')
    const path = join(directory, 'bus', 'inbox', threadHash, 'message-' + message.id + '.json')
    await writeFile(path, '{}')
    await expect(bus.pull('b')).rejects.toMatchObject({ code: 'MESSAGE_CORRUPT' })
    const memory = await createDurableStateStore({ directory, initialState: initial(), enabled: false }); stores.push(memory)
    expect(() => createMessageBus({ store: memory, bindings: createAgentBindingRegistry(memory) })).toThrow('durable')
  })

  it('isolates request revisions even when card/workflow match and preserves legacy request 1', async () => {
    const { bindings, bus } = await setup()
    const args = { toAgentId: 'b', taskId: 'task', kind: 'question' as const, summary: '需求版本范围' }
    expect((await bus.send('a', args)).requestRevision).toBe(1)
    await bindings.bind(input('b', { requestRevision: 2 }))
    await expect(bus.send('a', args)).rejects.toMatchObject({ code: 'IDENTITY_DENIED' })
    await bindings.bind(input('a', { requestRevision: 2 }))
    const current = await bus.send('a', args)
    expect(current.requestRevision).toBe(2)
    expect((await bus.pull('b')).messages.map((message) => message.id)).toEqual([current.id])
    await bus.ack('b', { messageIds: [current.id] })
  })
})
