import { randomUUID } from 'node:crypto'
import { SwarmError } from './util/errors.js'
import { getValueDigest } from './workflow.js'

export interface ContextBindingInfo {
  rootSessionId: string
  workspaceId: string
  taskId: string
  cardRevision: number
  workflowRevision: number
  requestRevision?: number
  threadId?: string
  blindReview?: boolean
}
export interface ContextArtifactInfo {
  ref: string
  digest: string
  binding: ContextBindingInfo
  layer: 'L0' | 'L1' | 'L2'
  kind: 'contract' | 'source' | 'evidence' | 'history' | 'experience' | 'author-reasoning'
  text: string
  allowThreads?: string[]
}
export interface ContextPageInfo {
  ref: string
  digest: string
  layer: ContextArtifactInfo['layer']
  kind: ContextArtifactInfo['kind']
  text: string
  cursor: string
  nextCursor: string | null
  truncated: boolean
  totalBytes: number
  cardRevision: number
  workflowRevision: number
  requestRevision?: number
}
export interface PreparedTaskContextReplacement {
  /** Detached snapshots; the live store is unchanged until commit succeeds. */
  readonly artifacts: ContextArtifactInfo[]
  readonly replaced: ContextArtifactInfo[]
  commit: () => void
  /** Release rollback capacity after the caller's durable transaction succeeds. */
  finalize: () => void
  /** Refuses to overwrite changes made to the same task after this commit. */
  rollback: () => void
}
export interface ContextStore {
  Add: (input: Omit<ContextArtifactInfo, 'ref' | 'digest'>) => ContextArtifactInfo
  PrepareTaskReplace: (binding: ContextBindingInfo, inputs: Array<Omit<ContextArtifactInfo, 'ref' | 'digest' | 'binding'>>) => PreparedTaskContextReplacement
  Restore: (artifact: unknown, expectedBinding?: ContextBindingInfo) => ContextArtifactInfo
  Read: (binding: ContextBindingInfo, ref: string, options?: { cursor?: string; limit?: number; expectedDigest?: string }) => ContextPageInfo
  List: (binding: ContextBindingInfo) => Array<Pick<ContextPageInfo, 'ref' | 'digest' | 'layer' | 'kind' | 'totalBytes' | 'cardRevision' | 'workflowRevision' | 'requestRevision'>>
  DelTask: (rootSessionId: string, taskId: string) => void
}

