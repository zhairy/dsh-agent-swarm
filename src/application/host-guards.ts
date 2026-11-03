import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentBinding } from '../agent-binding.js'
import type { SwarmConfigInfo } from '../config.js'
import type { TaskRecord } from '../evidence.js'
import type { AgentControlRecord } from '../agent-control.js'
import type { TicketRepository } from '../domain/tickets/repository.js'
import type { WorktreeRegistry } from '../worktree-binding.js'
import { WORKTREE_TOOL } from '../worktree-binding.js'
import { getAgentHeader, WRITE_TOOL_NAMES, type AgentLike, type ToolExecutionLike } from '../host-contract.js'
import { getToolApprovalDenial } from '../approval-policy.js'
import { getRouterToolDenial } from '../router-worker.js'
import { getPermissionLabel, getRoleInfo, isWriteAllowed, type RoleId } from '../role-registry.js'

export interface GuardSessionPort {
  rootAgent?: AgentLike
  rootEditAt: number
  store: Pick<TicketRepository, 'getTask' | 'getTasks'>
  features?: { bindings: { get: (agentId: string) => AgentBinding | undefined } }
  worktrees: Pick<WorktreeRegistry, 'canCreate' | 'findByAgent'>
}

export interface HostGuardDeps {
  getConfig: () => SwarmConfigInfo
  now: () => number
  isRootTianShu: (agent: AgentLike) => boolean
  getGoalCompletionReason: (agent: AgentLike) => string | undefined
  getAgentControl: (agentId: string) => AgentControlRecord | undefined
  hasManagedChildPreset: (agent: AgentLike) => boolean
  hasChildOwner: (agentId: string) => boolean
  isStartingChild: (agentId: string) => boolean
  isClosing: () => boolean
  isManagedAgent: (agent: AgentLike | undefined) => boolean
  getRoleForAgent: (agent: AgentLike | undefined) => RoleId | undefined
  getSession: (sessionId: string) => GuardSessionPort
  getChildOwner: (agentId: string) => string | undefined
  getChildSignal: (agentId: string) => AbortSignal | undefined
  getTaskSchemaNames: (agent: AgentLike) => readonly { name: string }[]
  isQuarantined: (taskId: string) => boolean
  isBindingCurrent: (session: GuardSessionPort, binding: AgentBinding, agent: AgentLike, task: TaskRecord) => boolean
  privateStateRoots: () => readonly string[]
  isWorkspaceMutationUnknown: (cwd: string) => boolean
}

export interface HostGuardUseCases {
  AddRootEdit: (agent: AgentLike | undefined, role: RoleId | undefined) => void
  getGuardReason: (execution: ToolExecutionLike) => string | undefined
}

const isWriter = (name: string): boolean => WRITE_TOOL_NAMES.includes(name) || name === WORKTREE_TOOL || name === 'bash' || name === 'pwsh'


