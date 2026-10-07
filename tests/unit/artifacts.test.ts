import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ValidateArtifactSnapshot, getArtifactSnapshot } from '../../src/artifacts.js'

describe('真实产物摘要', () => {
  it('未跟踪文件、目录与缺失文件进入摘要，内容改动使证据失效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-artifacts-'))
    try {
      await mkdir(join(dir, 'src'))
      await writeFile(join(dir, 'src/a.ts'), '原始代码')
      const before = await getArtifactSnapshot(dir, ['src', 'missing.ts'])
      expect(before.complete).toBe(true)
      expect(before.entries.find((entry) => entry.path === 'missing.ts')?.state).toBe('missing')
      expect(ValidateArtifactSnapshot(before, await getArtifactSnapshot(dir, ['missing.ts', 'src']))).toEqual([])
      await writeFile(join(dir, 'src/a.ts'), '修改后代码')
      expect(ValidateArtifactSnapshot(before, await getArtifactSnapshot(dir, ['src', 'missing.ts'])).join()).toContain('失效')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('越界链接、超限与特殊文件不能假装有效摘要', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-artifact-limit-'))
    const outside = await mkdtemp(join(tmpdir(), 'swarm-artifact-outside-'))
    try {
      await writeFile(join(outside, 'secret'), '不可读取')
      await symlink(outside, join(dir, 'link'))
      const outsideSnapshot = await getArtifactSnapshot(dir, ['link/secret', 'link/missing'])
      expect(outsideSnapshot.complete).toBe(false)
      expect(outsideSnapshot.entries.every((entry) => entry.digest === undefined)).toBe(true)
      await writeFile(join(dir, 'large'), '12345')
      const limit = await getArtifactSnapshot(dir, ['large'], { maxFileBytes: 4 })
      expect(limit.complete).toBe(false)
      expect(ValidateArtifactSnapshot(limit, limit).join()).toContain('未知')
    } finally { await rm(dir, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })

  it('symlink/../path 不先折叠成另一个文件的可信摘要', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-artifact-parent-'))
    try {
      await mkdir(join(dir, 'physical', 'sub'), { recursive: true })
      await writeFile(join(dir, 'target.ts'), '词法路径内容')
      await writeFile(join(dir, 'physical', 'target.ts'), '真实物理路径内容')
      await symlink(join(dir, 'physical', 'sub'), join(dir, 'link'))
      const result = await getArtifactSnapshot(dir, ['link/../target.ts'])
      expect(result.complete).toBe(false)
      expect(result.entries).toEqual([{ path: 'link/../target.ts', state: 'unknown', reason: '范围路径不能包含 .. 段' }])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
