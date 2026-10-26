import type { DurableStateStore } from './state-store.js'
import type { TaskRecord } from './evidence.js'
import { getCanonicalJson, getValueDigest } from './workflow.js'
import { intMutex } from './util/mutex.js'
import { RUNTIME_POLICY_VERSION } from './verification-receipt.js'

export type ProgressAction = 'plan-review' | 'delegate' | 'checkpoint' | 'root-round'
export interface ProgressControl {
  lineageId: string
  rootSessionId: string
  workspaceId: string
  taskIds: string[]
  policyVersion: typeof RUNTIME_POLICY_VERSION
  status: 'active' | 'stalled' | 'exhausted'
  historyCount: number
  activations: number
  recoveries: number
  replans: number
  lastFingerprint?: string
  taskGraphs?: Record<string, string>
  lastUserEvent?: string
  reason?: string
  legacyBaseline: boolean
  observedFacts?: Record<string, string>
}
export interface ProgressSignature { fingerprint: string; canonical: string; action: ProgressAction; hits: number; at: number }
export interface ProgressPage { lineageId: string; page: number; items: ProgressSignature[] }
export interface ProgressGuardState { runtimeControls?: Record<string, ProgressControl>; progressHistory?: Record<string, ProgressPage> }
export interface ProgressObservation { lineageId: string; taskId?: string; action: ProgressAction; projection: unknown; graphDigest?: string; waiting?: boolean; recoveryEvent?: string; replan?: boolean; legacyBaseline?: boolean }
const PAGE_SIZE = 32
const HISTORY_LIMIT = 1024
const ACTIVATION_LIMIT = 4096
const RECOVERY_LIMIT = 4
const REPLAN_LIMIT = 4
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export const ValidateProgressControl = (value: unknown): value is ProgressControl => {
  if (!value || typeof value !== 'object') return false
  const c = value as ProgressControl
  return hash(c.lineageId) && typeof c.rootSessionId === 'string' && c.rootSessionId.length > 0 && c.rootSessionId.length <= 512 && hash(c.workspaceId) && c.policyVersion === RUNTIME_POLICY_VERSION && ['active', 'stalled', 'exhausted'].includes(c.status)
    && Array.isArray(c.taskIds) && c.taskIds.length <= 128 && new Set(c.taskIds).size === c.taskIds.length && c.taskIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)
    && [c.historyCount, c.activations, c.recoveries, c.replans].every(n => Number.isSafeInteger(n) && n >= 0)
    && c.historyCount <= HISTORY_LIMIT && c.activations <= ACTIVATION_LIMIT && c.recoveries <= RECOVERY_LIMIT && c.replans <= REPLAN_LIMIT && typeof c.legacyBaseline === 'boolean'
    && (c.lastFingerprint === undefined || hash(c.lastFingerprint)) && (c.lastUserEvent === undefined || typeof c.lastUserEvent === 'string' && c.lastUserEvent.length <= 512)
    && (c.taskGraphs === undefined || c.taskGraphs !== null && typeof c.taskGraphs === 'object' && !Array.isArray(c.taskGraphs) && Object.keys(c.taskGraphs).length <= 128 && Object.entries(c.taskGraphs).every(([taskId,value]) => c.taskIds.includes(taskId) && hash(value)))
    && (c.reason === undefined || typeof c.reason === 'string' && c.reason.length <= 1024)
    && (c.observedFacts === undefined || c.observedFacts !== null && typeof c.observedFacts === 'object' && !Array.isArray(c.observedFacts) && Object.keys(c.observedFacts).length <= 64 && Object.entries(c.observedFacts).every(([key,value]) => hash(key) && hash(value)))
}
export const ValidateProgressPage = (value: unknown): value is ProgressPage => {
  if (!value || typeof value !== 'object') return false
  const p = value as ProgressPage
  try { return hash(p.lineageId) && Number.isSafeInteger(p.page) && p.page >= 0 && p.page < HISTORY_LIMIT / PAGE_SIZE && Array.isArray(p.items) && p.items.length > 0 && p.items.length <= PAGE_SIZE
    && p.items.every(item => hash(item.fingerprint) && typeof item.canonical === 'string' && item.canonical.length <= 16384 && getValueDigest({ action: item.action, projection: JSON.parse(item.canonical) }) === item.fingerprint
      && ['plan-review', 'delegate', 'checkpoint', 'root-round'].includes(item.action) && Number.isSafeInteger(item.hits) && item.hits >= 1 && Number.isFinite(item.at)) } catch { return false }
}

/** 忽略显示标签/节点UUID；保留角色、操作、输出合同、必需门禁与真实依赖方向。 */
export const getWorkflowStructure = (task: TaskRecord): Array<{ shape: string; status: string }> => {
  const nodes = task.workflowDefinition?.nodes ?? []
  const byId = new Map(nodes.map(node => [node.id, node]))
  const cache = new Map<string, string>()
  const visiting = new Set<string>()
  const describe = (id: string): string => {
    if (cache.has(id)) return cache.get(id)!
    const node = byId.get(id)
    if (!node || visiting.has(id)) throw new Error('Invalid progress graph')
    visiting.add(id)
    const signature = getValueDigest({ operation: node.operation, role: node.role ?? null, gates: [...(node.gates ?? [])].sort(), output: node.outputContractVersion, parents: node.dependsOn.map(describe).sort() })
    visiting.delete(id); cache.set(id, signature); return signature
  }
  return nodes.map(node => ({ shape: describe(node.id), status: task.workflowState?.nodes[node.id]?.status ?? 'pending' })).sort((a,b) => a.shape.localeCompare(b.shape) || a.status.localeCompare(b.status))
}

