import { randomUUID } from 'node:crypto'
import type { AgentLike } from '../host-contract.js'
import type { SwarmEventJournal } from '../event-journal.js'
import { getWorktreeOwnerKey, isSameWorktreeIdentity, type WorktreeBindingInfo, type WorktreeOwner, type WorktreeRegistry } from '../worktree-binding.js'
import type { WorktreeHostPort } from '../adapters/dsh-host/worktree.js'
import type { WorkspaceLease, WorkspaceLeaseManager } from '../util/workspace-lease.js'

export interface RestoreWorktreeInput {
  id: string
  agent: AgentLike
  owner: WorktreeOwner
  signal: AbortSignal
  registry: WorktreeRegistry
  journal: SwarmEventJournal
  host: WorktreeHostPort
  leases: WorkspaceLeaseManager
  lock: { run: <T>(operation: () => Promise<T>) => Promise<T> }
  assertCurrent: () => void
  confirmStopped: (previous: WorktreeBindingInfo) => Promise<void>
  assertStopped: (previous: WorktreeBindingInfo) => void
  getLease: (record: WorktreeBindingInfo) => WorkspaceLease | undefined
  retainLease: (lease: WorkspaceLease, record: WorktreeBindingInfo) => void
  warn: (message: string) => void
}

/** The only ownership publication path; durable commit and activation are separate boundaries. */
export const restoreRetainedWorktree = async (input: RestoreWorktreeInput): Promise<WorktreeBindingInfo> => {
  const expected = input.registry.findById(input.id)
  if (!expected || expected.taskId !== input.owner.taskId) throw new Error('工作树不属于当前任务')
  const unreserve = input.registry.reserve(input.id)
  let acquired: WorkspaceLease | undefined
  try {
    return await input.lock.run(async () => {
      const assertCurrent = () => { input.signal.throwIfAborted(); input.assertCurrent() }
      assertCurrent()
      const current = input.registry.findById(input.id)!
      if (current.ownershipRevision !== expected.ownershipRevision || getWorktreeOwnerKey(current) !== getWorktreeOwnerKey(expected)) throw new Error('等待期间工作树所有权已改变')
      if (input.journal.fatalError !== undefined) throw new Error('工作树事件持久化状态不明确，需要重新加载核对')
      const committed = input.journal.queryTypes(['worktree/restored']).findLast(event => (event.payload.binding as WorktreeBindingInfo | undefined)?.worktreeId === input.id)?.payload.binding as WorktreeBindingInfo | undefined
      if (committed !== undefined && (committed.ownershipRevision !== current.ownershipRevision || getWorktreeOwnerKey(committed) !== getWorktreeOwnerKey(current))) throw new Error('持久 owner 与内存状态不一致，需要重新加载核对')
      const existingLease = input.getLease(current)
      const reusableLease = getWorktreeOwnerKey(current) === getWorktreeOwnerKey(input.owner) && existingLease !== undefined && input.leases.isCurrent(existingLease)
      const idempotent = current.state === 'active' && reusableLease
      input.registry.suspend(input.id)
      await input.confirmStopped(current)
      assertCurrent()
      if (!reusableLease) {
        acquired = await input.leases.acquire(current.path, `${input.agent.id}:${input.owner.execution!.attemptId}:worktree`, 'write', input.signal, { wait: false })
      }
      const lease = acquired ?? existingLease!
      const before = await input.host.inspect(input.agent, current, input.signal)
      assertCurrent()
      if (current.observation !== undefined && !isSameWorktreeIdentity(current.observation, before)) throw new Error('原工作树目录已被替换')
      await input.host.setCwd(input.agent, current.path, input.signal)
      assertCurrent()
      const after = await input.host.inspect(input.agent, current, input.signal)
      assertCurrent()
      input.assertStopped(current)
      if (!isSameWorktreeIdentity(before, after) || before.head !== after.head || input.host.cwd(input.agent) !== current.path || !input.leases.isCurrent(lease)) throw new Error('恢复期间工作树现场、CWD 或租约已改变')
      if (idempotent) return input.registry.activate(input.id, getWorktreeOwnerKey(input.owner))
      const next = input.registry.prepareRestore(input.id, expected, input.owner, after)
      const eventId = `evt-worktree-restore-${randomUUID()}`
      const event = input.journal.append({ eventId, idempotencyKey: eventId, type: 'worktree/restored', ticketId: next.taskId, assignmentId: next.delegationId,
        actor: { kind: 'worker', id: next.agentId }, payload: { previousOwner: getWorktreeOwnerKey(expected), binding: next } })
      if (event === undefined || JSON.stringify(event.payload.binding) !== JSON.stringify(next)) throw new Error('恢复事实未可靠提交')
      // Adopt the committed owner while still fenced: an interruption must never resurrect the previous owner.
      input.registry.publishRestore(expected, next)
      assertCurrent()
      input.assertStopped(current)
      if (!input.leases.isCurrent(lease) || input.host.cwd(input.agent) !== current.path) throw new Error('提交后工作树授权已失效')
      input.retainLease(lease, next)
      acquired = undefined
      return input.registry.activate(input.id, getWorktreeOwnerKey(input.owner))
    })
  } catch (error) {
    input.warn(`工作树恢复被阻止：id=${input.id}；保持禁止写入`)
    throw error
  } finally {
    unreserve()
    if (acquired !== undefined) await acquired.release({ confirmedStopped: true })
  }
}
