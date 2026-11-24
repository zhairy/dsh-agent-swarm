import { randomUUID } from 'node:crypto';
import { getValueDigest } from './workflow.js';
import { getAuthorizationQuestions, ValidateAuthorizationDecision } from './authorization-wait.js';
const object = (raw) => raw !== null && typeof raw === 'object' && !Array.isArray(raw);
const id = (raw) => typeof raw === 'string' && raw.trim() !== '' && raw.length <= 512 && !/[\u0000-\u001f\u007f]/.test(raw);
const parse = (raw) => {
    if (typeof raw !== 'string' || raw.length > 32_000)
        return undefined;
    try {
        const value = JSON.parse(raw);
        return object(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
};
const payloadOf = (raw) => {
    if (!Array.isArray(raw) || raw.length !== 1 || !object(raw[0]) || raw[0].type !== 'text')
        return undefined;
    return parse(raw[0].text);
};
const answersOf = (raw, decision) => {
    if (!Array.isArray(raw) || raw.length !== decision.questions.length || new Set(raw.map(row => object(row) ? row.id : undefined)).size !== raw.length)
        return undefined;
    const answers = [];
    for (const question of decision.questions) {
        const row = raw.find(value => object(value) && value.id === question.id);
        if (!object(row) || !Array.isArray(row.selected) || row.selected.length > (question.multiSelect ? 16 : 1)
            || new Set(row.selected).size !== row.selected.length || row.selected.some(value => typeof value !== 'string' || !question.optionDigests.includes(getValueDigest(value)))
            || (row.custom !== undefined && (typeof row.custom !== 'string' || row.custom.length > 4000)))
            return undefined;
        answers.push({ id: question.id, selected: [...row.selected], ...(row.custom === undefined ? {} : { custom: row.custom }) });
    }
    return answers;
};
const goalValid = (value) => id(value.id) && Number.isSafeInteger(value.revision) && value.revision > 0
    && ['active', 'paused', 'blocked', 'complete'].includes(value.phase) && ['armed', 'disarmed'].includes(value.activation)
    && Number.isSafeInteger(value.roundsStarted) && value.roundsStarted >= 0 && Number.isSafeInteger(value.maxGoalRounds) && value.maxGoalRounds > 0;
/** Observations are server-only. No method issues a question or grants Host tool approval. */
export const createAuthorizationHostAdapter = (options) => {
    const holds = new Map();
    // One outstanding late input per decision. Values contain IDs/hashes, never answer text.
    const admittedInputs = new Map();
    const live = (agent) => {
        try {
            return options.isLiveRoot(agent);
        }
        catch {
            return false;
        }
    };
    const unsupported = (agent, reason) => {
        options.logger?.warn(`授权宿主适配不可用：agent=${agent.id} reason=${reason}`);
        return { supported: false, reason };
    };
    const observeReply = (decision, raw) => {
        if (!ValidateAuthorizationDecision(decision) || decision.hostCallId === undefined || !object(raw) || !id(raw.id)
            || (raw.role !== undefined && raw.role !== 'user') || !object(raw.source)
            || raw.source.kind !== 'user-question-reply' || raw.source.outcome !== 'answered' || raw.source.callId !== decision.hostCallId)
            return undefined;
        const payload = payloadOf(raw.content);
        if (payload?.kind !== 'answer_to_pending_question' || payload.tool !== 'ask_user_question' || payload.callId !== decision.hostCallId)
            return undefined;
        const questions = getAuthorizationQuestions(payload.questions);
        if (questions === undefined || getValueDigest(questions) !== decision.questionDigest)
            return undefined;
        const answers = answersOf(payload.answers, decision);
        if (answers === undefined)
            return undefined;
        return { kind: 'answer', callId: decision.hostCallId, messageId: raw.id, answers, answerDigest: getValueDigest(answers),
            origin: { kind: 'user-question-reply', callId: decision.hostCallId, messageId: raw.id } };
    };
    return {
        observeCall: (execution, nodeId) => {
            if (execution.name !== 'ask_user_question' || !id(execution.callId) || execution.agent === undefined || !live(execution.agent)
                || !object(execution.arguments) || (nodeId !== undefined && !id(nodeId)))
                return undefined;
            const questions = getAuthorizationQuestions(execution.arguments.questions);
            if (questions === undefined)
                return undefined;
            return { callId: execution.callId, rootSessionId: execution.agent.id, questions, questionDigest: getValueDigest(questions), ...(nodeId === undefined ? {} : { nodeId }) };
        },
        /** Use the final tools/result observer. Around-dispatch results may still be denied by post-policy. */
        observeResult: (decision, execution, result) => {
            const callId = decision.hostCallId ?? '';
            const unknown = (reason) => ({ kind: 'unknown', callId, reason });
            if (!ValidateAuthorizationDecision(decision) || execution.name !== 'ask_user_question' || execution.callId !== callId
                || execution.agent === undefined || execution.agent.id !== decision.questionBinding.rootSessionId || !live(execution.agent) || !object(result))
                return unknown('host-call-or-owner-mismatch');
            if (result.isError === true) {
                const error = object(result.error) ? result.error : undefined;
                const info = object(error?.info) ? error.info : undefined;
                const code = info?.code ?? error?.code;
                if (code === 'ASK_ABORTED' || code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH')
                    return { kind: 'cancelled', callId, reason: 'host-question-cancelled' };
                if (code === 'NO_PROVIDER' || code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER')
                    return { kind: 'unavailable', callId, reason: 'host-answer-channel-unavailable' };
                return unknown('host-question-failed-or-outcome-unknown');
            }
            const payload = payloadOf(result.content);
            if (payload?.pending === true && payload.callId === callId)
                return { kind: 'pending', callId };
            const answers = answersOf(payload?.answers, decision);
            return answers === undefined ? unknown('host-answer-result-unverifiable') : { kind: 'answer', callId, answers, origin: { kind: 'tool-result', callId } };
        },
        observeReply,
        /** Allows input consumption once; it does not approve the decision before Session admission. */
        observePendingReply: (agent, decision, messages) => {
            if (!live(agent) || agent.id !== decision.questionBinding.rootSessionId || admittedInputs.has(decision.id)
                || !['waiting', 'reconcile-required', 'unavailable'].includes(decision.phase))
                return undefined;
            for (const message of messages) {
                const reply = observeReply(decision, message);
                if (reply === undefined)
                    continue;
                if (admittedInputs.size >= 128)
                    return undefined;
                admittedInputs.set(decision.id, { messageId: reply.messageId, answerDigest: reply.answerDigest });
                return reply;
            }
            return undefined;
        },
        /** A failed admission can be retried only after the service reconciles the same Host message. */
        releasePendingReply: (decisionId, messageId) => {
            if (admittedInputs.get(decisionId)?.messageId !== messageId)
                return false;
            return admittedInputs.delete(decisionId);
        },
        getQuestions: (agent) => {
            const unavailable = (reason) => ({ supported: false, active: [], settledCallIds: [], reason });
            if (!live(agent) || agent.session === undefined)
                return unavailable('not-live-root');
            try {
                let raw = options.projections?.stateOf(agent.session, 'userQuestions');
                let partial = false;
                if (raw === undefined && options.userQuestions?.continued !== undefined) {
                    raw = { questions: { active: [...options.userQuestions.continued(agent)], settled: [] } };
                    partial = true;
                }
                if (!object(raw) || !object(raw.questions) || !Array.isArray(raw.questions.active) || !Array.isArray(raw.questions.settled))
                    return unavailable('question-projection-unavailable');
                const active = [];
                for (const row of raw.questions.active) {
                    if (!object(row) || !id(row.callId) || !['open', 'continued'].includes(String(row.state)))
                        return unavailable('question-projection-invalid');
                    const questions = getAuthorizationQuestions(row.questions);
                    if (questions === undefined)
                        return unavailable('question-projection-invalid');
                    active.push({ callId: row.callId, state: row.state, questionDigest: getValueDigest(questions) });
                }
                if (active.length > 128 || raw.questions.settled.some(row => !object(row) || !id(row.callId)))
                    return unavailable('question-projection-capacity-or-format');
                return { supported: true, active, settledCallIds: raw.questions.settled.slice(-128).map(row => row.callId),
                    ...(partial || raw.questions.settled.length > 128 ? { partial: true } : {}) };
            }
            catch {
                options.logger?.warn(`授权问题投影读取失败：agent=${agent.id}`);
                return unavailable('question-projection-read-failed');
            }
        },
        disarmForWait: (agent) => {
            if (!live(agent) || options.goals?.get === undefined || options.goals.disarm === undefined)
                return unsupported(agent, 'public-goal-suppression-unavailable');
            try {
                const goal = options.goals.get(agent);
                if (goal !== undefined && !goalValid(goal))
                    return unsupported(agent, 'public-goal-state-invalid');
                const previous = holds.get(agent.id);
                if (previous !== undefined && previous.goalId === goal?.id && previous.goalRevision === goal?.revision)
                    return { supported: true, hold: { ...previous } };
                const hold = { holdId: randomUUID(), rootSessionId: agent.id, ...(goal === undefined ? {} : { goalId: goal.id, goalRevision: goal.revision }), ownedDisarm: goal?.phase === 'active' && goal.activation === 'armed' };
                if (hold.ownedDisarm) {
                    options.goals.disarm(agent);
                    const stopped = options.goals.get(agent);
                    if (stopped?.id !== goal.id || stopped.revision !== goal.revision || stopped.phase !== 'active' || stopped.activation !== 'disarmed')
                        return unsupported(agent, 'public-goal-disarm-unconfirmed');
                }
                holds.set(agent.id, hold);
                return { supported: true, hold: { ...hold } };
            }
            catch {
                return unsupported(agent, 'public-goal-suppression-failed');
            }
        },
        /** Call on user cancellation, aborted lifecycle, goal replacement, or disposal. */
        invalidateHeldGoal: (rootSessionId) => { holds.delete(rootSessionId); },
        /** Root calls only after authentic answer consumption; never resume a user-paused/blocked goal. */
        resumeAfterAnswer: (agent, hold, decision) => {
            const currentHold = holds.get(agent.id);
            if (!live(agent) || currentHold?.holdId !== hold.holdId || !currentHold.ownedDisarm || !ValidateAuthorizationDecision(decision)
                || !['answered', 'approved'].includes(decision.phase) || decision.answerOrigin === undefined || decision.questionBinding.rootSessionId !== agent.id)
                return { resumed: false, reason: 'answer-or-owned-wait-not-current' };
            try {
                const current = options.goals?.get(agent);
                if (current?.id !== hold.goalId || current?.revision !== hold.goalRevision || current?.phase !== 'active' || current.activation !== 'disarmed'
                    || current.roundsStarted >= current.maxGoalRounds || options.goals?.resume === undefined)
                    return { resumed: false, reason: 'goal-changed-stopped-exhausted-or-resume-unsupported' };
                // Delete before a reentrant Host event; an uncertain outcome must be reconciled, never retried blindly.
                holds.delete(agent.id);
                const resumed = options.goals.resume(agent, { id: current.id, revision: current.revision });
                return resumed.id === current.id && resumed.phase === 'active' && resumed.activation === 'armed'
                    ? { resumed: true, reason: 'verified-answer-resumed-owned-wait' } : { resumed: false, reason: 'host-resume-outcome-unconfirmed' };
            }
            catch {
                options.logger?.warn(`授权答复后的目标恢复需核对：agent=${agent.id}`);
                return { resumed: false, reason: 'host-resume-failed-reconcile-required' };
            }
        }
    };
};
//# sourceMappingURL=authorization-host.js.map