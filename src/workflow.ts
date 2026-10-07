import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { GATE_IDS, GATE_ROLE, getSuggestedRoles, type GateId, type GateRequirement, type TaskCard } from './policy.js'
import { getRoleInfo, isDelegableRoleId, type DelegableRoleId, type SuanHengMode } from './role-registry.js'
import { SwarmError } from './util/errors.js'

export const WORKFLOW_GENERATOR_VERSION = '1'
export const MERMAID_PARSER_VERSION = '11.12.0'
export const WORKFLOW_LIMITS = Object.freeze({ nodes: 32, edges: 64, labelChars: 120, sourceBytes: 32768 })
export type WorkflowMode = 'quick' | 'standard' | 'algorithm'
export type WorkflowNodeOperation = 'delegate' | 'checkpoint' | 'accept'
export type WorkflowNodeStatus = 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped'
export interface WorkflowNodeInfo {
  id: string
  label: string
  operation: WorkflowNodeOperation
  role?: DelegableRoleId
  mathMode?: SuanHengMode
  dependsOn: string[]
  gates: GateId[]
  outputContractVersion: string
}
export interface WorkflowDefinition {
  schemaVersion: 1
  mode: WorkflowMode
  nodes: WorkflowNodeInfo[]
}
export interface WorkflowNodeStateInfo {
  status: WorkflowNodeStatus
  attemptId?: string
  reason?: string
  evidenceRefs?: string[]
}
export interface WorkflowStateInfo {
  round: number
  nodes: Record<string, WorkflowNodeStateInfo>
}
export interface WorkflowParserResultInfo {
  parserVersion: string
  parseVerdict: 'pass' | 'fail' | 'unavailable'
  projectionVerdict: 'pass' | 'fail'
  sourceDigest: string
  generatorVersion: string
  errors: string[]
}
export type MermaidParserLike = (source: string) => Promise<{ version: string; ok: boolean; error?: string }>

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const EDIT_ROLES: readonly DelegableRoleId[] = ['zhu_jian', 'ji_feng']
const POST_EDIT_GATES: readonly GateId[] = ['G_VERIFY', 'G_REVIEW', 'G_MATH_VERIFY', 'G_DIFF_TEST', 'G_BENCH']
const RISK_KEYS = ['changesAlgorithm', 'numericPrecision', 'securitySensitive', 'touchesFinancialLogic', 'timeSeriesOrBacktest', 'stateMachine', 'sharedStateConcurrency', 'crossModuleArchitecture', 'ambiguousRequirements'] as const

