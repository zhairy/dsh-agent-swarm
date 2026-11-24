import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SwarmError } from './util/errors.js';
const TRANSITIONS = {
    queued: ['running', 'blocked', 'failed'],
    running: ['completed', 'failed', 'blocked'],
    completed: [],
    failed: [],
    blocked: []
};
/**
 * 委派状态是否允许从 from 迁移到 to（终态不可再变）
 * @param {DelegationStatus} from - 当前状态
 * @param {DelegationStatus} to - 目标状态
 * @returns {boolean} 是否允许
 */
export const ValidateTransition = (from, to) => TRANSITIONS[from].includes(to);
/** 存储层的未知任务提示：这里没有会话上下文，只给出定位入口与任务卡的隔离语义。 */
const unknownTaskHint = (taskId) => `未知任务：${taskId}。任务卡按根会话与工作区隔离（DSH 重启或切换会话后需要用 swarm_task_card 重新创建）；swarm_status 可列出当前会话的全部任务。`;
/**
 * 创建内存存储；更新总是替换为新对象，旧引用保持不变
 * @returns {TaskStore} 存储
 */
export const intTaskStore = () => {
    const tasks = new Map();
    const delegations = new Map();
    // 写入口脏追踪：状态增量提交只编码被触碰的分片，未变更分片复用已提交缓存。
    const dirtyTasks = new Set();
    const dirtyDelegations = new Set();
    const removedTasks = new Set();
    const markTask = (taskId) => { dirtyTasks.add(taskId); removedTasks.delete(taskId); };
    const markDelegation = (delegationId) => { dirtyDelegations.add(delegationId); };
    const markRemovedTask = (taskId) => { dirtyTasks.delete(taskId); removedTasks.add(taskId); };
    const RollbackTask = (taskId, previous, expected) => {
        const current = tasks.get(taskId);
        if (current === undefined || (current.cardRevision ?? 1) !== expected.cardRevision || (current.workflowRevision ?? 1) !== expected.workflowRevision
            || (current.requestRevision ?? 1) !== expected.requestRevision)
            return false;
        if (previous === undefined) {
            if (current.delegationIds.length > 0)
                return false;
            markRemovedTask(taskId);
            return tasks.delete(taskId);
        }
        if (previous.taskId !== taskId || previous.sessionId !== current.sessionId)
            return false;
        tasks.set(taskId, { ...structuredClone(previous), delegationIds: [...current.delegationIds] });
        markTask(taskId);
        return true;
    };
    const UpdateTask = (taskId, patch) => {
        const current = tasks.get(taskId);
        if (current === undefined)
            throw new SwarmError('UNKNOWN_TASK', unknownTaskHint(taskId));
        if ((patch.taskId !== undefined && patch.taskId !== taskId) || (patch.sessionId !== undefined && patch.sessionId !== current.sessionId))
            throw new SwarmError('INVALID_ARGS', '任务身份不能通过更新迁移');
        if (patch.delegationIds !== undefined && (patch.delegationIds.length !== current.delegationIds.length || patch.delegationIds.some((id, index) => id !== current.delegationIds[index])))
            throw new SwarmError('INVALID_ARGS', '委派关联只能由 AddDelegation 原子更新');
        const next = { ...current, ...patch, updatedAt: Date.now() };
        tasks.set(taskId, next);
        markTask(taskId);
        return next;
    };
    const AddDelegation = (record) => {
        const task = tasks.get(record.taskId);
        if (task === undefined)
            throw new SwarmError('UNKNOWN_TASK', unknownTaskHint(record.taskId));
        if (delegations.has(record.delegationId) || task.delegationIds.includes(record.delegationId))
            throw new SwarmError('INVALID_ARGS', `重复委派：${record.delegationId}`);
        // Prepare both records before either Map changes; one synchronous commit cannot expose an orphan.
        const nextTask = { ...task, delegationIds: [...task.delegationIds, record.delegationId], updatedAt: Date.now() };
        delegations.set(record.delegationId, record);
        tasks.set(record.taskId, nextTask);
        markTask(record.taskId);
        markDelegation(record.delegationId);
    };
    const RestoreSnapshot = (snapshotTasks, snapshotDelegations) => {
        if (tasks.size !== 0 || delegations.size !== 0)
            throw new SwarmError('RECOVERY_REQUIRED', '不能将持久快照覆盖到非空任务存储');
        const restored = structuredClone({ tasks: snapshotTasks, delegations: snapshotDelegations });
        const stagedTasks = new Map();
        const stagedDelegations = new Map();
        const delegationIdsByTask = new Map();
        for (const task of restored.tasks) {
            const ids = new Set(task.delegationIds);
            if (stagedTasks.has(task.taskId) || ids.size !== task.delegationIds.length) {
                throw new SwarmError('RECOVERY_REQUIRED', '持久任务快照存在重复身份或委派关联');
            }
            stagedTasks.set(task.taskId, task);
            delegationIdsByTask.set(task.taskId, ids);
        }
        for (const record of restored.delegations) {
            const task = stagedTasks.get(record.taskId);
            if (stagedDelegations.has(record.delegationId) || task === undefined || !delegationIdsByTask.get(record.taskId)?.has(record.delegationId)) {
                throw new SwarmError('RECOVERY_REQUIRED', '持久委派快照的身份或任务关联无效');
            }
            stagedDelegations.set(record.delegationId, record);
        }
        for (const task of stagedTasks.values())
            for (const id of task.delegationIds) {
                if (stagedDelegations.get(id)?.taskId !== task.taskId)
                    throw new SwarmError('RECOVERY_REQUIRED', '持久任务引用缺失或跨任务的委派');
            }
        // Snapshot array order is not event order. Replaying its records through
        // lifecycle transitions invents intermediate states that never occurred.
        for (const [id, task] of stagedTasks) {
            tasks.set(id, task);
            markTask(id);
        }
        for (const [id, record] of stagedDelegations) {
            delegations.set(id, record);
            markDelegation(id);
        }
    };
    const UpdateDelegation = (delegationId, patch) => {
        const current = delegations.get(delegationId);
        if (current === undefined)
            throw new SwarmError('UNKNOWN_TASK', `未知委派：${delegationId}`);
        if ((patch.delegationId !== undefined && patch.delegationId !== delegationId) || (patch.taskId !== undefined && patch.taskId !== current.taskId))
            throw new SwarmError('INVALID_ARGS', '委派身份与所属任务不能通过更新迁移');
        if (patch.status !== undefined && patch.status !== current.status && !ValidateTransition(current.status, patch.status)) {
            throw new SwarmError('INVALID_TRANSITION', `委派 ${delegationId} 不允许从 ${current.status} 变为 ${patch.status}`);
        }
        const next = { ...current, ...patch };
        delegations.set(delegationId, next);
        markDelegation(delegationId);
        return next;
    };
    return {
        AddTask: (task) => {
            if (tasks.has(task.taskId))
                throw new SwarmError('INVALID_ARGS', `重复任务：${task.taskId}`);
            if (task.delegationIds.length > 0)
                throw new SwarmError('INVALID_ARGS', '新任务不能包含尚未提交的委派关联');
            tasks.set(task.taskId, task);
            markTask(task.taskId);
        },
        getTask: (taskId) => tasks.get(taskId),
        RestoreSnapshot,
        UpdateTask,
        RollbackTask,
        AddDelegation,
        UpdateDelegation,
        takeDirty: () => {
            const snapshot = { tasks: [...dirtyTasks], delegations: [...dirtyDelegations], removedTasks: [...removedTasks] };
            dirtyTasks.clear();
            dirtyDelegations.clear();
            removedTasks.clear();
            return snapshot;
        },
        restoreDirty: (dirty) => {
            for (const id of dirty.tasks)
                dirtyTasks.add(id);
            for (const id of dirty.delegations)
                dirtyDelegations.add(id);
            for (const id of dirty.removedTasks)
                removedTasks.add(id);
        },
        getDelegation: (delegationId) => delegations.get(delegationId),
        getTaskDelegations: (taskId) => {
            const records = [];
            for (const id of tasks.get(taskId)?.delegationIds ?? []) {
                const record = delegations.get(id);
                if (record !== undefined)
                    records.push(record);
            }
            return records;
        },
        getTasks: () => [...tasks.values()]
    };
};
const SECRET_PATTERNS = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /Bearer\s+[A-Za-z0-9._-]+/gi,
    /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi
];
const MAX_LEDGER_TEXT = 2000;
/**
 * 深度脱敏：字符串去除密钥样式内容并截断
 * @param {unknown} value - 任意值
 * @returns {unknown} 脱敏后的新值
 */
