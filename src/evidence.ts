import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvidenceItem } from './contracts.js'
import type { FindingResolution, GateDelegationView, GateRequirement, TaskCard, TriageAnswers } from './policy.js'
import type { RouteInfo } from './routes.js'
import { SwarmError } from './util/errors.js'
import type { PromptStyle } from './model-family.js'

export type DelegationStatus = GateDelegationView['status']
export type BackendKind = 'spawn' | 'codex' | 'codex-edit' | 'claude-plan' | 'claude-edit'

/** 一次路由尝试的记录 */
export interface RouteAttempt {
  route: string
  backend: BackendKind
  outcome: 'skipped' | 'failed' | 'used' | 'fallback'
  reason?: string
}

/** 衡鉴复评：交付完成后由 Jev 给出的置信度评分；它衡量判断的集中程度，不等于正确性，不作为硬门槛 */
export interface AssessmentInfo {
  status: 'ok' | 'unavailable'
  /** 未执行的原因（例如 missing-api-key、disabled、http-503） */
  reason?: string
  /** 可信 / 需核实 / 存疑 */
  verdict?: 'trusted' | 'review' | 'doubtful'
  /** 整体可信度，0–1（四档评分的期望值归一化） */
  reliability?: number
  /** Jev 对该评分的置信度（分布集中程度） */
  confidence?: number
  /** 各项是/否检查为「成立」的概率 */
  checks?: Record<string, number>
  model?: string
}

/** 一次委派的完整记录 */
export interface DelegationRecord extends GateDelegationView {
  taskId: string
  roleName: string
  gate?: string
  summary: string
  evidence: EvidenceItem[]
  route?: RouteInfo
  backend?: BackendKind
  attempts: RouteAttempt[]
  hardIsolation: boolean
  changedFiles?: string[]
  changeTracking?: 'git' | 'unavailable'
  unresolved: string[]
  childId?: string
  error?: string
  startedAt: number
  durationMs?: number
  /** 本次委派触发了容灾升级：原因与升级模型链 */
  upgrade?: { reasons: string[]; chain: string[] }
  /** 衡鉴复评 */
  assessment?: AssessmentInfo
  /** 会话方式：一次性，或连续会话（threadId 为子会话 ID，round 为该会话的第几轮） */
  session?: DelegationSessionInfo
  /** 自动重试：未执行、中断、出错或交付不合格时的重试记录 */
  retries?: DelegationRetryInfo[]
  /** 按所用模型家族选定的提示风格（claude / gpt / generic） */
  promptStyle?: PromptStyle
}

/** 一次委派的会话方式 */
export interface DelegationSessionInfo {
  kind: 'oneshot' | 'continuable'
  /** 连续会话的子会话 ID */
  threadId?: string
  /** 连续会话的第几轮（从 1 开始） */
  round?: number
  /** 是否追加到了已有会话 */
  appended: boolean
  /** 决定来源：衡鉴、规则、天枢指定或配置 */
  source: string
  reason: string
}

/** 一次自动重试 */
export interface DelegationRetryInfo {
  attempt: number
  reason: string
  /** continue：在同一会话里续跑或修正；restart：重新启动一次性子智能体；fallback：退回一次性调用 */
  action: 'continue' | 'restart' | 'fallback'
}

/** 衡鉴分流记录 */
export interface TriageRecord {
  source: 'rules' | 'rules+jev' | 'rules+jev-fallback'
  answers?: TriageAnswers
  fallbackReason?: string
  rulesApplied: string[]
}

/** 验收记录 */
export interface AcceptanceRecord {
  decision: 'accept' | 'reject' | 'incomplete'
  status: 'accepted' | 'blocked' | 'recorded'
  summary: string
  missing: string[]
  unresolved: string[]
  stopReason: string
  resolutions: FindingResolution[]
  at: number
}

/** 任务记录 */
export interface TaskRecord {
  taskId: string
  sessionId: string
  card: TaskCard
  gates: GateRequirement[]
  triage: TriageRecord
  delegationIds: string[]
  rounds: number
  acceptance?: AcceptanceRecord
  createdAt: number
  updatedAt: number
}

const TRANSITIONS: Readonly<Record<DelegationStatus, readonly DelegationStatus[]>> = {
  queued: ['running', 'blocked', 'failed'],
  running: ['completed', 'failed', 'blocked'],
  completed: [],
  failed: [],
  blocked: []
}

/**
 * 委派状态是否允许从 from 迁移到 to（终态不可再变）
 * @param {DelegationStatus} from - 当前状态
 * @param {DelegationStatus} to - 目标状态
 * @returns {boolean} 是否允许
 */
export const ValidateTransition = (from: DelegationStatus, to: DelegationStatus): boolean => TRANSITIONS[from].includes(to)

/** 单个根会话内的任务与委派存储 */
export interface TaskStore {
  AddTask: (task: TaskRecord) => void
  getTask: (taskId: string) => TaskRecord | undefined
  UpdateTask: (taskId: string, patch: Partial<TaskRecord>) => TaskRecord
  AddDelegation: (record: DelegationRecord) => void
  UpdateDelegation: (delegationId: string, patch: Partial<DelegationRecord>) => DelegationRecord
  getDelegation: (delegationId: string) => DelegationRecord | undefined
  getTaskDelegations: (taskId: string) => DelegationRecord[]
  getTasks: () => TaskRecord[]
}

