#!/usr/bin/env node
// Synthetic, isolated budget benchmark. Reads trusted source files without building lib/ or loading DSH.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { cpus, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

const args = process.argv.slice(2)
const option = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
const sampleCount = Number(option('--samples') ?? 30)
const warmup = Number(option('--warmup') ?? 5)
const sizes = (option('--sizes') ?? '500,2000,5000').split(',').map(Number)
if (!Number.isSafeInteger(sampleCount) || sampleCount < 5 || sampleCount > 100
  || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 20
  || sizes.length > 6 || sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 10000)) throw new Error('Invalid benchmark sample/resource limits')
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]

if (option('--worker')) {
  const sourcePath = resolve(option('--worker'))
  const source = await readFile(sourcePath, 'utf8')
  const javascript = sourcePath.endsWith('.ts') ? stripTypeScriptTypes(source, { mode: 'transform' }) : source
  const { createExecutionBudget } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'))
  const sample = (count, scenario) => {
    global.gc?.()
    const initialHeap = process.memoryUsage().heapUsed
    const limits = scenario === 'unlimited-generation'
      ? { maxDelegations: 0, maxTokens: 0, maxCostUsd: 0, maxMathWorkUnits: 1_000_000 }
      : scenario === 'jev-with-positive-caps' ? { maxDelegations: 1, maxTokens: 1, maxCostUsd: 0.001 }
        : { maxDelegations: count }
    const budget = createExecutionBudget(limits)
    const started = performance.now()
    for (let id = 0; id < count; id++) {
      const key = String(id)
      budget.reserve({ id: key, source: scenario === 'jev-with-positive-caps' ? 'jev' : 'delegate' })
      budget.start(key); budget.settle(key)
    }
    const elapsed = performance.now() - started
    // Keep each sample in its own stack frame: the previous sample's snapshot
    // must be unreachable before measuring the next initial heap.
    global.gc?.()
    const retained = process.memoryUsage().heapUsed - initialHeap
    const snapshot = budget.getSnapshot()
    if (snapshot.reservations.length !== count) throw new Error('Benchmark lost request history')
    if (scenario === 'jev-with-positive-caps' && snapshot.jev.attempts !== count) throw new Error('Benchmark lost Jev observations')
    return { elapsed, retained, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)) }
  }
  const rows = []
  for (const scenario of ['unlimited-generation', 'jev-with-positive-caps', 'limited-count']) for (const count of sizes) {
    const timings = [], retainedHeap = []
    let snapshotBytes = 0
    for (let iteration = 0; iteration < warmup + sampleCount; iteration++) {
      const result = sample(count, scenario)
      snapshotBytes = result.snapshotBytes
      const { elapsed, retained } = result
      if (iteration >= warmup) { timings.push(elapsed); retainedHeap.push(retained) }
    }
    rows.push({ scenario, count, medianMs: percentile(timings, 0.5), p95Ms: percentile(timings, 0.95),
      retainedHeapDeltaMedianBytes: percentile(retainedHeap, 0.5), snapshotBytes })
  }
  process.stdout.write(JSON.stringify({ sourceDigest: createHash('sha256').update(source).digest('hex'), rows,
    peakRssBytes: process.resourceUsage().maxRSS * (platform() === 'darwin' ? 1 : 1024) }))
} else {
  const run = promisify(execFile)
  const variants = { ...(option('--baseline-file') ? { before: resolve(option('--baseline-file')) } : {}),
    after: resolve(option('--current-file') ?? 'src/execution-budget.ts') }
  const results = []
  for (const [variant, source] of Object.entries(variants)) {
    const { stdout } = await run(process.execPath, ['--expose-gc', import.meta.filename, '--worker', source,
      '--samples', String(sampleCount), '--warmup', String(warmup), '--sizes', sizes.join(',')], { maxBuffer: 1024 * 1024 })
    results.push({ variant, ...JSON.parse(stdout) })
  }
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), baselineRef: option('--baseline-ref') ?? null,
    environment: { node: process.version, cpu: cpus()[0]?.model, platform: platform(), kernel: release() },
    sampleCount, warmup, sizes, methodology: 'Sequential isolated Node processes per source variant; GC before and after each sample. Measures synchronous reserve/start/settle only, excluding snapshot and DSH/model/I/O. Retained heap delta is not peak allocation; peak RSS includes the whole worker. All request history remains retained. No end-to-end latency, token, cost, or memory-saving claim.', results }
  const encoded = JSON.stringify(report, null, 2) + '\n'
  if (option('--output')) await writeFile(resolve(option('--output')), encoded)
  process.stdout.write(encoded)
}
