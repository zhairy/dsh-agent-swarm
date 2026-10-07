import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorkspaceLeaseManager } from '../../src/util/workspace-lease.js'

describe('canonical workspace execution leases', () => {
  it('serializes writers and verifiers across root managers and symlink aliases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-lease-test-'))
    try {
      const owners = join(directory, 'owners')
      const a = createWorkspaceLeaseManager({ ownerDirectory: owners })
      const b = createWorkspaceLeaseManager({ ownerDirectory: owners })
      const alias = join(directory, 'alias'); await symlink(directory, alias)
      const first = await a.acquire(directory, 'root-a', 'write')
      let granted = false
      const waiting = b.acquire(alias, 'root-b', 'verify').then((lease) => { granted = true; return lease })
      await new Promise((resolve) => setImmediate(resolve))
      expect(granted).toBe(false)
      await first.release({ confirmedStopped: true })
      const second = await waiting
      expect(second.workspaceId).toBe(first.workspaceId)
      expect(second.leaseEpoch).toBeGreaterThan(first.leaseEpoch)
      await second.release()
      expect((await a.getStatus(directory)).busy).toBe(false)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('removes cancelled waiters and fences cancelled writers until verified stopped', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-lease-test-'))
    try {
      const manager = createWorkspaceLeaseManager({ ownerDirectory: join(directory, 'owners') })
      const writing = new AbortController()
      const lease = await manager.acquire(directory, 'root', 'write', writing.signal)
      const queued = new AbortController()
      const waiting = manager.acquire(directory, 'other', 'verify', queued.signal)
      queued.abort()
      await expect(waiting).rejects.toMatchObject({ code: 'ABORTED' })
      writing.abort()
      await lease.release()
      expect((await manager.getStatus(directory)).mutationUnknown).toBe(true)
      await expect(manager.acquire(directory, 'other', 'write')).rejects.toMatchObject({ code: 'MUTATION_UNKNOWN' })
      await expect(manager.reconcile(directory, 'root', false)).rejects.toMatchObject({ code: 'LEASE_INVALID' })
      await manager.reconcile(directory, 'root', true)
      const next = await manager.acquire(directory, 'other', 'verify'); await next.release()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