export const getRedactedValue = (value) => {
    if (typeof value === 'string') {
        return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[已脱敏]'), value).slice(0, MAX_LEDGER_TEXT);
    }
    if (Array.isArray(value))
        return value.map(getRedactedValue);
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getRedactedValue(item)]));
    }
    return value;
};
/**
 * 账本文件路径：会话 id 中的非安全字符替换为下划线
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @returns {string} 文件路径
 */
export const getLedgerPath = (dir, sessionId) => join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`);
/**
 * 创建追加写入的 JSONL 账本；写入失败只回调 onError，不影响任务执行
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @param {(error: unknown) => void} [onError] - 写入失败回调
 * @returns {Ledger} 账本
 */
export const intLedger = (dir, sessionId, onError) => {
    const path = getLedgerPath(dir, sessionId);
    return {
        path,
        AddLedgerEvent: (event) => {
            try {
                mkdirSync(dir, { recursive: true });
                const line = { ts: new Date().toISOString(), sessionId, ...event, data: getRedactedValue(event.data) };
                appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8');
            }
            catch (error) {
                onError?.(error);
            }
        }
    };
};
/**
 * 读回账本事件，跳过无法解析的行
 * @param {string} path - 账本文件
 * @returns {LedgerEvent[]} 事件列表
 */
export const getLedgerEvents = (path) => {
    let text;
    try {
        text = readFileSync(path, 'utf8');
    }
    catch {
        return [];
    }
    return text.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
};
//# sourceMappingURL=evidence.js.map