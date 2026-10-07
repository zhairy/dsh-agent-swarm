import type { SubagentEndInfoLike } from './host-contract.js'
import { getRedactedText } from './jev.js'
import type { DelegableRoleId, SuanHengMode } from './role-registry.js'
import type { RouteKey } from './routes.js'
import type { PromptStyle } from './model-family.js'

/**
 * 专家会话策略：一次性调用，或连续会话（DSH continuable 子会话，可以反复追加内容）。
 * 由衡鉴（Jev）按任务判断：同一大类任务的后续工作追加到该专家已有的会话，保留上下文；
 * 一次性的独立工作用一次性调用。Jev 不可用时按规则回退。
 */

/** 一个连续会话：同一路由键（算衡按研算/验算区分）下的一个 continuable 子会话，可以跨任务追加 */
export interface ThreadInfo {
  /** 子会话 ID（也是子智能体的 agent id） */
  threadId: string
  key: RouteKey
  role: DelegableRoleId
  mode?: SuanHengMode
  /** 已处理的轮次（每次委派算一轮，含失败） */
  rounds: number
  /** 正在处理一轮委派；忙碌的会话不接受追加 */
  busy: boolean
  /** 会话无法再恢复（例如宿主拒绝投递），之后不再追加 */
  closed: boolean
  /** 建会话时是否开放了 web 工具；工具范围在建会话时固定，需要不同工具时另开会话 */
  allowWeb: boolean
  /** 建会话时按首选模型选定的提示风格；后续追加沿用同一风格，与 persona 保持一致 */
  style?: PromptStyle
  /** 该会话处理过的任务 */
  taskIds: string[]
  seenRevisions?: Record<string, { cardRevision: number; workflowRevision: number; requestRevision?: number }>
  /** 最近几轮的请求与结论，供衡鉴判断新请求是否同类 */
  history: Array<{ delegationId: string; taskId: string; request: string; summary: string; status: string }>
  createdAt: number
  lastUsedAt: number
}

const HISTORY_LIMIT = 5

/** 一个根会话内的连续会话登记表 */
export interface ThreadRegistry {
  Add: (thread: ThreadInfo) => void
  get: (threadId: string) => ThreadInfo | undefined
  /** 可追加的会话：同一路由键、空闲、未关闭，最近使用的在前 */
  getCandidates: (key: RouteKey) => ThreadInfo[]
  list: () => ThreadInfo[]
  Update: (threadId: string, patch: Partial<ThreadInfo>) => ThreadInfo | undefined
  /** 记录一轮结果并释放会话 */
  AddRound: (threadId: string, round: ThreadInfo['history'][number], now: number) => ThreadInfo | undefined
}

export const intThreadRegistry = (): ThreadRegistry => {
  const threads = new Map<string, ThreadInfo>()
  const Update: ThreadRegistry['Update'] = (threadId, patch) => {
    const current = threads.get(threadId)
    if (current === undefined) return undefined
    const next = { ...current, ...patch }
    threads.set(threadId, next)
    return next
  }
  return {
    Add: (thread) => { threads.set(thread.threadId, thread) },
    get: (threadId) => threads.get(threadId),
    getCandidates: (key) => [...threads.values()]
      .filter((thread) => thread.key === key && !thread.busy && !thread.closed)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    list: () => [...threads.values()],
    Update,
    AddRound: (threadId, round, now) => {
      const current = threads.get(threadId)
      if (current === undefined) return undefined
      return Update(threadId, {
        busy: false,
        rounds: current.rounds + 1,
        taskIds: current.taskIds.includes(round.taskId) ? current.taskIds : [...current.taskIds, round.taskId],
        history: [...current.history, round].slice(-HISTORY_LIMIT),
        lastUsedAt: now
      })
    }
  }
}

