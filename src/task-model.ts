import { createHash } from 'node:crypto'
import type { AgentLike } from './host-contract.js'
import type { DelegationRecord, TaskRecord } from './evidence.js'
import type { TaskCard } from './policy.js'
import type { ContextBindingInfo } from './context-store.js'

export interface TaskIntent { text: string; source: 'host' | 'declared'; sourceRef: string; digest: string }
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** 使用公开的消息推导接口读取用户需求，不读取已废弃的同步 session.events。 */
export const getTaskIntent = (agent: AgentLike, card: TaskCard): TaskIntent => {
  try {
    // DSH also stores catalogs/reminders as role=user; only human-origin messages steer the task.
    const users = agent.session?.deriveMessages?.().filter((message) => message.role === 'user'
      && (message.source === undefined || message.source.kind === 'user' || message.source.kind === 'user-question-reply')) ?? []
    const latest = users.at(-1)
    const text = latest?.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n').trim()
    if (text) {
      const sourceRef = latest?.id ?? `${agent.id}:user:${users.length}`
      return { text, source: 'host', sourceRef, digest: digest({ sourceRef, text }) }
    }
  } catch { /* 旧宿主能力不可用：显式声明需求来自任务输入，不冒称原始用户消息。 */ }
  const text = card.intent?.text ?? card.goal
  const sourceRef = card.intent?.sourceRef ?? 'declared-task-input'
  return { text, source: 'declared', sourceRef, digest: digest({ sourceRef, text }) }
}

export const getSemanticCardDigest = (card: TaskCard): string => {
  const { title: _presentation, workflow: _workflow, ...contract } = card
  return digest(contract)
}

export const getTaskBinding = (task: TaskRecord) => ({
  taskId: task.taskId,
  cardRevision: task.cardRevision ?? 1,
  workflowRevision: task.workflowRevision ?? 1,
  requestRevision: task.requestRevision ?? 1
})

/** Every task-scoped capability shares the same version comparison; missing legacy versions mean 1. */
export const isTaskVersionCurrent = (task: TaskRecord, binding: { cardRevision?: number; workflowRevision?: number; requestRevision?: number }): boolean =>
  (task.cardRevision ?? 1) === (binding.cardRevision ?? 1)
  && (task.workflowRevision ?? 1) === (binding.workflowRevision ?? 1)
  && (task.requestRevision ?? 1) === (binding.requestRevision ?? 1)

export const getTaskContextBinding = (task: TaskRecord, workspaceId: string): ContextBindingInfo => ({
  rootSessionId: task.sessionId, workspaceId, ...getTaskBinding(task)
})

export const getCurrentDelegations = (task: TaskRecord, records: DelegationRecord[], artifactDigest?: string): DelegationRecord[] =>
  records.filter((record) => {
    if ((record.finalization !== undefined && record.finalization !== 'ready') || !isTaskVersionCurrent(task, record) || record.staleReason) return false
    // 成功验证必须绑定当前产物；旧输入兼容仅限尚未引入版本绑定的第一版任务。
    if (artifactDigest && (['fu_he', 'yu_shi'].includes(record.role) || (record.role === 'suan_heng' && record.mode === 'verify'))
      && record.artifactAfter !== undefined && record.artifactAfter !== artifactDigest) return false
    return true
  })
