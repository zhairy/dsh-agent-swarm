import { createHash } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { LedgerEvent } from './evidence.js'

/** DSH 官方 Git 工作树 bundle 注册的模型工具。 */
export const WORKTREE_TOOL = 'create_worktree'

export interface CreatedWorktreeInfo {
  path: string
  branch: string
  baseCommit: string
  repositoryRoot: string
}

export interface WorktreeBindingInfo extends CreatedWorktreeInfo {
  worktreeId: string
  taskId: string
  delegationId: string
  agentId: string
  state: 'active' | 'recovery-required'
  retention: 'manual-only'
  createdAt: number
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const validString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)

const parseJsonObject = (value: string): unknown => {
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

/** 只接受 DSH 官方工具声明的四个结果字段；同时兼容直接结果和文本渲染结果。 */
export const ParseCreatedWorktree = (value: unknown): CreatedWorktreeInfo | undefined => {
  if (object(value) && validString(value.path) && validString(value.branch) && validString(value.baseCommit) && validString(value.repositoryRoot)) {
    if (!isAbsolute(value.path) || !isAbsolute(value.repositoryRoot)) return undefined
    const rel = relative(value.repositoryRoot, value.path)
    if (rel === '' || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return undefined
    return { path: value.path, branch: value.branch, baseCommit: value.baseCommit, repositoryRoot: value.repositoryRoot }
  }
  if (!object(value)) return undefined
  if (object(value.structured)) return ParseCreatedWorktree(value.structured)
  if (Array.isArray(value.content)) {
    for (const block of value.content) {
      if (!object(block) || block.type !== 'text' || typeof block.text !== 'string') continue
      const parsed = parseJsonObject(block.text)
      const result = ParseCreatedWorktree(parsed)
      if (result !== undefined) return result
    }
  }
  return undefined
}

export interface WorktreeRegistry {
  canCreate: (input: { agentId: string; taskId: string }) => string | undefined
  bind: (input: CreatedWorktreeInfo & { agentId: string; taskId: string; delegationId: string }) => WorktreeBindingInfo
  findByAgent: (agentId: string) => WorktreeBindingInfo | undefined
  findByTask: (taskId: string) => WorktreeBindingInfo[]
  findByPath: (path: string) => WorktreeBindingInfo | undefined
  project: (taskId?: string) => WorktreeBindingInfo[]
  hydrate: (events: readonly LedgerEvent[]) => void
}

const worktreeId = (path: string): string => `wt-${createHash('sha256').update(path).digest('hex').slice(0, 20)}`

/** Per-root registry. A retained worktree is never reused across tickets or assignments. */
export const intWorktreeRegistry = (deps: { now?: () => number } = {}): WorktreeRegistry => {
  const now = deps.now ?? Date.now
  const records = new Map<string, WorktreeBindingInfo>()
  const byAgent = new Map<string, string>()
  const byPath = new Map<string, string>()

  const bind = (input: CreatedWorktreeInfo & { agentId: string; taskId: string; delegationId: string }): WorktreeBindingInfo => {
    if (!validString(input.path) || !validString(input.branch) || !validString(input.baseCommit) || !validString(input.repositoryRoot)
      || !validString(input.agentId) || !validString(input.taskId) || !validString(input.delegationId)) throw new Error('工作树绑定字段无效')
    const existing = records.get(worktreeId(input.path))
    if (existing !== undefined) {
      if (existing.agentId !== input.agentId || existing.taskId !== input.taskId || existing.delegationId !== input.delegationId) {
        throw new Error('该工作树已经绑定到其它任务或专家，不能复用')
      }
      return structuredClone(existing)
    }
    const agentRecord = byAgent.get(input.agentId)
    if (agentRecord !== undefined) throw new Error('当前专家已经绑定工作树，不能创建第二棵可写工作树')
    const record: WorktreeBindingInfo = {
      ...input,
      worktreeId: worktreeId(input.path),
      state: 'active',
      retention: 'manual-only',
      createdAt: now()
    }
    records.set(record.worktreeId, record)
    byAgent.set(record.agentId, record.worktreeId)
    byPath.set(record.path, record.worktreeId)
    return structuredClone(record)
  }

  return {
    canCreate: ({ agentId, taskId }) => {
      const own = byAgent.get(agentId)
      if (own !== undefined) return '当前专家已经进入工作树，不能在同一执行身份中创建第二棵可写工作树'
      const taskBound = [...records.values()].find((record) => record.taskId === taskId)
      if (taskBound !== undefined) return '当前任务已经绑定工作树；新的专家执行身份应使用独立任务或显式恢复原工作树'
      return undefined
    },
    bind,
    findByAgent: (agentId) => {
      const id = byAgent.get(agentId)
      return id === undefined ? undefined : structuredClone(records.get(id)!)
    },
    findByTask: (taskId) => [...records.values()].filter((record) => record.taskId === taskId).map((record) => structuredClone(record)),
    findByPath: (path) => {
      const id = byPath.get(path)
      return id === undefined ? undefined : structuredClone(records.get(id)!)
    },
    project: (taskId) => [...records.values()].filter((record) => taskId === undefined || record.taskId === taskId).map((record) => structuredClone(record)),
    hydrate: (events) => {
      for (const event of events) {
        if (event.type !== 'worktree/created') continue
        const data = event.data
        const parsed = ParseCreatedWorktree(data)
        if (parsed === undefined || !validString(event.taskId) || !validString(event.delegationId) || !validString(data.agentId)) continue
        const id = worktreeId(parsed.path)
        if (records.has(id) || byAgent.has(data.agentId)) continue
        const record: WorktreeBindingInfo = {
          ...parsed,
          worktreeId: id,
          taskId: event.taskId,
          delegationId: event.delegationId,
          agentId: data.agentId,
          state: 'recovery-required',
          retention: 'manual-only',
          createdAt: Number.isFinite(data.createdAt) ? Number(data.createdAt) : Date.parse(event.ts)
        }
        records.set(id, record)
        byAgent.set(record.agentId, id)
        byPath.set(record.path, id)
      }
    }
  }
}