/** 等待某个子会话的下一次沉寂（subagent/end） */
export interface ChildEndHub {
  /**
   * 先登记再触发（创建或投递消息之前调用），否则可能错过结束事件
   * @returns promise 在结束时兑现；取消信号触发时以 AbortError 拒绝
   */
  wait: (childId: string, signal: AbortSignal) => Promise<SubagentEndInfoLike>
  /** 宿主的 subagent/end：交给登记最早的等待者；没有等待者时忽略（例如用户在界面里直接给子会话发消息） */
  Emit: (info: SubagentEndInfoLike) => void
  /** 本插件消费了一次结束：宿主随后给天枢的「子智能体已结束」通知是重复内容，可以滤掉 */
  MarkConsumed: (childId: string) => void
  /** 取走一次消费记录；返回 true 表示对应通知应当滤掉 */
  TakeConsumed: (childId: string) => boolean
}

export const intChildEndHub = (): ChildEndHub => {
  const waiters = new Map<string, Array<(info: SubagentEndInfoLike) => void>>()
  const consumed = new Map<string, number>()
  return {
    wait: (childId, signal) => new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      const settle = (info: SubagentEndInfoLike): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(info)
      }
      const onAbort = (): void => {
        const list = waiters.get(childId)?.filter((item) => item !== settle) ?? []
        if (list.length > 0) waiters.set(childId, list)
        else waiters.delete(childId)
        reject(new DOMException('aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.set(childId, [...(waiters.get(childId) ?? []), settle])
    }),
    Emit: (info) => {
      const list = waiters.get(info.id)
      if (list === undefined || list.length === 0) return
      const [first, ...rest] = list
      if (rest.length > 0) waiters.set(info.id, rest)
      else waiters.delete(info.id)
      first?.(info)
    },
    MarkConsumed: (childId) => { consumed.set(childId, (consumed.get(childId) ?? 0) + 1) },
    TakeConsumed: (childId) => {
      const count = consumed.get(childId) ?? 0
      if (count <= 0) return false
      if (count === 1) consumed.delete(childId)
      else consumed.set(childId, count - 1)
      return true
    }
  }
}

/** 本次委派的会话安排 */
export type SessionPlan =
  | { kind: 'oneshot'; source: SessionDecisionSource; reason: string; repeat?: number }
  | { kind: 'new'; source: SessionDecisionSource; reason: string; repeat?: number; sameCategory?: number }
  | { kind: 'continue'; threadId: string; source: SessionDecisionSource; reason: string; sameCategory?: number }

export type SessionDecisionSource = 'jev' | 'rules' | 'explicit' | 'config'

/** 天枢在 swarm_delegate 里显式指定的会话方式 */
export const SESSION_CHOICES = ['auto', 'new', 'continue', 'oneshot'] as const
export type SessionChoice = typeof SESSION_CHOICES[number]

/** Jev 不可用时默认开连续会话的角色：编辑、执行、验证与审查通常会按反馈反复调用 */
export const REPEAT_ROLES: readonly DelegableRoleId[] = ['zhu_jian', 'ji_feng', 'xing_zhou', 'fu_he', 'yu_shi']

/** 衡鉴的会话判断题 */
export const SESSION_QUESTIONS = {
  repeat: {
    type: 'noul',
    instructions: '在同一大类任务中，这位专家很可能还会被再次调用，并且保留它已有的上下文继续工作会更好（例如按审查意见修改、复查、补充验证、继续深入同一问题）',
    criteria: { true: '后续很可能还有同类的追加工作，保留上下文有明显价值', false: '这是一次性的独立工作，完成后不太会再追加' }
  }
} as const

export const SAME_CATEGORY_QUESTION = {
  type: 'noul',
  instructions: '新的委派请求与这位专家会话此前处理的工作属于同一大类任务，在原有上下文上继续追加更合适',
  criteria: { true: '同一目标或同一模块的后续工作，原有上下文可以直接复用', false: '主题不同或需要全新、独立的视角，应当开新会话' }
} as const

/**
 * 衡鉴判断会话方式的状态（全部脱敏截断）
 * @param {{ role: string; mode?: SuanHengMode; goal: string; request: string; thread?: ThreadInfo }} input - 角色、任务目标、新请求与候选会话
 * @returns {object} state
 */
