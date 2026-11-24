import { ParseCreatedWorktree } from '../worktree-binding.js';
import { SwarmError } from '../util/errors.js';
/** 保留百工 create-only 合同；alpha2 的 enter 工具会隐式进入已有树，不能直接开放。 */
export const createLinkedWorktree = async (context, raw, signal) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['name', 'from'].includes(key)))
        throw new SwarmError('INVALID_ARGS', '工作树参数仅接受 name/from');
    const input = raw;
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)))
        throw new SwarmError('INVALID_ARGS', '工作树 name 只能使用小写字母、数字和短横线，或省略由 Host 生成');
    const plan = context.plan;
    if (plan?.mode !== 'linked')
        throw new SwarmError('PLANNING_REVIEW_REQUIRED', '当前合同未批准 linked 工作树');
    if (input.from !== undefined && (typeof input.from !== 'string' || ![plan.head, plan.branch, 'HEAD'].includes(input.from)))
        throw new SwarmError('PLANNING_REVIEW_REQUIRED', '工作树只能从合同冻结的基线创建');
    signal.throwIfAborted();
    context.assertCurrent();
    const denied = context.canCreate();
    if (denied !== undefined)
        throw new SwarmError('RECOVERY_REQUIRED', denied);
    const source = await context.inspectSource();
    context.assertCurrent();
    if (source.repositoryRoot !== plan.repositoryRoot || source.head !== plan.head)
        throw new SwarmError('STALE_EVIDENCE', 'Host 已离开源仓库或 HEAD 漂移；不能创建第二棵或嵌套工作树');
    try {
        const created = await context.create(context.agent, { ...(input.name === undefined ? {} : { name: input.name }), from: plan.head }, signal);
        context.assertCurrent();
        const parsed = ParseCreatedWorktree(created);
        if (parsed === undefined || parsed.kind === 'primary' || parsed.repositoryRoot !== plan.repositoryRoot || parsed.baseCommit !== plan.head)
            throw new SwarmError('RECOVERY_REQUIRED', 'Host 创建回执与 linked 合同不一致');
        return parsed;
    }
    catch (error) {
        await context.quarantine();
        throw error;
    }
};
//# sourceMappingURL=linked-worktree.js.map