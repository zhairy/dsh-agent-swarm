import { getAgentHeader, type AgentLike } from '../host-contract.js'
import type { DelegationRecord, TaskRecord } from '../evidence.js'
import type { FeatureSession } from '../feature-session.js'
import type { SwarmService } from './service-api.js'
import type { ToolExecLike } from '../tool-shape.js'
import { revalidateEvidenceAssessment, type EvidenceAssessment, type EvidenceAssessmentBinding } from '../evidence-assessment.js'
import { discoverProjectFiles } from '../project-discovery.js'
import { SwarmError } from '../util/errors.js'

export interface QueryBindingPort {
  agentId: string
  blindReview?: boolean
}

export interface QuerySessionPort {
  rootAgent?: AgentLike
  store: { getDelegation: (delegationId: string) => DelegationRecord | undefined }
}

export interface QueryTaskContext {
  session: QuerySessionPort
  features: FeatureSession
  task: TaskRecord
  agent: AgentLike
  binding?: QueryBindingPort
}

export interface QueryToolDeps {
  getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<QueryTaskContext>
  privateStateRoots: () => readonly string[]
  evidencePrivatePaths: () => readonly string[]
  getBoundEvidenceAssessment: (record: DelegationRecord | undefined) => EvidenceAssessment | undefined
  evidenceBinding: (task: TaskRecord, features: FeatureSession) => EvidenceAssessmentBinding
  now: () => number
  isMessageBusEnabled: () => boolean
}

export type QueryToolUseCases = Pick<SwarmService, 'ProjectFiles' | 'MessageSend' | 'MessageRead' | 'MessageAck'>

/** Read-only project discovery and expert mailbox use cases. */
export const createQueryToolUseCases = (deps: QueryToolDeps): QueryToolUseCases => {
  const requireMailbox = async (raw: unknown, exec: ToolExecLike) => {
    const context = await deps.getToolTask(raw, exec)
    if (!deps.isMessageBusEnabled() || !context.features.store.durable || context.features.bus === undefined) {
      throw new SwarmError('SERVICE_UNAVAILABLE', '专家邮箱需要启用持久化与 messageBus')
    }
    if (context.binding === undefined) throw new SwarmError('PERMISSION_DENIED', '文件邮箱仅服务已绑定的专家，天枢不转述消息正文')
    return { ...context, bus: context.features.bus }
  }

  const ProjectFiles: QueryToolUseCases['ProjectFiles'] = async (raw, exec) => {
    const { session, binding, features } = await deps.getToolTask(raw, exec)
    if (binding !== undefined) features.bindings.requireActive(binding.agentId, 'context-read')
    return discoverProjectFiles(getAgentHeader(session.rootAgent ?? exec.agent).cwd ?? process.cwd(), raw as Parameters<typeof discoverProjectFiles>[1], {
      privateRoots: [...deps.privateStateRoots()], signal: exec.signal
    })
  }

  const MessageSend: QueryToolUseCases['MessageSend'] = async (raw, exec) => {
    const { bus, agent } = await requireMailbox(raw, exec)
    return bus.send(agent.id, raw as Parameters<typeof bus.send>[1])
  }

  const MessageRead: QueryToolUseCases['MessageRead'] = async (raw, exec) => {
    const { bus, agent, session, task, features } = await requireMailbox(raw, exec)
    const result = await bus.pull(agent.id, raw as Parameters<typeof bus.pull>[1])
    const notices = new Map<string, ReturnType<typeof revalidateEvidenceAssessment>>()
    const evidenceNotices = await Promise.all(result.messages.map(async (message) => ({
      messageId: message.id,
      artifacts: await Promise.all(message.artifactRefs.map(async (ref) => {
        const delegationId = task.contextDelegations?.[ref]
        const record = delegationId === undefined ? undefined : session.store.getDelegation(delegationId)
        const key = delegationId ?? `unassessed:${ref}`
        let pending = notices.get(key)
        if (pending === undefined) {
          pending = revalidateEvidenceAssessment(deps.getBoundEvidenceAssessment(record), {
            cwd: getAgentHeader(session.rootAgent ?? agent).cwd ?? process.cwd(), binding: deps.evidenceBinding(task, features)
          }, { now: deps.now, privatePaths: [...deps.evidencePrivatePaths()] })
          notices.set(key, pending)
        }
        return { ref, ...await pending }
      })),
      summaryEvidence: 'unknown', requiresVerification: true,
      reason: '材料评分只适用于原始已评估主张，不为新消息摘要背书；先核对实际材料，不能把消息当作门禁或实现依据。'
    })))
    return { ...result, evidenceNotices }
  }

  const MessageAck: QueryToolUseCases['MessageAck'] = async (raw, exec) => {
    const { bus, agent } = await requireMailbox(raw, exec)
    return bus.ack(agent.id, raw as Parameters<typeof bus.ack>[1])
  }

  return { ProjectFiles, MessageSend, MessageRead, MessageAck }
}
