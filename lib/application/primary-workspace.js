import { randomUUID } from 'node:crypto';
import { getWorktreeOwnerKey, isSameWorktreeIdentity } from '../worktree-binding.js';
import { assertWorkspacePlanBinding } from '../workspace-policy.js';
/** 主树沿用当前 attempt 已取得的路径排他租约，不能为同一路径再申请第二份租约。 */
export const bindPrimaryWorkspace = async (input) => input.lock.run(async () => {
    const check = () => {
        input.signal.throwIfAborted();
        input.assertCurrent();
        assertWorkspacePlanBinding(input.workspacePlan, input.record);
        if (input.record.kind !== 'primary' || input.record.path !== input.record.repositoryRoot || input.lease.cwd !== input.record.path
            || input.lease.kind !== 'write' || !input.leases.isCurrent(input.lease))
            throw new Error('主工作区缺少当前路径的排他写租约');
        if (input.journal.fatalError !== undefined)
            throw new Error('工作树事件持久化未确认，拒绝授权');
    };
    check();
    if (input.registry.findByTask(input.owner.taskId).some(row => row.kind !== 'primary'))
        throw new Error('当前任务已有 linked 工作树，切换模式须建立新任务');
    const existing = input.registry.findByTask(input.owner.taskId).find(row => row.kind === 'primary');
    if (existing !== undefined) {
        if (getWorktreeOwnerKey(existing) !== getWorktreeOwnerKey(input.owner) || existing.state !== 'active')
            throw new Error('已有主工作区需显式恢复，不自动接管旧 owner');
        const observed = await input.host.inspect(input.agent, existing, input.signal);
        check();
        if (observed.head !== input.expectedHead || existing.observation === undefined || !isSameWorktreeIdentity(existing.observation, observed)
            || input.host.cwd(input.agent) !== existing.path)
            throw new Error('主工作区现场或 HEAD 已改变');
        return existing;
    }
    const before = await input.host.inspect(input.agent, input.record, input.signal);
    check();
    if (before.head !== input.expectedHead || before.head !== input.record.baseCommit)
        throw new Error('主工作区 HEAD 与已确认基线不一致');
    const record = input.registry.bind({ ...input.record, ...input.owner });
    input.registry.suspend(record.worktreeId);
    try {
        await input.host.setCwd(input.agent, record.path, input.signal);
        const after = await input.host.inspect(input.agent, record, input.signal);
        check();
        if (!isSameWorktreeIdentity(before, after) || before.head !== after.head || input.host.cwd(input.agent) !== record.path)
            throw new Error('主工作区绑定期间目录、HEAD 或 CWD 已改变');
        const bound = { ...record, observation: after, state: 'recovery-required' };
        const eventId = `evt-primary-bound-${randomUUID()}`;
        const event = input.journal.append({ eventId, idempotencyKey: eventId, type: 'worktree/bound', ticketId: record.taskId, assignmentId: record.delegationId,
            actor: { kind: 'worker', id: record.agentId }, payload: { binding: bound } });
        if (event === undefined || JSON.stringify(event.payload.binding) !== JSON.stringify(bound))
            throw new Error('主工作区绑定未可靠落盘');
        check();
        input.retainLease(input.lease, bound);
        return input.registry.activate(record.worktreeId, getWorktreeOwnerKey(input.owner), after);
    }
    catch (error) {
        input.registry.suspend(record.worktreeId);
        throw error;
    }
});
//# sourceMappingURL=primary-workspace.js.map