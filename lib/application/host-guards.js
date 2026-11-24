import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { getNotebookRuntimePort } from '../host-contract.js';
import { getNotebookToolClass } from '../adapters/dsh-host/notebook-runtime.js';
import { WORKTREE_TOOL, RESTORE_WORKTREE_TOOL, PRIMARY_WORKSPACE_TOOL, VERIFICATION_OUTPUT_TOOL, isWorktreeMutationTool } from '../worktree-binding.js';
import { getAgentHeader, WRITE_TOOL_NAMES } from '../host-contract.js';
import { getToolApprovalDenial } from '../approval-policy.js';
import { getRouterToolDenial } from '../router-worker.js';
import { getPermissionLabel, getRoleInfo, isWriteAllowed } from '../role-registry.js';
const isWriter = (name) => isWorktreeMutationTool(name) || name === RESTORE_WORKTREE_TOOL;
const canonicalPath = (path) => {
    const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
    try {
        return realpathSync.native(absolute);
    }
    catch {
        let parent = dirname(absolute);
        for (let depth = 0; depth < 64; depth++) {
            try {
                const suffix = absolute.slice(parent.length).replace(/^[\\/]+/, '');
                return resolve(realpathSync.native(parent), suffix);
            }
            catch {
                const next = dirname(parent);
                if (next === parent)
                    break;
                parent = next;
            }
        }
        return absolute;
    }
};
const isWithin = (base, target) => {
    const rel = relative(base, target);
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};
const pathTargets = (execution, cwd) => {
    const args = execution.arguments;
    const targets = Object.entries(args ?? {}).filter(([key, value]) => /path|file|directory|root|cwd/i.test(key) && typeof value === 'string')
        .map(([, value]) => canonicalPath(isAbsolute(value) ? value : `${cwd}${sep}${value}`));
    if ((execution.name === 'glob' || execution.name === 'grep') && targets.length === 0)
        targets.push(canonicalPath(cwd));
    return targets;
};
const touchesPrivateRoot = (execution, targets, roots) => targets.some(target => roots.some(root => isWithin(root, target) || (['glob', 'grep'].includes(execution.name) && isWithin(target, root))));
const getPathDenial = (execution, session, taskId, config, privateStateRoots, getCurrentCwd) => {
    if (!['read', 'read_image', 'glob', 'grep', 'write', 'edit'].includes(execution.name))
        return undefined;
    const privateRoots = privateStateRoots.map(canonicalPath);
    const current = execution.agent ?? session.rootAgent;
    const cwd = current === undefined ? process.cwd() : getCurrentCwd?.(current) ?? getAgentHeader(current).cwd ?? process.cwd();
    const targets = pathTargets(execution, cwd);
    if (touchesPrivateRoot(execution, targets, privateRoots)) {
        return `私有状态与账本不能通过通用文件工具读取；调用 swarm_context_read({"task_id":${JSON.stringify(taskId)}}) 列出当前授权材料与执行摘要，再按 ref 分页读取。`;
    }
    if (WRITE_TOOL_NAMES.includes(execution.name) && targets.length > 0) {
        const worktree = current === undefined ? undefined : session.worktrees.findByAgent(current.id);
        if (worktree !== undefined && targets.some(target => !isWithin(canonicalPath(worktree.path), target)))
            return '写入路径超出当前 attempt 绑定的工作树';
        const task = session.store.getTask(taskId);
        if (task === undefined)
            return '当前任务不存在，不能校验写入范围';
        if (task.card.scope.length > 0) {
            const allowed = task.card.scope.map((path) => canonicalPath(isAbsolute(path) ? path : `${cwd}${sep}${path}`));
            if (targets.some((target) => !allowed.some((path) => isWithin(path, target))))
                return '写入路径超出当前任务允许的 scope';
        }
        else if (config.workflow.mode === 'enforced')
            return '写任务必须先明确允许修改的 scope';
    }
    return undefined;
};
/** Pure application guard. Host approval remains authoritative and is consumed through a callback-safe adapter. */
export const createHostGuardUseCases = (deps) => {
    const AddRootEdit = (agent, role) => {
        if (agent === undefined || role !== 'tian_shu' || getAgentHeader(agent).parentSession !== undefined)
            return;
        deps.getSession(agent.id).rootEditAt = deps.now();
    };
    const getGuardReason = (execution) => {
        if (execution.agent !== undefined && deps.isRootTianShu(execution.agent) && execution.name === 'update_goal'
            && execution.arguments?.action === 'complete')
            return deps.getGoalCompletionReason(execution.agent);
        if (execution.signal?.aborted === true)
            return '专家请求已经取消，迟到工具调用被拒绝';
        const writer = isWriter(execution.name);
        const oneShot = execution.agent === undefined ? undefined : deps.getAgentControl(execution.agent.id);
        if (execution.agent !== undefined && deps.hasManagedChildPreset(execution.agent)
            && !deps.hasChildOwner(execution.agent.id) && !deps.isStartingChild(execution.agent.id)) {
            return '专家执行授权已结束；迟到工具调用已被拒绝';
        }
        if (oneShot?.persistent === false && oneShot.oneShotSettled === true) {
            return oneShot.reason === 'one-shot-cancelled' ? '专家已经取消，延迟工具调用被拒绝' : '一次性专家已经结束，延迟工具调用被拒绝';
        }
        if (deps.isClosing() && execution.agent !== undefined && deps.isManagedAgent(execution.agent) && writer) {
            return '百工正在停止，拒绝新增写入、工作树或命令执行';
        }
        const role = deps.getRoleForAgent(execution.agent);
        const config = deps.getConfig();
        if (role === 'tian_shu' && execution.agent !== undefined && ['read', 'read_image', 'glob', 'grep', 'write', 'edit'].includes(execution.name)) {
            const roots = (deps.recoveryStateRoots?.() ?? []).map(canonicalPath);
            const cwd = deps.getCurrentCwd?.(execution.agent) ?? getAgentHeader(execution.agent).cwd ?? process.cwd();
            if (touchesPrivateRoot(execution, pathTargets(execution, cwd), roots))
                return '补阙私有状态不能通过通用文件工具读取或修改；请查看对应任务的复盘报告。';
        }
        if (execution.name.startsWith('nb_') && deps.isManagedAgent(execution.agent)) {
            const notebook = getNotebookToolClass(execution.name);
            if (notebook === undefined || getNotebookRuntimePort() === undefined)
                return 'Notebook 尚未接入可信沙箱适配器，未执行代码或文件操作';
            if (role === 'tian_shu' && notebook !== 'control')
                return '天枢负责主持与草稿整理；请委派专家执行 Notebook，再查看对应子会话的 Notebook 标签';
            if (notebook === 'execution' && (role === undefined || !getRoleInfo(role).capabilities.some(cap => cap === 'calculate' || cap === 'shell')))
                return '当前专家没有 Notebook 计算权限，请交给算衡或有执行能力的专家';
            if (notebook === 'file-write' && (role === undefined || getRoleInfo(role).permission !== 'workspace-edit'))
                return 'Notebook 保存需要当前可写 Worker 的工作树与任务 scope 授权';
        }
        if (role === 'tian_shu' && writer && config.router.workspaceWrites === 'deny') {
            const denial = getRouterToolDenial(execution.name, execution.arguments);
            return denial === undefined
                ? '天枢是 Router，只负责规划、授权、路由与派发；当前配置禁止它直接写入、运行命令或创建可写工作树。请委派铸剑、行舟或疾风执行。'
                : '天枢是 Router，不能执行该操作；请委派 Worker 执行。';
        }
        if (role === 'tian_shu' && execution.name === WORKTREE_TOOL)
            return '天枢是路由与会话主持者，不能直接创建可写工作树；请委派铸剑或疾风执行';
        if (deps.isManagedAgent(execution.agent)) {
            const denied = getToolApprovalDenial(execution, config.approvals);
            if (denied !== undefined)
                return denied;
        }
        const owner = execution.agent === undefined ? undefined : deps.getChildOwner(execution.agent.id);
        if (execution.name === VERIFICATION_OUTPUT_TOOL && (owner === undefined || role !== 'fu_he'))
            return '仅当前复核 Worker 可准备测试输出';
        if ([RESTORE_WORKTREE_TOOL, PRIMARY_WORKSPACE_TOOL].includes(execution.name) && (owner === undefined || role === undefined || getRoleInfo(role).permission !== 'workspace-edit'))
            return '仅当前合法可写 Worker 可以绑定或恢复工作区';
        if (owner !== undefined && execution.agent !== undefined) {
            const session = deps.getSession(owner);
            const binding = session.features?.bindings.get(execution.agent.id);
            if (binding === undefined)
                return '当前专家的身份绑定尚未就绪，不能执行工具';
            if (execution.signal?.aborted || deps.getChildSignal(execution.agent.id)?.aborted)
                return '专家已经取消，延迟工具调用被拒绝';
            if (binding.state !== 'active')
                return '专家执行身份已经撤销，请重新委派';
            if (deps.isQuarantined(binding.taskId, owner) && writer)
                return 'Ticket 已隔离：存在未知外部副作用，只允许只读核对与恢复读取，禁止写入、工作树或命令执行';
            const task = session.store.getTask(binding.taskId);
            if (task === undefined || !deps.isBindingCurrent(session, binding, execution.agent, task))
                return '专家绑定的是旧任务版本，不能继续执行工具';
            if (task.workspacePlan?.mode === 'blocked' && writer)
                return '项目工作区要求互相冲突，澄清前禁止写入';
            const workspaceEditor = role !== undefined && getRoleInfo(role).permission === 'workspace-edit';
            if ((workspaceEditor || execution.name === VERIFICATION_OUTPUT_TOOL) && writer && task.workspacePlanUnavailable)
                return 'Host 无法核验项目工作区规则，写入前先修复核验并重新规划';
            if (execution.name === WORKTREE_TOOL) {
                if (task.workspacePlan?.mode === 'primary' || task.workspacePlan?.mode === 'blocked')
                    return '项目要求唯一主工作区或规则待澄清，禁止创建 linked 工作树';
                if (!workspaceEditor)
                    return '只有可编辑工作区的专家能够创建可写工作树';
                const denied = session.worktrees.canCreate({ agentId: execution.agent.id, taskId: binding.taskId });
                if (denied !== undefined)
                    return denied;
            }
            else if (writer && workspaceEditor && ![RESTORE_WORKTREE_TOOL, PRIMARY_WORKSPACE_TOOL].includes(execution.name)) {
                const worktreeToolLoaded = deps.getTaskSchemaNames(execution.agent).some((tool) => tool.name === WORKTREE_TOOL);
                if (worktreeToolLoaded || session.worktrees.findByTask(binding.taskId).length > 0) {
                    const bound = session.worktrees.findByAgent(execution.agent.id);
                    if (bound === undefined)
                        return '当前 attempt 尚未绑定工作树；已有现场请从 swarm_context_read 获取 worktree_id 并调用 swarm_restore_worktree，否则先调用 create_worktree';
                    if (bound.taskId !== binding.taskId)
                        return '当前专家仍绑定其它任务的工作树，不能在新任务中写入';
                    if (bound.state !== 'active' || session.worktrees.isRestoring(bound.worktreeId) || deps.isWorktreeWriter?.(execution.agent, binding, bound) !== true)
                        return '工作树尚未取得当前 agent/delegation/attempt 的有效写租约，请显式恢复';
                    if ((deps.getCurrentCwd?.(execution.agent) ?? getAgentHeader(execution.agent).cwd) !== bound.path)
                        return '实际生效 CWD 不属于当前授权工作树，拒绝写入';
                    if (execution.name === 'bash' || execution.name === 'pwsh') {
                        const workdir = execution.arguments?.workdir;
                        if (typeof workdir === 'string' && !isWithin(canonicalPath(bound.path), canonicalPath(resolve(bound.path, workdir))))
                            return 'Shell workdir 超出当前授权工作树';
                    }
                }
            }
            const pathDenial = getPathDenial(execution, session, binding.taskId, config, deps.privateStateRoots(), deps.getCurrentCwd);
            if (pathDenial !== undefined)
                return pathDenial;
        }
        if (!writer)
            return undefined;
        if (execution.agent !== undefined && deps.isWorkspaceMutationUnknown(deps.getCurrentCwd?.(execution.agent) ?? getAgentHeader(execution.agent).cwd ?? process.cwd())) {
            return '工作区存在未确认副作用，必须完成恢复核对后才能再次写入或运行命令';
        }
        if (role === 'tian_shu' && execution.agent !== undefined && config.workflow.mode === 'enforced'
            && deps.getSession(execution.agent.id).store.getTasks().some((task) => task.acceptance?.status !== 'accepted' && task.acceptance?.decision !== 'incomplete')) {
            return '强制任务流程中，写入与通用命令需通过受工作区租约管理的专家执行';
        }
        if ((execution.name === 'bash' || execution.name === 'pwsh') && role !== undefined && getRoleInfo(role).capabilities.includes('shell'))
            return undefined;
        if (execution.name === VERIFICATION_OUTPUT_TOOL && role === 'fu_he')
            return undefined;
        if (role === undefined || isWriteAllowed(role))
            return undefined;
        return `dsh-agent-swarm 守卫：「${getRoleInfo(role).name}」是${getPermissionLabel(role)}角色，不能调用 ${execution.name} 修改文件。请在结果中写明需要的改动，由天枢交给铸剑或疾风处理。`;
    };
    return { AddRootEdit, getGuardReason };
};
//# sourceMappingURL=host-guards.js.map