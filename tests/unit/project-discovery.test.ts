import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { discoverProjectFiles } from '../../src/project-discovery.js'

describe('actual workspace file discovery', () => {
  it('returns actual candidates for a missing guessed path, excluding dependencies and private/link targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-discovery-'))
    const outside = await mkdtemp(join(tmpdir(), 'swarm-discovery-outside-'))
    try {
      for (const dir of ['src', 'node_modules', 'private']) await mkdir(join(root, dir))
      await writeFile(join(root, 'src/task-model.ts'), 'actual task type')
      await writeFile(join(root, 'src/service.ts'), 'actual operations')
      await writeFile(join(root, 'node_modules/task.ts'), 'dependency')
      await writeFile(join(root, 'private/ledger.json'), 'private')
      await writeFile(join(outside, 'secrets.txt'), 'outside')
      await symlink(outside, join(root, 'linked'))
      const missing = await discoverProjectFiles(root, { query: 'src/task.ts' }, { privateRoots: [join(root, 'private')] })
      expect(missing.status).toBe('ok')
      expect(missing.files).toEqual([])
      expect(missing).toHaveProperty('suggestions', ['src/task-model.ts'])
      const all = await discoverProjectFiles(root, {}, { privateRoots: [join(root, 'private')] })
      expect(all.files).toEqual(['src/service.ts', 'src/task-model.ts'])
      expect(all).toHaveProperty('skippedLinks', ['linked'])
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })
  it('invalidates pagination when the actual file index changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-discovery-cursor-'))
    try {
      await writeFile(join(root, 'a.ts'), '')
      await writeFile(join(root, 'b.ts'), '')
      const first = await discoverProjectFiles(root, { limit: 1 })
      expect(first.nextCursor).not.toBeNull()
      await writeFile(join(root, 'c.ts'), '')
      expect(await discoverProjectFiles(root, { limit: 1, cursor: first.nextCursor! })).toMatchObject({ status: 'stale', files: [] })
      expect(await discoverProjectFiles(root, {}, { maxEntries: 1 })).toMatchObject({ complete: false, scannedEntries: 1 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('scopes bounded indexes to actual subdirectories and rejects external/private traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-discovery-scope-'))
    const outside = await mkdtemp(join(tmpdir(), 'swarm-discovery-target-'))
    try {
      await mkdir(join(root, 'src'))
      await mkdir(join(root, 'private'))
      await writeFile(join(root, 'root.ts'), '')
      await writeFile(join(root, 'src/a.ts'), '')
      await writeFile(join(root, 'src/b.ts'), '')
      await symlink(outside, join(root, 'outside'))
      await symlink(join(root, 'src'), join(root, 'inside'))
      await symlink(join(root, 'private'), join(root, 'private-alias'))
      const page = await discoverProjectFiles(root, { path: 'src', limit: 1 })
      expect(page).toMatchObject({ path: 'src', files: ['src/a.ts'], complete: true })
      expect(await discoverProjectFiles(root, { cursor: page.nextCursor! })).toMatchObject({ status: 'stale' })
      for (const path of ['..', '../escape', '/tmp', 'outside']) await expect(discoverProjectFiles(root, { path })).rejects.toThrow()
      await expect(discoverProjectFiles(root, { path: 'private' }, { privateRoots: [join(root, 'private')] })).rejects.toThrow('私有状态')
      await expect(discoverProjectFiles(root, { path: 'private-alias' }, { privateRoots: [join(root, 'private')] })).rejects.toThrow('私有状态')
      expect(await discoverProjectFiles(root, { path: 'inside' })).toMatchObject({ path: 'src', files: ['src/a.ts', 'src/b.ts'] })
      const aborted = new AbortController()
      aborted.abort(new Error('cancelled'))
      await expect(discoverProjectFiles(root, {}, { signal: aborted.signal })).rejects.toThrow('cancelled')
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
  })
  it('bounds long-path indexes and pages without claiming unscanned files are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarm-discovery-bytes-'))
    try {
      for (let d = 0; d < 15; d++) {
        const directory = `${String(d).padStart(2, '0')}-${'d'.repeat(210)}`
        await mkdir(join(root, directory))
        await Promise.all(Array.from({ length: 200 }, (_, n) => writeFile(join(root, directory, `${String(n).padStart(3, '0')}-${'f'.repeat(210)}.ts`), '')))
      }
      const page = await discoverProjectFiles(root, { limit: 200 })
      expect(page).toMatchObject({ complete: false, indexCapped: true })
      expect(page.nextAction).toContain('不能证明文件不存在')
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(64 * 1024)
      const scoped = await discoverProjectFiles(root, { path: `00-${'d'.repeat(210)}`, limit: 200 })
      expect(scoped).toMatchObject({ complete: true, indexCapped: false, totalMatches: 200 })
      expect(scoped.files.length).toBeLessThan(200)
      expect(scoped.nextCursor).not.toBeNull()
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 15000)
})
