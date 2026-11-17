import type { AgentLike, GoalsLike, PreStepDecisionLike, SessionProjectionsLike, ToolExecutionLike, UserQuestionsLike } from './host-contract.js'
import type { TaskRecord } from './evidence.js'
import { createAuthorizationHostAdapter, type AuthorizationGoalHold, type AuthorizationHostObservation } from './authorization-host.js'
import { createAuthorizationRepository, isAuthorizationWaiting, type AuthorizationBinding, type AuthorizationDecision, type AuthorizationState } from './authorization-wait.js'
import { getValueDigest } from './workflow.js'
import { SwarmError } from './util/errors.js'

type Repository = ReturnType<typeof createAuthorizationRepository<AuthorizationState>>
export interface AuthorizationRuntimeContext {
  features: { workspaceId: string; authorizations: Repository }
  task?: TaskRecord
  binding: AuthorizationBinding
}
export interface AuthorizationRuntimeDeps {
  getContext: (agent: AgentLike) => Promise<AuthorizationRuntimeContext>
  /** Must enumerate this root's complete bounded collection, including the pre-task @root record. */
  listDecisions: (context: AuthorizationRuntimeContext) => readonly AuthorizationDecision[] | Promise<readonly AuthorizationDecision[]>
  /** The service owns taskLock, real intent refresh and persistence before returning the new binding. */
  refreshBinding: (context: AuthorizationRuntimeContext, agent: AgentLike) => Promise<AuthorizationBinding>
  getGoals: () => GoalsLike | undefined
  getProjections?: () => SessionProjectionsLike | undefined
  getUserQuestions?: () => UserQuestionsLike | undefined
  isLiveRoot: (agent: AgentLike) => boolean
  hasIndependentReadyWork?: (agent: AgentLike) => boolean | Promise<boolean>
  /** Local outer wait-owner pump only; never call getContext or this coordinator recursively. */
  afterDecisionSettled?: (agent: AgentLike) => void | Promise<void>
  /** A boolean ready queue alone cannot prove that this particular tool is independent. */
  isIndependentTool?: (execution: ToolExecutionLike, decisions: readonly AuthorizationDecision[]) => boolean | Promise<boolean>
  logger?: { warn: (message: string) => void }
}
interface CallBinding { context: AuthorizationRuntimeContext; decisionId: string; goalRef?: { id: string; revision: number } }
interface RootState {
  tail: Promise<void>
  calls: Map<string, CallBinding>
  hold?: AuthorizationGoalHold
  ticket?: { decisionId: string; messageId: string; callId: string }
  failure?: SwarmError
  unsupported?: string
  interrupted?: boolean
  notified: Map<string, AuthorizationDecision['phase']>
  deferredCancelled: Set<string>
}
const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
const SAFE_WAIT_TOOLS = new Set(['swarm_status', 'get_goal', 'swarm_context_read', 'swarm_message_read', 'swarm_message_ack', 'swarm_project_files', 'read', 'read_image', 'glob', 'grep', 'jev_health'])
const safeWhileWaiting = (execution: ToolExecutionLike): boolean => SAFE_WAIT_TOOLS.has(execution.name)
  || (execution.name === 'update_goal' && object(execution.arguments) && execution.arguments.action === 'pause')
  || (execution.name === 'swarm_accept' && object(execution.arguments) && execution.arguments.decision === 'incomplete')
const toolMessage = (raw: unknown): raw is Record<string, unknown> & { source: { kind: 'tool'; callId: string }; toolCallId: string } => object(raw)
  && raw.role === 'tool' && object(raw.source) && raw.source.kind === 'tool' && typeof raw.toolCallId === 'string' && raw.source.callId === raw.toolCallId

