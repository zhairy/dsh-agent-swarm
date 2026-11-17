import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { ChunkedState } from '../../src/state-chunks.js'
import { createDurableStateStore } from '../../src/state-store.js'

it('恢复逐条验证增量但只物化最终状态，不随日志长度重复分配视图', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'state-p6-test-'))
  const initialState = { count: 0, body: 'synthetic'.repeat(1000) }
  let store: Awaited<ReturnType<typeof createDurableStateStore<typeof initialState>>> | undefined
  const spy = vi.spyOn(ChunkedState.prototype, 'materialize')
  try {
    store = await createDurableStateStore({ directory, initialState, snapshotEvery: 1000 })
    for (let count = 1; count <= 20; count++) await store.update('fixture/change', { patch: { whole: { count } } })
    await store.dispose()
    spy.mockClear()
    store = await createDurableStateStore({ directory, initialState, snapshotEvery: 1000 })
    expect(store.read()).toEqual({ ...initialState, count: 20 })
    expect(store.getSequence()).toBe(20)
    // 初始化、快照、最终发布各至多一次，不允许每条增量重新分配完整视图。
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
    const value = store.read(); value.count = -1
    expect(store.read().count).toBe(20)
    await store.update('fixture/after-recovery', { build: (state) => {
      expect(Object.isFrozen(state)).toBe(true)
      return { whole: { count: state.count + 1 } }
    } })
    expect(store.getSequence()).toBe(21)
    await store.dispose()
    store = await createDurableStateStore({ directory, initialState, snapshotEvery: 1000 })
    expect(store.read().count).toBe(21)
  } finally {
    spy.mockRestore()
    await store?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})

it('前缀恢复成功也不能跳过末条损坏的校验，失败后释放 owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'state-p6-corrupt-'))
  let store: Awaited<ReturnType<typeof createDurableStateStore<{ count: number }>>> | undefined
  try {
    store = await createDurableStateStore({ directory, initialState: { count: 0 }, snapshotEvery: 1000 })
    for (let count = 1; count <= 20; count++) await store.update('fixture/change', { patch: { whole: { count } } })
    await store.dispose()
    const path = join(directory, 'journal.jsonl')
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('"whole":"20"')
    await writeFile(path, raw.replace('"whole":"20"', '"whole":"99"'))
    await expect(createDurableStateStore({ directory, initialState: { count: 0 } })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    await expect(readFile(join(directory, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await store?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
