import type { AgentBinding } from '../agent-binding.js'
import type { ContextPageInfo } from '../context-store.js'
import type { DelegationRecord, TaskRecord, TaskStore } from '../evidence.js'
import type { EvidenceAssessment, EvidenceAssessmentBinding } from '../evidence-assessment.js'
import type { FeatureSession } from '../feature-session.js'
import { getAgentHeader, type AgentLike } from '../host-contract.js'
import { getRedactedText } from '../jev.js'
import { getCurrentDelegations, getTaskBinding, getTaskContextBinding } from '../task-model.js'
import { revalidateEvidenceAssessment } from '../evidence-assessment.js'
import type { ToolExecLike } from '../tool-shape.js'
import { SwarmError } from '../util/errors.js'
import type { SwarmService } from './service-api.js'

export interface ContextQuerySessionPort {
  rootAgent?: AgentLike
  store: Pick<TaskStore, 'getDelegation' | 'getTaskDelegations'>
}

export interface ContextQueryTaskContext {
  session: ContextQuerySessionPort
  features: FeatureSession
  task: TaskRecord
  projectedTask: TaskRecord
  agent: AgentLike
  binding?: AgentBinding
}

export interface ContextQueryToolDeps {
  getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<ContextQueryTaskContext>
  getBoundEvidenceAssessment: (record: DelegationRecord | undefined) => EvidenceAssessment | undefined
  evidenceBinding: (task: TaskRecord, features: FeatureSession) => EvidenceAssessmentBinding
  evidencePrivatePaths: () => readonly string[]
  now: () => number
}

export type ContextQueryToolUseCases = Pick<SwarmService, 'ReadContext'>

/** Paginated, revision-bound private context reads; file paths cannot bypass the authorization index. */
export const createContextQueryToolUseCase = (deps: ContextQueryToolDeps): ContextQueryToolUseCases => {
  const ReadContext: ContextQueryToolUseCases['ReadContext'] = async (raw, exec) => {
    const context = await deps.getToolTask(raw, exec)
    const { session, features, task, projectedTask, binding, agent } = context
    const stateRefreshRequired = projectedTask !== task
    const args = raw as { ref?: string; cursor?: string; limit?: number; expectedDigest?: string }
    if (binding !== undefined) features.bindings.requireActive(binding.agentId, 'context-read')
    if (args.ref === undefined) {
      const current = binding?.blindReview ? [] : getCurrentDelegations(task, session.store.getTaskDelegations(task.taskId))
      return {
        task_id: task.taskId, stateRefreshRequired, publishedRevisions: getTaskBinding(task), projectedRevisions: getTaskBinding(projectedTask),
        materials: features.contexts.List(binding ?? getTaskContextBinding(task, features.workspaceId)),
        executionSummary: binding?.blindReview ? { omitted: '独立盲审不披露作者执行过程或历史评分' } : {
          total: current.length, truncated: current.length > 12,
          delegations: current.slice(-12).map((record) => ({ delegationId: record.delegationId, role: record.role, status: record.status,
            summary: getRedactedText(record.summary, 500), ...(record.error === undefined ? {} : { error: getRedactedText(record.error, 500) }) }))
        },
        nextAction: stateRefreshRequired
          ? '状态是只读投影，需求或流程需同步；通过 swarm_review_plan 显式同步审核，现有材料不能当作新版本已批准证据。'
          : '使用返回的 ref 和 digest 分页读取；本工具已提供当前授权执行摘要，不通过文件路径读取私有状态。'
      }
    }
    if (typeof args.ref !== 'string') throw new SwarmError('INVALID_ARGS', '上下文 ref 必须为字符串；不传 ref 可列出当前授权材料')
    if (stateRefreshRequired) {
      throw new SwarmError('STALE_EVIDENCE', `材料绑定旧需求或流程（已发布 ${task.requestRevision ?? 1}/${task.cardRevision ?? 1}/${task.workflowRevision ?? 1}，当前需求 ${projectedTask.requestRevision ?? 1}/${projectedTask.cardRevision ?? 1}/${projectedTask.workflowRevision ?? 1}）；先调用 swarm_review_plan 同步当前版本，再不传 ref 重新获取材料引用与 digest。旧 ref 不会自动升级，也不代表当前审核已通过。`)
    }
    let page: ContextPageInfo
    try {
      page = features.contexts.Read(binding ?? getTaskContextBinding(task, features.workspaceId), args.ref, args)
    } catch (error) {
      if (!(error instanceof SwarmError) || error.code !== 'CONTEXT_REFERENCE_UNAVAILABLE') throw error
      return {
        ok: false, code: error.code, task_id: task.taskId, ref: args.ref, stateRefreshRequired: false, publishedRevisions: getTaskBinding(task),
        materials: features.contexts.List(binding ?? getTaskContextBinding(task, features.workspaceId)), mayUseForImplementation: false, recovery: 'relist_current_materials',
        reason: '该引用在当前授权材料中不存在，可能来自旧版本或其他会话；这不证明状态损坏，也不代表旧材料已取得当前授权。',
        nextAction: '从 materials 中重新选择当前 ref 和 digest，省略旧 cursor 后重新读取；本次没有返回材料正文、批准或执行凭证。'
      }
    }
    const delegationId = task.contextDelegations?.[args.ref]
    if (delegationId === undefined) {
      return { ...page, stateRefreshRequired, ...(stateRefreshRequired ? { text: `[历史材料：需求或流程尚未同步，不是新版本已批准证据。]\n${page.text}` } : {}) }
    }
    const record = session.store.getDelegation(delegationId)
    const notice = await revalidateEvidenceAssessment(deps.getBoundEvidenceAssessment(record), {
      cwd: getAgentHeader(session.rootAgent ?? agent).cwd ?? process.cwd(), binding: deps.evidenceBinding(projectedTask, features)
    }, { now: deps.now, privatePaths: [...deps.evidencePrivatePaths()] })
    return {
      ...page, stateRefreshRequired, evidenceAssessment: notice,
      ...(notice.mayUseForImplementation ? {} : { text: `[探索材料：${notice.disposition}；需要核对，不能作为已证实实现依据。]\n${page.text}` })
    }
  }
  return { ReadContext }
}
