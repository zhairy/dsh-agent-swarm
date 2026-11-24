import { randomUUID } from 'node:crypto';
import { getValueDigest } from './workflow.js';
import { SwarmError } from './util/errors.js';
export const AUTHORIZATION_POLICY_VERSION = 1;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const id = (value) => text(value) && !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const revision = (value) => Number.isSafeInteger(value) && Number(value) > 0;
const exactKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const fail = (message) => { throw new SwarmError('INVALID_ARGS', message); };
const clone = (value) => structuredClone(value);
const sameOwner = (a, b) => ['rootSessionId', 'workspaceId', 'taskId', 'lineageId'].every(key => a[key] === b[key]);
export const ValidateAuthorizationBinding = (raw) => object(raw)
    && exactKeys(raw, ['rootSessionId', 'workspaceId', 'taskId', 'lineageId', 'requestRevision', 'cardRevision', 'workflowRevision', 'nodeId'])
    && [raw.rootSessionId, raw.workspaceId, raw.taskId, raw.lineageId].every(id)
    && [raw.requestRevision, raw.cardRevision, raw.workflowRevision].every(revision) && (raw.nodeId === undefined || id(raw.nodeId));
/** Normalize only the public ask-user schema fields; untrusted extra fields never become policy. */
export const getAuthorizationQuestions = (raw) => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8)
        return undefined;
    const questions = [];
    for (const row of raw) {
        if (!object(row) || !id(row.id) || !text(row.question, 4000) || (row.header !== undefined && (typeof row.header !== 'string' || row.header.length > 128)))
            return undefined;
        const multiSelect = row.multiSelect ?? row.multi_select;
        if (multiSelect !== undefined && typeof multiSelect !== 'boolean')
            return undefined;
        if (row.multiSelect !== undefined && row.multi_select !== undefined && row.multiSelect !== row.multi_select)
            return undefined;
        let options;
        if (row.options !== undefined) {
            if (!Array.isArray(row.options) || row.options.length < 1 || row.options.length > 16)
                return undefined;
            options = [];
            for (const option of row.options) {
                if (!object(option) || !text(option.label, 256) || (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 1000)))
                    return undefined;
                options.push({ label: option.label, ...(option.description === undefined ? {} : { description: option.description }) });
            }
            if (new Set(options.map(option => option.label)).size !== options.length)
                return undefined;
        }
        questions.push({ id: row.id, question: row.question, ...(row.header === undefined ? {} : { header: row.header }),
            ...(options === undefined ? {} : { options }), ...(multiSelect === undefined ? {} : { multiSelect }) });
    }
    if (new Set(questions.map(question => question.id)).size !== questions.length || JSON.stringify(questions).length > 24_000)
        return undefined;
    return questions;
};
const validRules = (raw, questions) => Array.isArray(raw)
    && raw.length <= questions.length && new Set(raw.map(row => object(row) ? row.questionId : undefined)).size === raw.length
    && raw.every(row => {
        if (!object(row) || !exactKeys(row, ['questionId', 'approveLabels', 'declineLabels']) || !id(row.questionId))
            return false;
        const question = questions.find(item => item.id === row.questionId);
        if (question === undefined)
            return false;
        const labels = [...(question.options ?? [])].map(option => option.label);
        return [row.approveLabels, row.declineLabels].every(values => Array.isArray(values) && values.length <= 16
            && new Set(values).size === values.length && values.every(value => typeof value === 'string' && labels.includes(value)))
            && !row.approveLabels.some(value => row.declineLabels.includes(value));
    });
export const getAuthorizationQuestionIdentities = (questions) => questions.map(question => ({
    id: question.id, optionDigests: (question.options ?? []).map(option => getValueDigest(option.label)), multiSelect: question.multiSelect === true
}));
const validIdentities = (raw) => Array.isArray(raw) && raw.length > 0 && raw.length <= 8
    && new Set(raw.map(row => object(row) ? row.id : undefined)).size === raw.length
    && raw.every(row => object(row) && exactKeys(row, ['id', 'optionDigests', 'multiSelect']) && id(row.id) && typeof row.multiSelect === 'boolean'
        && Array.isArray(row.optionDigests) && row.optionDigests.length <= 16 && row.optionDigests.every(digest) && new Set(row.optionDigests).size === row.optionDigests.length);
