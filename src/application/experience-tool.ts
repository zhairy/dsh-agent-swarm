import type { AgentBinding } from '../agent-binding.js'
import type { TaskRecord, TaskStore } from '../evidence.js'
import type { FeatureSession } from '../feature-session.js'
import { getAgentHeader, type AgentLike } from '../host-contract.js'
import type { MutexInfo } from '../util/mutex.js'
import { ValidateToolCandidate, type ToolCandidateMetadata } from '../tool-candidate.js'
import { getArtifactSnapshot } from '../artifacts.js'
import { getTaskBinding, isTaskVersionCurrent } from '../task-model.js'
import type { SwarmService } from './service-api.js'
import { SwarmError } from '../util/errors.js'
import type { ToolExecLike } from '../tool-shape.js'

export interface ExperienceSessionPort {
  taskLock: MutexInfo
  store: TaskStore
  rootAgent?: AgentLike
}

export interface ExperienceTaskContext {
  session: ExperienceSessionPort
  features: FeatureSession
  task: TaskRecord
  agent: AgentLike
  binding?: AgentBinding
}

export interface ExperienceToolDeps {
  getConfigEnabled: () => boolean
  getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<ExperienceTaskContext>
  isRootTianShu: (agent: AgentLike) => boolean
  currentTask: (context: ExperienceTaskContext) => TaskRecord
  isClosing: () => boolean
  now: () => number
}

export type ExperienceToolUseCases = Pick<SwarmService, 'Experience'>

/** Bounded experience lookup and evidence-bound tool-candidate registration. */
export const createExperienceToolUseCase = (deps: ExperienceToolDeps): ExperienceToolUseCases => {
  const Experience: ExperienceToolUseCases['Experience'] = async (raw, exec) => {
    const context = await deps.getToolTask(raw, exec)
    const { features, binding, session, task, agent } = context
    if (!deps.getConfigEnabled() || binding?.blindReview) throw new SwarmError('PERMISSION_DENIED', '经验检索已关闭或当前为独立盲审')
    const args = raw as { action?: string; problemClass?: string; includeCandidates?: boolean; conclusion?: string; appliesWhen?: string[]; doesNotApplyWhen?: string[]; toolCandidate?: ToolCandidateMetadata }
    if (args.action === 'record_tool_candidate') {
      if (!deps.isRootTianShu(agent) || binding !== undefined) throw new SwarmError('PERMISSION_DENIED', '只有天枢根会话可登记工具候选')
      if (!ValidateToolCandidate(args.toolCandidate) || typeof args.conclusion !== 'string' || !Array.isArray(args.appliesWhen) || args.appliesWhen.length === 0 || !Array.isArray(args.doesNotApplyWhen)) {
        throw new SwarmError('INVALID_ARGS', '候选需要有界来源、适用/排除条件、回滚和禁用执行标记')
      }
      return session.taskLock.run(async () => {
        if (deps.isClosing() || exec.signal.aborted) throw new SwarmError('RECOVERY_REQUIRED', '候选登记已取消或宿主正在停止')
        const current = deps.currentTask(context)
        if (!isTaskVersionCurrent(current, getTaskBinding(task))) throw new SwarmError('STALE_EVIDENCE', '候选来源任务已变更，请刷新后登记')
        const source = await getArtifactSnapshot(getAgentHeader(agent).cwd ?? process.cwd(), current.card.scope)
        if (!source.complete) throw new SwarmError('STALE_EVIDENCE', '候选来源产物不完整，未登记')
        if (exec.signal.aborted || deps.isClosing()) throw new SwarmError('RECOVERY_REQUIRED', '候选登记已取消或宿主正在停止')
        return features.experiences.addCandidate({
          problemClass: 'tool-candidate', conclusion: args.conclusion!, appliesWhen: args.appliesWhen!, doesNotApplyWhen: args.doesNotApplyWhen!,
          source: { taskId: task.taskId, cardRevision: current.cardRevision ?? 1, workflowRevision: current.workflowRevision ?? 1, artifactDigest: source.digest, authorId: agent.id },
          verification: [], counterexamples: [], operatorVersions: [args.toolCandidate!.version], toolCandidate: args.toolCandidate!, expiresAt: deps.now() + 7 * 86400000
        })
      })
    }
    if (args.action !== undefined && args.action !== 'list') throw new SwarmError('INVALID_ARGS', '未知经验操作')
    return features.experiences.list(args.problemClass, args.includeCandidates === true).slice(0, 3)
  }
  return { Experience }
}
