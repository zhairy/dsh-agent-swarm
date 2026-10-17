import type { DelegationRecord, TaskRecord } from './evidence.js'
import { getCurrentDelegations, getTaskBinding, isTaskVersionCurrent } from './task-model.js'
import { getRoleInfo } from './role-registry.js'
import { getCanonicalWorkflow, getMermaidLabel, getValueDigest, getWorkflowDigest, getWorkflowMermaid, type WorkflowNodeStatus } from './workflow.js'

export const TASK_DIAGRAM_VERSION = '1'
export const TASK_DIAGRAM_KINDS = [
  'workflow',
  'architecture',
  'sequence',
  'dataflow',
  'lifecycle',
  'orchestration'
] as const
export type TaskDiagramKind = typeof TASK_DIAGRAM_KINDS[number]
export type TaskDiagramStatus = WorkflowNodeStatus | 'unknown'
export const TASK_DIAGRAM_LIMITS = Object.freeze({ history: 32, sourceBytes: 32768, exportBytes: 1048576 })
const STATUSES: readonly TaskDiagramStatus[] = ['pending', 'ready', 'running', 'succeeded', 'failed', 'blocked', 'skipped', 'unknown']
const STATE_LABEL: Record<TaskDiagramStatus, string> = { pending: '待开始', ready: '就绪', running: '执行中', succeeded: '有效完成', failed: '失败', blocked: '阻塞', skipped: '跳过', unknown: '未知' }
const COLORS: Record<TaskDiagramStatus, string> = { pending: '#f1f5f9', ready: '#dbeafe', running: '#fef3c7', succeeded: '#dcfce7', failed: '#fee2e2', blocked: '#ffedd5', skipped: '#e5e7eb', unknown: '#ede9fe' }
export interface TaskDiagramNode { id: string; label: string; status: TaskDiagramStatus; operation: string; role?: string; dependsOn: string[] }
export interface TaskDiagramDelegation {
  id: string; nodeId: string | null; attemptId: string | null; role: string; status: string; current: boolean;
  startedAt: number | null; endedAt: number | null; evidenceCount: number
}
export interface TaskDiagramView {
  kind: TaskDiagramKind; title: string; basis: string; mermaid: string; sourceDigest: string; truncated: number
}
export interface TaskDiagrams {
  format: 'dsh-agent-swarm/task-diagrams'; schemaVersion: 1; generatorVersion: string;
  binding: ReturnType<typeof getTaskBinding>; snapshotDigest: string; workflowDigest: string | null;
  progress: { total: number; completed: number; percent: number | null; statuses: Record<TaskDiagramStatus, number>; accepted: boolean; basis: string };
  diagnostics: Array<{ code: string; nodeId?: string; delegationId?: string; message: string }>;
  source: { nodes: TaskDiagramNode[]; delegations: TaskDiagramDelegation[]; delegationTotal: number; contextCount: number; planningStatus: string; acceptanceStatus: string | null };
  views: TaskDiagramView[];
}
const text = (value: string): string => getMermaidLabel(value.slice(0, 120))
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const getEnd = (record: DelegationRecord): number | null => {
  if (!time(record.startedAt) || !['completed', 'failed', 'blocked'].includes(record.status)) return null
  if (time(record.finishedAt) && record.finishedAt >= record.startedAt) return record.finishedAt
  if (typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
    && time(record.startedAt + record.durationMs)) return record.startedAt + record.durationMs
  return null
}
const getEvents = (records: readonly TaskDiagramDelegation[]) => records.flatMap((record) => {
  if (record.startedAt === null) return []
  const events: Array<{ at: number; kind: 'start' | 'end'; record: TaskDiagramDelegation }> = [{ at: record.startedAt, kind: 'start', record }]
  if (record.endedAt !== null) events.push({ at: record.endedAt, kind: 'end', record })
  return events
}).sort((a, b) => a.at - b.at || a.record.id.localeCompare(b.record.id) || (a.kind === 'start' ? -1 : 1))
const eventLabel = (event: ReturnType<typeof getEvents>[number]): string => `${event.record.id} · ${event.record.current ? '当前' : '历史/失效'} · ${event.kind === 'start' ? '委派登记' : event.record.status} · ${event.at}`
const labelledFlow = (nodes: Array<{ id: string; label: string }>, edges: Array<[string, string]>, direction = 'LR'): string => [
  `flowchart ${direction}`, ...nodes.map((node) => `  n_${node.id}["${text(node.label)}"]`), ...edges.map(([from, to]) => `  n_${from} --> n_${to}`)
].join('\n')

