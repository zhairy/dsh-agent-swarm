import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../../src/state-core.js'
import { ChunkedState, type SegmentSpecs } from '../../src/state-chunks.js'

const specs: SegmentSpecs = { contexts: { kind: 'list', keyOf: value => (value as { ref: string }).ref } }
afterEach(() => vi.restoreAllMocks())

it('恢复重建复用已经验证且完全冻结的分片编码，仍检查每个元素的身份', () => {
  let identities = 0
  const measuredSpecs: SegmentSpecs = { contexts: { kind: 'list', keyOf: value => { identities++; return (value as { ref: string }).ref } } }
  const first = ChunkedState.fromState({ contexts: [{ ref: 'ctx-1', nested: { text: '中文证据' } }] }, measuredSpecs)
  const view = first.materialize()
  const warmed = ChunkedState.fromState(view, measuredSpecs, { verified: true })
  const encoded = warmed.encode(), checksum = warmed.rootChecksum()
  const hash = vi.spyOn(core, 'checksumText'), canonical = vi.spyOn(core, 'canonicalStateJson')
  const calls = identities
  const next = ChunkedState.fromState(view, measuredSpecs, { verified: true })
  expect(identities - calls).toBe(1)
  expect(hash).not.toHaveBeenCalled()
  expect(canonical).not.toHaveBeenCalled()
  expect(next.encode()).toBe(encoded)
  expect(next.rootChecksum()).toBe(checksum)
  expect(next.materialize()).toEqual(view)
})

it('不把调用方浅冻结对象的可变后代当作安全缓存', () => {
  const mutable = { text: 'before' }
  const item = Object.freeze({ ref: 'ctx-1', nested: mutable })
  const view = { contexts: [item] }
  const before = ChunkedState.fromState(view, specs, { verified: true }).rootChecksum()
  ChunkedState.fromState(view, specs, { verified: true })
  mutable.text = 'after'
  const after = ChunkedState.fromState(view, specs, { verified: true })
  expect(after.rootChecksum()).not.toBe(before)
  expect(after.materialize()).toEqual({ contexts: [{ ref: 'ctx-1', nested: { text: 'after' } }] })
  Object.assign(mutable, { password: 'synthetic-forbidden' })
  expect(() => ChunkedState.fromState(view, specs, { verified: true })).toThrow(/Credential/)
})

it('验证器替换容器元素或引入访问器时仍重新编码并拒绝非法值', () => {
  const initial = ChunkedState.fromState({ contexts: [{ ref: 'ctx-1', text: 'before' }] }, specs)
  const view = initial.materialize() as { contexts: Array<{ ref: string; text: string }> }
  ChunkedState.fromState(view, specs, { verified: true })
  const checksum = ChunkedState.fromState(view, specs, { verified: true }).rootChecksum()
  view.contexts[0] = { ref: 'ctx-1', text: 'after' }
  expect(ChunkedState.fromState(view, specs, { verified: true }).rootChecksum()).not.toBe(checksum)
  view.contexts = [{ ref: 'ctx-1', get text() { throw new Error('accessor must not execute') } }]
  expect(() => ChunkedState.fromState(view, specs, { verified: true })).toThrow(/accessors/)
})

it.each(['whole', 'nested'])('不缓存可能撤销的 Proxy：%s', kind => {
  const { proxy, revoke } = Proxy.revocable(Object.freeze({ text: 'synthetic' }), {})
  const value = kind === 'whole' ? proxy : Object.freeze({ nested: proxy })
  const state = { body: value }
  ChunkedState.fromState(state, {}, { verified: true })
  ChunkedState.fromState(state, {}, { verified: true })
  revoke()
  expect(() => ChunkedState.fromState(state, {}, { verified: true })).toThrow(TypeError)
})
