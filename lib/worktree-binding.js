import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
/** 百工的 create-only 模型合同；alpha2 通过 Host create API 实现，不透传隐式 enter。 */
export const WORKTREE_TOOL = 'create_worktree';
export const RESTORE_WORKTREE_TOOL = 'swarm_restore_worktree';
export const PRIMARY_WORKSPACE_TOOL = 'swarm_bind_primary_workspace';
export const WORKSPACE_GIT_SAVE_TOOL = 'swarm_git_save';
export const VERIFICATION_OUTPUT_TOOL = 'swarm_prepare_verification';
export const isWorktreeMutationTool = (name) => ['write', 'edit', 'apply_patch', 'bash', 'pwsh', 'nb_save', WORKTREE_TOOL, PRIMARY_WORKSPACE_TOOL, WORKSPACE_GIT_SAVE_TOOL, VERIFICATION_OUTPUT_TOOL].includes(name);
export const getWorktreeOwnerKey = (owner) => JSON.stringify([
    owner.agentId, owner.taskId, owner.delegationId, owner.execution?.attemptId, owner.execution?.nodeId,
    owner.execution?.cardRevision, owner.execution?.workflowRevision, owner.execution?.requestRevision,
    owner.execution?.generation, owner.execution?.leaseEpoch
]);
export const isSameWorktreeIdentity = (left, right) => ['repositoryIdentity', 'directoryIdentity', 'gitIdentity', 'commonIdentity', 'gitDirectory', 'commonDirectory']
    .every(key => left[key] === right[key]);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validString = (value) => typeof value === 'string' && value !== '' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const validExecution = (value) => object(value) && validString(value.attemptId) && validString(value.nodeId)
    && ['cardRevision', 'workflowRevision', 'requestRevision', 'generation', 'leaseEpoch'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 1);
const validObservation = (value) => object(value)
    && ['repositoryIdentity', 'directoryIdentity', 'gitIdentity', 'commonIdentity', 'gitDirectory', 'commonDirectory', 'head'].every(key => validString(value[key]))
    && isAbsolute(value.gitDirectory) && isAbsolute(value.commonDirectory) && /^[a-f0-9]{40,64}$/i.test(value.head);
