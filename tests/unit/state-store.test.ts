import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurableStateStore, markInterruptedOnRecovery, type DurableStateStore } from '../../src/state-store.js'

const directories: string[] = []
const stores: DurableStateStore<unknown>[] = []
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'swarm-state-test-')); directories.push(path); return path }
const track = <T>(store: DurableStateStore<T>) => { stores.push(store as DurableStateStore<unknown>); return store }
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.dispose().catch(() => undefined))); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('durable snapshot and committed journal', () => {
  it('serializes concurrent updates and restores full state rather than audit summaries', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, initialState: { count: 0, unresolved: ['important'], fullText: 'complete non-redacted proof context' } }))
    await Promise.all(Array.from({ length: 8 }, () => store.commit('increment', async (draft) => { await Promise.resolve(); draft.count++ })))
    expect(store.read().count).toBe(8)
    expect(store.getSequence()).toBe(8)
    const detached = store.read(); detached.unresolved.length = 0
    expect(store.read().unresolved).toEqual(['important'])
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, initialState: { count: 0, unresolved: [], fullText: '' } }))
    expect(reopened.read()).toEqual({ count: 8, unresolved: ['important'], fullText: 'complete non-redacted proof context' })
  })

  it('compacts safely and interrupts running work on recovery without replay', async () => {
    const path = await directory()
    const initial = { attempts: [{ status: 'queued', command: 'user-side-effect' }], bindings: [{ agentId: 'a', state: 'active', busy: true }] }
    const store = track(await createDurableStateStore({ directory: path, initialState: initial, snapshotEvery: 2 }))
    await store.commit('attempt/start', (draft) => { (draft.attempts[0] as { status: string }).status = 'running' })
    await store.commit('checkpoint', () => undefined)
    expect(await readFile(join(path, 'journal.jsonl'), 'utf8')).toBe('')
    await store.dispose()
    const reopened = track(await createDurableStateStore({ directory: path, initialState: initial, recover: markInterruptedOnRecovery }))
    expect(reopened.read().attempts[0]).toMatchObject({ status: 'interrupted', mutationUnknown: true })
    expect(reopened.read().bindings[0]).toMatchObject({ state: 'suspended', busy: false })
  })

  it('fails closed for corruption, partial records and unsupported snapshots', async () => {
    for (const kind of ['checksum', 'partial', 'version']) {
      const path = await directory()
      const store = track(await createDurableStateStore({ directory: path, initialState: { n: 0 } }))
      await store.commit('change', (draft) => { draft.n = 1 }); await store.dispose()
      if (kind === 'partial') await writeFile(join(path, 'journal.jsonl'), '{"incomplete":true}')
      if (kind === 'checksum') {
        const raw = await readFile(join(path, 'journal.jsonl'), 'utf8')
        await writeFile(join(path, 'journal.jsonl'), raw.replace('"n":1', '"n":2'))
      }
      if (kind === 'version') {
        const snapshot = JSON.parse(await readFile(join(path, 'snapshot.json'), 'utf8')) as Record<string, unknown>
        snapshot.schemaVersion = 99
        await writeFile(join(path, 'snapshot.json'), JSON.stringify(snapshot))
      }
      await expect(createDurableStateStore({ directory: path, initialState: { n: 0 } })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    }
  })

  it('retains the last durable state and rejects subsequent writes after I/O failure', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, initialState: { n: 0 } }))
    await mkdir(join(path, 'journal.jsonl'))
    await expect(store.commit('change', (draft) => { draft.n = 1 })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(store.read()).toEqual({ n: 0 })
    await expect(store.commit('change', (draft) => { draft.n = 2 })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  })

  it('checks ownership, schema, credential fields and symlink snapshots', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, initialState: { n: 0 }, validate: (raw) => typeof (raw as { n: unknown }).n === 'number' }))
    await expect(createDurableStateStore({ directory: path, initialState: { n: 0 } })).rejects.toMatchObject({ code: 'OWNER_ACTIVE' })
    await expect(store.commit('invalid', () => ({ n: 'wrong' } as unknown as { n: number }))).rejects.toMatchObject({ code: 'STATE_INVALID' })
    await expect(store.commit('secret', () => ({ n: 1, apiKey: 'private-value' }))).rejects.toMatchObject({ code: 'STATE_INVALID' })
    await store.dispose()
    await rm(join(path, 'snapshot.json'))
    const outside = join(await directory(), 'outside.json'); await writeFile(outside, '{}')
    await symlink(outside, join(path, 'snapshot.json'))
    await expect(createDurableStateStore({ directory: path, initialState: { n: 0 } })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  })

  it('offers the same transactional API without claiming durability when disabled', async () => {
    const store = track(await createDurableStateStore({ directory: join(await directory(), 'not-created'), initialState: { n: 0 }, enabled: false }))
    expect(store.durable).toBe(false)
    await store.commit('change', (draft) => { draft.n = 1 })
    expect(store.read().n).toBe(1)
  })
})