const validStoredRules = (raw, questions) => Array.isArray(raw)
    && raw.length <= questions.length && new Set(raw.map(row => object(row) ? row.questionId : undefined)).size === raw.length
    && raw.every(row => {
        if (!object(row) || !exactKeys(row, ['questionId', 'approveIndices', 'declineIndices']) || !id(row.questionId))
            return false;
        const question = questions.find(item => item.id === row.questionId);
        if (question === undefined)
            return false;
        return [row.approveIndices, row.declineIndices].every(values => Array.isArray(values) && values.length <= 16
            && new Set(values).size === values.length && values.every(value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < question.optionDigests.length))
            && !row.approveIndices.some(value => row.declineIndices.includes(value));
    });
const normalizeAnswers = (raw, questions) => {
    if (!Array.isArray(raw) || raw.length !== questions.length || new Set(raw.map(row => object(row) ? row.id : undefined)).size !== raw.length)
        return undefined;
    const answers = [];
    for (const question of questions) {
        const row = raw.find(item => object(item) && item.id === question.id);
        if (!object(row) || !exactKeys(row, ['id', 'selected', 'custom']) || !Array.isArray(row.selected)
            || row.selected.length > (question.multiSelect ? 16 : 1) || new Set(row.selected).size !== row.selected.length
            || row.selected.some(value => typeof value !== 'string' || !question.optionDigests.includes(getValueDigest(value)))
            || (row.custom !== undefined && (typeof row.custom !== 'string' || row.custom.length > 4000)))
            return undefined;
        answers.push({ id: question.id, selectedIndices: row.selected.map(value => question.optionDigests.indexOf(getValueDigest(value))),
            ...(typeof row.custom !== 'string' || row.custom.trim() === '' ? {} : { customDigest: getValueDigest(row.custom) }) });
    }
    return answers;
};
const validOrigin = (raw) => object(raw) && exactKeys(raw, ['kind', 'callId', 'messageId'])
    && ['tool-result', 'user-question-reply'].includes(String(raw.kind)) && id(raw.callId) && (raw.messageId === undefined || id(raw.messageId));
const answerPhase = (answers, rules) => {
    if (answers.some(answer => answer.selectedIndices.some(index => rules.find(rule => rule.questionId === answer.id)?.declineIndices.includes(index))))
        return 'declined';
    return answers.every(answer => answer.selectedIndices.length > 0 && answer.customDigest === undefined
        && answer.selectedIndices.every(index => rules.find(rule => rule.questionId === answer.id)?.approveIndices.includes(index))) ? 'approved' : 'answered';
};
export const getAuthorizationDedupKey = (input) => getValueDigest({
    rootSessionId: input.binding.rootSessionId, workspaceId: input.binding.workspaceId, taskId: input.binding.taskId,
    lineageId: input.binding.lineageId, operationDigest: input.operationDigest, scopeDigest: input.scopeDigest, policyVersion: AUTHORIZATION_POLICY_VERSION
});
const phases = ['prepared', 'waiting', 'reconcile-required', 'answered', 'approved', 'declined', 'cancelled', 'invalidated', 'unavailable'];
export const isAuthorizationWaiting = (decision) => ['prepared', 'waiting', 'reconcile-required', 'unavailable'].includes(decision.phase);
export const isAuthorizationApplicable = (decision, binding, operationDigest, scopeDigest) => decision.phase === 'approved' && decision.policyVersion === AUTHORIZATION_POLICY_VERSION && decision.operationDigest === operationDigest
    && decision.scopeDigest === scopeDigest && decision.appliesToBinding !== undefined && getValueDigest(decision.appliesToBinding) === getValueDigest(binding);
