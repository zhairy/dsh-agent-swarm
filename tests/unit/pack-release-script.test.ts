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
    const report = JSON.parse(stdout) as { entry: string; entries: string[]; closureFiles: number; packagedFiles: number; missing: number; missingRuntime: number; forbidden: number }
    // 入口闭包的每个文件都必须在 npm pack 的清单里：上一轮发布正是缺了新增模块。
    expect(report.entry).toBe('lib/index.js')
    expect(report.entries).toEqual(expect.arrayContaining(['lib/tools.js', 'lib/runtime.js', 'lib/client.js', 'lib/expert-tools.js']))
    expect(report.missing).toBe(0)
    expect(report.missingRuntime).toBe(0)
    expect(report.forbidden).toBe(0)
    expect(report.closureFiles).toBeGreaterThan(10)
    expect(report.packagedFiles).toBeGreaterThan(report.closureFiles)
    const packageInfo = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      files: string[]; dependencies: Record<string, string>
    }
    expect(packageInfo.files).not.toContain('docs')
    expect(packageInfo.files).toEqual(expect.arrayContaining([
      'docs/任务流程与验证.md',
      'docs/安装.md',
      'docs/角色.md',
      'docs/使用.md',
      'docs/升级与回退.md',
      'docs/路线图.md'
    ]))
    expect(packageInfo.files).not.toEqual(expect.arrayContaining([
      'docs/3.1.2-任务进度与后续路线.md',
      'docs/3.1.3-运行守卫与路由恢复.md'
    ]))
    expect(packageInfo.files).toContain('!lib/preset-builder.*')
    expect(packageInfo.dependencies).toHaveProperty('@deepseek-ai/cosmokit')
    expect(packageInfo.dependencies).toMatchObject({ mermaid: '12.2.0' })
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

  it('rejects tests, implementation plans and internal evidence from the tarball', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-forbidden-pack-'))
    try {
      await mkdir(join(root, 'lib'))
      await mkdir(join(root, 'docs', 'plans'), { recursive: true })
      await writeFile(join(root, 'lib/index.js'), 'export const valid = true\n')
      await writeFile(join(root, 'docs/plans/internal.md'), '# internal\n')
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'swarm-forbidden-pack-fixture', version: '1.0.0',
        exports: { '.': './lib/index.js' }, files: ['lib', 'docs'] }))
      await expect(execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'pack-release.mjs'), '--check-only', '--skip-build'], { cwd: root }))
        .rejects.toThrow(/开发或实施文件.*docs\/plans\/internal\.md/s)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.skipIf(!hasBuild)('binds tarball, git commit, evidence digest and manifest into SHA256SUMS', async () => {
    const out = await mkdtemp(join(tmpdir(), 'swarm-release-manifest-'))
    const evidence = join(out, 'evidence.json')
    await writeFile(evidence, '{"result":"candidate-green"}\n')
    try {
      const commit = 'a'.repeat(40)
      const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'pack-release.mjs'),
        '--skip-build', '--out', out, '--evidence', evidence, '--git-commit', commit, '--previous-version', '3.1.5', '--allow-dirty'], { cwd: process.cwd() })
      const report = JSON.parse(stdout) as { sha256: string; gitCommit: string; manifest: string }
      expect(report).toMatchObject({ gitCommit: commit, manifest: 'release-manifest.json' })
      const files = await readdir(out)
      expect(files).toEqual(expect.arrayContaining(['dsh-agent-swarm-3.1.6.tgz', 'dsh-agent-swarm.tgz', 'release-manifest.json', 'SHA256SUMS']))
      const manifest = JSON.parse(await readFile(join(out, 'release-manifest.json'), 'utf8'))
      const packageInfo = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
      expect(manifest).toMatchObject({ package: 'dsh-agent-swarm', version: packageInfo.version, gitCommit: commit, previousVersion: '3.1.5',
        tarballSha256: report.sha256, policyVersion: `swarm-release/${packageInfo.version}-v1`,
        evidence: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) })
      const sums = await readFile(join(out, 'SHA256SUMS'), 'utf8')
      expect(sums).toContain('release-manifest.json')
      expect(sums.match(new RegExp(report.sha256, 'g'))).toHaveLength(2)
    } finally { await rm(out, { recursive: true, force: true }) }
  }, 60_000)
})
