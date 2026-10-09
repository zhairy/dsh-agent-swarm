#!/usr/bin/env node
// Isolated source benchmark: does not build lib/, start DSH, or call a model.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { cpus, platform, release } from 'node:os'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const args = process.argv.slice(2)
const option = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
const samples = Number(option('--samples') ?? 30)
const warmup = Number(option('--warmup') ?? 5)
const sizes = (option('--sizes') ?? '1000,5000,10000').split(',').map(Number)
if (!Number.isSafeInteger(samples) || samples < 5 || samples > 100
  || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 20
  || sizes.length > 6 || sizes.some((size) => !Number.isSafeInteger(size) || size < 1 || size > 50000)) throw new Error('Invalid benchmark sample/resource limits')
const dependencyDirectory = resolve(option('--dependencies-dir') ?? fileURLToPath(new URL('../lib', import.meta.url)))
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
const summarize = (values) => ({ median: percentile(values, 0.5), p95: percentile(values, 0.95), min: Math.min(...values), max: Math.max(...values) })

if (option('--worker')) {
  const sourcePath = resolve(option('--worker'))
  const source = await readFile(sourcePath, 'utf8')
  const javascript = stripTypeScriptTypes(source, { mode: 'transform' }).replace(/(from\s+['"])(\.\/[^'"]+)(['"])/g,
    (_, before, relativePath, after) => before + pathToFileURL(resolve(dependencyDirectory, relativePath)).href + after)
  const { intRouteStateRegistry } = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'))
  const { getSwarmConfig } = await import(pathToFileURL(resolve(dependencyDirectory, 'config.js')).href)
  const route = { provider: 'benchmark', model: 'fixture' }
  const config = getSwarmConfig({ routes: { tian_shu: { chain: [route] } } })
  const rows = []
  for (const scenario of ['failed-one-shot', 'cancelled-one-shot', 'failed-root-steps']) for (const count of sizes) {
    const timings = [], heap = []
    let retainedAgents = 0, diagnostics
    let retained
    for (let iteration = 0; iteration < samples + warmup; iteration++) {
      retained = undefined
      global.gc?.()
      const beforeHeap = process.memoryUsage().heapUsed
      retained = intRouteStateRegistry()
      const started = performance.now()
      for (let index = 0; index < count; index++) {
        const id = scenario === 'failed-root-steps' ? 'benchmark-root' : `child-${index}`
        const requestId = `D-${index}`
        const agent = { id, session: { header: {} } }
        if (scenario === 'failed-root-steps') retained.BeginRequestStep(id, 0, index)
        else { retained.AddChild(id, { chain: [route], role: 'tan_wei', logicalRequestId: requestId }); retained.BeginRequestStep(id, 0, 0) }
        retained.getRequestOverride(agent, route, scenario === 'failed-root-steps' ? 'tian_shu' : undefined, config, true)
        if (scenario !== 'cancelled-one-shot') retained.getErrorAction({ agent, provider: route.provider, failure: { status: 400 } }, undefined, scenario === 'failed-root-steps' ? 'tian_shu' : undefined, config)
        if (scenario !== 'failed-root-steps') {
          retained.ReleaseAgent(id); retained.DelAgent(id)
          if (scenario === 'failed-one-shot' && retained.getTerminal(id) !== 'route_chain_exhausted') throw new Error('Terminal outcome lost before delegation consumed it')
          retained.FinishLogicalRequest?.(requestId)
        }
      }
      const elapsed = performance.now() - started
      global.gc?.()
      const retainedBytes = process.memoryUsage().heapUsed - beforeHeap
      // Inspect reachability after timing; do not turn the measurement into an O(N²) scan.
      retainedAgents = scenario === 'failed-root-steps' ? Number(retained.getRecovery('benchmark-root') !== undefined)
        : Array.from({ length: count }, (_, index) => Number(retained.getRecovery(`child-${index}`) !== undefined)).reduce((sum, value) => sum + value, 0)
      diagnostics = retained.getRecoveryDiagnostics?.() ?? null
      if (iteration >= warmup) { timings.push(elapsed); heap.push(retainedBytes) }
    }
    rows.push({ scenario, count, latencyMs: summarize(timings), retainedHeapDeltaBytes: summarize(heap), retainedAgents, diagnostics,
      raw: { latencyMs: timings, retainedHeapDeltaBytes: heap } })
  }
  process.stdout.write(JSON.stringify({ sourceDigest: createHash('sha256').update(source).digest('hex'), rows,
    peakRssBytes: process.resourceUsage().maxRSS * (platform() === 'darwin' ? 1 : 1024) }))
} else {
  const run = promisify(execFile)
  const variants = { ...(option('--baseline-file') ? { before: resolve(option('--baseline-file')) } : {}), after: resolve(option('--current-file') ?? 'src/route-state.ts') }
  const results = []
  for (const [variant, source] of Object.entries(variants)) {
    const { stdout } = await run(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', source,
      '--samples', String(samples), '--warmup', String(warmup), '--sizes', sizes.join(','), '--dependencies-dir', dependencyDirectory], { maxBuffer: 4 * 1024 * 1024 })
    results.push({ variant, ...JSON.parse(stdout) })
  }
  const dependencyDigests = {}
  for (const file of ['config.js', 'routes.js', 'route-health.js', 'provider-policy.js', 'network.js', 'upgrade.js']) dependencyDigests[file] = createHash('sha256').update(await readFile(resolve(dependencyDirectory, file))).digest('hex')
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), baselineRef: option('--baseline-ref') ?? null,
    environment: { node: process.version, cpu: cpus()[0]?.model, platform: platform(), kernel: release() }, samples, warmup, sizes, dependencyDigests,
    methodology: 'Sequential isolated Node processes per trusted source variant, in-memory TS stripping with existing compiled shared dependencies. GC outside each measured sample. Synthetic start/fail/dispose/finish lifecycle only; no DSH, model or file I/O in the timed section. Retained heap delta is noisy and is not peak allocation. Public getRecovery reachability and aggregate lifecycle counts corroborate retention. No production or end-to-end performance claim.',
    complexity: { before: 'O(all failed/cancelled historical requests) retained recovery memory; successful cleanup cannot reclaim failed steps.',
      after: 'O(active delegation steps + persistent/current agents + at most 1024 legacy terminal receipts); FinishLogicalRequest costs O(steps + associated agents), root step replacement O(1).' }, results }
  const encoded = JSON.stringify(report, null, 2) + '\n'
  if (option('--output')) await writeFile(resolve(option('--output')), encoded)
  process.stdout.write(encoded)
}