/** Strict persisted-record validation; the outer FeatureState validator also checks task ownership. */
export const ValidateAuthorizationDecision = (raw) => {
    if (!object(raw) || !exactKeys(raw, ['id', 'policyVersion', 'dedupKey', 'questionBinding', 'operationDigest', 'scopeDigest', 'questions', 'questionDigest', 'approvalRules',
        'phase', 'decisionRevision', 'createdAt', 'updatedAt', 'hostCallId', 'answerDigest', 'answers', 'answerOrigin', 'appliesToBinding', 'reason'])
        || !id(raw.id) || raw.policyVersion !== AUTHORIZATION_POLICY_VERSION || !ValidateAuthorizationBinding(raw.questionBinding)
        || ![raw.dedupKey, raw.operationDigest, raw.scopeDigest, raw.questionDigest].every(digest) || !revision(raw.decisionRevision)
        || !phases.includes(raw.phase) || !Number.isFinite(raw.createdAt) || Number(raw.createdAt) < 0
        || !Number.isFinite(raw.updatedAt) || Number(raw.updatedAt) < Number(raw.createdAt)
        || (raw.hostCallId !== undefined && !id(raw.hostCallId)) || (raw.reason !== undefined && !text(raw.reason, 1000)))
        return false;
    if (!validIdentities(raw.questions) || !validStoredRules(raw.approvalRules, raw.questions)
        || getAuthorizationDedupKey({ binding: raw.questionBinding, operationDigest: raw.operationDigest, scopeDigest: raw.scopeDigest }) !== raw.dedupKey)
        return false;
    const identities = raw.questions;
    const hasAnswer = raw.answers !== undefined || raw.answerDigest !== undefined || raw.answerOrigin !== undefined || raw.appliesToBinding !== undefined;
    if (hasAnswer) {
        if (!['answered', 'approved', 'declined', 'cancelled', 'invalidated'].includes(String(raw.phase)))
            return false;
        const answers = raw.answers;
        if (!Array.isArray(answers) || answers.length !== raw.questions.length || new Set(answers.map(row => object(row) ? row.id : undefined)).size !== answers.length
            || answers.some(row => {
                const question = object(row) ? identities.find(item => item.id === row.id) : undefined;
                return !object(row) || !exactKeys(row, ['id', 'selectedIndices', 'customDigest']) || question === undefined
                    || !Array.isArray(row.selectedIndices) || row.selectedIndices.length > (question.multiSelect ? 16 : 1)
                    || new Set(row.selectedIndices).size !== row.selectedIndices.length || row.selectedIndices.some(value => !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= question.optionDigests.length)
                    || (row.customDigest !== undefined && !digest(row.customDigest));
            }) || !digest(raw.answerDigest) || raw.answerDigest !== getValueDigest(answers) || !validOrigin(raw.answerOrigin)
            || raw.answerOrigin.callId !== raw.hostCallId || !ValidateAuthorizationBinding(raw.appliesToBinding)
            || !sameOwner(raw.questionBinding, raw.appliesToBinding)
            || raw.appliesToBinding.requestRevision < raw.questionBinding.requestRevision
            || raw.appliesToBinding.cardRevision !== raw.questionBinding.cardRevision || raw.appliesToBinding.workflowRevision !== raw.questionBinding.workflowRevision
            || (['approved', 'declined', 'answered'].includes(String(raw.phase)) && answerPhase(answers, raw.approvalRules) !== raw.phase))
            return false;
    }
    return (!['answered', 'approved', 'declined'].includes(String(raw.phase)) || hasAnswer)
        && (!['waiting', 'answered', 'approved', 'declined'].includes(String(raw.phase)) || id(raw.hostCallId));
};
/** Pure reducer: only verified host observations may be supplied by the server adapter. */
export const reduceAuthorizationDecision = (record, event, at) => {
    if (!ValidateAuthorizationDecision(record) || !Number.isFinite(at) || at < 0)
        return fail('授权记录或时间无效');
    const change = (patch) => ({ ...clone(record), ...patch, decisionRevision: record.decisionRevision + 1, updatedAt: Math.max(at, record.updatedAt) });
    if (event.type === 'cancel' || event.type === 'invalidate') {
        if (!text(event.reason, 1000))
            return fail('授权撤销原因必须明确且有界');
        const phase = event.type === 'cancel' ? 'cancelled' : 'invalidated';
        return record.phase === phase ? clone(record) : change({ phase, reason: event.reason });
    }
    if (event.type === 'dispatch-unknown' || event.type === 'unavailable') {
        if (!text(event.reason, 1000))
            return fail('授权恢复原因必须明确且有界');
        if (!isAuthorizationWaiting(record))
            return clone(record);
        const phase = event.type === 'unavailable' ? 'unavailable' : 'reconcile-required';
        return record.phase === phase && record.reason === event.reason ? clone(record) : change({ phase, reason: event.reason });
    }
    if (event.type === 'dispatch-known') {
        if (!id(event.callId) || event.questionDigest !== record.questionDigest)
            return fail('真实问答身份或问题合同不匹配');
        if (record.hostCallId !== undefined && record.hostCallId !== event.callId)
            throw new SwarmError('RECOVERY_REQUIRED', '同一用户决定已绑定另一问答，禁止重复提问');
        if (!isAuthorizationWaiting(record))
            return clone(record);
        return record.phase === 'waiting' && record.hostCallId === event.callId ? clone(record) : change({ phase: 'waiting', hostCallId: event.callId });
    }
    if (event.type !== 'answer')
        return fail('未知授权状态事件');
    const input = event.input;
    if (!ValidateAuthorizationBinding(input.binding) || !sameOwner(record.questionBinding, input.binding)
        || input.operationDigest !== record.operationDigest || input.scopeDigest !== record.scopeDigest
        || input.binding.requestRevision < record.questionBinding.requestRevision
        || input.binding.cardRevision !== record.questionBinding.cardRevision || input.binding.workflowRevision !== record.questionBinding.workflowRevision
        || !validOrigin(input.origin) || input.callId !== record.hostCallId || input.origin.callId !== input.callId)
        throw new SwarmError('STALE_EVIDENCE', '用户答复与当前操作、范围或原问题绑定不一致');
    const answers = normalizeAnswers(input.answers, record.questions);
    if (answers === undefined)
        return fail('用户答复的问题、选项或答案格式不合法');
    const answerDigest = getValueDigest(answers);
    if (record.phase === 'cancelled' || record.phase === 'invalidated')
        throw new SwarmError('STALE_EVIDENCE', '授权已取消或失效，迟到答复不能恢复动作');
    if (record.answerDigest !== undefined) {
        if (record.answerDigest !== answerDigest)
            throw new SwarmError('STALE_EVIDENCE', '同一问答已有不同的真实答复，请核对当前决定');
        return clone(record);
    }
    if (!isAuthorizationWaiting(record) || record.hostCallId === undefined)
        throw new SwarmError('RECOVERY_REQUIRED', '真实提问尚未绑定，不能消费用户答复');
    return change({ phase: answerPhase(answers, record.approvalRules), answers,
        answerDigest, answerOrigin: clone(input.origin), appliesToBinding: clone(input.binding) });
};
export const createAuthorizationRepository = (store, options = {}) => {
    const now = options.now ?? Date.now, maxEntries = options.maxEntries ?? 128, maxPerTask = options.maxPerTask ?? 64;
    if (![maxEntries, maxPerTask].every(value => Number.isSafeInteger(value) && value > 0) || maxEntries > 128 || maxPerTask > 64)
        return fail('授权记录容量配置超出安全范围');
    let cachedSequence = -1, cache = {};
    const entries = () => {
        const sequence = store.getSequence();
        if (cachedSequence !== sequence) {
            const current = (store.readFields === undefined ? store.read().authorizationDecisions : store.readFields(['authorizationDecisions']).authorizationDecisions) ?? {};
            if (!object(current) || Object.entries(current).some(([key, value]) => !ValidateAuthorizationDecision(value) || value.id !== key))
                throw new SwarmError('RECOVERY_REQUIRED', '授权状态不可验证，请通过受支持入口核对');
            cache = current;
            cachedSequence = sequence;
        }
        return cache;
    };
    const update = async (decisionId, event) => {
        let result;
        await store.update(`authorization/${event.type}`, { build: (state) => {
                const current = state.authorizationDecisions?.[decisionId];
                if (current === undefined)
                    throw new SwarmError('RECOVERY_REQUIRED', '授权决定不存在，不能猜测历史许可');
                result = reduceAuthorizationDecision(current, event, now());
                return { set: { authorizationDecisions: { [decisionId]: result } } };
            } });
        cachedSequence = -1;
        return clone(result);
    };
    return {
        get: (decisionId) => { const value = entries()[decisionId]; return value === undefined ? undefined : clone(value); },
        forTask: (taskId, rootSessionId) => Object.values(entries()).filter(value => value.questionBinding.taskId === taskId
            && (rootSessionId === undefined || value.questionBinding.rootSessionId === rootSessionId)).map(clone),
        prepare: async (input) => {
            const questions = getAuthorizationQuestions(input.questions), rules = input.approvalRules ?? [];
            if (input.requiresUserDecision !== true || !ValidateAuthorizationBinding(input.binding) || !digest(input.operationDigest) || !digest(input.scopeDigest)
                || questions === undefined || !validRules(rules, questions))
                return fail('只为实际缺少的用户决定登记有效操作、范围与问题');
            const at = now(), dedupKey = getAuthorizationDedupKey(input);
            let result, reused = false;
            await store.update('authorization/prepare', { build: (state) => {
                    const all = Object.values(state.authorizationDecisions ?? {});
                    // 已取消或作废的决定没有可沿用的答复：同一问题可以重新询问。
                    const previous = all.find(value => value.dedupKey === dedupKey && !['cancelled', 'invalidated'].includes(value.phase));
                    if (previous !== undefined) {
                        result = clone(previous);
                        reused = true;
                        return {};
                    }
                    const sameBinding = (value) => value.questionBinding.taskId === input.binding.taskId
                        && value.questionBinding.rootSessionId === input.binding.rootSessionId && value.questionBinding.workspaceId === input.binding.workspaceId;
                    // 容量满时只回收调用方允许的、已答复（answered/approved）的最旧决定：等待中的决定绝不回收；
                    // 取消、作废与拒绝的记录要留着拦截迟到答复并阻止重问被拒的问题。单任务超限只回收同一任务的决定。
                    const reclaimed = new Set();
                    const live = () => all.filter(value => !reclaimed.has(value.id));
                    for (;;) {
                        const totalOver = live().length >= maxEntries, taskOver = live().filter(sameBinding).length >= maxPerTask;
                        if (!totalOver && !taskOver)
                            break;
                        const candidate = live().filter(value => ['answered', 'approved'].includes(value.phase) && (!taskOver || sameBinding(value)) && options.canReclaim?.(clone(value)) === true)
                            .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))[0];
                        if (candidate === undefined)
                            break;
                        reclaimed.add(candidate.id);
                    }
                    const kept = live();
                    if (kept.length >= maxEntries || kept.filter(sameBinding).length >= maxPerTask)
                        throw new SwarmError('CAPACITY_EXCEEDED', '授权记录容量已满；保留旧决定并经受支持的归档/核对入口处理，不重复询问或制造批准');
                    result = { id: options.id?.() ?? `auth-${randomUUID()}`, policyVersion: AUTHORIZATION_POLICY_VERSION, dedupKey, questionBinding: clone(input.binding),
                        operationDigest: input.operationDigest, scopeDigest: input.scopeDigest, questions: getAuthorizationQuestionIdentities(questions), questionDigest: getValueDigest(questions),
                        approvalRules: rules.map(rule => ({ questionId: rule.questionId,
                            approveIndices: rule.approveLabels.map(label => questions.find(question => question.id === rule.questionId).options.findIndex(option => option.label === label)),
                            declineIndices: rule.declineLabels.map(label => questions.find(question => question.id === rule.questionId).options.findIndex(option => option.label === label)) })),
                        phase: 'prepared', decisionRevision: 1, createdAt: at, updatedAt: at };
                    if (!ValidateAuthorizationDecision(result) || kept.some(value => value.id === result.id))
                        return fail('授权决定身份无效或重复');
                    return { set: { authorizationDecisions: { [result.id]: result } }, ...(reclaimed.size === 0 ? {} : { remove: { authorizationDecisions: [...reclaimed] } }) };
                } });
            cachedSequence = -1;
            return { decision: clone(result), reused };
        },
        dispatchKnown: (decisionId, input) => update(decisionId, { type: 'dispatch-known', ...input }),
        dispatchUnknown: (decisionId, reason) => update(decisionId, { type: 'dispatch-unknown', reason }),
        consumeAnswer: (decisionId, input) => update(decisionId, { type: 'answer', input }),
        unavailable: (decisionId, reason) => update(decisionId, { type: 'unavailable', reason }),
        invalidate: (decisionId, reason) => update(decisionId, { type: 'invalidate', reason }),
        cancel: (decisionId, reason) => update(decisionId, { type: 'cancel', reason })
    };
};
//# sourceMappingURL=authorization-wait.js.map