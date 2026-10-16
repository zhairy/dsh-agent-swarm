import { describe, expect, it } from 'vitest'
import { canonicalStateJson } from '../../src/state-core.js'
import { ChunkedState, SWARM_LAYOUT_OPTIONS } from '../../src/state-chunks.js'

const specs = SWARM_LAYOUT_OPTIONS.segments

/** 覆盖字符串转义、嵌套容器、空值与分桶段：切分器必须与逐段编码完全等价。 */
const trickyState = () => ({
  schemaVersion: 1,
  tasks: [
    { taskId: 'T-1', title: '含 "引号" 与 \\ 反斜杠 与 {} [] 与 ,逗号', notes: ['a",b', 'c\\d', '\n\t'] },
    { taskId: 'T-2', title: '', nested: { deep: { deeper: [1, 2, { x: null }, [true, false]] } } },
    { taskId: '3', title: '数字键名任务' }
  ],
  delegations: [
    { delegationId: 'D-1', taskId: 'T-1', summary: 'x', evidence: [{ kind: 'command', ref: 'a,b' }] },
    { delegationId: 'D-2', taskId: 'T-1', summary: '' },
    { delegationId: 'D-3', taskId: '3', summary: '{"injected":true}' }
  ],
  contexts: [],
  empty: {},
  emptyList: [],
  scalars: { a: 0, b: -1.5, c: null, d: true },
  runtime: { counters: { native: 0, jev: 0, review: 0, session: 0 }, rootEditAt: 1, taskSequence: 2, rootUpgradeExplicit: [] }
})

describe('chunked encoding invariants', () => {
  it('re-encodes a tricky state byte-for-byte', () => {
    const state = trickyState()
    const encoded = canonicalStateJson(state)
    const chunked = ChunkedState.fromState(JSON.parse(encoded) as unknown, specs, { verified: true })
    expect(chunked.encode()).toBe(encoded)
    expect(chunked.getStateBytes()).toBe(Buffer.byteLength(encoded, 'utf8'))
    expect(chunked.materialize()).toEqual(state)
    // 根哈希必须只依赖内容：同一状态重新分片后仍然相同。
    const again = ChunkedState.fromState(JSON.parse(encoded) as unknown, specs, { verified: true })
    expect(again.rootChecksum()).toBe(chunked.rootChecksum())
  })

  it('groups delegations into one bucket per task', () => {
    const chunked = ChunkedState.fromState(trickyState(), specs)
    // 两个任务各一个桶：段内分片数按任务计数，而不是按委派条数。
    expect(chunked.order('delegations')).toEqual(['T-1', '3'])
    expect(chunked.segmentEncoded('delegations')).toBe(canonicalStateJson(trickyState().delegations))
    // 分桶只改变分片划分，不改变整份编码。
    const flat = ChunkedState.fromState(trickyState(), {})
    expect(flat.encode()).toBe(chunked.encode())
  })

  it('keeps whole segments byte-identical', () => {
    const state = { schemaVersion: 1, runtime: { rootEditAt: 0, taskSequence: 0, counters: { native: 0, jev: 0, review: 0, session: 0 }, rootUpgradeExplicit: ['a'] } }
    const encoded = canonicalStateJson(state)
    const chunked = ChunkedState.fromState(state, specs)
    expect(chunked.segmentEncoded('runtime')).toBe(canonicalStateJson(state.runtime))
    expect(chunked.encode()).toBe(encoded)
  })

  it('classifies unserialisable values as STATE_INVALID instead of leaking TypeError', () => {
    const cyclic: Record<string, unknown> = { schemaVersion: 1 }
    cyclic.self = cyclic
    // 内存态记录里的 undefined/类原型会被 JSON 往返归一化（与旧全量路径一致），但循环引用必须给出可分类错误。
    expect(() => ChunkedState.fromState(cyclic, specs)).toThrow(/STATE_INVALID|not serialisable|cyclic/)
  })
})
