import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemoryHandoffEnvelope, loadMemoryHandoff } from '../../src/memory-handoff.js'
import { digest } from '../../src/task-model.js'
import { canonicalStateJson } from '../../src/state-store.js'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))) })
const setup = async (sourceVersion: '2.3.0' | '2.3.1' = '2.3.0') => {
  const dshHome = await mkdtemp(join(tmpdir(), 'swarm-memory-handoff-')); homes.push(dshHome)
  const rootSessionId = 'handoff-root', workspaceId = 'a'.repeat(64)
  const maintenance = join(dshHome, 'share', 'dsh-agent-swarm', 'maintenance')
  const directory = join(maintenance, workspaceId, digest(rootSessionId))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const pending = join(directory, 'pending.json')
  const state = { tasks: [{ taskId: 'T-1', goal: 'keep an in-memory task' }], revision: 1 }
  const envelope = createMemoryHandoffEnvelope({ rootSessionId, workspaceId, state, sourceVersion })
  await writeFile(pending, canonicalStateJson(envelope), { mode: 0o600 })
  const validate = vi.fn((raw: unknown) => (raw as typeof state).revision === 1)
  const input = { dshHome, rootSessionId, workspaceId, persistenceEnabled: false, validate }
  return { input, state, envelope, directory, pending, maintenance }
}

describe('trusted one-time memory handoff', () => {
  it.each(['2.3.0', '2.3.1'] as const)('loads %s without consuming, preserves a failed initializer, then consumes exactly once', async (sourceVersion) => {
    const fixture = await setup(sourceVersion)
    const before = await readFile(fixture.pending, 'utf8')
    const loaded = await loadMemoryHandoff<typeof fixture.state>(fixture.input)
    expect(loaded?.state).toEqual(fixture.state)
    expect(loaded?.sourceVersion).toBe(sourceVersion)
    expect(fixture.input.validate).toHaveBeenCalledTimes(1)
    expect(await readFile(fixture.pending, 'utf8')).toBe(before)
    // Omitting commitConsumption is the failed-initialization path.
    expect((await loadMemoryHandoff(fixture.input))?.state).toEqual(fixture.state)
    const backups = await Promise.all([loaded!.commitConsumption(), loaded!.commitConsumption(), loaded!.commitConsumption()])
    const backup = backups[0]!
    expect(new Set(backups).size).toBe(1)
    expect(backup).toMatch(/consumed-\d+-[a-f0-9-]+\.json$/)
    expect(await readFile(backup, 'utf8')).toBe(before)
    expect(Number((await lstat(backup)).mode) & 0o777).toBe(0o600)
    expect(await loaded!.commitConsumption()).toBe(backup)
    expect(await loadMemoryHandoff(fixture.input)).toBeUndefined()
    expect(await readdir(fixture.directory)).toEqual([backup.split('/').at(-1)])
  })

  it('requires an explicit supported origin when creating the maintenance envelope', () => {
    const scope = { rootSessionId: 'handoff-root', workspaceId: 'a'.repeat(64), state: {} }
    expect(() => createMemoryHandoffEnvelope({ ...scope, sourceVersion: '2.3.2' as '2.3.1' })).toThrow('ENVELOPE_VERSION')
    expect(() => createMemoryHandoffEnvelope(scope as Parameters<typeof createMemoryHandoffEnvelope>[0])).toThrow('ENVELOPE_VERSION')
  })

  it('does nothing without a staged handoff or when durable persistence is enabled', async () => {
    const fixture = await setup()
    expect(await loadMemoryHandoff({ ...fixture.input, persistenceEnabled: true })).toBeUndefined()
    expect(fixture.input.validate).not.toHaveBeenCalled()
    expect(await readFile(fixture.pending, 'utf8')).toContain('keep an in-memory task')
    const absent = join(fixture.input.dshHome, 'does-not-exist')
    expect(await loadMemoryHandoff({ ...fixture.input, dshHome: absent })).toBeUndefined()
    await expect(lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['scope', 'version', 'checksum', 'schema', 'json'] as const)('rejects %s corruption and leaves the pending file unchanged', async (kind) => {
    const fixture = await setup()
    if (kind === 'scope') fixture.envelope.rootSessionId = 'wrong-private-root'
    if (kind === 'version') (fixture.envelope as { sourceVersion: string }).sourceVersion = '2.2.2'
    if (kind === 'checksum') fixture.envelope.state.revision = 2
    if (kind === 'schema') fixture.input.validate.mockReturnValue(false)
    const encoded = kind === 'json' ? '{incomplete' : canonicalStateJson(fixture.envelope)
    await writeFile(fixture.pending, encoded)
    await expect(loadMemoryHandoff(fixture.input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await readFile(fixture.pending, 'utf8')).toBe(encoded)
    expect(await readdir(fixture.directory)).toEqual(['pending.json'])
  })

  it.each(['file-symlink', 'parent-symlink', 'file-mode', 'directory-mode', 'hardlink', 'oversize'] as const)('rejects unsafe %s staging', async (kind) => {
    const fixture = await setup()
    if (kind === 'file-symlink') {
      const original = join(fixture.directory, 'original.json')
      await rename(fixture.pending, original)
      await symlink(original, fixture.pending)
    }
    if (kind === 'parent-symlink') {
      const original = fixture.directory + '-original'
      await rename(fixture.directory, original)
      await symlink(original, fixture.directory)
    }
    if (kind === 'file-mode') await chmod(fixture.pending, 0o644)
    if (kind === 'directory-mode') await chmod(fixture.maintenance, 0o755)
    if (kind === 'hardlink') await link(fixture.pending, join(fixture.directory, 'alias.json'))
    if (kind === 'oversize') await writeFile(fixture.pending, 'x'.repeat(4 * 1024 * 1024 + 1))
    await expect(loadMemoryHandoff(fixture.input)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await lstat(fixture.pending)).toBeDefined()
  })

  it('refuses to consume a replaced or modified pending file after initialization', async () => {
    const fixture = await setup()
    const loaded = await loadMemoryHandoff(fixture.input)
    await writeFile(fixture.pending, canonicalStateJson({ ...fixture.envelope, checksum: 'b'.repeat(64) }))
    await expect(loaded!.commitConsumption()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await readdir(fixture.directory)).toEqual(['pending.json'])
  })

  it('accepts structured validation and keeps its errors separate from private state values', async () => {
    const fixture = await setup()
    const secret = 'PRIVATE_PAYLOAD_MUST_NOT_APPEAR'
    await expect(loadMemoryHandoff({ ...fixture.input, validate: () => ({ ok: false, issues: [{ path: secret, code: secret }] }) }))
      .rejects.toMatchObject({ message: 'Memory handoff rejected: STATE_SCHEMA' })
    expect((await loadMemoryHandoff({ ...fixture.input, validate: () => ({ ok: true }) }))?.state).toEqual(fixture.state)
  })
})
