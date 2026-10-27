import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const hasBuild = existsSync(join(process.cwd(), 'lib', 'index.js'))

describe('release packing guard', () => {
  it.skipIf(!hasBuild)('verifies the entry dependency closure is inside the tarball', async () => {
    const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'pack-release.mjs'), '--check-only', '--skip-build'], { cwd: process.cwd() })
    const report = JSON.parse(stdout) as { entry: string; entries: string[]; closureFiles: number; packagedFiles: number; missing: number }
    // 入口闭包的每个文件都必须在 npm pack 的清单里：上一轮发布正是缺了新增模块。
    expect(report.entry).toBe('lib/index.js')
    expect(report.entries).toEqual(expect.arrayContaining(['lib/tools.js', 'lib/runtime.js', 'lib/client.js', 'lib/expert-tools.js']))
    expect(report.missing).toBe(0)
    expect(report.closureFiles).toBeGreaterThan(10)
    expect(report.packagedFiles).toBeGreaterThan(report.closureFiles)
  }, 60_000)

  it('rejects an absent expert export even when the main entry imports successfully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-export-closure-'))
    try {
      await mkdir(join(root, 'lib'))
      await writeFile(join(root, 'lib/index.js'), 'export const valid = true\n')
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'swarm-export-closure-fixture', version: '1.0.0',
        exports: { '.': './lib/index.js', './expert-tools': './lib/expert-tools.js' }, files: ['lib'] }))
      await expect(execFileAsync(process.execPath, [join(process.cwd(), 'scripts/pack-release.mjs'), '--check-only', '--skip-build'], { cwd: root })).rejects.toThrow(/缺少文件.*expert-tools/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!hasBuild)('binds tarball, git commit, evidence digest and manifest into SHA256SUMS', async () => {
    const out = await mkdtemp(join(tmpdir(), 'swarm-release-manifest-'))
    const evidence = join(out, 'evidence.json')
    await writeFile(evidence, '{"result":"candidate-green"}\n')
    try {
      const commit = 'a'.repeat(40)
      const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'pack-release.mjs'),
        '--skip-build', '--out', out, '--evidence', evidence, '--git-commit', commit, '--previous-version', '3.1.3'], { cwd: process.cwd() })
      const report = JSON.parse(stdout) as { sha256: string; gitCommit: string; manifest: string }
      expect(report).toMatchObject({ gitCommit: commit, manifest: 'release-manifest.json' })
      const files = await readdir(out)
      expect(files).toEqual(expect.arrayContaining(['release-manifest.json', 'SHA256SUMS']))
      const manifest = JSON.parse(await readFile(join(out, 'release-manifest.json'), 'utf8'))
      expect(manifest).toMatchObject({ package: 'dsh-agent-swarm', version: '3.1.4', gitCommit: commit, previousVersion: '3.1.3',
        tarballSha256: report.sha256, evidence: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) })
      expect(await readFile(join(out, 'SHA256SUMS'), 'utf8')).toContain('release-manifest.json')
    } finally { await rm(out, { recursive: true, force: true }) }
  }, 60_000)
})