/** Coordinates existing tool/Session hooks. It never asks, approves tools, or edits Host goal state privately. */
export const createAuthorizationRuntime = (deps: AuthorizationRuntimeDeps) => {
  const roots = new Map<string, RootState>()
  const adapters = new Map<string, ReturnType<typeof createAuthorizationHostAdapter>>()
  const live = (agent: AgentLike): boolean => { try { return deps.isLiveRoot(agent) } catch { return false } }
  const stateFor = (agent: AgentLike): RootState => {
    let state = roots.get(agent.id)
    if (state === undefined) { state = { tail: Promise.resolve(), calls: new Map(), notified: new Map(), deferredCancelled: new Set() }; roots.set(agent.id, state) }
    return state
  }
  const hostFor = (agent: AgentLike) => {
    let host = adapters.get(agent.id)
    if (host === undefined) {
      host = createAuthorizationHostAdapter({ isLiveRoot: deps.isLiveRoot, logger: deps.logger,
        goals: {
          get: owner => { const goals = deps.getGoals(); if (goals === undefined) throw new Error('goals-unavailable'); return goals.get(owner) },
          disarm: owner => { const goals = deps.getGoals(); if (goals === undefined) throw new Error('goals-unavailable'); return goals.disarm(owner) },
          resume: (owner, ref) => { const goals = deps.getGoals(); if (goals?.resume === undefined) throw new Error('resume-unavailable'); return goals.resume(owner, ref) }
        }, projections: { stateOf: (session, key) => deps.getProjections?.()?.stateOf(session, key) },
        userQuestions: { continued: owner => { const service = deps.getUserQuestions?.(); if (service?.continued === undefined) throw new Error('questions-unavailable'); return service.continued(owner) } } })
      adapters.set(agent.id, host)
    }
    return host
  }
  const serial = <T>(agent: AgentLike, action: (state: RootState) => Promise<T>, critical = false): Promise<T> => {
    const state = stateFor(agent)
    const promise = state.tail.then(() => action(state))
    state.tail = promise.then(() => undefined, () => {
      if (critical) {
        state.failure = new SwarmError('RECOVERY_REQUIRED', '授权结果落账或目标恢复核对尚未完成，请读取状态并通过受支持入口处理；未启动依赖动作')
        deps.logger?.warn(`授权结果结算或目标恢复失败：root=${agent.id}`)
      }
    })
    return promise
  }
  const assertHealthy = (state: RootState): void => { if (state.failure !== undefined) throw state.failure }
  /** 释放已准入的用户回复；结算失败或回合结束时必须允许下一次重新准入。 */
  const releaseTicket = (agent: AgentLike, state: RootState): void => {
    const ticket = state.ticket
    if (ticket === undefined) return
    hostFor(agent).releasePendingReply(ticket.decisionId, ticket.messageId)
    state.ticket = undefined
  }
  /** critical 结算失败后的受控对账：只重放已提交事实与中止回合的取消，不猜测授权。 */
  const reconcileFailure = async (agent: AgentLike, state: RootState): Promise<void> => {
    if (state.failure === undefined) return
    try {
      const context = await deps.getContext(agent)
      await reconcileCommitted(agent, state, context)
      if (state.interrupted) {
        for (const decision of (await decisionsFor(agent, context)).filter(isAuthorizationWaiting)) {
          const cancelled = await context.features.authorizations.cancel(decision.id, 'recovery-retry-after-failed-settle')
          await notifySettled(agent, state, cancelled, false, true)
        }
      }
    } catch {
      // 对账仍失败时保持原有的脱敏失败，不把底层错误原文带给调用方。
      deps.logger?.warn(`授权结算失败后的重新对账仍未完成：root=${agent.id}`)
      throw state.failure
    }
    releaseTicket(agent, state)
    state.failure = undefined
    state.interrupted = false
    deps.logger?.warn(`授权结算失败后已重新对账并恢复：root=${agent.id}`)
  }
  const decisionsFor = async (agent: AgentLike, context: AuthorizationRuntimeContext): Promise<AuthorizationDecision[]> =>
    [...await deps.listDecisions(context)].filter(decision => decision.questionBinding.rootSessionId === agent.id)
  const independent = (agent: AgentLike) => deps.hasIndependentReadyWork?.(agent) ?? false
  const holdForWait = async (agent: AgentLike, state: RootState): Promise<void> => {
    if (await independent(agent)) return
    const result = hostFor(agent).disarmForWait(agent)
    if (!result.supported) {
      state.unsupported = result.reason
      throw new SwarmError('SERVICE_UNAVAILABLE', `授权等待缺少可靠的公开目标续轮抑制能力（${result.reason}）；此适配不支持自动继续`)
    }
    // A pending answer belongs to the original suspended goal. A replacement
    // may also need suppression, but that must not transfer rearm ownership.
    if (state.hold !== undefined && (state.hold.goalId !== result.hold.goalId || state.hold.goalRevision !== result.hold.goalRevision)) {
      state.unsupported = 'goal-changed-while-user-decision-pending'
      return
    }
    state.hold = result.hold
  }
  const contextFor = (context: AuthorizationRuntimeContext, decision: AuthorizationDecision): AuthorizationRuntimeContext => ({
    ...context, binding: decision.questionBinding,
    ...(context.task?.taskId === decision.questionBinding.taskId ? {} : { task: undefined })
  })
  const notifySettled = async (agent: AgentLike, state: RootState, decision: AuthorizationDecision, ownedResume = false, afterStop = false): Promise<void> => {
    if (!live(agent) || isAuthorizationWaiting(decision) || state.notified.get(decision.id) === decision.phase || (state.interrupted && !afterStop)) return
    if (!afterStop) {
      const original = decision.hostCallId === undefined ? undefined : state.calls.get(decision.hostCallId)?.goalRef
      const current = deps.getGoals()?.get(agent)
      // Unknown/replaced goals cannot gain recovery rights from an older answer.
      if (ownedResume) {
        if (original === undefined || current?.id !== original.id || current.revision !== original.revision + 1 || current.phase !== 'active' || current.activation !== 'armed') return
      } else if (original === undefined ? current !== undefined : current?.id !== original.id || current.revision !== original.revision) return
    }
    state.notified.set(decision.id, decision.phase)
    await deps.afterDecisionSettled?.(agent)
  }
  const settle = async (agent: AgentLike, state: RootState, context: AuthorizationRuntimeContext, decision: AuthorizationDecision, observation: AuthorizationHostObservation): Promise<void> => {
    const repo = context.features.authorizations
    if (observation.kind === 'answer') {
      if (!isAuthorizationWaiting(decision)) return
      if (state.interrupted) { const cancelled = await repo.cancel(decision.id, 'host-turn-aborted'); await notifySettled(agent, state, cancelled, false, true); return }
      const binding = await deps.refreshBinding(contextFor(context, decision), agent)
      if (state.interrupted) { const cancelled = await repo.cancel(decision.id, 'host-turn-aborted'); await notifySettled(agent, state, cancelled, false, true); return }
      const consumed = await repo.consumeAnswer(decision.id, { ...observation, binding, operationDigest: decision.operationDigest, scopeDigest: decision.scopeDigest })
      releaseTicket(agent, state)
      let resumed = false
      if (state.hold !== undefined && context.task?.acceptance?.decision !== 'incomplete' && context.task?.acceptance?.status !== 'accepted') {
        const result = hostFor(agent).resumeAfterAnswer(agent, state.hold, consumed)
        resumed = result.resumed
        if (!result.resumed && state.hold.ownedDisarm) state.unsupported = result.reason
        else state.unsupported = undefined
        state.hold = undefined
      }
      await notifySettled(agent, state, consumed, resumed)
      return
    }
    if (!isAuthorizationWaiting(decision)) return
    if (observation.kind === 'cancelled') {
      await repo.cancel(decision.id, observation.reason)
      state.deferredCancelled.add(decision.id)
      hostFor(agent).invalidateHeldGoal(agent.id); state.hold = undefined; releaseTicket(agent, state)
      return
    }
    if (observation.kind === 'unavailable') await repo.unavailable(decision.id, observation.reason)
    else if (observation.kind === 'unknown') await repo.dispatchUnknown(decision.id, observation.reason)
    await holdForWait(agent, state)
  }
  /** Final tools/result runs before the Session tool result is logged. Read committed public messages here. */
  const reconcileCommitted = async (agent: AgentLike, state: RootState, context: AuthorizationRuntimeContext): Promise<void> => {
    const pending = (await decisionsFor(agent, context)).filter(isAuthorizationWaiting)
    if (pending.length === 0) return
    const byCall = new Map(pending.filter(decision => decision.hostCallId !== undefined).map(decision => [decision.hostCallId!, decision]))
    const messages = agent.session?.deriveMessages?.() ?? []
    for (let index = messages.length - 1; index >= 0 && byCall.size > 0; index--) {
      const message = messages[index]!
      if (toolMessage(message)) {
        const decision = byCall.get(message.toolCallId)
        if (decision === undefined) continue
        const observation = hostFor(agent).observeResult(decision, { name: 'ask_user_question', callId: message.toolCallId, agent }, message)
        await settle(agent, state, state.calls.get(message.toolCallId)?.context ?? contextFor(context, decision), decision, observation)
        byCall.delete(message.toolCallId)
      } else {
        for (const [callId, decision] of byCall) {
          const reply = hostFor(agent).observeReply(decision, message)
          if (reply === undefined) continue
          await settle(agent, state, contextFor(context, decision), decision, reply)
          byCall.delete(callId)
        }
      }
    }
  }
  return {
    beforeTool: async (execution: ToolExecutionLike): Promise<void> => {
      const agent = execution.agent
      if (agent === undefined || !live(agent)) return
      await serial(agent, async state => {
        // Read-only diagnostics remain available even when a previous guard commit failed.
        if (state.failure !== undefined && safeWhileWaiting(execution)) return
        if (state.failure !== undefined) await reconcileFailure(agent, state)
        assertHealthy(state)
        const context = await deps.getContext(agent)
        await reconcileCommitted(agent, state, context)
        const waiting = (await decisionsFor(agent, context)).filter(isAuthorizationWaiting)
        if (execution.name !== 'ask_user_question') {
          if (waiting.length === 0 || safeWhileWaiting(execution) || await deps.isIndependentTool?.(execution, waiting)) return
          await holdForWait(agent, state)
          throw new SwarmError('PERMISSION_DENIED', '当前操作依赖尚未回答的用户决定；只可读取诊断、停止或执行已核实无依赖的工作，未回复不等于授权')
        }
        const call = hostFor(agent).observeCall(execution, context.binding.nodeId)
        if (call === undefined) throw new SwarmError('INVALID_ARGS', '用户询问缺少真实调用身份或有效问题，未建立授权等待')
        if (waiting.length > 0 || state.calls.has(call.callId)) throw new SwarmError('RECOVERY_REQUIRED', '根会话已有用户决定或同一调用待处理，禁止重复提问；请复用原问答并核对来源')
        const operationDigest = getValueDigest({ kind: 'user-decision', lineageId: context.binding.lineageId, taskId: context.binding.taskId,
          questions: call.questions.map(({ id: _id, ...question }) => question) })
        const scopeDigest = getValueDigest({ workspaceId: context.features.workspaceId, taskId: context.binding.taskId, scope: [...(context.task?.card.scope ?? [])].sort() })
        const goal = deps.getGoals()?.get(agent)
        const { decision, reused } = await context.features.authorizations.prepare({ binding: context.binding, operationDigest, scopeDigest, questions: call.questions, requiresUserDecision: true })
        if (reused) throw new SwarmError('RECOVERY_REQUIRED', '同一用户问题已有记录；沿用原答复或恢复核对，不重新发问')
        try { await context.features.authorizations.dispatchKnown(decision.id, { callId: call.callId, questionDigest: call.questionDigest }) }
        catch (error) {
          state.failure = new SwarmError('RECOVERY_REQUIRED', '问题登记未能完成，宿主询问未派发；这是维护核对缺口，不是等待用户批准')
          deps.logger?.warn(`授权问题登记失败且未派发：root=${agent.id}`)
          throw error
        }
        state.interrupted = false
        state.calls.set(call.callId, { context, decisionId: decision.id, ...(goal === undefined ? {} : { goalRef: { id: goal.id, revision: goal.revision } }) })
      })
    },
    /** Synchronous registration is essential: the Host does not await final-result observer promises. */
    observeFinalResult: (execution: ToolExecutionLike, result: unknown): void => {
      const agent = execution.agent
      if (agent === undefined || !live(agent) || execution.name !== 'ask_user_question' || execution.callId === undefined) return
      const state = stateFor(agent), call = state.calls.get(execution.callId)
      if (call === undefined) return
      void serial(agent, async current => {
        const decision = call.context.features.authorizations.get(call.decisionId)
        if (decision === undefined) throw new SwarmError('RECOVERY_REQUIRED', '真实提问缺少已提交的决定记录')
        const observation = hostFor(agent).observeResult(decision, execution, result)
        // Answers must become real Session input before refreshBinding derives a newer request.
        if (observation.kind !== 'answer') await settle(agent, current, call.context, decision, observation)
      }, true).catch(() => undefined)
    },
    beforeStep: async (agent: AgentLike, decision: PreStepDecisionLike): Promise<PreStepDecisionLike> => {
      if (!live(agent) || decision.kind === 'reject') return decision
      return serial(agent, async state => {
        if (state.failure !== undefined) await reconcileFailure(agent, state)
        assertHealthy(state)
        const context = await deps.getContext(agent)
        await reconcileCommitted(agent, state, context)
        const allDecisions = await decisionsFor(agent, context)
        const stoppedReplies = decision.messages.filter(message => allDecisions.some(pending => ['cancelled', 'invalidated'].includes(pending.phase)
          && hostFor(agent).observeReply(pending, message) !== undefined))
        if (stoppedReplies.length > 0) {
          const retained = decision.messages.filter(message => !stoppedReplies.includes(message))
          return retained.some(message => message.source?.kind === 'user') ? { ...decision, messages: retained } : { kind: 'reject' }
        }
        const waiting = allDecisions.filter(isAuthorizationWaiting)
        if (waiting.length === 0) return decision
        if (state.ticket !== undefined && decision.messages.some(message => message.id === state.ticket!.messageId)) return decision
        for (const pending of waiting) {
          const reply = hostFor(agent).observePendingReply(agent, pending, decision.messages)
          if (reply === undefined) continue
          state.ticket = { decisionId: pending.id, messageId: reply.messageId, callId: reply.callId }
          return decision
        }
        if (await independent(agent)) return decision
        await holdForWait(agent, state)
        return { kind: 'reject' }
      })
    },
    beforeRequest: async (agent: AgentLike): Promise<void> => {
      if (!live(agent)) return
      await serial(agent, async state => {
        if (state.failure !== undefined) await reconcileFailure(agent, state)
        assertHealthy(state)
        const context = await deps.getContext(agent)
        await reconcileCommitted(agent, state, context)
        if (!(await decisionsFor(agent, context)).some(isAuthorizationWaiting) || state.ticket !== undefined || await independent(agent)) return
        await holdForWait(agent, state)
        throw new SwarmError('RECOVERY_REQUIRED', '用户决定仍待回答；已抑制模型续轮，不能把等待当作新的推理任务')
      })
    },
    onUserMessage: (agent: AgentLike, message: unknown): void => {
      if (!live(agent)) return
      void serial(agent, async state => {
        if (!object(message) || typeof message.id !== 'string') return
        const committed = agent.session?.deriveMessages?.().find(value => value.id === message.id)
        if (committed === undefined) return
        const context = await deps.getContext(agent)
        for (const decision of (await decisionsFor(agent, context)).filter(isAuthorizationWaiting)) {
          const observation = hostFor(agent).observeReply(decision, committed)
          if (observation !== undefined) await settle(agent, state, contextFor(context, decision), decision, observation)
        }
      }, true).catch(() => undefined)
    },
    onToolResult: (agent: AgentLike, message: unknown): void => {
      if (!live(agent) || !toolMessage(message)) return
      void serial(agent, async state => {
        const committed = agent.session?.deriveMessages?.().findLast(value => toolMessage(value) && value.toolCallId === message.toolCallId)
        if (committed === undefined) return
        const context = await deps.getContext(agent)
        const decision = (await decisionsFor(agent, context)).find(value => value.hostCallId === message.toolCallId && isAuthorizationWaiting(value))
        if (decision === undefined) return
        const observation = hostFor(agent).observeResult(decision, { name: 'ask_user_question', callId: message.toolCallId, agent }, committed)
        await settle(agent, state, state.calls.get(message.toolCallId)?.context ?? contextFor(context, decision), decision, observation)
      }, true).catch(() => undefined)
    },
    onTurnEnd: (agent: AgentLike, reason: { kind?: string } | undefined): void => {
      if (!live(agent)) return
      const aborted = reason?.kind === 'aborted'
      const state = stateFor(agent)
      // 任何回合结束都释放已准入但未结算的回复；中止回合还要取消等待中的决定。
      releaseTicket(agent, state)
      if (!aborted) return
      hostFor(agent).invalidateHeldGoal(agent.id)
      state.hold = undefined; state.interrupted = true
      void serial(agent, async () => {
        const context = await deps.getContext(agent)
        for (const decision of await decisionsFor(agent, context)) {
          if (isAuthorizationWaiting(decision)) {
            const cancelled = await context.features.authorizations.cancel(decision.id, 'host-turn-aborted')
            await notifySettled(agent, state, cancelled, false, true)
          } else if (state.deferredCancelled.has(decision.id)) await notifySettled(agent, state, decision, false, true)
        }
        state.deferredCancelled.clear()
      }, true).catch(() => undefined)
    },
    onDisposed: async (agent: AgentLike): Promise<void> => {
      const state = roots.get(agent.id)
      if (state === undefined) return
      adapters.get(agent.id)?.invalidateHeldGoal(agent.id)
      releaseTicket(agent, state)
      state.hold = undefined; state.interrupted = true
      await state.tail
      adapters.delete(agent.id); roots.delete(agent.id)
    },
    getDiagnostics: (rootSessionId: string) => {
      const state = roots.get(rootSessionId)
      return { outcome: state?.failure === undefined ? state?.unsupported === undefined ? 'ready' : 'unsupported' : 'reconcile-required',
        ...(state?.unsupported === undefined ? {} : { reason: state.unsupported }), waitingForInputAdmission: state?.ticket !== undefined }
    }
  }
}
