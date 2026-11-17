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
  refs?: Array<{ source: string; text: string }>
}
export interface TaskIntentCursorInfo { intentSourceRef?: string; intentLastDigest?: string; intentSource?: 'host' | 'declared' }
export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

type HostMessageInfo = NonNullable<NonNullable<AgentLike['session']>['deriveMessages']> extends () => readonly (infer T)[] ? T : never
const CONTROL_ONLY_MESSAGES = new Set(['继续', '请继续', '继续执行'])
const getMessageText = (message: HostMessageInfo): string => message.content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n').trim() ?? ''
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const getJsonObject = (value: unknown): Record<string, unknown> | undefined => {
  if (isObject(value)) return value
  if (typeof value !== 'string') return undefined
  try { const parsed: unknown = JSON.parse(value); return isObject(parsed) ? parsed : undefined } catch { return undefined }
}
const getQuestionItems = (value: unknown): Array<Record<string, unknown>> | undefined => {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !isObject(item) || typeof item.id !== 'string' || item.id.trim() === '' || typeof item.question !== 'string' || item.question.trim() === '')) return undefined
  const rows = value as Array<Record<string, unknown>>
  if (new Set(rows.map(item => item.id)).size !== rows.length) return undefined
  return rows
}
const getQuestionContract = (questions: Array<Record<string, unknown>>): string => JSON.stringify(questions.map(question => ({
  id: question.id, question: question.question, header: question.header ?? '', detail: question.detail ?? '',
  multiSelect: question.multiSelect ?? question.multi_select ?? false,
  options: Array.isArray(question.options) ? question.options.map(option => isObject(option)
    ? { label: option.label, description: option.description ?? '' } : option) : question.options ?? []
})))
const getConfirmedQuestionText = (callId: string, questions: Array<Record<string, unknown>>, raw: unknown): string | undefined => {
  const answers = getJsonObject(raw)?.answers
  if (!Array.isArray(answers) || answers.length !== questions.length) return undefined
  const byId = new Map(questions.map(question => [question.id, question]))
  const seen = new Set<string>()
  for (const answer of answers) {
    if (!isObject(answer) || typeof answer.id !== 'string' || seen.has(answer.id) || !byId.has(answer.id)
      || !Array.isArray(answer.selected) || answer.selected.some(value => typeof value !== 'string')
      || (answer.custom !== undefined && typeof answer.custom !== 'string')) return undefined
    if (new Set(answer.selected).size !== answer.selected.length || (answer.selected.length === 0 && (typeof answer.custom !== 'string' || answer.custom.trim() === ''))) return undefined
    seen.add(answer.id)
    const options = byId.get(answer.id)!.options
    if (answer.selected.length > 0 && (!Array.isArray(options) || answer.selected.some(value => !options.some(option => isObject(option) && option.label === value)))) return undefined
  }
  return `用户对 ask_user_question 的确认（${callId}）：\n${JSON.stringify({ questions, answers })}\n只有 answers 中的 selected 和 custom 表示用户反馈；未选选项不是授权。`
}

/** 同步问题的答案是 tool/result，不是 user/message；必须按真实调用身份配对，普通工具文本不成为用户授权。 */
const getHumanIntentMessages = (messages: readonly HostMessageInfo[]): HostMessageInfo[] => {
  const questions = new Map<string, Array<Record<string, unknown>> | null>()
  const human: HostMessageInfo[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && (message.source === undefined || message.source.kind === 'model')) {
      for (const block of message.content ?? []) {
        if (block.type !== 'tool-call' || block.name !== 'ask_user_question' || typeof block.id !== 'string' || block.id === '') continue
        const items = getQuestionItems(getJsonObject(block.arguments)?.questions)
        // 同一 callId 对应两个提问时不猜哪一份获得确认。
        questions.set(block.id, questions.has(block.id) ? null : items ?? null)
      }
    }
    if (message.role === 'tool' && message.source?.kind === 'tool' && message.isError !== true
      && typeof message.toolCallId === 'string' && message.toolCallId === message.source.callId) {
      const asked = questions.get(message.toolCallId)
      const confirmed = asked ? getConfirmedQuestionText(message.toolCallId, asked, getMessageText(message)) : undefined
      if (confirmed !== undefined) human.push({ ...message, content: [{ type: 'text', text: confirmed }] })
      continue
    }
    if (message.role !== 'user' || (message.source !== undefined && !['user', 'user-question-reply'].includes(message.source.kind ?? ''))) continue
    if (message.source?.kind === 'user-question-reply') {
      const text = getMessageText(message)
      const payload = getJsonObject(text)
      const asked = getQuestionItems(payload?.questions)
      const declared = typeof message.source.callId === 'string' ? questions.get(message.source.callId) : undefined
      // 已识别的问答不能因验证失败降格为普通 user 原话；只兼容无元数据的旧版自由文本。
      const structured = message.source.callId !== undefined || message.source.outcome !== undefined
        || (payload !== undefined && ['kind', 'tool', 'callId', 'questions', 'answers'].some(key => Object.hasOwn(payload, key)))
        || /answer_to_pending_question|send_user_message_question_reply|["'](?:callId|questions|answers|tool)["']\s*:/.test(text)
      if (message.source.outcome === 'answered' && typeof message.source.callId === 'string' && payload?.callId === message.source.callId
        && payload.kind === 'answer_to_pending_question' && payload.tool === 'ask_user_question' && asked !== undefined
        && declared != null && getQuestionContract(asked) === getQuestionContract(declared)) {
        const confirmed = getConfirmedQuestionText(message.source.callId, declared, payload)
        if (confirmed !== undefined) { human.push({ ...message, content: [{ type: 'text', text: confirmed }] }); continue }
      }
      if (structured) continue
    }
    human.push(message)
  }
  return human
}

