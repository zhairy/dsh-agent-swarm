import { getRedactedText, isJevProbability } from './jev.js';
const HISTORY_LIMIT = 5;
export const intThreadRegistry = () => {
    const threads = new Map();
    const dirtyThreads = new Set();
    const markThread = (threadId) => { dirtyThreads.add(threadId); };
    const Update = (threadId, patch) => {
        const current = threads.get(threadId);
        if (current === undefined)
            return undefined;
        const next = { ...current, ...patch };
        threads.set(threadId, next);
        markThread(threadId);
        return next;
    };
    return {
        Add: (thread) => { threads.set(thread.threadId, thread); markThread(thread.threadId); },
        get: (threadId) => threads.get(threadId),
        getCandidates: (key) => [...threads.values()]
            .filter((thread) => thread.key === key && !thread.busy && !thread.closed)
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt),
        list: () => [...threads.values()],
        Update,
        AddRound: (threadId, round, now) => {
            const current = threads.get(threadId);
            if (current === undefined)
                return undefined;
            return Update(threadId, {
                busy: false,
                rounds: current.rounds + 1,
                taskIds: current.taskIds.includes(round.taskId) ? current.taskIds : [...current.taskIds, round.taskId],
                history: [...current.history, round].slice(-HISTORY_LIMIT),
                lastUsedAt: now
            });
        },
        takeDirty: () => {
            const snapshot = { threads: [...dirtyThreads] };
            dirtyThreads.clear();
            return snapshot;
        },
        restoreDirty: (dirty) => { for (const threadId of dirty.threads)
            dirtyThreads.add(threadId); }
    };
};
export const intChildEndHub = () => {
    const waiters = new Map();
    const consumed = new Map();
    const activations = new Map();
    return {
        ObserveStart: info => {
            if (typeof info.runId !== 'string' || !info.runId || typeof info.provider !== 'string' || !info.provider
                || typeof info.parentSessionId !== 'string' || !info.parentSessionId || typeof info.local !== 'boolean')
                return;
            if (activations.get(info.id)?.runId === info.runId)
                return;
            activations.set(info.id, { ...info, ended: false });
        },
        wait: (childId, signal) => new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
            }
            const settle = (info) => {
                signal.removeEventListener('abort', onAbort);
                resolve(info);
            };
            const onAbort = () => {
                const list = waiters.get(childId)?.filter((item) => item !== settle) ?? [];
                if (list.length > 0)
                    waiters.set(childId, list);
                else
                    waiters.delete(childId);
                reject(new DOMException('aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            waiters.set(childId, [...(waiters.get(childId) ?? []), settle]);
        }),
        Emit: (info, beforeDelivery) => {
            const activation = activations.get(info.id);
            if (info.runId !== undefined || activation !== undefined) {
                if (activation === undefined || activation.ended || info.runId !== activation.runId || info.provider !== activation.provider
                    || info.parentSessionId !== activation.parentSessionId || info.local !== activation.local)
                    return;
                activation.ended = true;
            }
            // 控制状态、路由与租约观察也必须在身份通过之后更新。
            beforeDelivery?.();
            const list = waiters.get(info.id);
            if (list === undefined || list.length === 0)
                return;
            const [first, ...rest] = list;
            if (rest.length > 0)
                waiters.set(info.id, rest);
            else
                waiters.delete(info.id);
            first?.(info);
        },
        MarkConsumed: (childId) => { consumed.set(childId, (consumed.get(childId) ?? 0) + 1); },
        TakeConsumed: (childId) => {
            const count = consumed.get(childId) ?? 0;
            if (count <= 0)
                return false;
            if (count === 1)
                consumed.delete(childId);
            else
                consumed.set(childId, count - 1);
            return true;
        }
    };
};
/** 天枢在 swarm_delegate 里显式指定的会话方式 */
export const SESSION_CHOICES = ['auto', 'new', 'continue', 'oneshot'];
/** Jev 不可用时默认开连续会话的角色：编辑、执行、验证与审查通常会按反馈反复调用 */
export const REPEAT_ROLES = ['zhu_jian', 'ji_feng', 'xing_zhou', 'fu_he', 'yu_shi'];
/** 衡鉴的会话判断题 */
export const SESSION_QUESTIONS = {
    repeat: {
        type: 'noul',
        instructions: '在同一大类任务中，这位专家很可能还会被再次调用，并且保留它已有的上下文继续工作会更好（例如按审查意见修改、复查、补充验证、继续深入同一问题）',
        criteria: { true: '后续很可能还有同类的追加工作，保留上下文有明显价值', false: '这是一次性的独立工作，完成后不太会再追加' }
    }
};
export const SAME_CATEGORY_QUESTION = {
    type: 'noul',
    instructions: '新的委派请求与这位专家会话此前处理的工作属于同一大类任务，在原有上下文上继续追加更合适',
    criteria: { true: '同一目标或同一模块的后续工作，原有上下文可以直接复用', false: '主题不同或需要全新、独立的视角，应当开新会话' }
};
/**
 * 衡鉴判断会话方式的状态（全部脱敏截断）
 * @param {{ role: string; mode?: SuanHengMode; goal: string; request: string; thread?: ThreadInfo }} input - 角色、任务目标、新请求与候选会话
 * @returns {object} state
 */