/** Five readonly views, one version-bound snapshot. Rendering never publishes state or passes a gate. */
export const getTaskDiagrams = (task: TaskRecord, records: DelegationRecord[]): TaskDiagrams => {
  records = records.filter((record) => record.taskId === task.taskId)
  const diagnostics: TaskDiagrams['diagnostics'] = []
  const definition = task.workflowDefinition === undefined ? undefined : getCanonicalWorkflow(task.workflowDefinition)
  const workflowDigest = definition === undefined ? null : getWorkflowDigest(definition)
  if (task.workflowDigest !== undefined && workflowDigest !== task.workflowDigest) diagnostics.push({ code: 'WORKFLOW_DIGEST_MISMATCH', message: '流程摘要与定义不一致，视图不修复或批准该状态' })
  const valid = new Map(getCurrentDelegations(task, records, task.artifactSnapshot?.digest).map((record) => [record.delegationId, record]))
  const byAttempt = new Map<string, DelegationRecord[]>()
  for (const record of valid.values()) if (record.nodeId !== undefined && record.attemptId !== undefined) {
    const key = `${record.nodeId}:${record.attemptId}`
    const matches = byAttempt.get(key) ?? []
    matches.push(record)
    byAttempt.set(key, matches)
  }
  const nodes: TaskDiagramNode[] = (definition?.nodes ?? []).map((node) => {
    const state = task.workflowState?.nodes[node.id]
    let status: TaskDiagramStatus = state?.status ?? 'unknown'
    if (node.operation === 'delegate' && status === 'succeeded') {
      const matches = state?.attemptId === undefined ? [] : byAttempt.get(`${node.id}:${state.attemptId}`) ?? []
      if (matches.length !== 1 || matches[0]!.status !== 'completed' || matches[0]!.role !== node.role
        || (node.role === 'suan_heng' ? matches[0]!.mode ?? 'research' : matches[0]!.mode) !== node.mathMode) {
        status = 'unknown'
        diagnostics.push({ code: 'COMPLETION_NOT_BOUND', nodeId: node.id, message: '完成节点缺少同版本、同角色与当前 attempt 的唯一有效交付；不计入完成数' })
      }
    }
    if (state === undefined) diagnostics.push({ code: 'STATE_MISSING', nodeId: node.id, message: '节点缺少执行状态' })
    if (['running', 'succeeded'].includes(status) && node.dependsOn.some((id) => !['succeeded', 'skipped'].includes(task.workflowState?.nodes[id]?.status ?? 'unknown'))) diagnostics.push({ code: 'DEPENDENCY_NOT_SETTLED', nodeId: node.id, message: '已开始节点存在未完成依赖，请人工核对；视图不会重放' })
    return { id: node.id, label: node.label, operation: node.operation, status, ...(node.role === undefined ? {} : { role: node.role }), dependsOn: [...node.dependsOn] }
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  for (const id of Object.keys(task.workflowState?.nodes ?? {})) if (!nodeIds.has(id)) diagnostics.push({ code: 'STATE_NODE_UNKNOWN', nodeId: id, message: '执行状态引用了当前流程以外的节点' })
  const statuses = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<TaskDiagramStatus, number>
  for (const node of nodes) if (node.operation === 'delegate') statuses[node.status] += 1
  const total = Object.values(statuses).reduce((sum, count) => sum + count, 0)
  const sorted = records.map((record): TaskDiagramDelegation => ({
    id: record.delegationId, nodeId: record.nodeId ?? null, attemptId: record.attemptId ?? null, role: record.role, status: record.status,
    current: isTaskVersionCurrent(task, record) && !record.staleReason, startedAt: time(record.startedAt) ? record.startedAt : null, endedAt: getEnd(record), evidenceCount: record.evidence.length
  })).sort((a, b) => (a.startedAt ?? -1) - (b.startedAt ?? -1) || a.id.localeCompare(b.id))
  const delegations = sorted.slice(-TASK_DIAGRAM_LIMITS.history)
  const truncated = sorted.length - delegations.length
  const source: TaskDiagrams['source'] = { nodes, delegations, delegationTotal: sorted.length, contextCount: task.contextRefs?.length ?? 0,
    planningStatus: task.planningReview?.status ?? 'pending', acceptanceStatus: task.acceptance?.status ?? null }
  const binding = getTaskBinding(task)
  const snapshotDigest = getValueDigest({ binding, workflowDigest, source })
  const views: TaskDiagramView[] = []
  // 编排视图来自执行前的拆分决策，与执行进度无关：没有编排时这一段不产出视图。
  const add = (kind: TaskDiagramKind, title: string, basis: string, mermaid: string, omitted = 0): void => {
    if (Buffer.byteLength(mermaid, 'utf8') > TASK_DIAGRAM_LIMITS.sourceBytes) throw new Error('Bounded task diagram exceeded its source limit')
    views.push({ kind, title, basis, mermaid, sourceDigest: getValueDigest(mermaid), truncated: omitted })
  }
  const workflow = definition === undefined ? labelledFlow([{ id: 'unknown', label: '未提供版本化流程' }], [], 'TD') : [getWorkflowMermaid(definition),
    ...STATUSES.map((status) => `  classDef ${status} fill:${COLORS[status]},stroke:#475569,color:#0f172a`),
    ...nodes.map((node) => `  class n_${node.id} ${node.status}`)].join('\n')
  // 编排视图来自执行前的拆分决策，与执行进度无关：没有编排记录时不产出该视图。
  const orchestration = task.orchestration
  if (orchestration !== undefined) {
    add('orchestration', '执行前编排', `复杂度 ${orchestration.complexity}（来源 ${orchestration.source}）；拆分角度 ${orchestration.dimensions.join('/')}；并行组 ${orchestration.parallelGroups.filter((group) => group.length > 1).length} 个；不表示执行进度或验收结论`, orchestration.mermaid)
  }
  add('workflow', '工作流', '当前版本 DAG；颜色来自节点状态，完成数另需有效交付；不等于验收', workflow)
  const roles = [...new Set(delegations.map((record) => record.role))].sort()
  add('architecture', '委派架构', '仅本任务已记录的根代理与角色关系；不表示外部服务或部署架构', labelledFlow([
    { id: 'root', label: '天枢 · 根代理' }, ...roles.map((role, index) => ({ id: `role_${index}`, label: getRoleInfo(role as DelegationRecord['role']).name }))
  ], roles.map((_, index) => ['root', `role_${index}`])), truncated)
  const events = getEvents(delegations)
  add('sequence', '委派记录时序', 'startedAt 是委派登记时刻，包含排队；仅已记录终结画返回；历史旧版本明确标注；不代表逐模型调用或耗时比例', [
    'sequenceDiagram', '  participant p_root as 天枢', ...roles.map((role, index) => `  participant p_${index} as ${text(getRoleInfo(role as DelegationRecord['role']).name)}`),
    ...(events.length === 0 ? ['  Note over p_root: 无可用执行时间记录'] : events.map((event) => `  ${event.kind === 'start' ? `p_root->>p_${roles.indexOf(event.record.role)}` : `p_${roles.indexOf(event.record.role)}-->>p_root`}: ${text(eventLabel(event))}`))
  ].join('\n'), truncated)
  const evidenceCount = delegations.reduce((sum, record) => sum + record.evidenceCount, 0)
  add('dataflow', '合同与证据流', '合同、上下文与已登记交付元数据；不复制提示词、文件内容或凭据；箭头表示所有权/关联而非网络流量', labelledFlow([
    { id: 'contract', label: `任务合同 ${binding.cardRevision} / 流程 ${binding.workflowRevision}` },
    { id: 'context', label: `已登记上下文 ${source.contextCount} 项` },
    { id: 'delegations', label: `保留委派记录 ${delegations.length} 项` }, { id: 'evidence', label: `上述记录的证据 ${evidenceCount} 项` }
  ], [['contract', 'context'], ['contract', 'delegations'], ['delegations', 'evidence']]), truncated)
  const allStates = Object.fromEntries(STATUSES.map((status) => [status, nodes.filter((node) => node.status === status).length]))
  add('lifecycle', '生命周期快照', '当前流程节点状态分布（包含控制节点）；未保存状态迁移日志，不绘制虚构历史迁移', [
    'stateDiagram-v2', ...STATUSES.map((status) => `  state "${STATE_LABEL[status]} · ${allStates[status]}" as s_${status}`)
  ].join('\n'))
  return { format: 'dsh-agent-swarm/task-diagrams', schemaVersion: 1, generatorVersion: TASK_DIAGRAM_VERSION, binding, snapshotDigest, workflowDigest,
    progress: { total, completed: statuses.succeeded, percent: total === 0 ? null : Math.floor(statuses.succeeded / total * 100), statuses, accepted: task.acceptance?.status === 'accepted',
      basis: '当前有效完成的委派节点数 / 当前流程委派节点总数；跳过、失败与未知不算完成；不表示工时、正确率或已验收' }, diagnostics, source, views }
}

/** Integrity check for an explicit user export, never an execution authorization. */
export const ValidateTaskDiagrams = (raw: unknown): string[] => {
  if (raw === null || typeof raw !== 'object') return ['缺少任务图表快照']
  const value = raw as TaskDiagrams
  if (value.format !== 'dsh-agent-swarm/task-diagrams' || value.schemaVersion !== 1 || value.generatorVersion !== TASK_DIAGRAM_VERSION) return ['不支持的图表格式或版本']
  // 编排视角是可选追加：只有任务记录了执行前编排方案时才产出，其余五个视角始终必需。
  const required = TASK_DIAGRAM_KINDS.filter((kind) => kind !== 'orchestration')
  if (!value.binding || !value.source || !Array.isArray(value.source.nodes) || !Array.isArray(value.source.delegations) || !Array.isArray(value.views)
    || new Set(value.views.map((view) => view.kind)).size !== value.views.length
    || required.some((kind) => !value.views.some((view) => view.kind === kind))) return ['图表快照结构不完整']
  try {
    if (getValueDigest({ binding: value.binding, workflowDigest: value.workflowDigest, source: value.source }) !== value.snapshotDigest) return ['图表快照摘要不一致']
    if (value.views.some((view) => !TASK_DIAGRAM_KINDS.includes(view.kind) || typeof view.mermaid !== 'string' || Buffer.byteLength(view.mermaid, 'utf8') > TASK_DIAGRAM_LIMITS.sourceBytes || getValueDigest(view.mermaid) !== view.sourceDigest)) return ['图表源码或摘要不一致']
  } catch { return ['图表快照不是有限 JSON'] }
  return []
}

export const ARCHIFY_CONTRACT = Object.freeze({ repository: 'https://github.com/tt-a1i/archify', commit: '58ab0b98d2d0def8e49dced705c7b566936723ec', version: '3.0.1' })
/** Explicit export only. IR uses the inspected upstream schemas; Archify is not a runtime dependency. */
export const getArchifyTaskDiagrams = (snapshot: TaskDiagrams): { contract: typeof ARCHIFY_CONTRACT; snapshotDigest: string; diagrams: Array<{ kind: TaskDiagramKind; ir: Record<string, unknown> | null; reason?: string }> } => {
  const errors = ValidateTaskDiagrams(snapshot)
  if (errors.length > 0) throw new Error(errors.join('; '))
  const { source } = snapshot
  const roles = [...new Set(source.delegations.map((record) => record.role))].sort()
  const meta = (kind: TaskDiagramKind, viewBox?: [number, number]) => ({ title: `${snapshot.binding.taskId} · ${kind}`, output: `${kind}.html`, locale: 'zh-CN', animation: 'none', quality_profile: 'standard',
    subtitle: `${snapshot.views.find((view) => view.kind === kind)!.basis} · snapshot ${snapshot.snapshotDigest}`, ...(viewBox === undefined ? {} : { viewBox }) })
  const base = (kind: TaskDiagramKind, viewBox?: [number, number]) => ({ schema_version: 1, diagram_type: kind, meta: meta(kind, viewBox) })
  const architecture = { ...base('architecture', [1100, Math.max(500, Math.ceil((roles.length + 1) / 4) * 160)]),
    layout: { mode: 'grid', cols: 4, cellW: 200, cellH: 80, gapX: 60, gapY: 80 },
    components: [{ id: 'root', type: 'backend', label: '天枢 · 根代理', row: 0, col: 0 }, ...roles.map((role, i) => ({ id: `role_${i}`, type: 'backend', label: getRoleInfo(role as DelegationRecord['role']).name, row: Math.floor((i + 1) / 4), col: (i + 1) % 4 }))],
    connections: roles.map((_, i) => ({ from: 'root', to: `role_${i}`, label: '已登记委派角色' })) }
  const workflowNodes = source.nodes.length === 0 ? [{ id: 'unknown', label: '未提供版本化流程', status: 'unknown', dependsOn: [] }] : source.nodes
  const depths = new Map<string, number>()
  const remaining = new Set(workflowNodes.map((node) => node.id))
  for (let round = 0; round < workflowNodes.length && remaining.size > 0; round += 1) for (const node of workflowNodes) {
    if (remaining.has(node.id) && node.dependsOn.every((id) => depths.has(id))) { depths.set(node.id, Math.max(-1, ...node.dependsOn.map((id) => depths.get(id)!)) + 1); remaining.delete(node.id) }
  }
  if (remaining.size > 0) throw new Error('Cannot export a cyclic or incomplete workflow')
  const depthCounts = new Map<number, number>()
  const workflow = { ...base('workflow'), schema_version: 2,
    lanes: Array.from({ length: Math.floor(Math.max(...depths.values()) / 6) + 1 }, (_, i) => ({ id: `band_${i}`, label: `当前流程 DAG · 层级 ${i * 6}–${i * 6 + 5}` })),
    nodes: workflowNodes.map((node) => {
      const depth = depths.get(node.id)!
      const position = depthCounts.get(depth) ?? 0
      depthCounts.set(depth, position + 1)
      const width = Math.max(120, ...node.label.split('\n').map((line) => [...line].reduce((sum, char) => sum + (char.charCodeAt(0) < 128 ? 7 : 14), 32)))
      return { id: node.id, lane: `band_${Math.floor(depth / 6)}`, col: depth % 6, yOffset: position * 140, width, type: 'backend', label: node.label, sublabel: STATE_LABEL[node.status as TaskDiagramStatus] }
    }),
    edges: workflowNodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id }))) }
  const events = getEvents(source.delegations)
  const sequence = events.length === 0 ? null : { ...base('sequence', [Math.max(1000, (roles.length + 1) * 220), Math.max(480, events.length * 70 + 240)]),
    participants: [{ id: 'root', type: 'backend', label: '天枢' }, ...roles.map((role, i) => ({ id: `role_${i}`, type: 'backend', label: getRoleInfo(role as DelegationRecord['role']).name }))],
    messages: events.map((event, i) => ({ id: `event_${i}`, from: event.kind === 'start' ? 'root' : `role_${roles.indexOf(event.record.role)}`, to: event.kind === 'start' ? `role_${roles.indexOf(event.record.role)}` : 'root', y: 180 + i * 70, label: eventLabel(event), variant: event.kind === 'end' ? 'return' : 'default' })) }
  const dataflow = { ...base('dataflow', [1200, 600]), stages: [{ label: '合同' }, { label: '登记材料' }, { label: '证据引用' }],
    nodes: [{ id: 'contract', type: 'backend', label: `合同 ${snapshot.binding.cardRevision}`, stage: 0, row: 0 }, { id: 'context', type: 'backend', label: `上下文 ${source.contextCount} 项`, stage: 1, row: 0 },
      { id: 'delegations', type: 'backend', label: `保留委派 ${source.delegations.length} 项`, stage: 1, row: 1 }, { id: 'evidence', type: 'backend', label: `上述记录的证据 ${source.delegations.reduce((sum, record) => sum + record.evidenceCount, 0)} 项`, stage: 2, row: 1 }],
    flows: [{ from: 'contract', to: 'context', label: '关联' }, { from: 'contract', to: 'delegations', label: '关联' }, { from: 'delegations', to: 'evidence', label: '引用' }] }
  // Lifecycle v1 inserts an implicit phase rail, which would invent state history. v2 draws only explicit transitions.
  const lifecycle = { ...base('lifecycle'), schema_version: 2, lanes: [{ id: 'main', label: '状态快照' }, { id: 'other', label: '其他状态快照' }],
    states: STATUSES.map((status, i) => ({ id: status, type: status === 'succeeded' ? 'success' : status === 'failed' ? 'failure' : status === 'running' ? 'active' : 'neutral', label: `${STATE_LABEL[status]} · ${source.nodes.filter((node) => node.status === status).length}`, lane: i < 4 ? 'main' : 'other', col: i % 4 })), transitions: [] }
  return { contract: ARCHIFY_CONTRACT, snapshotDigest: snapshot.snapshotDigest, diagrams: [
    { kind: 'workflow', ir: workflow }, { kind: 'architecture', ir: architecture },
    { kind: 'sequence', ir: sequence, ...(sequence === null ? { reason: '未记录可用调用事件；上游 sequence schema 要求消息，不能伪造补齐' } : {}) },
    { kind: 'dataflow', ir: dataflow }, { kind: 'lifecycle', ir: lifecycle }
  ] }
}
