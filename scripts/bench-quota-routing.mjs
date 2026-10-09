#!/usr/bin/env node
// CPU-only quota metadata benchmark. No CLI, server, credentials or model call.
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const root = resolve(process.env.SWARM_PLUGIN_ROOT ?? new URL('../', import.meta.url).pathname)
const routing = await import(pathToFileURL(join(root, 'lib/quota-routing.js')).href)
const quota = await import(pathToFileURL(join(root, 'lib/quota.js')).href)
const samples = 30, warmups = 5
const makeInput = (accountCount, modelCount, routeCount, memberCount) => {
  const keys = Array.from({ length: accountCount }, (_, i) => `account-${i}`)
  const members = Object.fromEntries(Array.from({ length: routeCount }, (_, i) => [`tier-${i}`, keys.slice(0, memberCount).map(account => ({ provider: 'codex', account, model: `model-${i}` }))]))
  const accounts = keys.map((key, i) => ({ id: quota.getQuotaAccountId('codex', key), label: `Account ${i}`, isDefault: i === 0, status: 'reported', completeness: 'complete', readAt: 1000, sampledAt: null, freshness: 'upstream-not-disclosed', ...quota.normalizeSubscriptionUsage('codex', key, { supported: true, windows: [{ kind: 'weekly', usedPercent: 100, resetsAt: 100_000 }] }, 1000) }))
  const input = { quota: { source: 'dsh-plugin-subscriptions', readAt: 1000, sampledAt: null, freshness: 'upstream-not-disclosed', providers: [{ provider: 'codex', status: 'reported', readAt: 1000, accounts, warnings: [] }], routes: [], warnings: [], delivery: 'read', cacheAgeMs: 0, refreshRequested: false, refreshJoinedExisting: false },
    poolConfiguration: { source: 'dsh-config-editor', namespace: 'subscriptions-fixture', pool: { tiers: members } },
    providerSettings: { codex: { provider: 'codex', settings: {}, accounts: keys.map(key => ({ key, models: Array.from({ length: modelCount }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` })) })) } }, registeredProviders: ['codex'], now: 1000 }
  return { input, routes: Array.from({ length: routeCount }, (_, i) => ({ provider: 'codex', model: `tier-${i}` })) }
}
const measure = (run) => {
  for (let i = 0; i < warmups; i++) run()
  const times = []
  for (let i = 0; i < samples; i++) { const start = performance.now(); run(); times.push(performance.now() - start) }
  times.sort((a, b) => a - b)
  return { medianMs: times[Math.floor(samples / 2)], p95Ms: times[Math.ceil(samples * .95) - 1] }
}
const cases = [
  { name: 'small', accounts: 2, models: 64, routes: 13, members: 2 },
  { name: 'bounded-catalog-tier', accounts: 32, models: 256, routes: 32, members: 16 },
  { name: 'catalog-tier-stress', accounts: 32, models: 512, routes: 32, members: 16 }
]
const results = cases.map(entry => {
  const { input, routes } = makeInput(entry.accounts, entry.models, entry.routes, entry.members)
  const baseline = () => routes.map(route => routing.getQuotaRouteDecision(route, input))
  const original = baseline()
  let optimized
  if (routing.createQuotaRouteEvaluator !== undefined) {
    const run = () => { const evaluate = routing.createQuotaRouteEvaluator(input); return routes.map(evaluate) }
    const candidate = run()
    if (JSON.stringify(candidate) !== JSON.stringify(original)) throw new Error('Scoped evaluator changed a decision')
    optimized = measure(run)
  }
  const sourceBytes = Buffer.byteLength(JSON.stringify({ type: 'server-response', rpcId: 'benchmark', result: { ok: true, value: input.providerSettings.codex } }))
  return { ...entry, sourceBytes, fitsCurrentRpcByteLimit: sourceBytes <= 512 * 1024, unscoped: measure(baseline), ...(optimized === undefined ? {} : { scoped: optimized, outputsEqual: true }) }
})
const result = { node: process.version, samples, warmups, kind: 'synthetic-cpu-only', results }
const outputIndex = process.argv.indexOf('--output')
if (outputIndex >= 0) writeFileSync(process.argv[outputIndex + 1], JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
