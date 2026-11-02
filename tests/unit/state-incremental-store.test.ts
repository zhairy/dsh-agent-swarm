import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalStateJson, createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { ChunkedState, SWARM_LAYOUT_OPTIONS, SWARM_SEGMENT_SPECS } from '../../src/state-chunks.js'

const directories: string[] = []
const stores: DurableStateStore<Record<string, unknown>>[] = []
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'swarm-state-incremental-')); directories.push(path); return path }
const track = <T extends Record<string, unknown>>(store: DurableStateStore<T & Record<string, unknown>>) => { stores.push(store as DurableStateStore<Record<string, unknown>>); return store }
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const initialState = () => ({
  schemaVersion: 1,
  tasks: [{ taskId: 'T-1', title: 'first' }],
  delegations: [{ delegationId: 'D-1', taskId: 'T-1' }],
  threads: [{ threadId: 'th-1', rounds: 0 }],
  contexts: [{ ref: 'ctx-1', text: 'a' }]
})

describe('incremental chunk journal', () => {
  it('writes only the touched chunks and replays them into an identical state', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    await store.update('task/retitle', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'second' } } } } })
    await store.update('context/append', { patch: { set: { contexts: { 'ctx-2': { ref: 'ctx-2', text: 'b' } } }, order: { contexts: ['ctx-1', 'ctx-2'] } } })
    const lines = (await readFile(join(path, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0]!) as { schemaVersion: number; changes: Record<string, unknown> }
    expect(first.schemaVersion).toBe(2)
    expect(Object.keys(first.changes)).toEqual(['tasks'])
    const second = JSON.parse(lines[1]!) as { changes: { contexts: { set: Record<string, string>; order: string[] } } }
    expect(Object.keys(second.changes)).toEqual(['contexts'])
    expect(Object.keys(second.changes.contexts.set)).toEqual(['ctx-2'])
    expect(second.changes.contexts.order).toEqual(['ctx-1', 'ctx-2'])
    const expectedRoot = store.getRootChecksum()
    const expectedBytes = store.getStateBytes()
    const expectedState = store.read()
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(reopened.read()).toEqual(expectedState)
    expect(reopened.getRootChecksum()).toBe(expectedRoot)
    expect(reopened.getStateBytes()).toBe(expectedBytes)
    expect(Buffer.byteLength(canonicalStateJson(reopened.read()), 'utf8')).toBe(expectedBytes)
  })

  it('rejects a tampered incremental chunk on recovery', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    await store.update('task/retitle', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'second' } } } } })
    await store.dispose()
    const raw = await readFile(join(path, 'journal.jsonl'), 'utf8')
    await writeFile(join(path, 'journal.jsonl'), raw.replace('second', 'tampered'))
    await expect(createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  })

  it('keeps the previous committed state and sequence when the update would exceed the byte limit', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true, maxStateBytes: 4096 }))
    const before = { bytes: store.getStateBytes(), sequence: store.getSequence(), root: store.getRootChecksum() }
    await expect(store.update('context/huge', { patch: { set: { contexts: { 'ctx-huge': { ref: 'ctx-huge', text: 'x'.repeat(8192) } } } } }))
      .rejects.toMatchObject({ code: 'STATE_TOO_LARGE' })
    expect(store.getStateBytes()).toBe(before.bytes)
    expect(store.getSequence()).toBe(before.sequence)
    expect(store.getRootChecksum()).toBe(before.root)
  })

  it('passes only the touched chunks to the incremental validator and falls back to the full validator when absent', async () => {
    const path = await directory()
    const incremental = vi.fn((_state: unknown, _changed: unknown) => true)
    const full = vi.fn(() => true)
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: full, validateIncremental: incremental }))
    const fullCallsBefore = full.mock.calls.length
    // delegations 按任务分桶：桶键是 taskId，桶值是该任务的委派数组。
    await store.update('delegation/add', { patch: { set: { delegations: { 'T-1': [{ delegationId: 'D-1', taskId: 'T-1' }, { delegationId: 'D-2', taskId: 'T-1' }] } } } })
    expect(incremental).toHaveBeenCalledTimes(1)
    expect(incremental.mock.calls[0]![1]).toEqual([{ segment: 'delegations', key: 'T-1' }])
    expect(full.mock.calls.length).toBe(fullCallsBefore)
    const legacy = track(await createDurableStateStore({ directory: await directory(), ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: full }))
    const legacyFullCallsBefore = full.mock.calls.length
    await legacy.update('thread/round', { patch: { set: { threads: { 'th-1': { threadId: 'th-1', rounds: 1 } } } } })
    expect(full.mock.calls.length).toBe(legacyFullCallsBefore + 1)
  })

  it('applies the incremental validator result and leaves the state unchanged when it rejects', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(),
      validate: () => true, validateIncremental: (state) => state.delegations !== undefined && (state.delegations as Array<{ taskId: string }>).every((item) => item.taskId === 'T-1') }))
    await expect(store.update('delegation/bad', { patch: { set: { delegations: { 'T-9': [{ delegationId: 'D-3', taskId: 'T-9' }] } } } }))
      .rejects.toMatchObject({ code: 'STATE_INVALID' })
    expect(store.getSequence()).toBe(0)
    expect(store.read().delegations).toEqual([{ delegationId: 'D-1', taskId: 'T-1' }])
  })

  it('reads a legacy version-1 snapshot plus journal and continues with version-2 entries', async () => {
    const path = await directory()
    const legacyState = initialState()
    const encoded = canonicalStateJson(legacyState)
    const hash = (value: unknown) => createHash('sha256').update(canonicalStateJson(value)).digest('hex')
    const snapshot = { schemaVersion: 1, sequence: 0, checksum: hash(legacyState), state: legacyState }
    await writeFile(join(path, 'snapshot.json'), canonicalStateJson(snapshot) + '\n')
    await writeFile(join(path, 'journal.jsonl'), '')
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(store.read()).toEqual(legacyState)
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(store.getStateBytes())
    await store.update('task/retitle', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'upgraded' } } } } })
    const line = JSON.parse((await readFile(join(path, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).at(-1)!) as { schemaVersion: number; previousChecksum: string }
    expect(line.schemaVersion).toBe(2)
    expect(line.previousChecksum).toBe(ChunkedState.fromState(legacyState, SWARM_SEGMENT_SPECS).rootChecksum())
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(reopened.read().tasks).toEqual([{ taskId: 'T-1', title: 'upgraded' }])
  })
})