/** 稳定 JSON：对象键排序，数组保留语义顺序，拒绝非 JSON 值。 */
export const getCanonicalJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map(normalize)
    if (isObject(input)) return Object.fromEntries(Object.keys(input).sort().filter((key) => input[key] !== undefined).map((key) => [key, normalize(input[key])]))
    throw new SwarmError('INVALID_ARGS', '摘要输入必须是有限 JSON 值')
  }
  return JSON.stringify(normalize(value))
}
export const getValueDigest = (value: unknown): string => createHash('sha256').update(getCanonicalJson(value)).digest('hex')
/** 节点列表、无序依赖/门禁的重排属于展示变化，不改变执行语义摘要。 */
export const getCanonicalWorkflow = (definition: WorkflowDefinition): WorkflowDefinition => ({ ...definition, nodes: [...definition.nodes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((node) => ({ ...node, dependsOn: [...node.dependsOn].sort(), gates: [...node.gates].sort() })) })
export const getWorkflowDigest = (definition: WorkflowDefinition): string => getValueDigest(getCanonicalWorkflow(definition))
export const getWorkflowMode = (card: TaskCard): WorkflowMode => card.flags.changesAlgorithm ? 'algorithm'
  : RISK_KEYS.some((key) => card.flags[key]) || card.scope.length > 3 ? 'standard' : 'quick'

/** 从有效门禁生成小流程。没有代码改动时不强拉修改或运行角色。 */
export const getDefaultWorkflow = (card: TaskCard, gates: readonly GateRequirement[]): WorkflowDefinition => {
  const nodes: WorkflowNodeInfo[] = []
  const add = (id: string, role: DelegableRoleId, dependsOn: string[], nodeGates: GateId[] = [], mathMode?: SuanHengMode): void => {
    nodes.push({ id, label: mathMode === undefined ? `${getRoleInfo(role).name}：${getRoleInfo(role).title}` : `算衡·${mathMode === 'research' ? '研算' : '验算'}`, operation: 'delegate', role, ...(mathMode === undefined ? {} : { mathMode }), dependsOn, gates: nodeGates, outputContractVersion: '1' })
  }
  const suggested = getSuggestedRoles(card, [...gates])
  const analysis = suggested.filter(({ role }) => !EDIT_ROLES.includes(role) && !['fu_he', 'yu_shi', 'suan_heng', 'xing_zhou'].includes(role))
  for (const { role } of analysis) add(role, role, [], role === 'guan_xiang' ? gates.filter((g) => g.gate === 'G_VISION').map((g) => g.gate) : [])
  if (!card.flags.changesCode && !card.flags.hasExecSteps && analysis.length === 0 && gates.length === 0) add('analysis', 'mou_ding', [])
  const analysisIds = nodes.map((node) => node.id)
  if (gates.some((g) => g.gate === 'G_MATH_RESEARCH')) add('math_research', 'suan_heng', analysisIds, ['G_MATH_RESEARCH'], 'research')
  const beforeEdit = nodes.map((node) => node.id)
  if (card.flags.changesCode) {
    const role = suggested.find((entry) => EDIT_ROLES.includes(entry.role))?.role ?? 'ji_feng'
    add('implementation', role, beforeEdit)
  }
  if (card.flags.hasExecSteps) add('execution', 'xing_zhou', card.flags.changesCode ? ['implementation'] : beforeEdit)
  const artifacts = nodes.length === 0 ? [] : card.flags.hasExecSteps ? ['execution'] : card.flags.changesCode ? ['implementation'] : beforeEdit
  const verification = gates.filter((g) => g.role === 'fu_he').map((g) => g.gate)
  if (verification.length > 0) add('verification', 'fu_he', artifacts, verification)
  if (gates.some((g) => g.gate === 'G_REVIEW')) add('review', 'yu_shi', artifacts, ['G_REVIEW'])
  if (gates.some((g) => g.gate === 'G_MATH_VERIFY')) add('math_verify', 'suan_heng', artifacts, ['G_MATH_VERIFY'], 'verify')
  // 所有业务节点都进入最后检查点，避免遗留无验收路径的分支。
  nodes.push({ id: 'checkpoint', label: '检查点：回顾、收敛、范围、协作、资源', operation: 'checkpoint', dependsOn: nodes.map((node) => node.id), gates: [], outputContractVersion: '1' })
  nodes.push({ id: 'accept', label: '天枢：核对证据与验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' })
  return { schemaVersion: 1, mode: getWorkflowMode(card), nodes }
}

const getAncestors = (nodes: readonly WorkflowNodeInfo[], id: string): Set<string> => {
  const index = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const visit = (key: string): void => {
    for (const parent of index.get(key)?.dependsOn ?? []) if (!seen.has(parent)) { seen.add(parent); visit(parent) }
  }
  visit(id)
  return seen
}

/** 规范化并检查 DAG、角色、门禁、验收路径与实现前研算。 */
export const ValidateWorkflow = (raw: unknown, card: TaskCard, gates: readonly GateRequirement[]): { definition?: WorkflowDefinition; errors: string[] } => {
  const errors: string[] = []
  if (!isObject(raw) || raw.schemaVersion !== 1 || !['quick', 'standard', 'algorithm'].includes(String(raw.mode)) || !Array.isArray(raw.nodes)) return { errors: ['workflow 必须包含 schemaVersion:1、mode 与 nodes'] }
  if (Object.keys(raw).some((key) => !['schemaVersion', 'mode', 'nodes'].includes(key))) errors.push('workflow 含不允许的字段')
  if (raw.nodes.length === 0 || raw.nodes.length > WORKFLOW_LIMITS.nodes) errors.push(`workflow 节点数必须为 1–${WORKFLOW_LIMITS.nodes}`)
  const nodes: WorkflowNodeInfo[] = []
  for (const [i, item] of raw.nodes.entries()) {
    if (!isObject(item)) { errors.push(`nodes[${i}] 必须是对象`); continue }
    if (Object.keys(item).some((key) => !['id', 'label', 'operation', 'role', 'mathMode', 'dependsOn', 'gates', 'outputContractVersion'].includes(key))) errors.push(`nodes[${i}] 含不允许的字段`)
    if (typeof item.id !== 'string' || !ID_PATTERN.test(item.id)) errors.push(`nodes[${i}].id 不合法`)
    if (typeof item.label !== 'string' || item.label.trim() === '' || item.label.length > WORKFLOW_LIMITS.labelChars) errors.push(`nodes[${i}].label 必须为非空且不超过 ${WORKFLOW_LIMITS.labelChars} 字符`)
    if (!['delegate', 'checkpoint', 'accept'].includes(String(item.operation))) errors.push(`nodes[${i}].operation 不合法`)
    const deps = item.dependsOn
    const nodeGates = item.gates
    if (!Array.isArray(deps) || deps.some((id) => typeof id !== 'string') || new Set(deps).size !== deps.length) errors.push(`nodes[${i}].dependsOn 必须是无重复的 ID 数组`)
    if (!Array.isArray(nodeGates) || nodeGates.some((gate) => !GATE_IDS.includes(gate as GateId)) || new Set(nodeGates).size !== nodeGates.length) errors.push(`nodes[${i}].gates 不合法`)
    if (item.operation === 'delegate' && !isDelegableRoleId(item.role)) errors.push(`nodes[${i}].role 必须是可委派角色`)
    if (item.operation !== 'delegate' && (item.role !== undefined || item.mathMode !== undefined || (Array.isArray(nodeGates) && nodeGates.length > 0))) errors.push(`nodes[${i}] 控制节点不能指定角色、模式或门禁`)
    if (item.mathMode !== undefined && (item.role !== 'suan_heng' || !['research', 'verify'].includes(String(item.mathMode)))) errors.push(`nodes[${i}].mathMode 仅算衡可指定 research/verify`)
    if (item.outputContractVersion !== '1') errors.push(`nodes[${i}].outputContractVersion 必须为 1`)
    if (Array.isArray(nodeGates)) for (const gate of nodeGates) {
      const expected = GATE_ROLE[gate as GateId]
      if (expected !== undefined && (expected.role !== item.role || expected.mode !== item.mathMode)) errors.push(`节点 ${String(item.id)} 不能由 ${String(item.role)} 产生门禁 ${String(gate)}`)
    }
    if (typeof item.id === 'string' && typeof item.label === 'string' && Array.isArray(deps) && Array.isArray(nodeGates)) nodes.push({ id: item.id, label: item.label.trim(), operation: item.operation as WorkflowNodeOperation, ...(item.role === undefined ? {} : { role: item.role as DelegableRoleId }), ...(item.mathMode === undefined ? {} : { mathMode: item.mathMode as SuanHengMode }), dependsOn: [...deps], gates: [...nodeGates] as GateId[], outputContractVersion: '1' })
  }
  if (errors.length > 0) return { errors }
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length) errors.push('workflow 节点 ID 重复')
  if (nodes.reduce((count, node) => count + node.dependsOn.length, 0) > WORKFLOW_LIMITS.edges) errors.push('workflow 依赖边超过上限')
  for (const node of nodes) for (const dep of node.dependsOn) if (!ids.has(dep)) errors.push(`节点 ${node.id} 的依赖 ${dep} 不存在`)
  if (errors.length > 0) return { errors }
  const pending = new Map(nodes.map((node) => [node.id, node.dependsOn.length]))
  const children = new Map<string, string[]>()
  for (const node of nodes) for (const dep of node.dependsOn) children.set(dep, [...(children.get(dep) ?? []), node.id])
  const queue = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.id)
  let visited = 0
  for (let i = 0; i < queue.length; i += 1) {
    visited += 1
    for (const child of children.get(queue[i]!) ?? []) { const count = pending.get(child)! - 1; pending.set(child, count); if (count === 0) queue.push(child) }
  }
  if (visited !== nodes.length) return { errors: ['workflow 依赖必须无环'] }
  const accepts = nodes.filter((node) => node.operation === 'accept')
  if (accepts.length !== 1) errors.push('workflow 必须有唯一验收节点')
  else {
    const ancestors = getAncestors(nodes, accepts[0]!.id)
    for (const node of nodes) if (node.id !== accepts[0]!.id && !ancestors.has(node.id)) errors.push(`节点 ${node.id} 没有通向验收的路径`)
    if (!nodes.some((node) => node.operation === 'checkpoint' && accepts[0]!.dependsOn.includes(node.id))) errors.push('验收必须依赖最后检查点')
  }
  for (const gate of gates) if (!nodes.some((node) => node.gates.includes(gate.gate))) errors.push(`workflow 缺少必需门禁 ${gate.gate}`)
  const edits = nodes.filter((node) => node.role !== undefined && EDIT_ROLES.includes(node.role))
  for (const node of nodes) if (node.gates.some((gate) => POST_EDIT_GATES.includes(gate))) {
    const ancestors = getAncestors(nodes, node.id)
    for (const edit of edits) if (!ancestors.has(edit.id)) errors.push(`节点 ${node.id} 必须在实现 ${edit.id} 后执行`)
  }
  if (card.flags.changesAlgorithm) for (const edit of edits) {
    const ancestors = getAncestors(nodes, edit.id)
    if (!nodes.some((node) => node.gates.includes('G_MATH_RESEARCH') && ancestors.has(node.id))) errors.push(`算法实现 ${edit.id} 必须依赖已完成研算`)
  }
  if (raw.mode === 'quick' && getWorkflowMode(card) !== 'quick') errors.push('当前风险或范围不能使用 quick 流程')
  return errors.length > 0 ? { errors } : { definition: { schemaVersion: 1, mode: raw.mode as WorkflowMode, nodes }, errors: [] }
}