/**
 * 创建内存存储；更新总是替换为新对象，旧引用保持不变
 * @returns {TaskStore} 存储
 */
export const intTaskStore = (): TaskStore => {
  const tasks = new Map<string, TaskRecord>()
  const delegations = new Map<string, DelegationRecord>()

  const UpdateTask = (taskId: string, patch: Partial<TaskRecord>): TaskRecord => {
    const current = tasks.get(taskId)
    if (current === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${taskId}`)
    const next = { ...current, ...patch, updatedAt: Date.now() }
    tasks.set(taskId, next)
    return next
  }

  const AddDelegation = (record: DelegationRecord): void => {
    const task = tasks.get(record.taskId)
    if (task === undefined) throw new SwarmError('UNKNOWN_TASK', `未知任务：${record.taskId}`)
    delegations.set(record.delegationId, record)
    UpdateTask(record.taskId, { delegationIds: [...task.delegationIds, record.delegationId] })
  }

  const UpdateDelegation = (delegationId: string, patch: Partial<DelegationRecord>): DelegationRecord => {
    const current = delegations.get(delegationId)
    if (current === undefined) throw new SwarmError('UNKNOWN_TASK', `未知委派：${delegationId}`)
    if (patch.status !== undefined && patch.status !== current.status && !ValidateTransition(current.status, patch.status)) {
      throw new SwarmError('INVALID_TRANSITION', `委派 ${delegationId} 不允许从 ${current.status} 变为 ${patch.status}`)
    }
    const next = { ...current, ...patch }
    delegations.set(delegationId, next)
    return next
  }

  return {
    AddTask: (task) => { tasks.set(task.taskId, task) },
    getTask: (taskId) => tasks.get(taskId),
    UpdateTask,
    AddDelegation,
    UpdateDelegation,
    getDelegation: (delegationId) => delegations.get(delegationId),
    getTaskDelegations: (taskId) =>
      (tasks.get(taskId)?.delegationIds ?? []).map((id) => delegations.get(id)).filter((d): d is DelegationRecord => d !== undefined),
    getTasks: () => [...tasks.values()]
  }
}

export type LedgerEventType =
  | 'task/card' | 'delegation/queued' | 'delegation/running' | 'delegation/completed' | 'delegation/failed'
  | 'delegation/blocked' | 'route/skipped' | 'route/fallback' | 'route/upgrade' | 'jev/call' | 'review/assessment' | 'native/call' | 'accept/decision'
  | 'session/plan' | 'delegation/retry'

/** 账本事件（一行 JSON） */
export interface LedgerEvent {
  ts: string
  type: LedgerEventType
  sessionId: string
  taskId?: string
  delegationId?: string
  data: Record<string, unknown>
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi
]
const MAX_LEDGER_TEXT = 2000

/**
 * 深度脱敏：字符串去除密钥样式内容并截断
 * @param {unknown} value - 任意值
 * @returns {unknown} 脱敏后的新值
 */
export const getRedactedValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[已脱敏]'), value).slice(0, MAX_LEDGER_TEXT)
  }
  if (Array.isArray(value)) return value.map(getRedactedValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, getRedactedValue(item)]))
  }
  return value
}

/**
 * 账本文件路径：会话 id 中的非安全字符替换为下划线
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @returns {string} 文件路径
 */
export const getLedgerPath = (dir: string, sessionId: string): string =>
  join(dir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.jsonl`)

/** 账本句柄 */
export interface Ledger {
  path: string
  AddLedgerEvent: (event: Omit<LedgerEvent, 'ts' | 'sessionId'>) => void
}

/**
 * 创建追加写入的 JSONL 账本；写入失败只回调 onError，不影响任务执行
 * @param {string} dir - 账本目录
 * @param {string} sessionId - 根会话 id
 * @param {(error: unknown) => void} [onError] - 写入失败回调
 * @returns {Ledger} 账本
 */
export const intLedger = (dir: string, sessionId: string, onError?: (error: unknown) => void): Ledger => {
  const path = getLedgerPath(dir, sessionId)
  return {
    path,
    AddLedgerEvent: (event) => {
      try {
        mkdirSync(dir, { recursive: true })
        const line: LedgerEvent = { ts: new Date().toISOString(), sessionId, ...event, data: getRedactedValue(event.data) as Record<string, unknown> }
        appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8')
      } catch (error) {
        onError?.(error)
      }
    }
  }
}

/**
 * 读回账本事件，跳过无法解析的行
 * @param {string} path - 账本文件
 * @returns {LedgerEvent[]} 事件列表
 */
export const getLedgerEvents = (path: string): LedgerEvent[] => {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').filter((line) => line.trim() !== '').flatMap((line) => {
    try {
      return [JSON.parse(line) as LedgerEvent]
    } catch {
      return []
    }
  })
}
