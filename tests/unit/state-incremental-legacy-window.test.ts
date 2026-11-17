import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalStateJson, createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { SWARM_LAYOUT_OPTIONS } from '../../src/state-chunks.js'

const directories: string[] = []
const stores: DurableStateStore<Record<string, unknown>>[] = []
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'swarm-state-legacy-window-')); directories.push(path); return path }
const track = <T extends Record<string, unknown>>(store: DurableStateStore<T & Record<string, unknown>>) => { stores.push(store as DurableStateStore<Record<string, unknown>>); return store }
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const hash = (value: unknown) => createHash('sha256').update(canonicalStateJson(value)).digest('hex')
const initialState = () => ({ schemaVersion: 1, tasks: [] as Array<{ taskId: string; title: string }>, contexts: [] as unknown[] })

const versionOneEntry = (fields: { sequence: number; type: string; previousChecksum: string; checksum: string; state: unknown }) => {
  const payload = { schemaVersion: 1, ...fields }
  return canonicalStateJson({ ...payload, entryChecksum: hash(payload) })
}

/**
 * 2.5.2 的压缩顺序是「先写快照、再清空日志」。若进程恰好在两步之间退出，
 * 目录里会留下「快照序号与日志行号重叠、且日志行是 v1 全量行」的形态。
 * 2.6.0 升级后打开这种目录必须仍然可恢复。
 */
describe('legacy snapshot and journal overlap (crash between snapshot write and journal clear)', () => {
  const buildCrashWindowDirectory = async (options: { forgeLastChecksum?: boolean } = {}) => {
    const path = await directory()
    const empty = initialState()
    const first = { ...empty, tasks: [{ taskId: 'T-1', title: 'one' }] }
    const second = { ...empty, tasks: [{ taskId: 'T-1', title: 'one' }, { taskId: 'T-2', title: 'two' }] }
    const lines = [
      versionOneEntry({ sequence: 1, type: 'legacy/add', previousChecksum: hash(empty), checksum: hash(first), state: first }),
      versionOneEntry({ sequence: 2, type: 'legacy/add', previousChecksum: hash(first), checksum: options.forgeLastChecksum === true ? hash(empty) : hash(second), state: second })
    ]
    await writeFile(join(path, 'journal.jsonl'), lines.join('\n') + '\n')
    await writeFile(join(path, 'snapshot.json'), canonicalStateJson({ schemaVersion: 1, sequence: 2, checksum: hash(second), state: second }) + '\n')
    return { path, second }
  }

  it('recovers the snapshot state and continues with version-2 incremental entries', async () => {
    const { path, second } = await buildCrashWindowDirectory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(store.read()).toEqual(second)
    expect(store.getSequence()).toBe(2)
    await store.update('task/retitle', { patch: { set: { tasks: { 'T-2': { taskId: 'T-2', title: 'two-v2' } } } } })
    const appended = JSON.parse((await readFile(join(path, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).at(-1)!) as { schemaVersion: number }
    expect(appended.schemaVersion).toBe(2)
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
    expect(reopened.read().tasks).toEqual([{ taskId: 'T-1', title: 'one' }, { taskId: 'T-2', title: 'two-v2' }])
  })

  it('still rejects a same-sequence legacy line whose checksum disagrees with the snapshot', async () => {
    const { path } = await buildCrashWindowDirectory({ forgeLastChecksum: true })
    await expect(createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: initialState(), validate: () => true }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  })
})

describe('whole patches on declared segments', () => {
  it('rejects a whole patch for an absent segment that is declared as a chunked kind', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: { schemaVersion: 1 }, validate: () => true }))
    await expect(store.update('seed/whole', { patch: { whole: { tasks: [{ taskId: 'T-1', title: 'seed' }] } } }))
      .rejects.toMatchObject({ code: 'STATE_INVALID' })
    // 拒绝后同一段仍按声明类型接受分片补丁，段类型不会被固化。
    await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'chunked' } } } } })
    expect(store.read().tasks).toEqual([{ taskId: 'T-1', title: 'chunked' }])
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: { schemaVersion: 1 }, validate: () => true }))
    expect(reopened.read().tasks).toEqual([{ taskId: 'T-1', title: 'chunked' }])
  })
})
