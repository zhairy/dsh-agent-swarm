import assert from 'node:assert/strict'
import test from 'node:test'
import { intChildEndHub } from '../lib/threads.js'

test('a stale or forged rc.3 end cannot settle the current child activation', async () => {
  const hub = intChildEndHub(), abort = new AbortController()
  const current = { id: 'same-child', runId: 'new-run', provider: 'spawn', parentSessionId: 'root', local: true }
  let settled = false
  const waiting = hub.wait(current.id, abort.signal).then(info => { settled = true; return info })
  hub.ObserveStart?.(current)
  for (const changed of [{ runId: 'old-run' }, { provider: 'external' }, { parentSessionId: 'other-root' }, { local: false }]) {
    hub.Emit({ ...current, ...changed, stopReason: 'completed' })
    await Promise.resolve()
    assert.equal(settled, false, JSON.stringify(changed))
  }
  hub.Emit({ ...current, stopReason: 'completed' })
  assert.equal((await waiting).runId, current.runId)
  const next = hub.wait(current.id, abort.signal).catch(error => error.name)
  hub.Emit({ ...current, stopReason: 'completed' })
  abort.abort()
  assert.equal(await next, 'AbortError', '重复结束不能消费下一轮等待者')
})

test('legacy end delivery remains supported without a run identity', async () => {
  const hub = intChildEndHub()
  const waiting = hub.wait('legacy-child', new AbortController().signal)
  hub.Emit({ id: 'legacy-child', stopReason: 'completed' })
  assert.equal((await waiting).id, 'legacy-child')
})
