#!/usr/bin/env node
// Fake metadata only: no model generation, credentials, CLI startup, network or production build.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { cpus, platform, release } from 'node:os'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const args = process.argv.slice(2)
const option = (key) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
const sampleCount = Number(option('--samples') ?? 30), warmup = Number(option('--warmup') ?? 5)
const counts = (option('--owners') ?? '1,10,100').split(',').map(Number)
const delayMs = Number(option('--delay-ms') ?? 2)
if (!Number.isSafeInteger(sampleCount) || sampleCount < 5 || sampleCount > 100
  || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 20
  || counts.length > 6 || counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 1000)
  || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > 50) throw new Error('Invalid probe benchmark limits')
const asModule = (source) => 'data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64')
const variants = []
for (const [name, directory] of Object.entries({ ...(option('--baseline-dir') ? { before: resolve(option('--baseline-dir')) } : {}), after: resolve(option('--current-dir') ?? 'src') })) {
  const files = Object.fromEntries(await Promise.all(['routes.ts', 'provider-policy.ts', 'util/errors.ts'].map(async (file) => [file, await readFile(join(directory, file), 'utf8')])))
  const routeSource = files['routes.ts'].replace("'./provider-policy.js'", JSON.stringify(asModule(files['provider-policy.ts'])))
    .replace("'./util/errors.js'", JSON.stringify(asModule(files['util/errors.ts'])))
  variants.push({ name, module: await import(asModule(routeSource)),
    sourceDigests: Object.fromEntries(Object.entries(files).map(([file, source]) => [file, createHash('sha256').update(source).digest('hex')])) })
}
const chain = Array.from({ length: 4 }, (_, i) => ({ provider: 'fake-provider', model: 'fake-model-' + i }))
const rows = []
for (const mode of ['sequential-owners', 'concurrent-owners']) for (const owners of counts) {
  const measurements = new Map(variants.map((variant) => [variant.name, []]))
  for (let iteration = 0; iteration < warmup + sampleCount; iteration++) {
    for (const variant of iteration % 2 ? [...variants].reverse() : variants) {
      let modelInfoCalls = 0, callConfigCalls = 0, ownerHealthChecks = 0
      const llm = { listProviders: () => [{ id: 'fake-provider' }], resolveModelInfo: async () => {
        modelInfoCalls++
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        return { inputModalities: ['text', 'image'] }
      }, resolveCallConfig: async (config) => { callConfigCalls++; return config } }
      const metadataCache = variant.module.createRouteMetadataCache?.({ now: () => 0 })
      const probe = (route) => variant.module.intRouteProbe(() => llm, { now: () => 0, metadataCache,
        isRouteAvailable: () => { ownerHealthChecks++; return true } })(route)
      const owner = async () => {
        const selected = await variant.module.FindUsableRoutes(chain, { probe })
        if (selected.usable.length !== chain.length || selected.usable.some((route, i) => route.model !== chain[i].model)) throw new Error('Probe benchmark changed route order or eligibility')
      }
      const started = performance.now()
      if (mode === 'concurrent-owners') await Promise.all(Array.from({ length: owners }, owner))
      else for (let i = 0; i < owners; i++) await owner()
      const elapsedMs = performance.now() - started
      if (ownerHealthChecks < owners * chain.length) throw new Error('Probe benchmark skipped owner health checks')
      if (iteration >= warmup) measurements.get(variant.name).push({ elapsedMs, modelInfoCalls, callConfigCalls, ownerHealthChecks })
    }
  }
  for (const variant of variants) {
    const samples = measurements.get(variant.name), times = samples.map((sample) => sample.elapsedMs).sort((a, b) => a - b)
    rows.push({ variant: variant.name, mode, owners, routesPerOwner: chain.length,
      medianMs: times[Math.ceil(times.length / 2) - 1], p95Ms: times[Math.ceil(times.length * 0.95) - 1],
      modelInfoCallsPerSample: [...new Set(samples.map((sample) => sample.modelInfoCalls))],
      callConfigCallsPerSample: [...new Set(samples.map((sample) => sample.callConfigCalls))],
      ownerHealthChecksPerSample: [...new Set(samples.map((sample) => sample.ownerHealthChecks))] })
  }
}
const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), baselineRef: option('--baseline-ref') ?? null,
  environment: { node: process.version, cpu: cpus()[0]?.model, platform: platform(), kernel: release() }, sampleCount, warmup, delayMs,
  methodology: 'Four fake routes per owner; a fresh intRouteProbe wrapper per route call reproduces the old child-probe path. Baseline/current order alternates in one process. Simulated metadata delay only; no HTTP or generation. Each owner fake health predicate remains invoked on every use. Results are metadata-call and synthetic control-latency measurements, not real provider/model latency savings.',
  sources: variants.map(({ name, sourceDigests }) => ({ name, sourceDigests })), rows,
  peakRssBytes: process.resourceUsage().maxRSS * (platform() === 'darwin' ? 1 : 1024) }
const encoded = JSON.stringify(report, null, 2) + '\n'
if (option('--output')) await writeFile(resolve(option('--output')), encoded)
process.stdout.write(encoded)