export const getSessionState = (input) => ({
    role: input.roleName,
    ...(input.mode === undefined ? {} : { mode: input.mode === 'research' ? '研算' : '验算' }),
    task_goal: getRedactedText(input.goal),
    new_request: getRedactedText(input.request, 1200),
    ...(input.thread === undefined ? {} : {
        existing_session: {
            rounds: input.thread.rounds,
            recent: input.thread.history.slice(-3).map((round) => ({ request: getRedactedText(round.request, 400), summary: getRedactedText(round.summary, 400) }))
        }
    })
});
/**
 * 会话判断题：有候选会话时加问「是否同类」
 * @param {boolean} hasThread - 是否有可追加的会话
 * @returns {Record<string, unknown>} Jev 题目
 */
export const getSessionQuestions = (hasThread) => hasThread ? { ...SESSION_QUESTIONS, same_category: SAME_CATEGORY_QUESTION } : { ...SESSION_QUESTIONS };
const getNoul = (answers, id) => {
    const value = answers[id];
    const noul = value !== null && typeof value === 'object' && !Array.isArray(value) ? value.noul : undefined;
    return isJevProbability(noul) ? noul : undefined;
};
/**
 * 由 Jev 答案决定会话方式
 * @param {Record<string, unknown>} answers - Jev 原始答案
 * @param {{ thread?: ThreadInfo; repeatAbove: number; sameCategoryAbove: number }} options - 候选会话与阈值
 * @returns {SessionPlan | undefined} 安排；答案缺项时为 undefined（由调用方按规则回退）
 */
export const ParseSessionPlan = (answers, options) => {
    const repeat = getNoul(answers, 'repeat');
    const sameCategory = getNoul(answers, 'same_category');
    if (repeat === undefined || (options.thread !== undefined && sameCategory === undefined) || (Object.hasOwn(answers, 'same_category') && sameCategory === undefined))
        return undefined;
    if (options.thread !== undefined && sameCategory !== undefined && sameCategory >= options.sameCategoryAbove) {
        return { kind: 'continue', threadId: options.thread.threadId, source: 'jev', reason: `同一大类任务（${sameCategory.toFixed(2)}），追加到已有会话`, sameCategory };
    }
    if (repeat >= options.repeatAbove) {
        return {
            kind: 'new', source: 'jev', repeat,
            reason: options.thread === undefined ? `同类任务还会再调用（${repeat.toFixed(2)}），开连续会话` : `与已有会话不同类（${(sameCategory ?? 0).toFixed(2)}），开新的连续会话`,
            ...(sameCategory === undefined ? {} : { sameCategory })
        };
    }
    return { kind: 'oneshot', source: 'jev', repeat, reason: `一次性工作（再次调用概率 ${repeat.toFixed(2)}）` };
};
/**
 * Jev 不可用时的规则：同一任务已有会话就追加；编辑、执行、验证、审查角色开连续会话；其余一次性
 * @param {{ role: DelegableRoleId; taskId: string; thread?: ThreadInfo; reason: string }} input - 角色、任务、候选会话与回退原因
 * @returns {SessionPlan} 安排
 */
export const getRuleSessionPlan = (input) => {
    if (input.thread !== undefined && input.thread.taskIds.includes(input.taskId)) {
        return { kind: 'continue', threadId: input.thread.threadId, source: 'rules', reason: `同一任务的后续工作，追加到已有会话（衡鉴未判断：${input.reason}）` };
    }
    if (REPEAT_ROLES.includes(input.role))
        return { kind: 'new', source: 'rules', reason: `该角色通常需要反复调用，开连续会话（衡鉴未判断：${input.reason}）` };
    return { kind: 'oneshot', source: 'rules', reason: `一次性调用（衡鉴未判断：${input.reason}）` };
};
//# sourceMappingURL=threads.js.map