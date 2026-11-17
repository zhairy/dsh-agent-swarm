import { mkdir, mkdtemp, readdir, stat, statfs, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { strict as assert } from 'node:assert'

// 单独观察上下文身份/正文重复；不启用新去重行为，不读取用户上下文。
const [compiled, output, root] = process.argv.slice(2)
if (!compiled || !output || !root) throw new Error('Usage: node --expose-gc benchmark-state-context-p6.mjs compiled output ext4-private-root')
await mkdir(root, { recursive: true })
assert.equal((await statfs(root)).type, 0xef53)
const load = (name) => import(pathToFileURL(join(resolve(compiled), `${name}.js`)))
const { createDurableStateStore } = await load('state-store')
const { createSwarmEventJournal } = await load('event-journal')
const { initializeStateJournal, appendStateCommitToJournal } = await load('state-journal')
const { SWARM_SEGMENT_SPECS: specs } = await load('state-chunks')
const bytes = async (directory) => {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    total += entry.isDirectory() ? await bytes(path) : (await stat(path)).size
  }
  return total
}
let store
try {
  const directory = await mkdtemp(join(resolve(root), 'context-'))
  const initialState = { tasks: Array.from({ length: 300 }, (_, n) => ({ taskId: `T-${n}` })),
    contexts: Array.from({ length: 600 }, (_, n) => ({ ref: `C-${n}`, body: 'synthetic-context-'.repeat(32) })) }
  const events = join(directory, 'events')
  const journal = createSwarmEventJournal({ directory: events, rootSessionId: 'synthetic-context-p6', now: () => new Date('2026-01-01T00:00:00Z') })
  initializeStateJournal(journal, initialState, 0, specs)
  store = await createDurableStateStore({ directory: join(directory, 'store'), initialState, segments: specs,
    journalOnly: true, beforeCommit: (fact) => appendStateCommitToJournal(journal, fact) })
  const rows = []
  for (let sample = 0; sample < 7; sample++) {
    for (const operation of ['same-ref-same-body', 'new-ref-same-body']) {
      const ref = operation === 'same-ref-same-body' ? 'C-0' : `duplicate-${sample}`
      const context = { ...initialState.contexts[0], ref }
      const before = await bytes(events), sequence = store.getSequence()
      global.gc?.()
      const heap = process.memoryUsage().heapUsed, start = performance.now()
      const result = await store.update('fixture/context', { patch: { set: { contexts: { [ref]: context } } } })
      const ms = performance.now() - start, heapDeltaBytes = process.memoryUsage().heapUsed - heap
      const writtenBytes = (await bytes(events)) - before
      assert.equal(result.changed, operation === 'new-ref-same-body')
      assert.equal(result.sequence, sequence + Number(result.changed))
      if (!result.changed) assert.equal(writtenBytes, 0)
      rows.push({ operation, sample, ms, heapDeltaBytes, writtenBytes, changed: result.changed,
        contextEncodedBytes: Buffer.byteLength(JSON.stringify(context)) })
    }
  }
  await writeFile(output, JSON.stringify({ samples: 7, tasks: 300, contexts: 600, filesystem: 'ext4', cache: 'warm; no eviction',
    memory: 'heap delta only, not allocation/peak', writeMetric: 'logical EventJournal file growth, not device writes', rows }, null, 2))
} catch (error) {
  console.error('P6 context observation failed', { output, error: String(error) })
  throw error
} finally { await store?.dispose() }