const getMessageIntent = (agentId: string, message: HostMessageInfo): TaskIntent | undefined => {
  const text = getMessageText(message)
  if (text === '' || CONTROL_ONLY_MESSAGES.has(text)) return undefined
  // 没有稳定消息 ID 时只能识别最新可见内容；不用易因压缩变化的位置序号假装历史游标。
  const sourceRef = message.id ?? `${agentId}:user:content:${digest(text)}`
  return { text, source: 'host', sourceRef, digest: digest({ sourceRef, text }), refs: [{ source: sourceRef, text }] }
}

/** 使用公开的消息推导接口读取用户需求，不读取已废弃的同步 session.events。 */
export const getTaskIntent = (agent: AgentLike, card: TaskCard, previous?: TaskIntentCursorInfo): TaskIntent => {
  let historyNote = '宿主没有提供可读取的真实用户消息，使用显式任务需求'
  try {
    const users = getHumanIntentMessages(agent.session?.deriveMessages?.() ?? [])
    const cursor = previous?.intentSourceRef === undefined ? -1 : users.findLastIndex((message) => message.id === previous.intentSourceRef)
    if (cursor >= 0) {
      const cursorIntent = getMessageIntent(agent.id, users[cursor]!)
      const changedCursor = cursorIntent !== undefined && cursorIntent.digest !== previous?.intentLastDigest
      const pending = users.slice(cursor + (changedCursor ? 0 : 1)).map((message) => getMessageIntent(agent.id, message)).filter((item): item is TaskIntent => item !== undefined)
      const latest = pending.at(-1)
      if (latest !== undefined) return { ...latest, text: pending.map((item) => item.text).join('\n\n'), refs: pending.flatMap(item => item.refs ?? []), historyCoverage: 'since-cursor' }
      if (previous?.intentLastDigest !== undefined) return {
        text: cursorIntent?.text ?? card.intent?.text ?? card.goal, source: 'host', sourceRef: previous.intentSourceRef!, digest: previous.intentLastDigest, historyCoverage: 'since-cursor', refs: cursorIntent?.refs ?? []
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

export const getTaskIntentRefs = (task: Pick<TaskRecord, 'intentRefs' | 'intentText' | 'taskId' | 'requestRevision' | 'card'>): Array<{ source: string; text: string }> =>
  task.intentRefs?.map(ref => ({ ...ref })) ?? [{ source: `legacy-aggregate:${task.taskId}:r${task.requestRevision ?? 1}`, text: task.intentText ?? task.card.goal }]

/** 同一消息编辑替换原位置；新增消息顺序追加，不把聚合全文假归给最后一个消息 ID。 */
export const mergeTaskIntentRefs = (task: TaskRecord | undefined, intent: TaskIntent): Array<{ source: string; text: string }> => {
  const refs = new Map((task === undefined ? [] : getTaskIntentRefs(task)).map(ref => [ref.source, ref]))
  for (const ref of intent.refs ?? [{ source: intent.sourceRef, text: intent.text }]) refs.set(ref.source, { ...ref })
  return [...refs.values()]
}

export const getTaskIntentText = (refs: readonly { source: string; text: string }[]): string => refs.length === 1 && !refs[0]!.source.startsWith('legacy-aggregate:')
  ? refs[0]!.text
  : refs.map(ref => `${ref.source.startsWith('legacy-aggregate:') ? '旧版聚合需求（逐条出处不可恢复）' : '用户需求来源'}（${ref.source}）：\n${ref.text}`).join('\n\n')

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
