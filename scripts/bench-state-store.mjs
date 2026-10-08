import { performance } from 'node:perf_hooks'
import { cpus, platform, release } from 'node:os'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Development benchmark: build current sources first. A baseline is an explicitly supplied trusted compiled directory.
const args = process.argv.slice(2)
const option = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
const sampleCount = Number(option('--samples') ?? 30)
const warmup = Number(option('--warmup') ?? 5)
if (!Number.isSafeInteger(sampleCount) || sampleCount < 5 || sampleCount > 1000 || !Number.isSafeInteger(warmup) || warmup < 0 || warmup > 50) throw new Error('Invalid sample/warmup limits')
const directories = { ...(option('--baseline-dir') ? { before: resolve(option('--baseline-dir')) } : {}), after: resolve(option('--current-dir') ?? 'lib') }
const variants = []
for (const [name, directory] of Object.entries(directories)) {
  const statePath = join(directory, 'state-store.js')
  variants.push({ name, directory, ...(await import(pathToFileURL(statePath).href)), ...(await import(pathToFileURL(join(directory, 'agent-binding.js')).href)),
    validateFeatureState: (await import(pathToFileURL(join(directory, 'feature-session.js')).href)).validateFeatureState,
    moduleDigests: Object.fromEntries(await Promise.all(['state-store.js', 'agent-binding.js', 'feature-session.js'].map(async (file) => [file, createHash('sha256').update(await readFile(join(directory, file))).digest('hex')]))) })
}
const median = (values) => { const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2 }
const summarize = (values) => ({ medianMs: Number(median(values).toFixed(5)), p95Ms: Number([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1].toFixed(5)), minMs: Number(Math.min(...values).toFixed(5)), maxMs: Number(Math.max(...values).toFixed(5)) })
const rows = []
const binding = { agentId: 'audit-agent', rootSessionId: 'audit-root', workspaceId: 'audit-workspace', taskId: 'audit-task', nodeId: 'audit-node', attemptId: 'audit-attempt', threadId: 'audit-thread', role: 'mou_ding', cardRevision: 1, workflowRevision: 1, requestRevision: 1, generation: 1, leaseEpoch: 1, state: 'active', permissions: ['context-read'] }
for (const payloadBytes of [65536, 262144, 1048576, 2097152]) {
  const states = []
  for (const variant of variants) {
    const store = await variant.createDurableStateStore({ directory: '/unused-state-benchmark', enabled: false,
      initialState: { counter: 0, payload: 'x'.repeat(payloadBytes), bindings: { 'audit-agent': binding }, bindingHistory: {} } })
    states.push({ variant, store, registry: variant.createAgentBindingRegistry(store), samples: { read: [], commit: [], bindingLookup: [] } })
  }
  for (let iteration = 0; iteration < warmup + sampleCount; iteration++) {
    if (iteration === warmup) global.gc?.()
    const ordered = iteration % 2 ? [...states].reverse() : states
    for (const entry of ordered) {
      let started = performance.now(); entry.store.read(); const read = performance.now() - started
      started = performance.now(); await entry.store.commit('benchmark/update', (draft) => { draft.counter++ }); const commit = performance.now() - started
      started = performance.now(); entry.registry.get('audit-agent'); const bindingLookup = performance.now() - started
      if (iteration >= warmup) { entry.samples.read.push(read); entry.samples.commit.push(commit); entry.samples.bindingLookup.push(bindingLookup) }
    }
  }
  for (const entry of states) {
    rows.push({ variant: entry.variant.name, payloadBytes, stateBytes: Buffer.byteLength(JSON.stringify(entry.store.read())),
      read: summarize(entry.samples.read), commit: summarize(entry.samples.commit), bindingLookup: summarize(entry.samples.bindingLookup) })
    await entry.store.dispose()
  }
}

const validationRows = []
for (const [taskCount, delegationCount] of [[1, 1000], [1, 4000], [100, 4000]]) {
  const tasks = Array.from({ length: taskCount }, (_, i) => ({ taskId: 'T-' + i, sessionId: 'audit-root',
    card: { title: 'audit', goal: 'audit', acceptance: ['inspect'], scope: [], flags: {} }, gates: [], triage: { source: 'rules', rulesApplied: [] },
    delegationIds: [], rounds: 0, createdAt: 0, updatedAt: 0 }))
  const delegations = Array.from({ length: delegationCount }, (_, i) => {
    const task = tasks[i % taskCount]; const id = 'D-' + i; task.delegationIds.push(id)
    return { delegationId: id, taskId: task.taskId, role: 'mou_ding', status: 'failed', summary: '', unresolved: [], evidence: [], startedAt: 0 }
  })
  const state = { schemaVersion: 1, tasks, delegations, threads: [], budgets: {}, contexts: [], bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {} }
  const samples = new Map(variants.map((variant) => [variant.name, []]))
  for (let iteration = 0; iteration < warmup + sampleCount; iteration++) {
    for (const variant of iteration % 2 ? [...variants].reverse() : variants) {
      const started = performance.now()
      if (!variant.validateFeatureState(state, { rootSessionId: 'audit-root', workspaceId: 'audit-workspace' })) throw new Error('Benchmark fixture was rejected')
      if (iteration >= warmup) samples.get(variant.name).push(performance.now() - started)
    }
  }
  for (const variant of variants) validationRows.push({ variant: variant.name, taskCount, delegationCount, stateBytes: Buffer.byteLength(JSON.stringify(state)), validation: summarize(samples.get(variant.name)) })
}
const output = {
  schemaVersion: 1, recordedAt: new Date().toISOString(), baselineRef: option('--baseline-ref') ?? null, node: process.versions.node, cpu: cpus()[0]?.model, platform: platform(), kernel: release(), sampleCount, warmup, gcExposed: typeof global.gc === 'function',
  methodology: 'Synthetic ASCII state, memory-only store, no business validator in store timings; alternating baseline/current order in the same process. Feature validation measured separately. This is not a NAS, end-to-end, LLM cost, or token-savings benchmark.',
  sources: variants.map(({ name, directory, moduleDigests }) => ({ name, directory, moduleDigests })), rows, validationRows
}
const encoded = JSON.stringify(output, null, 2) + '\n'
if (option('--output')) await writeFile(resolve(option('--output')), encoded)
process.stdout.write(encoded)