/** 受控引用读取；ID 不是授权，始终检查根、工作区、任务、版本与盲审权限。 */
export const intContextStore = (limits: { maxArtifacts?: number; maxArtifactBytes?: number; maxPageChars?: number } = {}): ContextStore => {
  const store = new Map<string, ContextArtifactInfo>()
  const byTask = new Map<string, { refs: Set<string>; version: number }>()
  const replacements = new Map<string, symbol>()
  let rollbackSlots = 0
  const maxArtifacts = limits.maxArtifacts ?? 512
  const maxArtifactBytes = limits.maxArtifactBytes ?? 1024 * 1024
  const maxPageChars = limits.maxPageChars ?? 8000
  const taskKey = (owner: Pick<ContextBindingInfo, 'rootSessionId' | 'taskId'>) => JSON.stringify([owner.rootSessionId, owner.taskId])
  const sameRevision = (a: ContextBindingInfo, b: ContextBindingInfo) => a.rootSessionId === b.rootSessionId && a.workspaceId === b.workspaceId && a.taskId === b.taskId
    && a.cardRevision === b.cardRevision && a.workflowRevision === b.workflowRevision && (a.requestRevision ?? 1) === (b.requestRevision ?? 1)
  const mutable = (key: string, token?: symbol) => {
    if (replacements.has(key) && replacements.get(key) !== token) throw new SwarmError('INVALID_ARGS', '当前任务上下文正在提交，请等待本轮合同事务完成')
  }
  const put = (artifact: ContextArtifactInfo) => {
    store.set(artifact.ref, artifact)
    const key = taskKey(artifact.binding)
    let group = byTask.get(key)
    if (!group) { group = { refs: new Set(), version: 0 }; byTask.set(key, group) }
    group.refs.add(artifact.ref); group.version++
  }
  const remove = (artifact: ContextArtifactInfo) => {
    store.delete(artifact.ref)
    const key = taskKey(artifact.binding), group = byTask.get(key)
    if (group) { group.refs.delete(artifact.ref); group.version++; if (group.refs.size === 0) byTask.delete(key) }
  }
  const fits = (removed: number, added: number) => {
    if (store.size + rollbackSlots - removed + added > maxArtifacts) throw new SwarmError('INVALID_ARGS', '上下文材料超过容量上限')
  }
  const requireArtifact = (binding: ContextBindingInfo, ref: string, expectedDigest?: string): ContextArtifactInfo => {
    const artifact = store.get(ref)
    if (artifact === undefined) throw new SwarmError('INVALID_ARGS', '上下文引用不存在')
    const owner = artifact.binding
    if (owner.rootSessionId !== binding.rootSessionId || owner.workspaceId !== binding.workspaceId || owner.taskId !== binding.taskId) throw new SwarmError('INVALID_ARGS', '无权读取其他会话、工作区或任务的材料')
    if (owner.cardRevision !== binding.cardRevision || owner.workflowRevision !== binding.workflowRevision) throw new SwarmError('INVALID_ARGS', '材料版本过期')
    if ((owner.requestRevision ?? 1) !== (binding.requestRevision ?? 1)) throw new SwarmError('INVALID_ARGS', '材料需求版本过期')
    if (artifact.allowThreads !== undefined && (binding.threadId === undefined || !artifact.allowThreads.includes(binding.threadId))) throw new SwarmError('INVALID_ARGS', '当前专家没有材料读取权限')
    if (binding.blindReview === true && ['author-reasoning', 'history', 'experience'].includes(artifact.kind)) throw new SwarmError('INVALID_ARGS', '独立盲审不能读取作者过程或历史结论')
    if (expectedDigest !== undefined && expectedDigest !== artifact.digest) throw new SwarmError('INVALID_ARGS', '材料摘要已改变')
    return artifact
  }
  const ValidateArtifact = (raw: unknown): ContextArtifactInfo => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SwarmError('INVALID_ARGS', '恢复材料必须为对象')
    const input = raw as Record<string, unknown>
    if (Object.keys(input).some((key) => !['ref', 'digest', 'binding', 'layer', 'kind', 'text', 'allowThreads'].includes(key))) throw new SwarmError('INVALID_ARGS', '恢复材料含未知字段')
    if (typeof input.ref !== 'string' || !/^ctx-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.ref) || typeof input.digest !== 'string' || !/^[0-9a-f]{64}$/.test(input.digest) || typeof input.text !== 'string' || input.digest !== getValueDigest(input.text)) throw new SwarmError('INVALID_ARGS', '恢复材料引用或摘要不合法')
    if (!['L0', 'L1', 'L2'].includes(String(input.layer)) || !['contract', 'source', 'evidence', 'history', 'experience', 'author-reasoning'].includes(String(input.kind))) throw new SwarmError('INVALID_ARGS', '恢复材料类型不合法')
    if (input.binding === null || typeof input.binding !== 'object' || Array.isArray(input.binding)) throw new SwarmError('INVALID_ARGS', '恢复材料缺少身份绑定')
    const binding = input.binding as Record<string, unknown>
    if (Object.keys(binding).some((key) => !['rootSessionId', 'workspaceId', 'taskId', 'cardRevision', 'workflowRevision', 'requestRevision', 'threadId', 'blindReview'].includes(key)) || ['rootSessionId', 'workspaceId', 'taskId'].some((key) => typeof binding[key] !== 'string' || String(binding[key]).trim() === '') || ['cardRevision', 'workflowRevision'].some((key) => !Number.isSafeInteger(binding[key]) || Number(binding[key]) < 1) || (binding.requestRevision !== undefined && (!Number.isSafeInteger(binding.requestRevision) || Number(binding.requestRevision) < 1))) throw new SwarmError('INVALID_ARGS', '恢复材料身份或版本不合法')
    if ((binding.threadId !== undefined && typeof binding.threadId !== 'string') || (binding.blindReview !== undefined && typeof binding.blindReview !== 'boolean') || (input.allowThreads !== undefined && (!Array.isArray(input.allowThreads) || input.allowThreads.some((thread) => typeof thread !== 'string' || thread.trim() === '')))) throw new SwarmError('INVALID_ARGS', '恢复材料专家权限不合法')
    if (Buffer.byteLength(input.text, 'utf8') > maxArtifactBytes) throw new SwarmError('INVALID_ARGS', '恢复材料超过容量上限')
    return { ...structuredClone(input), binding: { ...structuredClone(binding), requestRevision: binding.requestRevision ?? 1 } } as unknown as ContextArtifactInfo
  }
  const makeArtifact = (input: Omit<ContextArtifactInfo, 'ref' | 'digest'>) => ValidateArtifact({ ...input, ref: `ctx-${randomUUID()}`, digest: getValueDigest(input.text) })
  return {
    Add: (input) => {
      mutable(taskKey(input.binding)); fits(0, 1)
      const artifact = makeArtifact(input)
      put(artifact)
      return structuredClone(artifact)
    },
    PrepareTaskReplace: (binding, inputs) => {
      const key = taskKey(binding)
      mutable(key)
      if (!Array.isArray(inputs) || inputs.length === 0) throw new SwarmError('INVALID_ARGS', '合同替换必须包含新材料')
      const artifacts = inputs.map((input) => makeArtifact({ ...input, binding }))
      const group = byTask.get(key), version = group?.version
      const replaced = [...(group?.refs ?? [])].flatMap((ref) => { const entry = store.get(ref)!; return sameRevision(entry.binding, binding) ? [] : [entry] })
      fits(replaced.length, artifacts.length)
      const token = Symbol('context-replacement')
      const reserved = Math.max(0, replaced.length - artifacts.length)
      let state: 'prepared' | 'committed' | 'finalized' | 'rolled-back' = 'prepared'
      const release = () => { rollbackSlots -= reserved; replacements.delete(key) }
      return {
        get artifacts () { return structuredClone(artifacts) },
        get replaced () { return structuredClone(replaced) },
        commit: () => {
          if (state === 'committed' || state === 'finalized') return
          if (state !== 'prepared') throw new SwarmError('INVALID_ARGS', '已回滚的上下文事务不能重新提交')
          mutable(key)
          if (byTask.get(key) !== group || group?.version !== version) throw new SwarmError('STALE_EVIDENCE', '任务材料在预检后改变，请重新准备合同替换')
          fits(replaced.length, artifacts.length)
          // Every capacity and schema check precedes this synchronous, task-scoped map mutation.
          for (const artifact of replaced) remove(artifact)
          for (const artifact of artifacts) put(artifact)
          rollbackSlots += reserved; replacements.set(key, token); state = 'committed'
        },
        finalize: () => {
          if (state === 'finalized' || state === 'rolled-back') return
          if (state !== 'committed') throw new SwarmError('INVALID_ARGS', '上下文替换尚未提交')
          release(); state = 'finalized'
        },
        rollback: () => {
          if (state === 'rolled-back') return
          if (state === 'prepared') { state = 'rolled-back'; return }
          if (state !== 'committed' || replacements.get(key) !== token) throw new SwarmError('STALE_EVIDENCE', '已确认的上下文事务不能回滚')
          // Same-task mutators are fenced until finalize/rollback; other tasks keep their own materials.
          for (const artifact of artifacts) remove(artifact)
          for (const artifact of replaced) put(artifact)
          release(); state = 'rolled-back'
        }
      }
    },
    Restore: (raw, expectedBinding) => {
      const artifact = ValidateArtifact(raw)
      if (expectedBinding !== undefined && ['rootSessionId', 'workspaceId', 'taskId', 'cardRevision', 'workflowRevision'].some((key) => artifact.binding[key as keyof ContextBindingInfo] !== expectedBinding[key as keyof ContextBindingInfo])) throw new SwarmError('INVALID_ARGS', '恢复材料不属于当前身份或版本')
      if (expectedBinding !== undefined && (artifact.binding.requestRevision ?? 1) !== (expectedBinding.requestRevision ?? 1)) throw new SwarmError('INVALID_ARGS', '恢复材料不属于当前需求版本')
      const existing = store.get(artifact.ref)
      if (existing !== undefined) {
        if (getValueDigest(existing) !== getValueDigest(artifact)) throw new SwarmError('INVALID_ARGS', '恢复材料同 ID 存在内容或权限冲突')
        return structuredClone(existing)
      }
      mutable(taskKey(artifact.binding)); fits(0, 1)
      put(artifact)
      return structuredClone(artifact)
    },
    Read: (binding, ref, options = {}) => {
      const artifact = requireArtifact(binding, ref, options.expectedDigest)
      const owner = artifact.binding
      const cursor = options.cursor ?? '0'
      if (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new SwarmError('INVALID_ARGS', 'cursor 必须是合法偏移')
      let start = Number(cursor)
      if (start > artifact.text.length) throw new SwarmError('INVALID_ARGS', 'cursor 超出材料范围')
      const limit = options.limit ?? maxPageChars
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageChars) throw new SwarmError('INVALID_ARGS', '上下文页大小不合法')
      // UTF-16 页边界不拆开代理对；游标仍是字符偏移，不伪装成字节。
      if (start > 0 && /[\uDC00-\uDFFF]/.test(artifact.text[start] ?? '') && /[\uD800-\uDBFF]/.test(artifact.text[start - 1] ?? '')) start -= 1
      let end = Math.min(artifact.text.length, start + limit)
      if (end < artifact.text.length && /[\uD800-\uDBFF]/.test(artifact.text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(artifact.text[end] ?? '')) end += 1
      return { ref, digest: artifact.digest, layer: artifact.layer, kind: artifact.kind, text: artifact.text.slice(start, end), cursor: String(start), nextCursor: end < artifact.text.length ? String(end) : null, truncated: start > 0 || end < artifact.text.length, totalBytes: Buffer.byteLength(artifact.text, 'utf8'), cardRevision: owner.cardRevision, workflowRevision: owner.workflowRevision, requestRevision: owner.requestRevision ?? 1 }
    },
    List: (binding) => [...(byTask.get(taskKey(binding))?.refs ?? [])].flatMap((ref) => {
      try {
        const artifact = requireArtifact(binding, ref)
        return [{ ref: artifact.ref, digest: artifact.digest, layer: artifact.layer, kind: artifact.kind,
          totalBytes: Buffer.byteLength(artifact.text, 'utf8'), cardRevision: artifact.binding.cardRevision,
          workflowRevision: artifact.binding.workflowRevision, requestRevision: artifact.binding.requestRevision ?? 1 }]
      } catch { return [] }
    }),
    DelTask: (rootSessionId, taskId) => {
      const key = taskKey({ rootSessionId, taskId }); mutable(key)
      for (const ref of [...(byTask.get(key)?.refs ?? [])]) remove(store.get(ref)!)
    }
  }
}

/** 只有相同语义版本才能在专家续会话里省略完整任务背景。 */
export const isContextRevisionKnown = (seen: { cardRevision: number; workflowRevision: number; requestRevision?: number } | undefined, current: { cardRevision: number; workflowRevision: number; requestRevision?: number }): boolean => seen?.cardRevision === current.cardRevision && seen.workflowRevision === current.workflowRevision && (seen.requestRevision ?? 1) === (current.requestRevision ?? 1)