export const getProgressProjection = (task: TaskRecord, extra: Record<string, unknown> = {}): unknown => ({
  artifact: task.artifactSnapshot?.digest ?? null,
  scope: [...task.card.scope].sort(),
  graph: { digest: getValueDigest(getWorkflowStructure(task)), nodes: task.workflowDefinition?.nodes.length ?? 0 },
  unresolvedCount: task.checkpoint?.unresolved.length ?? 0,
  requiredGates: task.gates.map(gate => gate.gate).sort(),
  ...extra
})

/** 分页历史只装载一次索引；每次仅改一个≤32项的页，不复制TaskRecord里的全历史Set。 */
export const createProgressGuard = <T extends ProgressGuardState>(store: DurableStateStore<T>, now: () => number = Date.now, scope = { rootSessionId: 'local', workspaceId: '0'.repeat(64) }) => {
  const mutex = intMutex()
  const index = new Map<string, { pageKey: string; fingerprint: string; canonical: string; hits: number }>()
  const tasks = new Map<string, string>()
  const controls = store.readFields?.(['runtimeControls']).runtimeControls ?? store.read().runtimeControls ?? {}
  for (const control of Object.values(controls)) for (const taskId of control.taskIds) tasks.set(taskId, control.lineageId)
  const pages = store.readFields?.(['progressHistory']).progressHistory ?? store.read().progressHistory ?? {}
  for (const [pageKey, page] of Object.entries(pages)) for (const item of page.items) index.set(page.lineageId + ':' + item.fingerprint, { pageKey, fingerprint: item.fingerprint, canonical: item.canonical, hits: item.hits })
  const readControl = (lineageId: string) => store.readPath === undefined ? store.read().runtimeControls?.[lineageId] : store.readPath<ProgressControl>(['runtimeControls', lineageId])
  return {
    get: readControl,
    forTask: (taskId: string) => { const lineage = tasks.get(taskId); return lineage === undefined ? undefined : readControl(lineage) },
    lineageFor: (task: TaskRecord, workspaceId: string): string => tasks.get(task.taskId) ?? getValueDigest({ rootSessionId: task.sessionId, workspaceId, userSource: task.intentSource === 'host' ? task.intentSourceRef ?? 'unavailable' : 'declared-task:' + task.taskId }),
    bindTask: (task: TaskRecord, workspaceId: string, rootScopeLineage?: string): Promise<string> => mutex.run(async () => {
      const lineageId = tasks.get(task.taskId) ?? rootScopeLineage ?? getValueDigest({ rootSessionId: task.sessionId, workspaceId, userSource: task.intentSource === 'host' ? task.intentSourceRef ?? 'unavailable' : 'declared-task:' + task.taskId })
      if (!hash(lineageId)) throw new Error('Invalid runtime lineage')
      await store.update('runtime/task-linked', { build: state => {
        const old = state.runtimeControls?.[lineageId]
        if (old?.taskIds.includes(task.taskId)) return {}
        if (old && old.taskIds.length >= 128) throw new Error('Runtime lineage task capacity reached')
        const control: ProgressControl = old ? { ...old, taskIds: [...old.taskIds, task.taskId] } : { lineageId, ...scope, taskIds: [task.taskId], policyVersion: RUNTIME_POLICY_VERSION, status: 'active', historyCount: 0, activations: 0, recoveries: 0, replans: 0, legacyBaseline: task.recovered === true }
        return { set: { runtimeControls: { [lineageId]: control } } }
      } })
      tasks.set(task.taskId, lineageId)
      return lineageId
    }),
    recordFact: (taskId: string, locator: string, content: string): Promise<void> => mutex.run(async () => {
      const lineage = tasks.get(taskId)
      if (lineage === undefined || !hash(locator) || !hash(content)) return
      await store.update('runtime/observed-fact', { build: state => {
        const control = state.runtimeControls?.[lineage]
        if (control === undefined || control.observedFacts?.[locator] === content) return {}
        const facts = { ...control.observedFacts }
        if (facts[locator] === undefined && Object.keys(facts).length >= 64) delete facts[Object.keys(facts)[0]!]
        facts[locator] = content
        const next = { ...control, observedFacts: facts }
        if (next.status === 'stalled' && next.recoveries < RECOVERY_LIMIT) { next.status = 'active'; next.recoveries++; delete next.reason }
        return { set: { runtimeControls: { [lineage]: next } } }
      } })
    }),
    observe: (input: ProgressObservation): Promise<ProgressControl> => mutex.run(async () => {
      if (!hash(input.lineageId)) throw new Error('Invalid progress lineage')
      let result!: ProgressControl
      let inserted: { pageKey: string; fingerprint: string; canonical: string; hits: number } | undefined
      const committed = await store.update('runtime/progress', { build: state => {
        const old = state.runtimeControls?.[input.lineageId]
        const implicitTask = input.taskId === undefined ? ((state as unknown as { tasks?: TaskRecord[] }).tasks ?? []).find(task => getValueDigest({ rootSessionId: scope.rootSessionId, workspaceId: scope.workspaceId, taskId: task.taskId }) === input.lineageId)?.taskId : undefined
        const taskId = input.taskId ?? implicitTask
        if (input.taskId !== undefined && tasks.has(input.taskId) && tasks.get(input.taskId) !== input.lineageId) throw new Error('Task lineage changed during admission')
        const control: ProgressControl = old ? { ...old, taskIds: [...old.taskIds] } : { lineageId: input.lineageId, ...scope, taskIds: [], policyVersion: RUNTIME_POLICY_VERSION, status: 'active', historyCount: 0, activations: 0, recoveries: 0, replans: 0, legacyBaseline: input.legacyBaseline === true }
        if (taskId !== undefined && !control.taskIds.includes(taskId)) {
          if (control.taskIds.length >= 128) { control.status = 'exhausted'; control.reason = '同一谱系任务目录容量已用尽' }
          else control.taskIds.push(taskId)
        }
        // 同一真实在途句柄等待不创建新工作、不消耗新意；新句柄仍须正常准入。
        if (input.waiting) { result = control; return {} }
        const recovery = input.recoveryEvent !== undefined && input.recoveryEvent !== control.lastUserEvent
        if (recovery && control.status !== 'exhausted') {
          if (control.recoveries >= RECOVERY_LIMIT) { control.status = 'exhausted'; control.reason = '恢复窗口已用尽；保留证据并显式升级处理' }
          else { control.recoveries++; control.lastUserEvent = input.recoveryEvent!.slice(0,512); control.status = 'active'; delete control.reason }
        }
        if (control.status !== 'active') { result = control; return recovery ? { set: { runtimeControls: { [input.lineageId]: control } } } : {} }
        const priorGraph = taskId === undefined ? undefined : control.taskGraphs?.[taskId]
        const graphChanged = input.graphDigest !== undefined && priorGraph !== undefined && input.graphDigest !== priorGraph
        if ((input.replan || graphChanged) && ++control.replans > REPLAN_LIMIT) { control.replans = REPLAN_LIMIT; control.status = 'exhausted'; control.reason = '同一谱系重规划已达有限上界' }
        if (input.graphDigest !== undefined) {
          if (!hash(input.graphDigest)) throw new Error('Invalid progress graph digest')
          if (taskId !== undefined) control.taskGraphs = { ...control.taskGraphs, [taskId]: input.graphDigest }
        }
        if (control.activations >= ACTIVATION_LIMIT || control.historyCount >= HISTORY_LIMIT || store.getStateBytes() + 32768 >= store.maxStateBytes) { control.status = 'exhausted'; control.reason = '进展历史或控制容量已用尽；停止新派发，保留取消/诊断空间' }
        if (control.status !== 'active') { result = control; return { set: { runtimeControls: { [input.lineageId]: control } } } }
        const canonical = getCanonicalJson(input.projection)
        if (canonical.length > 16384) throw new Error('Progress projection exceeds bounded size')
        const fingerprint = getValueDigest({ action: input.action, projection: input.projection })
        const seen = index.get(input.lineageId + ':' + fingerprint)
        control.activations++
        control.lastFingerprint = fingerprint
        if (seen && seen.canonical !== canonical) { control.status = 'stalled'; control.reason = '摘要碰撞或规范结构不一致，需要独立核对'; result = control; return { set: { runtimeControls: { [input.lineageId]: control } } } }
        const pageKey = seen?.pageKey ?? input.lineageId + ':' + Math.floor(control.historyCount / PAGE_SIZE)
        const page: ProgressPage = structuredClone(state.progressHistory?.[pageKey] ?? { lineageId: input.lineageId, page: Math.floor(control.historyCount / PAGE_SIZE), items: [] })
        if (seen) {
          const item = page.items.find(item => item.fingerprint === fingerprint)!
          item.hits++
          if (!recovery && item.hits > 2) { control.status = 'stalled'; control.reason = `LOOP_DETECTED：${input.action} 全历史结构重复且没有新证据，不以改卡/换ref/改标签重置` }
          inserted = { pageKey, fingerprint, canonical, hits: item.hits }
        } else {
          page.items.push({ fingerprint, canonical, action: input.action, hits: 1, at: now() }); control.historyCount++
          inserted = { pageKey, fingerprint, canonical, hits: 1 }
        }
        result = control
        return { set: { runtimeControls: { [input.lineageId]: control }, progressHistory: { [pageKey]: page } } }
      } })
      if (inserted) index.set(input.lineageId + ':' + inserted.fingerprint, inserted)
      if (committed.changed) for (const taskId of result.taskIds) tasks.set(taskId, input.lineageId)
      return structuredClone(result)
    })
  }
}
