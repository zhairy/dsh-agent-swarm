#!/usr/bin/env node
// 本地控制面基准与可导入的完整模型用量；不会把未调用模型的样本宣传成 token 节省。
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { cpus, platform, release, arch } from 'node:os'
import { ValidateTaskCard, getRuleGates } from '../lib/policy.js'
import { getDefaultWorkflow, ValidateWorkflow, getWorkflowDigest, getWorkflowMermaid } from '../lib/workflow.js'
import { calculate } from '../lib/math/operators.js'

const args = process.argv.slice(2)
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
const out = option('--out')
const samples = Number(option('--samples') ?? 100)
if (!Number.isSafeInteger(samples) || samples < 20 || samples > 10000) throw new Error('--samples must be 20..10000')
const inputs = [
  ['readonly', {}], ['small-edit', { changesCode: true }], ['ambiguous', { ambiguousRequirements: true }],
  ['architecture', { changesCode: true, crossModuleArchitecture: true }], ['algorithm', { changesCode: true, changesAlgorithm: true }],
  ['numeric', { changesCode: true, numericPrecision: true }], ['state-machine', { changesCode: true, stateMachine: true }],
  ['concurrency', { changesCode: true, sharedStateConcurrency: true }], ['security', { changesCode: true, securitySensitive: true }],
  ['financial', { changesCode: true, touchesFinancialLogic: true }], ['backtest', { changesCode: true, timeSeriesOrBacktest: true }],
  ['visual', { hasVisualInput: true }], ['copy', { uiCopy: true }], ['external', { needsExternalFacts: true }],
  ['execution', { hasExecSteps: true }], ['edit-execute', { changesCode: true, hasExecSteps: true }],
  ['algorithm-architecture', { changesCode: true, changesAlgorithm: true, crossModuleArchitecture: true }],
  ['visual-copy', { hasVisualInput: true, uiCopy: true }], ['perf-target', { changesCode: true }, { p95Ms: 10, dataScale: 'n=32' }],
  ['perf-pending', { changesCode: true }, { p95Ms: '待测' }]
]
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)]
const cases = inputs.map(([id, flags, perf]) => {
  const card = ValidateTaskCard({ title: id, goal: '完成该用例对应的可验收工作', acceptance: ['符合合同与证据门禁'], scope: ['src/example.ts'], flags, ...(perf ? { perf } : {}) }).card
  if (!card) throw new Error('Invalid benchmark task')
  const gates = getRuleGates(card)
  const run = () => {
    const workflow = getDefaultWorkflow(card, gates)
    const check = ValidateWorkflow(workflow, card, gates)
    if (check.errors.length) throw new Error(check.errors.join(';'))
    getWorkflowDigest(workflow); getWorkflowMermaid(workflow)
    return workflow
  }
  for (let i = 0; i < 10; i++) run()
  const times = []
  let workflow
  for (let i = 0; i < samples; i++) { const at = performance.now(); workflow = run(); times.push(performance.now() - at) }
  return { id, samples, mode: workflow.mode, nodes: workflow.nodes.length,
    edges: workflow.nodes.reduce((n, node) => n + node.dependsOn.length, 0),
    p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), p99Ms: percentile(times, 0.99),
    throughputPerSecond: 1000 * samples / times.reduce((sum, n) => sum + n, 0) }
})
const math = [
  { op: 'gcd', mode: 'bigint', args: { a: '144', b: '89' } },
  { op: 'sum', mode: 'float64', args: { values: [1e16, 1, -1e16] } },
  { op: 'variance', mode: 'float64', args: { values: [1e12, 1e12 + 1, 1e12 + 2], ddof: 0 } },
  { op: 'dot', mode: 'float64', args: { a: [1, 2], b: [3, 4] } },
  { op: 'norm2', mode: 'float64', args: { values: [3, 4] } },
  { op: 'compare_close', mode: 'float64', args: { a: 1e308, b: -1e308 }, tolerance: { abs: 0, rel: 0.1 } }
].map((input) => {
  const times = []
  let result
  for (let i = 0; i < samples; i++) { const at = performance.now(); result = calculate(input); times.push(performance.now() - at) }
  if (!result.ok) throw new Error('Math fixture failed: ' + result.message)
  return { op: input.op, samples, p95Ms: percentile(times, 0.95), value: result.value, evidenceKind: result.evidenceKind }
})
const readUsage = (file) => {
  if (!file) return null
  const records = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(records) || records.length > 100000) throw new Error('Usage must be a bounded record array')
  const providers = Object.create(null)
  let unknown = 0
  for (const row of records) {
    if (typeof row.taskId !== 'string' || typeof row.provider !== 'string') throw new Error('Usage needs taskId/provider')
    if (!Number.isSafeInteger(row.inputTokens) || row.inputTokens < 0 || !Number.isSafeInteger(row.outputTokens) || row.outputTokens < 0) { unknown++; continue }
    const data = providers[row.provider] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0, unknownCost: 0, calls: 0 }
    data.inputTokens += row.inputTokens; data.outputTokens += row.outputTokens; data.calls++
    if (typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) && row.costUsd >= 0) data.costUsd += row.costUsd
    else data.unknownCost++
  }
  return { records: records.length, providers, unknownUsage: unknown }
}
const usage = readUsage(option('--usage')), baselineUsage = readUsage(option('--baseline-usage'))
const savings = Object.create(null)
if (usage && baselineUsage && !usage.unknownUsage && !baselineUsage.unknownUsage) {
  for (const [provider, data] of Object.entries(usage.providers)) {
    const old = baselineUsage.providers[provider]
    const tokens = data.inputTokens + data.outputTokens
    const baselineTokens = old ? old.inputTokens + old.outputTokens : 0
    savings[provider] = baselineTokens > 0 ? 1 - tokens / baselineTokens : null
  }
}
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  environment: { node: process.version, os: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model ?? 'unknown', concurrency: 1 },
  scope: 'Local workflow generation/validation and bounded calculations; model end-to-end quality and token savings require actual paired usage.',
  peakRssBytes: process.resourceUsage().maxRSS * (platform() === 'darwin' ? 1 : 1024),
  cases, math, usage, baselineUsage, tokenSavingsByProvider: savings,
  tokenSavingsClaim: usage && baselineUsage ? 'Inspectable provider totals; requires identical task/model conditions and quality validation.' : 'unknown; 28% has not been measured'
}
if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ cases: cases.length, mathCases: math.length, maxWorkflowP95Ms: Math.max(...cases.map((c) => c.p95Ms)), peakRssBytes: report.peakRssBytes, tokenSavingsClaim: report.tokenSavingsClaim, out: out ?? null }, null, 2))