const parseJsonObject = (value) => {
    try {
        return JSON.parse(value);
    }
    catch {
        return undefined;
    }
};
/** 只接受 DSH 官方工具声明的四个结果字段；同时兼容直接结果和文本渲染结果。 */
export const ParseCreatedWorktree = (value) => {
    if (object(value) && validString(value.path) && validString(value.branch) && validString(value.baseCommit) && validString(value.repositoryRoot)) {
        if (value.kind !== undefined && value.kind !== 'primary' && value.kind !== 'linked')
            return undefined;
        if (!isAbsolute(value.path) || !isAbsolute(value.repositoryRoot))
            return undefined;
        const rel = relative(value.repositoryRoot, value.path);
        if (value.kind === 'primary' ? rel !== '' : rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))
            return undefined;
        return { path: value.path, branch: value.branch, baseCommit: value.baseCommit, repositoryRoot: value.repositoryRoot,
            ...(value.kind === undefined ? {} : { kind: value.kind }) };
    }
    if (!object(value))
        return undefined;
    if (object(value.structured))
        return ParseCreatedWorktree(value.structured);
    if (Array.isArray(value.content)) {
        for (const block of value.content) {
            if (!object(block) || block.type !== 'text' || typeof block.text !== 'string')
                continue;
            const parsed = parseJsonObject(block.text);
            const result = ParseCreatedWorktree(parsed);
            if (result !== undefined)
                return result;
        }
    }
    return undefined;
};
// 主树可以按顺序服务不同任务，记录不能因共享路径混为同一授权；物理排他仍由路径租约保护。
const worktreeId = (path, taskId) => `wt-${createHash('sha256').update(taskId === undefined ? path : `${path}\0${taskId}`).digest('hex').slice(0, 20)}`;
/** Per-root registry. A retained worktree is never reused across tickets or assignments. */
export const intWorktreeRegistry = (deps = {}) => {
    const now = deps.now ?? Date.now;
    const records = new Map();
    const byAgent = new Map();
    const byPath = new Map();
    const restoring = new Set();
    const requireRecord = (id) => {
        const record = records.get(id);
        if (record === undefined)
            throw new Error('未知工作树');
        return record;
    };
    const assertPrevious = (expected) => {
        const previous = requireRecord(expected.worktreeId);
        if (previous.ownershipRevision !== expected.ownershipRevision || getWorktreeOwnerKey(previous) !== getWorktreeOwnerKey(expected))
            throw new Error('工作树所有权已改变，不能提交旧恢复请求');
        return previous;
    };
    const publish = (record) => {
        const old = records.get(record.worktreeId);
        if (old !== undefined && byAgent.get(old.agentId) === old.worktreeId)
            byAgent.delete(old.agentId);
        records.set(record.worktreeId, structuredClone(record));
        byAgent.set(record.agentId, record.worktreeId);
        byPath.set(record.path, record.worktreeId);
    };
    const bind = (input) => {
        if (ParseCreatedWorktree(input) === undefined)
            throw new Error('工作树种类、路径或仓库字段无效');
        if (!validString(input.path) || !validString(input.branch) || !validString(input.baseCommit) || !validString(input.repositoryRoot)
            || !validString(input.agentId) || !validString(input.taskId) || !validString(input.delegationId))
            throw new Error('工作树绑定字段无效');
        if (input.execution !== undefined && !validExecution(input.execution) || input.observation !== undefined && !validObservation(input.observation))
            throw new Error('工作树执行身份或目录指纹无效');
        const id = worktreeId(input.path, input.kind === 'primary' ? input.taskId : undefined);
        const existing = records.get(id);
        if ([...records.values()].some(row => row.taskId === input.taskId && row.worktreeId !== id))
            throw new Error('当前任务已经绑定其它工作树，不能追加不同种类或路径');
        if (existing !== undefined) {
            if (getWorktreeOwnerKey(existing) !== getWorktreeOwnerKey(input) || (existing.kind ?? 'linked') !== (input.kind ?? 'linked') || existing.branch !== input.branch || existing.repositoryRoot !== input.repositoryRoot || existing.baseCommit !== input.baseCommit) {
                throw new Error('该工作树已经绑定到其它任务或专家，不能复用');
            }
            return structuredClone(existing);
        }
        const agentRecord = byAgent.get(input.agentId);
        if (agentRecord !== undefined)
            throw new Error('当前专家已经绑定工作树，不能创建第二棵可写工作树');
        const record = {
            ...input,
            worktreeId: id,
            state: 'active',
            retention: 'manual-only',
            createdAt: now(),
            ownershipRevision: 1
        };
        records.set(record.worktreeId, record);
        byAgent.set(record.agentId, record.worktreeId);
        byPath.set(record.path, record.worktreeId);
        return structuredClone(record);
    };
    return {
        canCreate: ({ agentId, taskId }) => {
            const own = byAgent.get(agentId);
            if (own !== undefined)
                return '当前专家已经进入工作树，不能在同一执行身份中创建第二棵可写工作树';
            const taskBound = [...records.values()].find((record) => record.taskId === taskId);
            if (taskBound !== undefined)
                return '当前任务已经绑定工作树；新的专家执行身份应使用独立任务或显式恢复原工作树';
            return undefined;
        },
        bind,
        findById: id => { const record = records.get(id); return record === undefined ? undefined : structuredClone(record); },
        reserve: id => {
            requireRecord(id);
            if (restoring.has(id))
                throw new Error('工作树恢复正在执行，拒绝并发接管');
            restoring.add(id);
            return () => { restoring.delete(id); };
        },
        isRestoring: id => restoring.has(id),
        suspend: id => { requireRecord(id).state = 'recovery-required'; },
        prepareRestore: (id, expected, owner, observation) => {
            const previous = assertPrevious(expected);
            if (id !== previous.worktreeId || owner.taskId !== previous.taskId || !validString(owner.agentId) || !validString(owner.delegationId)
                || !validExecution(owner.execution) || !validObservation(observation) || !Number.isSafeInteger(previous.ownershipRevision + 1))
                throw new Error('不能跨任务或缺少当前 attempt 接管工作树');
            const occupied = byAgent.get(owner.agentId);
            if (occupied !== undefined && occupied !== id)
                throw new Error('当前专家已经绑定另一工作树');
            return { ...structuredClone(previous), ...structuredClone(owner), observation: structuredClone(observation), ownershipRevision: previous.ownershipRevision + 1, state: 'recovery-required' };
        },
        publishRestore: (expected, next) => {
            const previous = assertPrevious(expected);
            if (next.taskId !== previous.taskId || next.path !== previous.path || (next.kind ?? 'linked') !== (previous.kind ?? 'linked') || next.branch !== previous.branch
                || next.baseCommit !== previous.baseCommit || next.repositoryRoot !== previous.repositoryRoot
                || next.ownershipRevision !== previous.ownershipRevision + 1)
                throw new Error('恢复提交的工作树身份不一致');
            publish({ ...next, state: 'recovery-required' });
        },
        activate: (id, ownerKey, observation) => {
            const record = requireRecord(id);
            if (getWorktreeOwnerKey(record) !== ownerKey)
                throw new Error('恢复授权已被替换');
            record.state = 'active';
            if (observation !== undefined)
                record.observation = structuredClone(observation);
            return structuredClone(record);
        },
        findByAgent: (agentId) => {
            const id = byAgent.get(agentId);
            return id === undefined ? undefined : structuredClone(records.get(id));
        },
        findByTask: (taskId) => [...records.values()].filter((record) => record.taskId === taskId).map((record) => structuredClone(record)),
        findByPath: (path) => {
            const id = byPath.get(path);
            return id === undefined ? undefined : structuredClone(records.get(id));
        },
        project: (taskId) => [...records.values()].filter((record) => taskId === undefined || record.taskId === taskId).map((record) => structuredClone(record)),
        hydrate: (events) => {
            for (const event of events) {
                if (event.type !== 'worktree/created')
                    continue;
                const data = event.data;
                const parsed = ParseCreatedWorktree(data);
                if (parsed === undefined || !validString(event.taskId) || !validString(event.delegationId) || !validString(data.agentId))
                    continue;
                const id = worktreeId(parsed.path, parsed.kind === 'primary' ? event.taskId : undefined);
                if (records.has(id) || byAgent.has(data.agentId))
                    continue;
                const record = {
                    ...parsed,
                    worktreeId: id,
                    taskId: event.taskId,
                    delegationId: event.delegationId,
                    agentId: data.agentId,
                    state: 'recovery-required',
                    retention: 'manual-only',
                    createdAt: Number.isFinite(data.createdAt) ? Number(data.createdAt) : Date.parse(event.ts),
                    ownershipRevision: 1
                };
                records.set(id, record);
                byAgent.set(record.agentId, id);
                byPath.set(record.path, id);
            }
        },
        hydrateJournal: events => {
            for (const event of events) {
                if (event.type !== 'worktree/bound' && event.type !== 'worktree/restored')
                    continue;
                const raw = event.payload.binding ?? event.payload.legacyData;
                const parsed = ParseCreatedWorktree(raw);
                if (parsed === undefined || !object(raw) || !validString(raw.agentId) || !validString(event.ticketId) || !validString(event.assignmentId))
                    throw new Error('工作树持久记录无效，拒绝恢复写权限');
                const id = worktreeId(parsed.path, parsed.kind === 'primary' ? event.ticketId : undefined);
                const previous = records.get(id);
                const execution = raw.execution;
                if (execution !== undefined && !validExecution(execution))
                    throw new Error('持久工作树的 attempt 身份无效');
                if (raw.observation !== undefined && !validObservation(raw.observation))
                    throw new Error('持久工作树目录指纹无效');
                if (raw.taskId !== undefined && raw.taskId !== event.ticketId || raw.delegationId !== undefined && raw.delegationId !== event.assignmentId
                    || raw.worktreeId !== undefined && raw.worktreeId !== id)
                    throw new Error('持久工作树归属与事件不一致');
                const next = { ...parsed, agentId: raw.agentId, taskId: event.ticketId, delegationId: event.assignmentId,
                    worktreeId: id, execution, observation: raw.observation,
                    ownershipRevision: Number.isSafeInteger(raw.ownershipRevision) ? Number(raw.ownershipRevision) : 1,
                    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.parse(event.at), retention: 'manual-only', state: 'recovery-required' };
                if (event.type === 'worktree/restored') {
                    if (previous === undefined || event.payload.previousOwner !== getWorktreeOwnerKey(previous)
                        || next.ownershipRevision !== previous.ownershipRevision + 1 || next.execution === undefined
                        || (next.kind ?? 'linked') !== (previous.kind ?? 'linked') || next.taskId !== previous.taskId || next.branch !== previous.branch || next.repositoryRoot !== previous.repositoryRoot || next.baseCommit !== previous.baseCommit)
                        throw new Error('工作树恢复事件链不一致');
                }
                else if (previous !== undefined) {
                    if (next.taskId !== previous.taskId || next.branch !== previous.branch || next.repositoryRoot !== previous.repositoryRoot || next.baseCommit !== previous.baseCommit)
                        throw new Error('持久工作树重复绑定冲突');
                    continue;
                }
                if (!Number.isSafeInteger(next.ownershipRevision) || next.ownershipRevision < 1)
                    throw new Error('持久工作树所有权版本无效');
                const occupied = byAgent.get(next.agentId);
                if (occupied !== undefined && occupied !== id)
                    throw new Error('持久工作树 owner 冲突');
                publish(next);
            }
        }
    };
};
//# sourceMappingURL=worktree-binding.js.map