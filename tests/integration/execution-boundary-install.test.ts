import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureDsh, getSandboxDshModules, getTestedVersion, REPO_ROOT } from '../../scripts/sandbox.mjs'

const version = getTestedVersion()
const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

describe('exact-package execution boundary installer', () => {
  it('patches the selected Host, remains idempotent, restores and rejects unknown bytes atomically', () => {
    ensureDsh()
    const root = mkdtempSync(join(tmpdir(), 'swarm-boundary-install-'))
    const modules = join(root, 'node_modules')
    const source = getSandboxDshModules()
    const files = ['dsh-subprocess-local', 'dsh-working-directory', 'dsh-fs-local'].map(name => `@deepseek-ai/${name}/lib/index.js`)
    try {
      const manifest = join(modules, '@deepseek-ai/dsh/package.json')
      mkdirSync(dirname(manifest), { recursive: true })
      copyFileSync(join(source, '@deepseek-ai/dsh/package.json'), manifest)
      for (const name of files) {
        mkdirSync(dirname(join(modules, name)), { recursive: true })
        const backup = join(source, `${name}.swarm-execution-boundary.orig`)
        copyFileSync(existsSync(backup) ? backup : join(source, name), join(modules, name))
      }
      const originals = files.map(name => sha(join(modules, name)))
      const script = join(REPO_ROOT, 'scripts/apply-dsh-execution-boundary.mjs')
      const run = (...extra: string[]) => JSON.parse(execFileSync(process.execPath, [script, '--dsh', modules, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      const first = run()
      expect(first.hostVersion).toBe(version)
      const patched = files.map(name => sha(join(modules, name)))
      expect(patched.every((hash, index) => hash !== originals[index])).toBe(true)
      expect(run().state.map((entry: { sha256: string }) => entry.sha256)).toEqual(patched)
      expect(run('--check').checked).toBe(true)
      run('--restore')
      expect(files.map(name => sha(join(modules, name)))).toEqual(originals)
      const last = join(modules, files.at(-1)!)
      writeFileSync(last, readFileSync(last, 'utf8') + '\nunknown fixture bytes\n')
      const beforeFailure = files.map(name => sha(join(modules, name)))
      const rejected = spawnSync(process.execPath, [script, '--dsh', modules], { encoding: 'utf8' })
      expect(rejected.status).not.toBe(0)
      expect(rejected.stderr).toContain('Unknown Host checksum')
      expect(files.map(name => sha(join(modules, name)))).toEqual(beforeFailure)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
