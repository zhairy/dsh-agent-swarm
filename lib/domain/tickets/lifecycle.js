export const ACCEPT_MODES = ['off', 'observe', 'auto'];
const enabled = (rule, rules) => rules.includes(rule);
/** Stable projection key used by the event journal and migration manifest. */
export const getTicketStageKey = (stage) => stage.stage === 'working' || stage.stage === 'person'
    ? `${stage.stage}:${stage.action}`
    : stage.stage === 'ended' ? `ended:${stage.outcome}` : stage.stage;
/** Decide proactive admission without granting any host or workspace permission. */
export const evaluateProactiveAdmission = (request) => {
    if (request.strength === 'explicit')
        return { kind: 'accept', mandateRequired: true };
    if (request.mode === 'off')
        return { kind: 'ignore', reason: 'off-mode' };
    if (!request.hostPermitted)
        return { kind: 'ignore', reason: 'host-denied' };
    if (!request.budgetAvailable)
        return { kind: 'ignore', reason: 'budget-exhausted' };
    if (!request.matchedRules.some((rule) => enabled(rule, request.enabledRules)))
        return { kind: 'ignore', reason: 'no-matched-rule' };
    if (request.mode === 'observe')
        return { kind: 'observe', wouldAccept: true, reason: 'observe-mode' };
    return { kind: 'accept', mandateRequired: true };
};
/** A resumed or queued inferred ticket must still satisfy the current policy. */
export const revalidateMandate = (mandate, current, at) => {
    if (mandate.expiresAt !== undefined && mandate.expiresAt <= at)
        return false;
    if (mandate.strength === 'explicit')
        return true;
    return current.mode === 'auto' && mandate.matchedRules.some((rule) => enabled(rule, current.enabledRules));
};
const latest = (delegations) => [...delegations].sort((left, right) => right.startedAt - left.startedAt || right.delegationId.localeCompare(left.delegationId))[0];
const hasRunning = (delegations) => delegations.some((record) => record.status === 'running');
const hasQueued = (delegations) => delegations.some((record) => record.status === 'queued');
/** Project the existing task/delegation records into the v3.2.0 ticket lifecycle. */
export const projectTicketLifecycle = (task, delegations) => {
    const revisions = { request: task.requestRevision ?? 1, card: task.cardRevision ?? 1, workflow: task.workflowRevision ?? 1 };
    const assignmentIds = delegations.map((record) => record.delegationId);
    const active = [...delegations].reverse().find((record) => record.status === 'running' || record.status === 'queued');
    const last = latest(delegations);
    let stage;
    if (task.acceptance !== undefined) {
        const outcome = task.acceptance.decision === 'accept' ? 'accepted' : task.acceptance.decision === 'reject' ? 'rejected' : 'incomplete';
        stage = { stage: 'ended', outcome };
    }
    else if (last?.finalization === 'failed' || last?.finalization === 'cancelled')
        stage = { stage: 'person', action: 'failed' };
    else if (last?.status === 'blocked')
        stage = { stage: 'person', action: 'blocked' };
    else if (last?.status === 'failed')
        stage = { stage: 'person', action: 'failed' };
    else if (hasRunning(delegations))
        stage = { stage: 'working', action: 'running' };
    else if (hasQueued(delegations))
        stage = { stage: 'working', action: 'queued' };
    else if (last?.status === 'completed')
        stage = { stage: 'person', action: 'review' };
    else if (delegations.length > 0)
        stage = { stage: 'idle' };
    else
        stage = { stage: 'created' };
    return {
        ticketId: task.taskId,
        title: task.card.title,
        stage,
        revisions,
        assignmentIds,
        ...(active === undefined ? {} : { activeAssignmentId: active.delegationId }),
        canRetry: stage.stage === 'person' && (stage.action === 'blocked' || stage.action === 'failed')
    };
};
//# sourceMappingURL=lifecycle.js.map