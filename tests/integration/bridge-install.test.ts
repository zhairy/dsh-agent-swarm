import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureDsh, getSandboxDshModules, getTestedVersion, REPO_ROOT } from '../../scripts/sandbox.mjs'

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
const originalHash = 'a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1'
const patchedHash = 'c7390f4da755e9c57ad9176df605d2991822bdeb7f13e87260b4f5d0e51ea5ae'

describe.skipIf(getTestedVersion() !== '0.2.2-rc.1')('version-bound DSH model bridge installer', () => {
  it('applies once, verifies, restores and refuses unknown files without changing them', () => {
    ensureDsh()
    const root = mkdtempSync(join(tmpdir(), 'swarm-bridge-install-'))
    try {
      const source = getSandboxDshModules()
      for (const name of ['dsh', 'dsh-agent-loop']) {
        const target = join(root, 'node_modules/@deepseek-ai', name)
        mkdirSync(join(target, 'lib'), { recursive: true })
        copyFileSync(join(source, '@deepseek-ai', name, 'package.json'), join(target, 'package.json'))
      }
      const pristine = join(source, '@deepseek-ai/dsh-agent-loop/lib/index.js.swarm-pristine-a6fa8e0c7c90')
      const original = existsSync(pristine) ? pristine : join(source, '@deepseek-ai/dsh-agent-loop/lib/index.js')
      const target = join(root, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
      copyFileSync(original, target)
      const script = join(REPO_ROOT, 'scripts/apply-dsh-step-bridge.mjs')
      const run = (...extra: string[]) => JSON.parse(execFileSync(process.execPath, [script, '--dsh-root', root, ...extra], { encoding: 'utf8' }))
      expect(sha(target)).toBe(originalHash)
      expect(run().changed).toBe(true)
      expect(sha(target)).toBe(patchedHash)
      expect(run().changed).toBe(false)
      expect(run('--check').state).toBe('patched')
      expect(run('--restore').state).toBe('original')
      expect(sha(target)).toBe(originalHash)
      writeFileSync(target, readFileSync(target, 'utf8') + '\n')
      const unknownHash = sha(target)
      expect(spawnSync(process.execPath, [script, '--dsh-root', root], { encoding: 'utf8' }).status).not.toBe(0)
      expect(sha(target)).toBe(unknownHash)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
