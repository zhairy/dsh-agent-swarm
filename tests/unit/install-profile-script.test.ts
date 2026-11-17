import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

describe('profile local-link installer', () => {
  it('unpacks a versioned tarball, rewrites file: to link:, and preserves a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-profile-link-'))
    try {
      const fixture = join(root, 'fixture')
      const profile = join(root, 'profiles', 'web')
      const dshHome = join(root, 'dsh-home')
      await mkdir(join(fixture, 'package'), { recursive: true })
      await mkdir(profile, { recursive: true })
      await writeFile(join(fixture, 'package', 'package.json'), JSON.stringify({ name: 'dsh-agent-swarm', version: '9.8.7', files: ['index.js'] }))
      await writeFile(join(fixture, 'package', 'index.js'), 'export const ok = true\n')
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: { 'dsh-agent-swarm': 'file:/stale.tgz', other: '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2) + '\n')
      await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
      const tarball = join(root, 'dsh-agent-swarm.tgz')
      await execFileAsync('tar', ['-czf', tarball, '-C', fixture, 'package'])
      const { stdout } = await execFileAsync(process.execPath, [
        join(process.cwd(), 'scripts', 'install-profile.mjs'),
        '--tarball', tarball,
        '--profile', profile,
        '--dsh-home', dshHome,
        '--no-install'
      ])
      const report = JSON.parse(stdout) as { dependency: string; version: string }
      expect(report.version).toBe('9.8.7')
      expect(report.dependency).toMatch(/^link:.*dsh-agent-swarm-v9\.8\.7-[a-f0-9]{12}$/)
      const installed = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
      expect(installed.dependencies).toMatchObject({ 'dsh-agent-swarm': report.dependency, other: '1.0.0' })
      expect(installed.dependencies['dsh-agent-swarm']).not.toMatch(/^file:/)
      expect(installed.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-agent-swarm'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects archive paths outside the package root before extraction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-profile-link-'))
    try {
      const fixture = join(root, 'fixture')
      const profile = join(root, 'profiles', 'web')
      await mkdir(join(fixture, 'package'), { recursive: true })
      await mkdir(profile, { recursive: true })
      await writeFile(join(fixture, 'package', 'package.json'), JSON.stringify({ name: 'dsh-agent-swarm', version: '9.8.7' }))
      await writeFile(join(fixture, 'escape.txt'), 'escape')
      await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'profile', dependencies: {} }))
      await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
      const tarball = join(root, 'unsafe.tgz')
      await execFileAsync('tar', ['-czf', tarball, '-C', fixture, 'package', 'escape.txt'])
      await expect(execFileAsync(process.execPath, [
        join(process.cwd(), 'scripts', 'install-profile.mjs'),
        '--tarball', tarball,
        '--profile', profile,
        '--dsh-home', join(root, 'dsh-home'),
        '--no-install'
      ])).rejects.toMatchObject({ stderr: expect.stringContaining('tarball 包含非法路径') })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