const canonicalPath = (path: string): string => {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`
  try { return realpathSync.native(absolute) } catch {
    let parent = dirname(absolute)
    for (let depth = 0; depth < 64; depth++) {
      try {
        const suffix = absolute.slice(parent.length).replace(/^[\\/]+/, '')
        return resolve(realpathSync.native(parent), suffix)
      } catch {
        const next = dirname(parent)
        if (next === parent) break
        parent = next
      }
    }
    return absolute
  }
}

const isWithin = (base: string, target: string): boolean => {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

const getPathDenial = (execution: ToolExecutionLike, session: GuardSessionPort, taskId: string, config: SwarmConfigInfo, privateStateRoots: readonly string[]): string | undefined => {
  if (!['read', 'read_image', 'glob', 'grep', 'write', 'edit'].includes(execution.name)) return undefined
  const privateRoots = privateStateRoots.map(canonicalPath)
  const current = execution.agent ?? session.rootAgent
  const cwd = current === undefined ? process.cwd() : getAgentHeader(current).cwd ?? process.cwd()
  const args = execution.arguments as Record<string, unknown> | undefined
  const targets = Object.entries(args ?? {}).filter(([key, value]) => /path|file|directory|root|cwd/i.test(key) && typeof value === 'string')
    .map(([, value]) => canonicalPath(isAbsolute(value as string) ? value as string : `${cwd}${sep}${value as string}`))
  if ((execution.name === 'glob' || execution.name === 'grep') && targets.length === 0) targets.push(canonicalPath(cwd))
  if (targets.some((target) => privateRoots.some((root) => isWithin(root, target) || ((execution.name === 'glob' || execution.name === 'grep') && isWithin(target, root))))) {
    return `私有状态与账本不能通过通用文件工具读取；调用 swarm_context_read({"task_id":${JSON.stringify(taskId)}}) 列出当前授权材料与执行摘要，再按 ref 分页读取。`
  }
  if (WRITE_TOOL_NAMES.includes(execution.name) && targets.length > 0) {
    const task = session.store.getTask(taskId)
    if (task === undefined) return '当前任务不存在，不能校验写入范围'
    if (task.card.scope.length > 0) {
      const allowed = task.card.scope.map((path) => canonicalPath(isAbsolute(path) ? path : `${cwd}${sep}${path}`))
      if (targets.some((target) => !allowed.some((path) => isWithin(path, target)))) return '写入路径超出当前任务允许的 scope'
    } else if (config.workflow.mode === 'enforced') return '写任务必须先明确允许修改的 scope'
  }
  return undefined
}

/** Pure application guard. Host approval remains authoritative and is consumed through a callback-safe adapter. */
export const createHostGuardUseCases = (deps: HostGuardDeps): HostGuardUseCases => {
  const AddRootEdit = (agent: AgentLike | undefined, role: RoleId | undefined): void => {
    if (agent === undefined || role !== 'tian_shu' || getAgentHeader(agent).parentSession !== undefined) return
    deps.getSession(agent.id).rootEditAt = deps.now()
  }

  const getGuardReason = (execution: ToolExecutionLike): string | undefined => {
    if (execution.agent !== undefined && deps.isRootTianShu(execution.agent) && execution.name === 'update_goal'
      && (execution.arguments as { action?: unknown } | undefined)?.action === 'complete') return deps.getGoalCompletionReason(execution.agent)
    if (execution.signal?.aborted === true) return '专家请求已经取消，迟到工具调用被拒绝'
    const writer = isWriter(execution.name)
    const oneShot = execution.agent === undefined ? undefined : deps.getAgentControl(execution.agent.id)
    if (execution.agent !== undefined && deps.hasManagedChildPreset(execution.agent)
      && !deps.hasChildOwner(execution.agent.id) && !deps.isStartingChild(execution.agent.id)) {
      return '专家执行授权已结束；迟到工具调用已被拒绝'
    }
    if (oneShot?.persistent === false && oneShot.oneShotSettled === true) {
      return oneShot.reason === 'one-shot-cancelled' ? '专家已经取消，延迟工具调用被拒绝' : '一次性专家已经结束，延迟工具调用被拒绝'
    }
    if (deps.isClosing() && execution.agent !== undefined && deps.isManagedAgent(execution.agent) && writer) {
      return '百工正在停止，拒绝新增写入、工作树或命令执行'
    }
    const role = deps.getRoleForAgent(execution.agent)
    const config = deps.getConfig()
    if (role === 'tian_shu' && writer && config.router.workspaceWrites === 'deny') {
      const denial = getRouterToolDenial(execution.name, execution.arguments)
      return denial === undefined
        ? '天枢是 Router，只负责规划、授权、路由与派发；当前配置禁止它直接写入、运行命令或创建可写工作树。请委派铸剑、行舟或疾风执行。'
        : '天枢是 Router，不能执行该操作；请委派 Worker 执行。'
    }
    if (role === 'tian_shu' && execution.name === WORKTREE_TOOL) return '天枢是路由与会话主持者，不能直接创建可写工作树；请委派铸剑或疾风执行'
    if (deps.isManagedAgent(execution.agent)) {
      const denied = getToolApprovalDenial(execution, config.approvals)
      if (denied !== undefined) return denied
    }

    const owner = execution.agent === undefined ? undefined : deps.getChildOwner(execution.agent.id)
    if (owner !== undefined && execution.agent !== undefined) {
      const session = deps.getSession(owner)
      const binding = session.features?.bindings.get(execution.agent.id)
      if (binding === undefined) return '当前专家的身份绑定尚未就绪，不能执行工具'
      if (execution.signal?.aborted || deps.getChildSignal(execution.agent.id)?.aborted) return '专家已经取消，延迟工具调用被拒绝'
      if (binding.state !== 'active') return '专家执行身份已经撤销，请重新委派'
      if (deps.isQuarantined(binding.taskId) && writer) return 'Ticket 已隔离：存在未知外部副作用，只允许只读核对与恢复读取，禁止写入、工作树或命令执行'
      const task = session.store.getTask(binding.taskId)
      if (task === undefined || !deps.isBindingCurrent(session, binding, execution.agent, task)) return '专家绑定的是旧任务版本，不能继续执行工具'
      const workspaceEditor = role !== undefined && getRoleInfo(role).permission === 'workspace-edit'
      if (execution.name === WORKTREE_TOOL) {
        if (!workspaceEditor) return '只有可编辑工作区的专家能够创建可写工作树'
        const denied = session.worktrees.canCreate({ agentId: execution.agent.id, taskId: binding.taskId })
        if (denied !== undefined) return denied
      } else if (writer && workspaceEditor) {
        const worktreeToolLoaded = deps.getTaskSchemaNames(execution.agent).some((tool) => tool.name === WORKTREE_TOOL)
        if (worktreeToolLoaded) {
          const bound = session.worktrees.findByAgent(execution.agent.id)
          if (bound === undefined) return '可编辑专家尚未创建隔离工作树；请先调用 create_worktree，再修改文件或运行命令'
          if (bound.taskId !== binding.taskId) return '当前专家仍绑定其它任务的工作树，不能在新任务中写入'
        }
      }
      const pathDenial = getPathDenial(execution, session, binding.taskId, config, deps.privateStateRoots())
      if (pathDenial !== undefined) return pathDenial
    }

    if (!writer) return undefined
    if (execution.agent !== undefined && deps.isWorkspaceMutationUnknown(getAgentHeader(execution.agent).cwd ?? process.cwd())) {
      return '工作区存在未确认副作用，必须完成恢复核对后才能再次写入或运行命令'
    }
    if (role === 'tian_shu' && execution.agent !== undefined && config.workflow.mode === 'enforced'
      && deps.getSession(execution.agent.id).store.getTasks().some((task) => task.acceptance?.status !== 'accepted' && task.acceptance?.decision !== 'incomplete')) {
      return '强制任务流程中，写入与通用命令需通过受工作区租约管理的专家执行'
    }
    if ((execution.name === 'bash' || execution.name === 'pwsh') && role !== undefined && getRoleInfo(role).capabilities.includes('shell')) return undefined
    if (role === undefined || isWriteAllowed(role)) return undefined
    return `dsh-agent-swarm 守卫：「${getRoleInfo(role).name}」是${getPermissionLabel(role)}角色，不能调用 ${execution.name} 修改文件。请在结果中写明需要的改动，由天枢交给铸剑或疾风处理。`
  }

  return { AddRootEdit, getGuardReason }
}
