import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createHostWorktreePort } from '../../../lib/adapters/dsh-host/worktree.js'
import { restoreRetainedWorktree } from '../../../lib/application/worktree-recovery.js'
import { intWorktreeRegistry } from '../../../lib/worktree-binding.js'
import { createWorkspaceLeaseManager } from '../../../lib/util/workspace-lease.js'
import { intMutex } from '../../../lib/util/mutex.js'
import { createSwarmEventJournal } from '../../../lib/event-journal.js'

export const name = 'swarm-worktree-host-proof'
export const inject = ['agents', 'workingDirectory', 'fs', 'subprocess', 'sandbox', 'sandboxPolicy']

export const apply = ctx => {
  setTimeout(() => { void (async () => {
    let handle, lease
    try {
      const fixture = JSON.parse(await readFile(process.env.SWARM_WORKTREE_FIXTURE, 'utf8'))
      handle = await ctx.agents.create({ sessionId: `worktree-proof-${randomUUID()}`, meta: { cwd: fixture.repositoryRoot } })
      const host = createHostWorktreePort(ctx), signal = new AbortController().signal
      const before = await host.inspect(handle.agent, fixture, signal)
      const registry = intWorktreeRegistry()
      const record = registry.bind({ ...fixture, taskId: 'T-proof', delegationId: 'D-before', agentId: 'old-owner', observation: before })
      const journal = createSwarmEventJournal({ directory: `${process.env.DSH_HOME}/proof-events`, rootSessionId: 'proof-root' })
      journal.append({ eventId: 'bound', idempotencyKey: 'bound', type: 'worktree/bound', ticketId: record.taskId, assignmentId: record.delegationId, actor: { kind: 'host', id: 'fixture' }, payload: { binding: record } })
      const result = await restoreRetainedWorktree({ id: record.worktreeId, agent: handle.agent, signal, registry, journal, host,
        leases: createWorkspaceLeaseManager({ ownerDirectory: `${process.env.DSH_HOME}/proof-leases` }), lock: intMutex(),
        owner: { taskId: record.taskId, delegationId: 'D-current', agentId: handle.agent.id, execution: { attemptId: 'current-attempt', nodeId: 'implementation', cardRevision: 1, workflowRevision: 1, requestRevision: 1, generation: 1, leaseEpoch: 1 } },
        assertCurrent: () => signal.throwIfAborted(), confirmStopped: async () => {}, assertStopped: () => {}, getLease: () => undefined,
        retainLease: value => { lease = value }, warn: message => ctx.logger.warn(message)
      })
      const after = await host.inspect(handle.agent, fixture, signal)
      await writeFile(process.env.SWARM_WORKTREE_PROOF_OUT, JSON.stringify({ ok: result.state === 'active' && host.cwd(handle.agent) === fixture.path && after.head === before.head,
        effectiveCwd: host.cwd(handle.agent), originalCwd: handle.agent.session.header.cwd, originalOwnerGone: registry.findByAgent('old-owner') === undefined,
        restoredEvents: journal.queryTypes(['worktree/restored']).length, sandboxMode: ctx.sandboxPolicy.resolve({ session: handle.agent.session }).mode,
        headUnchanged: before.head === after.head, host: '0.2.2-rc.1', modelCalls: 0 }), { mode: 0o600 })
    } catch (error) {
      await writeFile(process.env.SWARM_WORKTREE_PROOF_OUT, JSON.stringify({ ok: false, error: String(error?.message ?? error) }), { mode: 0o600 })
      process.exitCode = 1
    } finally {
      await lease?.release({ confirmedStopped: true })
      await handle?.dispose?.()
      setTimeout(() => process.exit(process.exitCode || 0), 100)
    }
  })() }, 500)
  setTimeout(() => process.exit(2), 45000).unref()
}
