#!/usr/bin/env node
// 离线评测：只读冻结轨迹与声明式策略，不访问宿主、网络、工作区或生产状态。
import { readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const tracePath = option('--trace')
const policyPath = option('--policy')
const outputPath = option('--out')
const fail = (message) => { throw new Error(`evolution-evaluate: ${message}`) }
if (tracePath === undefined || policyPath === undefined) fail('需要 --trace <json> 和 --policy <json>')

const parse = (path, label) => {
  try { return JSON.parse(readFileSync(resolve(path), 'utf8')) } catch (error) { fail(`${label} 读取或 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`) }
}
const trace = parse(tracePath, 'trace')
const policy = parse(policyPath, 'policy')
const module = await import(pathToFileURL(resolve('lib/evolution-governance.js')).href)
const result = module.runEvolutionEvaluation(trace, policy)
const output = JSON.stringify(result, null, 2) + '\n'
if (outputPath === undefined) process.stdout.write(output)
else {
  const target = resolve(outputPath)
  const temporary = `${target}.tmp-${process.pid}`
  writeFileSync(temporary, output, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, target)
  process.stdout.write(JSON.stringify({ out: target, outcome: result.outcome, digest: result.digest,
    operationalTokens: result.operationalTokens, evaluationTokens: result.evaluationTokens }, null, 2) + '\n')
}
