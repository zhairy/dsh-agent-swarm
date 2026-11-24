import { getAgentHeader } from '../host-contract.js';
import { revalidateEvidenceAssessment } from '../evidence-assessment.js';
import { discoverProjectFiles } from '../project-discovery.js';
import { SwarmError } from '../util/errors.js';
/** Read-only project discovery and expert mailbox use cases. */
export const createQueryToolUseCases = (deps) => {
    const requireMailbox = async (raw, exec) => {
        const context = await deps.getToolTask(raw, exec);
        if (!deps.isMessageBusEnabled() || !context.features.store.durable || context.features.bus === undefined) {
            throw new SwarmError('SERVICE_UNAVAILABLE', '专家邮箱需要启用持久化与 messageBus');
        }
        if (context.binding === undefined)
            throw new SwarmError('PERMISSION_DENIED', '文件邮箱仅服务已绑定的专家，天枢不转述消息正文');
        return { ...context, bus: context.features.bus };
    };
    const ProjectFiles = async (raw, exec) => {
        const { session, binding, features, agent } = await deps.getToolTask(raw, exec);
        if (binding !== undefined)
            features.bindings.requireActive(binding.agentId, 'context-read');
        return discoverProjectFiles(deps.getCurrentCwd?.(agent) ?? getAgentHeader(session.rootAgent ?? agent).cwd ?? process.cwd(), raw, {
            privateRoots: [...deps.privateStateRoots()], signal: exec.signal
        });
    };
    const MessageSend = async (raw, exec) => {
        const { bus, agent } = await requireMailbox(raw, exec);
        return bus.send(agent.id, raw);
    };
    const MessageRead = async (raw, exec) => {
        const { bus, agent, session, task, features } = await requireMailbox(raw, exec);
        const result = await bus.pull(agent.id, raw);
        const notices = new Map();
        const evidenceNotices = await Promise.all(result.messages.map(async (message) => ({
            messageId: message.id,
            artifacts: await Promise.all(message.artifactRefs.map(async (ref) => {
                const delegationId = task.contextDelegations?.[ref];
                const record = delegationId === undefined ? undefined : session.store.getDelegation(delegationId);
                const key = delegationId ?? `unassessed:${ref}`;
                let pending = notices.get(key);
                if (pending === undefined) {
                    pending = revalidateEvidenceAssessment(deps.getBoundEvidenceAssessment(record), {
                        cwd: getAgentHeader(session.rootAgent ?? agent).cwd ?? process.cwd(), binding: deps.evidenceBinding(task, features)
                    }, { now: deps.now, privatePaths: [...deps.evidencePrivatePaths()] });
                    notices.set(key, pending);
                }
                return { ref, ...await pending };
            })),
            summaryEvidence: 'unknown', requiresVerification: true,
            reason: '材料评分只适用于原始已评估主张，不为新消息摘要背书；先核对实际材料，不能把消息当作门禁或实现依据。'
        })));
        return { ...result, evidenceNotices };
    };
    const MessageAck = async (raw, exec) => {
        const { bus, agent } = await requireMailbox(raw, exec);
        return bus.ack(agent.id, raw);
    };
    return { ProjectFiles, MessageSend, MessageRead, MessageAck };
};
//# sourceMappingURL=query-tools.js.map