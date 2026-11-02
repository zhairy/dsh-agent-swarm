import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
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

  it('DSH 在写入中途重启留下的所有者文件（进程已退出）不再永久占用工作区；活着的其他进程仍然独占', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-lease-test-'))
    try {
      const owners = join(directory, 'owners')
      const first = createWorkspaceLeaseManager({ ownerDirectory: owners })
      const lease = await first.acquire(directory, 'root', 'write')
      const [file] = await readdir(owners)
      await lease.release({ confirmedStopped: true })
      // 模拟上一个 DSH 进程（pid 已不存在）留下的所有者文件
      await mkdir(owners, { recursive: true })
      const write = (pid: number) => writeFile(join(owners, file!), JSON.stringify({ schemaVersion: 1, pid, host: hostname(), leaseId: 'old', owner: 'old-root', cwd: directory }), { mode: 0o600 })
      await write(2 ** 22 + 12345)
      const restarted = createWorkspaceLeaseManager({ ownerDirectory: owners })
      const next = await restarted.acquire(directory, 'root-after-restart', 'write')
      expect(next.owner).toBe('root-after-restart')
      await next.release({ confirmedStopped: true })
      await write(1)
      await expect(createWorkspaceLeaseManager({ ownerDirectory: owners }).acquire(directory, 'root', 'write')).rejects.toMatchObject({ code: 'WORKSPACE_BUSY' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
