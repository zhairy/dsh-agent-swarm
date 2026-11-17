import { mkdtemp, mkdir, readdir, readFile, stat, statfs, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'

// 编译产物与持久化均显式传入；只使用冻结合成状态，不读取真实历史。
const [compiled, output, temporaryRoot] = process.argv.slice(2)
if (!compiled || !output || !temporaryRoot) throw new Error('Usage: node --expose-gc scripts/benchmark-state-p6.mjs compiled output ext4-private-root')
await mkdir(temporaryRoot, { recursive: true })
const filesystem = await statfs(temporaryRoot)
assert.equal(filesystem.type, 0xef53, 'benchmark requires ext4, not tmpfs/LayerFS')
const load = (name) => import(pathToFileURL(join(resolve(compiled), name + '.js')))
const { createDurableStateStore } = await load('state-store')
const { createSwarmEventJournal } = await load('event-journal')
const { appendStateCommitToJournal, recoverStateFromJournal } = await load('state-journal')
const { ChunkedState, SWARM_SEGMENT_SPECS: specs } = await load('state-chunks')
const { checksumText, deepFreeze } = await load('state-core')
const initial = deepFreeze({ schemaVersion: 1, count: 0,
  tasks: Array.from({ length: 300 }, (_, n) => ({ taskId: `T-${n}`, status: 'queued', title: `Synthetic task ${n}`, body: 'task-context-'.repeat(32) })),
  contexts: Array.from({ length: 600 }, (_, n) => ({ ref: `C-${n}`, body: 'synthetic-context-'.repeat(32) })) })
const inputJson = JSON.stringify(initial)
const digest = (s) => createHash('sha256').update(s).digest('hex')
const bytesOnDisk = async (directory) => {
  let bytes = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    bytes += entry.isDirectory() ? await bytesOnDisk(path) : (await stat(path)).size
  }
  return bytes
}
const rows = []
const measure = async (operation, patches, sample, run) => {
  global.gc?.()
  const heap = process.memoryUsage().heapUsed
  let fromStateCalls = 0, materializeCalls = 0, encodedBytes = 0, validators = 0
  const from = ChunkedState.fromState, materialize = ChunkedState.prototype.materialize
  ChunkedState.fromState = function (...args) {
    fromStateCalls++
    const result = from.apply(this, args)
    encodedBytes += result.getStateBytes()
    return result
  }
  ChunkedState.prototype.materialize = function (...args) { materializeCalls++; return materialize.apply(this, args) }
  const cpu = process.cpuUsage()
  const start = performance.now()
  try {
    const result = await run(() => { validators++ })
    rows.push({ operation, patches, sample, ms: performance.now() - start, cpuMicros: process.cpuUsage(cpu),
      heapDeltaBytes: process.memoryUsage().heapUsed - heap, fromStateCalls, materializeCalls, fromStateEncodedBytes: encodedBytes, validators, ...result })
  } finally {
    ChunkedState.fromState = from
    ChunkedState.prototype.materialize = materialize
  }
}
try {
  for (const patches of [50, 200]) {
    const root = await mkdtemp(join(resolve(temporaryRoot), `fixture-${patches}-`))
    const eventDirectory = join(root, 'events'), localDirectory = join(root, 'local')
    const journal = createSwarmEventJournal({ directory: eventDirectory, rootSessionId: 'synthetic-p6', now: () => new Date('2026-01-01T00:00:00Z') })
    let chunked = ChunkedState.fromState(initial, specs, { verified: true })
    appendStateCommitToJournal(journal, { kind: 'snapshot', type: 'fixture/seed', sequence: 0, previousChecksum: checksumText(''), checksum: chunked.rootChecksum(), state: initial })
    let store = await createDurableStateStore({ directory: localDirectory, initialState: initial, segments: specs, snapshotEvery: 10000 })
    for (let sequence = 1; sequence <= patches; sequence++) {
      const patch = { whole: { count: sequence } }
      const previousChecksum = chunked.rootChecksum()
      chunked = chunked.preview(patch).next
      // 同时覆盖两种合法表示，使用与现有 state-journal 测试一致的 append 构造器与规格。
      appendStateCommitToJournal(journal, { kind: 'patch', type: 'fixture/change', sequence, previousChecksum,
        checksum: chunked.rootChecksum(), ...(sequence % 2 ? { patch } : { changes: { count: { whole: String(sequence) } } }) })
      await store.update('fixture/change', { patch })
    }
    await store.dispose()
    const expected = { ...initial, count: patches }
    const journalHash = digest(JSON.stringify(journal.read().events))
    for (let sample = 0; sample < 7; sample++) {
      await measure('event-journal-recovery', patches, sample, async (validated) => {
        // 包括真实文件重新装载；queryTypes/恢复均走生产代码。
        const diskJournal = createSwarmEventJournal({ directory: eventDirectory, rootSessionId: 'synthetic-p6' })
        const recovered = recoverStateFromJournal(diskJournal, { specs, validate: (value) => {
          validated()
          return value.schemaVersion === 1 && value.tasks.length === 300 && value.contexts.length === 600 && Number.isSafeInteger(value.count)
        } })
        assert.deepEqual(recovered.state, expected)
        assert.equal(recovered.commits, patches + 1)
        assert.deepEqual(recovered.issues, [])
        return { journalHash, persistedBytes: await bytesOnDisk(eventDirectory), writtenBytes: 0 }
      })
      const localBefore = await bytesOnDisk(localDirectory)
      await measure('state-store-recovery', patches, sample, async () => {
        store = await createDurableStateStore({ directory: localDirectory, initialState: initial, segments: specs, snapshotEvery: 10000 })
        assert.deepEqual(store.read(), expected)
        assert.equal(store.getSequence(), patches)
        return { journalHash: digest(await readFile(join(localDirectory, 'journal.jsonl'))), persistedBytes: localBefore }
      })
      await store.dispose()
    }
    store = await createDurableStateStore({ directory: localDirectory, initialState: expected, segments: specs, snapshotEvery: 10000,
      journalOnly: true, initialSequence: patches, beforeCommit: (fact) => appendStateCommitToJournal(journal, fact) })
    // journalOnly 从显式 initialState 起步；使用不同值保证单 key 写入实际发生。
    for (let sample = 0; sample < 7; sample++) {
      for (const operation of ['single-key', 'noop']) {
        const before = await bytesOnDisk(eventDirectory)
        await measure(operation, patches, sample, async () => {
          const result = await store.update('fixture/change', { patch: { whole: { count: patches + sample + 1 } } })
          assert.equal(result.changed, operation === 'single-key')
          return { writtenBytes: (await bytesOnDisk(eventDirectory)) - before,
            logicalChangeBytes: operation === 'noop' ? 0 : Buffer.byteLength(String(patches + sample + 1)) }
        })
      }
    }
    await store.dispose()
  }
  await writeFile(output, JSON.stringify({ node: process.version, platform: process.platform, filesystemType: filesystem.type,
    inputBytes: Buffer.byteLength(inputJson), inputSha256: digest(inputJson), tasks: 300, contexts: 600,
    samples: 7, cache: 'warm OS cache; sample 0 first recovery; no cache eviction, no cold-disk claim',
    memory: 'heap delta after pre-sample GC, not total allocation; deterministic counts instrumented equally in both versions',
    persistedBytes: 'logical file sizes, not physical device writes; fsync unchanged', rows }, null, 2))
} catch (error) {
  console.error('P6 synthetic benchmark failed', { output, temporaryRoot, error: String(error) })
  throw error
}