/** 新门禁只能补入结构，保持已有业务节点 ID；返回变更摘要供调用方递增版本。 */
export const ReconcileWorkflow = (definition: WorkflowDefinition, card: TaskCard, gates: readonly GateRequirement[]): { definition: WorkflowDefinition; changed: boolean; errors: string[] } => {
  const next = structuredClone(definition)
  const defaultDefinition = getDefaultWorkflow(card, gates)
  for (const gate of gates) {
    if (next.nodes.some((node) => node.gates.includes(gate.gate))) continue
    const template = defaultDefinition.nodes.find((node) => node.gates.includes(gate.gate))!
    const compatible = next.nodes.find((node) => node.role === template.role && node.mathMode === template.mathMode)
    if (compatible !== undefined) compatible.gates = [...new Set([...compatible.gates, gate.gate])]
    else {
      let id = template.id
      while (next.nodes.some((node) => node.id === id)) id += '_gate'
      next.nodes.push({ ...template, id, gates: [gate.gate], dependsOn: [] })
    }
  }
  const research = next.nodes.filter((node) => node.gates.includes('G_MATH_RESEARCH')).map((node) => node.id)
  const edits = next.nodes.filter((node) => node.role !== undefined && EDIT_ROLES.includes(node.role)).map((node) => node.id)
  for (const node of next.nodes) {
    if (card.flags.changesAlgorithm && edits.includes(node.id)) node.dependsOn = [...new Set([...node.dependsOn, ...research])]
    if (node.gates.some((gate) => POST_EDIT_GATES.includes(gate))) node.dependsOn = [...new Set([...node.dependsOn, ...edits])]
  }
  // 保留自定义中间检查点，不能删掉仍被业务节点依赖的控制节点。
  let checkpoint = next.nodes.find((node) => node.operation === 'checkpoint' && next.nodes.filter((candidate) => candidate.operation === 'delegate').every((candidate) => !getAncestors(next.nodes, candidate.id).has(node.id)))
  if (checkpoint === undefined) {
    checkpoint = structuredClone(defaultDefinition.nodes.find((node) => node.operation === 'checkpoint')!)
    while (next.nodes.some((node) => node.id === checkpoint!.id)) checkpoint.id += '_final'
    next.nodes.push(checkpoint)
  }
  let accept = next.nodes.find((node) => node.operation === 'accept')
  if (accept === undefined) { accept = structuredClone(defaultDefinition.nodes.find((node) => node.operation === 'accept')!); next.nodes.push(accept) }
  checkpoint.dependsOn = next.nodes.filter((node) => node.id !== checkpoint.id && node.operation !== 'accept').map((node) => node.id)
  accept.dependsOn = [checkpoint.id]
  next.mode = getWorkflowMode(card)
  const check = ValidateWorkflow(next, card, gates)
  return { definition: check.definition ?? next, changed: getWorkflowDigest(next) !== getWorkflowDigest(definition), errors: check.errors }
}

