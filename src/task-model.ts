import { createHash } from 'node:crypto'
import type { AgentLike } from './host-contract.js'
import type { DelegationRecord, TaskRecord } from './evidence.js'
import type { TaskCard } from './policy.js'
import type { ContextBindingInfo } from './context-store.js'

export interface TaskIntent {
  text: string
  source: 'host' | 'declared'
  sourceRef: string
  /** 游标只绑定最后一条实质消息；text 可以包含自上次游标之后的多条补充。 */
  digest: string
  historyCoverage?: 'since-cursor' | 'latest-visible' | 'unavailable'
  historyNote?: string
}
export interface TaskIntentCursorInfo { intentSourceRef?: string; intentLastDigest?: string; intentSource?: 'host' | 'declared' }
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

type HostMessageInfo = NonNullable<NonNullable<AgentLike['session']>['deriveMessages']> extends () => readonly (infer T)[] ? T : never
const CONTROL_ONLY_MESSAGES = new Set(['继续', '请继续', '继续执行'])
const getMessageText = (message: HostMessageInfo): string => message.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n').trim() ?? ''
const getMessageIntent = (agentId: string, message: HostMessageInfo): TaskIntent | undefined => {
  const text = getMessageText(message)
  if (text === '' || CONTROL_ONLY_MESSAGES.has(text)) return undefined
  // 没有稳定消息 ID 时只能识别最新可见内容；不用易因压缩变化的位置序号假装历史游标。
  const sourceRef = message.id ?? `${agentId}:user:content:${digest(text)}`
  return { text, source: 'host', sourceRef, digest: digest({ sourceRef, text }) }
}

/** 使用公开的消息推导接口读取用户需求，不读取已废弃的同步 session.events。 */
export const getTaskIntent = (agent: AgentLike, card: TaskCard, previous?: TaskIntentCursorInfo): TaskIntent => {
  let historyNote = '宿主没有提供可读取的真实用户消息，使用显式任务需求'
  try {
    // DSH also stores catalogs/reminders as role=user; only human-origin messages steer the task.
    const users = agent.session?.deriveMessages?.().filter((message) => message.role === 'user'
      && (message.source === undefined || message.source.kind === 'user' || message.source.kind === 'user-question-reply')) ?? []
    const cursor = previous?.intentSourceRef === undefined ? -1 : users.findLastIndex((message) => message.id === previous.intentSourceRef)
    if (cursor >= 0) {
      const cursorIntent = getMessageIntent(agent.id, users[cursor]!)
      const changedCursor = cursorIntent !== undefined && cursorIntent.digest !== previous?.intentLastDigest
      const pending = users.slice(cursor + (changedCursor ? 0 : 1)).map((message) => getMessageIntent(agent.id, message)).filter((item): item is TaskIntent => item !== undefined)
      const latest = pending.at(-1)
      if (latest !== undefined) return { ...latest, text: pending.map((item) => item.text).join('\n\n'), historyCoverage: 'since-cursor' }
      if (previous?.intentLastDigest !== undefined) return {
        text: cursorIntent?.text ?? card.intent?.text ?? card.goal, source: 'host', sourceRef: previous.intentSourceRef!, digest: previous.intentLastDigest, historyCoverage: 'since-cursor'
      }
    }
    for (let index = users.length - 1; index >= 0; index -= 1) {
      const latest = getMessageIntent(agent.id, users[index]!)
      if (latest === undefined) continue
      return { ...latest, historyCoverage: 'latest-visible', ...(previous?.intentSourceRef === undefined ? {} : {
        historyNote: '上次需求游标在可见历史中缺失，仅读取最新实质消息；不能证明恢复了压缩或缺失的全部补充'
      }) }
    }
  } catch { historyNote = '宿主用户消息读取失败；本次不能证明取得最新需求，未包含底层异常以避免泄露会话内容' }
  if (previous?.intentSourceRef !== undefined && previous.intentLastDigest !== undefined) return {
    text: card.intent?.text ?? card.goal, source: previous.intentSource ?? 'declared', sourceRef: previous.intentSourceRef, digest: previous.intentLastDigest,
    historyCoverage: 'unavailable', historyNote
  }
  const text = card.intent?.text ?? card.goal
  const sourceRef = card.intent?.sourceRef ?? 'declared-task-input'
  return { text, source: 'declared', sourceRef, digest: digest({ sourceRef, text }), historyCoverage: 'unavailable', historyNote }
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
