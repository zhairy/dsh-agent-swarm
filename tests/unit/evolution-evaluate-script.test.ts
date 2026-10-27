import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFile = promisify(execFileCallback)
const hash = (value: string): string => value.repeat(64).slice(0, 64)
const trace = {
  schemaVersion: 1, split: 'acceptance', baselineDigest: hash('a'), candidateDigest: hash('b'),
  engineVersion: 'test/1', policyVersion: 'swarm-evolution/3.1.4-v1', seed: 1,
  groups: Array.from({ length: 3 }, (_, group) => ({
    id: `G-${group}`, lineageId: hash(String(group + 1)), evidenceSequenceDigest: hash('c'),
    steps: [
      { id: `G${group}-1`, projectionDigest: hash(String.fromCharCode(100 + group)), artifactDigest: hash('e'), baselineDecision: 'continue', expected: 'continue', severity: 'normal',
        novelEvidence: false, operationalTokens: { actual: 1, estimated: 0, unknown: 0 }, evaluationTokens: { actual: 0, estimated: 0, unknown: 0 } },
      { id: `G${group}-2`, projectionDigest: hash(String.fromCharCode(100 + group)), artifactDigest: hash('e'), baselineDecision: 'continue', expected: 'stop', severity: 'severe',
        novelEvidence: false, operationalTokens: { actual: 1, estimated: 0, unknown: 0 }, evaluationTokens: { actual: 0, estimated: 0, unknown: 0 } }
    ]
  }))
}
const policy = { schemaVersion: 1, id: 'repeat-1', repeatThreshold: 1, respectOpenWait: true, resetOnNewEvidence: true }

describe('offline evolution evaluator CLI', () => {
  it.skipIf(!existsSync(join(process.cwd(), 'lib/evolution-governance.js')))('writes deterministic evidence without side effects', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-evolution-eval-'))
    try {
      const tracePath = join(directory, 'trace.json'), policyPath = join(directory, 'policy.json'), out = join(directory, 'result.json')
      await writeFile(tracePath, JSON.stringify(trace))
      await writeFile(policyPath, JSON.stringify(policy))
      const { stdout } = await execFile(process.execPath, [join(process.cwd(), 'scripts/evolution-evaluate.mjs'), '--trace', tracePath, '--policy', policyPath, '--out', out])
      expect(JSON.parse(stdout)).toMatchObject({ outcome: 'passed', digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
      const result = JSON.parse(await readFile(out, 'utf8'))
      expect(result).toMatchObject({ deterministic: true, sideEffects: 0, networkCalls: 0, outcome: 'passed' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
