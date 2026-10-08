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
})