export const getSessionState = (input: { roleName: string; mode?: SuanHengMode; goal: string; request: string; thread?: ThreadInfo }) => ({
  role: input.roleName,
  ...(input.mode === undefined ? {} : { mode: input.mode === 'research' ? '研算' : '验算' }),
  task_goal: getRedactedText(input.goal),
  new_request: getRedactedText(input.request, 1200),
  ...(input.thread === undefined ? {} : {
    existing_session: {
      rounds: input.thread.rounds,
      recent: input.thread.history.slice(-3).map((round) => ({ request: getRedactedText(round.request, 400), summary: getRedactedText(round.summary, 400) }))
    }
  })
})

/**
 * 会话判断题：有候选会话时加问「是否同类」
 * @param {boolean} hasThread - 是否有可追加的会话
 * @returns {Record<string, unknown>} Jev 题目
 */
export const getSessionQuestions = (hasThread: boolean): Record<string, unknown> =>
  hasThread ? { ...SESSION_QUESTIONS, same_category: SAME_CATEGORY_QUESTION } : { ...SESSION_QUESTIONS }

const getNoul = (answers: Record<string, unknown>, id: string): number | undefined => {
  const value = answers[id]
  const noul = value !== null && typeof value === 'object' ? (value as { noul?: unknown }).noul : undefined
  return typeof noul === 'number' ? Math.round(noul * 100) / 100 : undefined
}

/**
 * 由 Jev 答案决定会话方式
 * @param {Record<string, unknown>} answers - Jev 原始答案
 * @param {{ thread?: ThreadInfo; repeatAbove: number; sameCategoryAbove: number }} options - 候选会话与阈值
 * @returns {SessionPlan | undefined} 安排；答案缺项时为 undefined（由调用方按规则回退）
 */
export const ParseSessionPlan = (answers: Record<string, unknown>, options: { thread?: ThreadInfo; repeatAbove: number; sameCategoryAbove: number }): SessionPlan | undefined => {
  const repeat = getNoul(answers, 'repeat')
  const sameCategory = getNoul(answers, 'same_category')
  if (repeat === undefined) return undefined
  if (options.thread !== undefined && sameCategory !== undefined && sameCategory >= options.sameCategoryAbove) {
    return { kind: 'continue', threadId: options.thread.threadId, source: 'jev', reason: `同一大类任务（${sameCategory.toFixed(2)}），追加到已有会话`, sameCategory }
  }
  if (repeat >= options.repeatAbove) {
    return {
      kind: 'new', source: 'jev', repeat,
      reason: options.thread === undefined ? `同类任务还会再调用（${repeat.toFixed(2)}），开连续会话` : `与已有会话不同类（${(sameCategory ?? 0).toFixed(2)}），开新的连续会话`,
      ...(sameCategory === undefined ? {} : { sameCategory })
    }
  }
  return { kind: 'oneshot', source: 'jev', repeat, reason: `一次性工作（再次调用概率 ${repeat.toFixed(2)}）` }
}

/**
 * Jev 不可用时的规则：同一任务已有会话就追加；编辑、执行、验证、审查角色开连续会话；其余一次性
 * @param {{ role: DelegableRoleId; taskId: string; thread?: ThreadInfo; reason: string }} input - 角色、任务、候选会话与回退原因
 * @returns {SessionPlan} 安排
 */
export const getRuleSessionPlan = (input: { role: DelegableRoleId; taskId: string; thread?: ThreadInfo; reason: string }): SessionPlan => {
  if (input.thread !== undefined && input.thread.taskIds.includes(input.taskId)) {
    return { kind: 'continue', threadId: input.thread.threadId, source: 'rules', reason: `同一任务的后续工作，追加到已有会话（衡鉴未判断：${input.reason}）` }
  }
  if (REPEAT_ROLES.includes(input.role)) return { kind: 'new', source: 'rules', reason: `该角色通常需要反复调用，开连续会话（衡鉴未判断：${input.reason}）` }
  return { kind: 'oneshot', source: 'rules', reason: `一次性调用（衡鉴未判断：${input.reason}）` }
}
