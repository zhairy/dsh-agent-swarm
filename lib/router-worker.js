import { PRIMARY_WORKSPACE_TOOL, RESTORE_WORKTREE_TOOL, VERIFICATION_OUTPUT_TOOL, WORKSPACE_GIT_SAVE_TOOL, WORKTREE_TOOL } from './worktree-binding.js';
export const EVENT_FILTER_REASONS = ['duplicate', 'self-echo', 'ignored-kind', 'stale-request-revision', 'stale-card-revision', 'stale-workflow-revision', 'stale-lease'];
/** Filter host events before they can mutate a ticket or start a model call. */
export const filterEvent = (input) => {
    const keys = [input.eventId, input.idempotencyKey].filter((key) => key !== undefined && key !== '');
    if (keys.some((key) => input.seen.has(key)))
        return { accepted: false, reason: 'duplicate' };
    if (input.senderAgentId !== undefined && input.senderAgentId === input.rootAgentId)
        return { accepted: false, reason: 'self-echo' };
    if (input.ignoredKinds?.includes(input.kind) === true)
        return { accepted: false, reason: 'ignored-kind' };
    if (input.requestRevision !== input.current.requestRevision)
        return { accepted: false, reason: 'stale-request-revision' };
    if (input.cardRevision !== input.current.cardRevision)
        return { accepted: false, reason: 'stale-card-revision' };
    if (input.workflowRevision !== input.current.workflowRevision)
        return { accepted: false, reason: 'stale-workflow-revision' };
    if (input.leaseEpoch !== input.current.leaseEpoch)
        return { accepted: false, reason: 'stale-lease' };
    return { accepted: true };
};
export const ROUTER_DENIED_TOOLS = new Set([
    'write', 'edit', 'apply_patch', 'shell_write', 'swarm_book_write', 'git_commit', 'deploy', 'publish'
]);
/** 天枢默认不应在模型工具清单中看到的执行、写入与可写工作树能力。 */
export const ROUTER_HIDDEN_MODEL_TOOLS = Object.freeze([
    'bash', 'pwsh', 'run_code', 'swarm_kernel_execute', 'write', 'edit', 'apply_patch', 'nb_save',
    WORKTREE_TOOL, 'enter_worktree', 'exit_worktree',
    RESTORE_WORKTREE_TOOL, PRIMARY_WORKSPACE_TOOL, WORKSPACE_GIT_SAVE_TOOL, VERIFICATION_OUTPUT_TOOL
]);
/** DSH 的 PTC 传输名由执行器保留，不能被 tools.restrict() 过滤。 */
export const ROUTER_RESERVED_TRANSPORT_TOOLS = Object.freeze(['run_code']);
/**
 * 计算天枢当前步骤的模型可见工具边界。
 *
 * 非 human 顶层轮次（例如 goal round）隐藏 create_goal；直接 human 轮次保留，
 * 但命令、文件写入和可写工作树能力始终由 Worker 执行。run_code 是 PTC 保留传输，
 * 不能传给 tools.restrict()，由调用方在真实出现时 fail closed。
 */
export const getRouterToolVisibility = (visibleNames, directHumanTurn, workspaceWritesAllowed = false) => {
    const visible = new Set(visibleNames);
    const hidden = ROUTER_HIDDEN_MODEL_TOOLS.filter((name) => visible.has(name)
        && !(workspaceWritesAllowed && ['bash', 'pwsh', 'write', 'edit', 'apply_patch'].includes(name)));
    const deny = hidden.filter((name) => !ROUTER_RESERVED_TRANSPORT_TOOLS.includes(name));
    if (!directHumanTurn && visible.has('create_goal'))
        deny.push('create_goal');
    return {
        deny,
        reservedTransport: hidden.filter((name) => ROUTER_RESERVED_TRANSPORT_TOOLS.includes(name))
    };
};
/** The router may route and read evidence; host denial and writes stay with workers. */
export const getRouterToolDenial = (toolName, argumentsValue) => {
    if (ROUTER_DENIED_TOOLS.has(toolName))
        return `router cannot execute ${toolName}`;
    if (toolName === 'bash' && argumentsValue !== null && typeof argumentsValue === 'object') {
        const command = argumentsValue.command;
        if (typeof command === 'string' && /(^|[;&|]\s*)(sleep\s+[1-9]|\S*timeout\s+[3-9][1-9]\d*)/i.test(command))
            return 'router cannot block on a long wait';
    }
    return undefined;
};
export const ValidateAssignmentEnvelope = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const envelope = value;
    return typeof envelope.ticketId === 'string' && envelope.ticketId.length > 0 && envelope.ticketId.length <= 128
        && typeof envelope.assignmentId === 'string' && envelope.assignmentId.length > 0 && envelope.assignmentId.length <= 128
        && typeof envelope.role === 'string' && envelope.role.length > 0 && envelope.role.length <= 64
        && ['expert', 'native-codex', 'native-claude'].includes(String(envelope.workerKind))
        && typeof envelope.provider === 'string' && envelope.provider.length > 0 && envelope.provider.length <= 128
        && typeof envelope.model === 'string' && envelope.model.length > 0 && envelope.model.length <= 256
        && (envelope.reasoningEffort === undefined || (typeof envelope.reasoningEffort === 'string' && envelope.reasoningEffort.length <= 64))
        && [envelope.requestRevision, envelope.cardRevision, envelope.workflowRevision, envelope.leaseEpoch].every((item) => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0)
        && typeof envelope.inputDigest === 'string' && /^[a-f0-9]{64}$/i.test(envelope.inputDigest)
        && Array.isArray(envelope.permissions) && envelope.permissions.length <= 256 && envelope.permissions.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 128)
        && typeof envelope.createdAt === 'number' && Number.isFinite(envelope.createdAt);
};
export const validateWorkerSubmission = (envelope, submission) => {
    if (submission.ticketId !== envelope.ticketId)
        return { accepted: false, reason: 'ticket-mismatch' };
    if (submission.assignmentId !== envelope.assignmentId)
        return { accepted: false, reason: 'assignment-mismatch' };
    if (submission.requestRevision !== envelope.requestRevision)
        return { accepted: false, reason: 'stale-request-revision' };
    if (submission.cardRevision !== envelope.cardRevision)
        return { accepted: false, reason: 'stale-card-revision' };
    if (submission.workflowRevision !== envelope.workflowRevision)
        return { accepted: false, reason: 'stale-workflow-revision' };
    if (submission.leaseEpoch !== envelope.leaseEpoch)
        return { accepted: false, reason: 'stale-lease' };
    if (submission.inputDigest !== envelope.inputDigest)
        return { accepted: false, reason: 'input-mismatch' };
    return { accepted: true };
};
//# sourceMappingURL=router-worker.js.map