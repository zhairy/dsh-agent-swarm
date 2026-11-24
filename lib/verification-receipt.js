import { randomUUID } from 'node:crypto';
import { getValueDigest } from './workflow.js';
import { ValidateStructuredOutput } from './contracts.js';
import { getSemanticCardDigest, getTaskBinding } from './task-model.js';
import { ACCEPTANCE_QUESTIONS } from './review.js';
export const RUNTIME_POLICY_VERSION = 'swarm-runtime/3.1.3-v1';
export const VERIFICATION_QUESTION_VERSION = getValueDigest(ACCEPTANCE_QUESTIONS);
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
/** 类型不防伪：只由服务的当前证据校验路径签发，调用方JSON不会进入此路径。 */
export const IssueVerificationReceipt = (binding, producerIds, at) => {
    if (!id(binding.rootSessionId) || !id(binding.taskId) || !hash(binding.workspaceId) || !['artifactDigest', 'evidenceDigest', 'decisionDigest'].every(key => hash(binding[key]))
        || ![binding.cardRevision, binding.workflowRevision, binding.requestRevision].every(value => Number.isSafeInteger(value) && value >= 1)
        || binding.policyVersion !== RUNTIME_POLICY_VERSION || !id(binding.questionVersion) || (binding.goalBinding !== undefined && !hash(binding.goalBinding)) || producerIds.length === 0 || producerIds.length > 128 || producerIds.some(value => !id(value) || value === binding.rootSessionId) || !Number.isFinite(at) || at < 0)
        throw new Error('Invalid trusted verification binding');
    return { id: 'vr-' + randomUUID(), policyVersion: RUNTIME_POLICY_VERSION, status: 'consumed', binding: structuredClone(binding), issuer: 'independent-evidence-verifier', producerIds: [...new Set(producerIds)], issuedAt: at, consumedAt: at };
};
export const ValidateVerificationReceipt = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const r = raw;
    const b = r.binding;
    return /^vr-[a-f0-9-]{36}$/.test(r.id ?? '') && r.policyVersion === RUNTIME_POLICY_VERSION && r.status === 'consumed' && r.issuer === 'independent-evidence-verifier'
        && b !== null && typeof b === 'object' && id(b.rootSessionId) && hash(b.workspaceId) && id(b.taskId) && b.policyVersion === RUNTIME_POLICY_VERSION && id(b.questionVersion)
        && [b.cardRevision, b.workflowRevision, b.requestRevision].every(value => Number.isSafeInteger(value) && value >= 1)
        && hash(b.artifactDigest) && hash(b.evidenceDigest) && hash(b.decisionDigest) && (b.goalBinding === undefined || hash(b.goalBinding))
        && Array.isArray(r.producerIds) && r.producerIds.length > 0 && r.producerIds.length <= 128 && r.producerIds.every(value => id(value) && value !== b.rootSessionId)
        && Number.isFinite(r.issuedAt) && r.issuedAt >= 0 && r.consumedAt === r.issuedAt;
};
export const IsVerificationReceiptCurrent = (raw, expected) => ValidateVerificationReceipt(raw) && getValueDigest(raw.binding) === getValueDigest(expected);
/** 验收与goal完成守卫共用的绑定投影；所有事实须由宿主重取，不能从caller JSON传入。 */
export const getTaskVerificationBinding = (input) => ({
    rootSessionId: input.task.sessionId, workspaceId: input.workspaceId, ...getTaskBinding(input.task),
    questionVersion: VERIFICATION_QUESTION_VERSION, policyVersion: RUNTIME_POLICY_VERSION,
    artifactDigest: input.artifactDigest, decisionDigest: input.decisionDigest,
    ...(input.goalBinding === undefined ? {} : { goalBinding: input.goalBinding }),
    evidenceDigest: getValueDigest({ goalId: input.task.runtimeGoalId ?? null, card: getSemanticCardDigest(input.task.card), workflow: input.task.workflowDefinition ?? null,
        nodes: input.task.workflowDefinition?.nodes.filter(node => node.operation === 'delegate').map(node => input.task.workflowState?.nodes[node.id] ?? null) ?? [],
        planningReview: input.task.planningReview ?? null, checkpoint: input.task.checkpoint ?? null,
        records: input.records, resolutions: input.resolutions, externalEditAt: input.externalEditAt, policy: input.policyDigest })
});
/** 授权答案是服务器事实；稳定排序使存储顺序不改变当前授权绑定。 */
export const getVerificationDecisionDigest = (raw, taskId) => getValueDigest(Object.values(raw !== null && typeof raw === 'object' ? raw : {}).filter(value => value !== null && typeof value === 'object' && [taskId, '@root'].includes(value.questionBinding?.taskId ?? ''))
    .sort((left, right) => String(left.id).localeCompare(String(right.id))));
/** 证明来自已登记、已提交的独立子委派；不声称输出里的测试语义一定正确。 */
export const getVerificationProducers = (task, records, saved) => {
    const committed = new Map(saved.filter(record => record.taskId === task.taskId).map(record => [record.delegationId, getValueDigest(record)]));
    return [...new Set(records.filter(record => record.status === 'completed' && record.finalization !== 'processing'
            && record.finalization !== 'cancelled' && record.finalization !== 'failed' && record.hardIsolation === true
            && typeof record.childId === 'string' && record.childId !== task.sessionId
            && committed.get(record.delegationId) === getValueDigest(record)
            && ValidateStructuredOutput(record.role, record.structured, record.mode).length === 0).map(record => record.childId))].slice(0, 128);
};
//# sourceMappingURL=verification-receipt.js.map