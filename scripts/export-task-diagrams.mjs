#!/usr/bin/env node
// Explicit offline export; Archify remains an optional, user-supplied CLI.
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const options = {}
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]
  if (!['--input', '--output', '--archify'].includes(key) || process.argv[i + 1] === undefined || options[key] !== undefined) throw new Error('Usage: node export-task-diagrams.mjs --input snapshot.json --output new-directory [--archify /path/to/archify.mjs]')
  options[key] = process.argv[i + 1]
}
if (!options['--input'] || !options['--output']) throw new Error('--input and --output are required')
const root = resolve(process.env.SWARM_PLUGIN_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const { getArchifyTaskDiagrams, ValidateTaskDiagrams, TASK_DIAGRAM_LIMITS } = await import(pathToFileURL(join(root, 'lib/task-diagrams.js')).href)
const input = resolve(options['--input'])
if ((await stat(input)).size > TASK_DIAGRAM_LIMITS.exportBytes) throw new Error('Diagram snapshot exceeds export input limit')
const parsed = JSON.parse(await readFile(input, 'utf8'))
const snapshot = parsed?.result?.value?.diagrams ?? parsed?.diagrams ?? parsed
const errors = ValidateTaskDiagrams(snapshot)
if (errors.length > 0) throw new Error(errors.join('; '))
const converted = getArchifyTaskDiagrams(snapshot)
const output = resolve(options['--output'])
// Require a new directory, so a mistaken invocation cannot replace existing artifacts.
await mkdir(output, { recursive: false, mode: 0o700 })
await writeFile(join(output, 'snapshot.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 })
const results = []
for (const diagram of converted.diagrams) {
  const view = snapshot.views.find((candidate) => candidate.kind === diagram.kind)
  await writeFile(join(output, `${diagram.kind}.mmd`), view.mermaid, { flag: 'wx', mode: 0o600 })
  if (diagram.ir === null) { results.push({ kind: diagram.kind, status: 'unavailable', reason: diagram.reason }); continue }
  const irPath = join(output, `${diagram.kind}.archify.json`)
  await writeFile(irPath, JSON.stringify(diagram.ir, null, 2), { flag: 'wx', mode: 0o600 })
  if (!options['--archify']) { results.push({ kind: diagram.kind, status: 'exported-not-validated' }); continue }
  const cli = resolve(options['--archify'])
  const run = (command) => {
    const result = spawnSync(process.execPath, [cli, command, diagram.kind, irPath, ...(command === 'deliver' ? [join(output, `${diagram.kind}.html`)] : []), '--json'], { cwd: output, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
    let receipt
    try { receipt = JSON.parse(result.stdout) } catch { receipt = { error: result.stderr?.slice(0, 2000) || result.error?.message || 'Archify returned no JSON receipt' } }
    return { exitCode: result.status, receipt }
  }
  const validation = run('validate')
  const valid = validation.exitCode === 0 && validation.receipt.ok === true
  const delivery = valid ? run('deliver') : null
  const result = { kind: diagram.kind, status: valid && delivery?.exitCode === 0 && delivery.receipt.ok === true ? 'delivered' : 'failed', validation, delivery }
  await writeFile(join(output, `${diagram.kind}.receipt.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  results.push(result)
}
const manifest = { format: 'dsh-agent-swarm/diagram-export', schemaVersion: 1, contract: converted.contract, snapshotDigest: converted.snapshotDigest,
  note: 'IR schema/basic delivery does not certify visual quality, workflow authorization, or business acceptance. Sequence positions encode recorded order, not elapsed-time proportions.', results }
await writeFile(join(output, 'export-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ output, snapshotDigest: snapshot.snapshotDigest, results: results.map(({ kind, status }) => ({ kind, status })) }))
if (results.some((result) => result.status === 'failed')) process.exitCode = 1
