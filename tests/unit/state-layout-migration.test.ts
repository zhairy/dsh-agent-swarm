import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { LAYOUT_VERSION, LEGACY_SEGMENT_SPECS, SWARM_LAYOUT_OPTIONS, SWARM_SEGMENT_SPECS } from '../../src/state-chunks.js'

const directories: string[] = []
const stores: DurableStateStore<Record<string, unknown>>[] = []
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'swarm-layout-')); directories.push(path); return path }
const track = <T extends Record<string, unknown>>(store: DurableStateStore<T & Record<string, unknown>>) => { stores.push(store as DurableStateStore<Record<string, unknown>>); return store }
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const initialState = () => ({ schemaVersion: 1, tasks: [{ taskId: 'T-1', title: 'first' }], delegations: [] as Array<{ delegationId: string; taskId: string }> })
const currentOptions = { ...SWARM_LAYOUT_OPTIONS, validate: () => true }
const legacyOptions = { segments: LEGACY_SEGMENT_SPECS, legacySegments: LEGACY_SEGMENT_SPECS, layoutVersion: 1, validate: () => true }
const journalLines = async (path: string) => (await readFile(join(path, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { schemaVersion: number; layout?: unknown; changes?: unknown; state?: unknown })

describe('bucketed delegations', () => {
  it('merges one task of delegations into a single chunk and replays it unchanged', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    await store.update('delegation/add', { patch: { set: { delegations: { 'T-1': [{ delegationId: 'D-1', taskId: 'T-1' }, { delegationId: 'D-2', taskId: 'T-1' }] } } } })
    await store.update('delegation/add2', { patch: { set: { delegations: { 'T-1': [{ delegationId: 'D-1', taskId: 'T-1' }, { delegationId: 'D-2', taskId: 'T-1' }, { delegationId: 'D-3', taskId: 'T-1' }] } } } })
    const lines = await journalLines(path)
    // 两次提交都只触碰一个桶分片：段内分片数按任务计数，不随委派条数增长。
    expect(Object.keys((lines[0]!.changes as Record<string, { set: Record<string, unknown> }>).delegations.set)).toEqual(['T-1'])
    expect(Object.keys((lines[1]!.changes as Record<string, { set: Record<string, unknown> }>).delegations.set)).toEqual(['T-1'])
    const expected = store.read().delegations
    expect(expected).toHaveLength(3)
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(reopened.read().delegations).toEqual(expected)
  })

  it('keeps two tasks in two buckets and removes a bucket without touching the other', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    await store.update('delegation/two-tasks', { patch: { set: { delegations: {
      'T-1': [{ delegationId: 'D-1', taskId: 'T-1' }],
      'T-2': [{ delegationId: 'D-9', taskId: 'T-2' }]
    } } } })
    await store.update('delegation/drop-second', { patch: { remove: { delegations: ['T-2'] } } })
    expect(store.read().delegations).toEqual([{ delegationId: 'D-1', taskId: 'T-1' }])
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(reopened.read().delegations).toEqual([{ delegationId: 'D-1', taskId: 'T-1' }])
  })

  it('rejects a non-array value for a bucketed segment instead of failing later', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    await expect(store.update('delegation/bad-shape', { patch: { set: { delegations: { 'T-1': { delegationId: 'D-1', taskId: 'T-1' } } } } }))
      .rejects.toMatchObject({ code: 'STATE_INVALID', message: expect.stringContaining('array of bucket items') })
    expect(store.getSequence()).toBe(0)
    expect(store.read().delegations).toEqual([])
  })
})

describe('layout migration from the flat delegation layout', () => {
  it('recovers a legacy directory, writes one full migration line, then continues with incremental lines', async () => {
    const path = await directory()
    const legacy = track(await createDurableStateStore({ directory: path, ...legacyOptions, initialState: initialState() }))
    await legacy.commit('legacy/add', (draft) => { (draft.delegations as Array<{ delegationId: string; taskId: string }>).push({ delegationId: 'D-1', taskId: 'T-1' }) })
    const legacyState = legacy.read()
    const legacyLines = await journalLines(path)
    expect(legacyLines.every((line) => line.layout === 1)).toBe(true)
    await legacy.dispose()

    const upgraded = track(await createDurableStateStore({ directory: path, ...currentOptions, initialState: initialState() }))
    expect(upgraded.read()).toEqual(legacyState)
    await upgraded.update('delegation/add', { patch: { set: { delegations: { 'T-1': [
      { delegationId: 'D-1', taskId: 'T-1' }, { delegationId: 'D-2', taskId: 'T-1' }
    ] } } } })
    const lines = await journalLines(path)
    const migration = lines.at(-2)!
    const incremental = lines.at(-1)!
    expect(migration.layout).toBe(LAYOUT_VERSION)
    expect(migration.state).toBeDefined()
    expect(incremental.layout).toBe(LAYOUT_VERSION)
    expect(incremental.changes).toBeDefined()
    await upgraded.dispose()

    const reopened = track(await createDurableStateStore({ directory: path, ...currentOptions, initialState: initialState() }))
    expect(reopened.read().delegations).toHaveLength(2)
  })

  it('does not migrate on read-only open', async () => {
    const path = await directory()
    const legacy = track(await createDurableStateStore({ directory: path, ...legacyOptions, initialState: initialState() }))
    await legacy.commit('legacy/add', (draft) => { (draft.delegations as Array<{ delegationId: string; taskId: string }>).push({ delegationId: 'D-1', taskId: 'T-1' }) })
    await legacy.dispose()
    const before = (await journalLines(path)).length
    const reader = track(await createDurableStateStore({ directory: path, ...currentOptions, initialState: initialState() }))
    reader.read()
    await reader.dispose()
    expect((await journalLines(path)).length).toBe(before)
  })

  it('refuses a directory written by a newer layout version', async () => {
    const path = await directory()
    const future = track(await createDurableStateStore({ directory: path, segments: SWARM_SEGMENT_SPECS, legacySegments: SWARM_SEGMENT_SPECS,
      layoutVersion: LAYOUT_VERSION + 5, initialState: initialState(), validate: () => true }))
    await future.commit('future/write', (draft) => { draft.tasks = [{ taskId: 'T-1', title: 'future' }] })
    await future.dispose()
    await expect(createDurableStateStore({ directory: path, ...currentOptions, initialState: initialState() }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', message: expect.stringContaining('newer layout') })
  })

  it('fences a 3.1.3 layout-3 reader from layout-4 governance state', async () => {
    const path = await directory()
    const current = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    await current.commit('v314/governance', draft => { draft.schemaVersion = 2 })
    await current.dispose()
    const oldV3 = {
      segments: SWARM_SEGMENT_SPECS,
      legacySegments: LEGACY_SEGMENT_SPECS,
      legacyLayouts: { 1: LEGACY_SEGMENT_SPECS, 2: SWARM_SEGMENT_SPECS },
      layoutVersion: 3,
      validate: () => true
    }
    await expect(createDurableStateStore({ directory: path, ...oldV3, initialState: initialState() }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', message: expect.stringContaining('newer layout') })
  })
})