/** 标签永远只是文字；数值实体防止引号、HTML 与 Mermaid 指令注入。 */
export const getMermaidLabel = (value: string): string => value.replace(/[\\"<>#&\r\n]/g, (char) => `#${char.charCodeAt(0)};`)
export const getWorkflowMermaid = (definition: WorkflowDefinition): string => [
  'flowchart TD',
  ...getCanonicalWorkflow(definition).nodes.map((node) => `  n_${node.id}["${getMermaidLabel(node.label)}"]`),
  ...getCanonicalWorkflow(definition).nodes.flatMap((node) => node.dependsOn.map((dep) => `  n_${dep} --> n_${node.id}`))
].join('\n')

/** 同一合同和图生成可复制任务说明，展示与执行状态共用唯一数据源。 */
export const getTaskCardMarkdown = (card: TaskCard, definition: WorkflowDefinition, options: { taskId: string; cardRevision?: number; workflowRevision?: number; state?: WorkflowStateInfo; planningStatus?: string; delegationLimit?: number } ): string => [
  `### ${card.title}`,
  `任务：${options.taskId} · 合同 ${options.cardRevision ?? 1} · 流程 ${options.workflowRevision ?? 1}`,
  `目标：${card.goal}`,
  '验收标准：', ...card.acceptance.map((item, index) => `- A${index + 1}：${item}`),
  `相关文件：${card.scope.length === 0 ? '待定位' : card.scope.join('、')}`,
  `性能预算：${card.perf === undefined ? '待测' : Object.entries(card.perf).map(([key, value]) => `${key}=${String(value)}`).join('；') || '待测'}`,
  ...(card.constraints === undefined ? [] : [`约束：${Object.entries(card.constraints).map(([key, value]) => `${key}=${String(value)}`).join('；')}`]),
  ...(options.delegationLimit === undefined ? [] : [`委派预算：${options.delegationLimit === 0 ? '不限' : `${options.delegationLimit} 次`}`]),
  `规划审核：${options.planningStatus ?? 'pending'}`,
  '```mermaid', getWorkflowMermaid(definition), '```',
  ...definition.nodes.map((node) => `- ${node.id}：${node.label} · ${options.state?.nodes[node.id]?.status ?? 'pending'}${options.state?.nodes[node.id]?.reason === undefined ? '' : `；${options.state.nodes[node.id]!.reason}`}`)
].join('\n\n')

/** 受限生成器投影必须精确一致，语法正确也不能篡改标签或箭头。 */
export const ValidateMermaidProjection = (definition: WorkflowDefinition, source: string): string[] => {
  if (Buffer.byteLength(source, 'utf8') > WORKFLOW_LIMITS.sourceBytes) return ['Mermaid 源码超过上限']
  const normalize = (text: string): string => text.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim()
  return normalize(source) === normalize(getWorkflowMermaid(definition)) ? [] : ['Mermaid 源码的节点、标签或依赖与结构化流程不一致']
}

/** 官方 parser 在独立 worker 的 DOM 适配里运行，不污染宿主 globalThis。 */
export const intOfficialMermaidParser = (timeoutMs = 10000): MermaidParserLike => async (source) => {
  const require = createRequire(import.meta.url)
  let mermaidUrl: string
  let jsdomPath: string
  let version: string
  try { mermaidUrl = pathToFileURL(require.resolve('mermaid')).href; jsdomPath = require.resolve('jsdom'); version = String(JSON.parse(readFileSync(require.resolve('mermaid/package.json'), 'utf8')).version) }
  catch (error) { return { version: 'unavailable', ok: false, error: `官方 Mermaid parser 不可用：${String(error)}` } }
  return new Promise((resolve) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const { JSDOM } = require(workerData.jsdomPath)
      const dom = new JSDOM('<!doctype html><html><body></body></html>')
      globalThis.window = dom.window
      globalThis.document = dom.window.document
      import(workerData.mermaidUrl).then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, flowchart: { htmlLabels: false }, maxTextSize: 32768, maxEdges: 64 })
        try { await mermaid.parse(workerData.source); parentPort.postMessage({ version: workerData.version, ok: true }) }
        catch (error) { parentPort.postMessage({ version: workerData.version, ok: false, error: String(error.message ?? error).slice(0, 2000) }) }
      }).catch((error) => parentPort.postMessage({ version: 'unavailable', ok: false, error: String(error) }))
    `, { eval: true, workerData: { mermaidUrl, jsdomPath, source, version } })
    let settled = false
    const finish = (result: { version: string; ok: boolean; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ version: 'unavailable', ok: false, error: '官方 Mermaid parser 超时' }), timeoutMs)
    worker.once('message', finish)
    worker.once('error', (error) => finish({ version: 'unavailable', ok: false, error: String(error) }))
    worker.once('exit', (code) => { if (!settled) finish({ version: 'unavailable', ok: false, error: `官方 Mermaid parser 提前退出：${code}` }) })
  })
}

export const ParseWorkflowMermaid = async (definition: WorkflowDefinition, source = getWorkflowMermaid(definition), parser: MermaidParserLike = intOfficialMermaidParser()): Promise<WorkflowParserResultInfo> => {
  const projection = ValidateMermaidProjection(definition, source)
  if (projection.length > 0) return { parserVersion: 'not-run', generatorVersion: WORKFLOW_GENERATOR_VERSION, sourceDigest: getValueDigest(source), parseVerdict: 'fail', projectionVerdict: 'fail', errors: projection }
  let result: Awaited<ReturnType<MermaidParserLike>>
  try { result = await parser(source) }
  catch (error) { result = { version: 'unavailable', ok: false, error: `官方 Mermaid parser 调用失败：${String(error)}` } }
  return { parserVersion: result.version, generatorVersion: WORKFLOW_GENERATOR_VERSION, sourceDigest: getValueDigest(source), parseVerdict: result.ok ? 'pass' : result.version === 'unavailable' ? 'unavailable' : 'fail', projectionVerdict: 'pass', errors: result.error === undefined ? [] : [result.error] }
}

export const intWorkflowState = (definition: WorkflowDefinition, round = 0): WorkflowStateInfo => ({ round, nodes: Object.fromEntries(definition.nodes.map((node) => [node.id, { status: node.dependsOn.length === 0 ? 'ready' : 'pending' }])) })
export const getReadyNodes = (definition: WorkflowDefinition, state: WorkflowStateInfo): WorkflowNodeInfo[] => definition.nodes.filter((node) => {
  const status = state.nodes[node.id]?.status
  return (status === 'ready' || status === 'pending') && node.dependsOn.every((dep) => state.nodes[dep]?.status === 'succeeded' || state.nodes[dep]?.status === 'skipped')
})
export const getMatchingNode = (definition: WorkflowDefinition, state: WorkflowStateInfo, input: { role: DelegableRoleId; mode?: SuanHengMode; gate?: GateId; nodeId?: string }): { node?: WorkflowNodeInfo; reason?: string } => {
  const ready = getReadyNodes(definition, state).filter((node) => node.operation === 'delegate' && node.role === input.role && node.mathMode === (input.role === 'suan_heng' ? input.mode ?? 'research' : undefined) && (input.gate === undefined || node.gates.includes(input.gate)))
  const matches = input.nodeId === undefined ? ready : ready.filter((node) => node.id === input.nodeId)
  return matches.length === 1 ? { node: matches[0] } : { reason: matches.length === 0 ? '没有匹配且依赖已满足的节点' : '存在多个匹配节点，请指定 node_id' }
}

/** 更新显式节点状态。attempt 旧结果不能覆盖新结果；终态只能由新修复轮重建。 */
export const UpdateWorkflowNode = (state: WorkflowStateInfo, nodeId: string, status: WorkflowNodeStatus, patch: Omit<Partial<WorkflowNodeStateInfo>, 'status'> = {}): WorkflowStateInfo => {
  const current = state.nodes[nodeId]
  if (current === undefined) throw new SwarmError('INVALID_ARGS', `未知流程节点：${nodeId}`)
  if (patch.attemptId !== undefined && current.attemptId !== undefined && patch.attemptId !== current.attemptId) throw new SwarmError('INVALID_TRANSITION', '过期 attempt 不能改变节点状态')
  const transitions: Record<WorkflowNodeStatus, WorkflowNodeStatus[]> = { pending: ['ready', 'blocked', 'skipped'], ready: ['running', 'succeeded', 'blocked', 'skipped'], running: ['succeeded', 'failed', 'blocked'], succeeded: [], failed: [], blocked: [], skipped: [] }
  if (current.status !== status && !transitions[current.status].includes(status)) throw new SwarmError('INVALID_TRANSITION', `流程节点不允许 ${current.status} → ${status}`)
  return { ...state, nodes: { ...state.nodes, [nodeId]: { ...current, ...patch, status } } }
}
