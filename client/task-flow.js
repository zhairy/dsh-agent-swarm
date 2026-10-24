// 流程是宿主状态的派生只读视图；RPC 失败时保留真实工具结果与源码，不伪造通过状态。
const React = require('react')
const h = React.createElement
const { retainTaskViewStore } = require('@swarm/task-view-store')
let MarkdownText
try { MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText } catch { MarkdownText = undefined }

const NS = 'swarmTaskFlow'
const KIND = 'swarm-task-flow'
const ASSET_URL = '/api/swarm-assets/mermaid.min.js'
const EMPTY_LABELS = Object.freeze({ code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' })
const zh = { title: '任务流程', refresh: '刷新状态', source: 'Mermaid 源码', loading: '读取任务状态…', unavailable: '任务状态暂不可用', renderError: '图形展示不可用，仍可读取源码与步骤', pending: '流程已生成，等待审核', notReviewed: '流程已生成（观察模式，按需审核）', nodePending: '待执行', reviewing: '审核中', pass: '已审核', pass_with_degradation: '降级审核', changes_requested: '需修正', unknown: '审核未确定', 'needs-clarification': '待澄清', review_required: '需独立复核', stale: '审核失效', ready: '可执行', running: '执行中', succeeded: '已完成', failed: '失败', blocked: '阻塞', skipped: '跳过', generated: '流程已生成', workflowMode: '流程模式' }
const en = { title: 'Task flow', refresh: 'Refresh status', source: 'Mermaid source', loading: 'Loading task state…', unavailable: 'Task state unavailable', renderError: 'Diagram unavailable; source and steps remain readable', pending: 'Generated, awaiting review', notReviewed: 'Generated (advisory mode; review on demand)', nodePending: 'Pending', reviewing: 'Reviewing', pass: 'Reviewed', pass_with_degradation: 'Reviewed with degradation', changes_requested: 'Changes requested', unknown: 'Review undetermined', 'needs-clarification': 'Needs clarification', review_required: 'Independent review required', stale: 'Review stale', ready: 'Ready', running: 'Running', succeeded: 'Completed', failed: 'Failed', blocked: 'Blocked', skipped: 'Skipped', generated: 'Flow generated', workflowMode: 'Flow mode' }
Object.assign(zh, { zoomIn: '放大', zoomOut: '缩小', fit: '适应宽度' })
Object.assign(en, { zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit width' })
Object.assign(zh, { planningReview: '规划审核', goalDimension: '目标', designDimension: '流程设计', mermaidDimension: 'Mermaid', agentOpinion: '独立 Agent', jevOpinion: 'Jev 判断', syntaxCheck: '语法', projectionCheck: '投影', semanticCheck: '语义', reviewNotReviewed: '未审核', checkPass: '通过', checkFail: '未通过', reviewIssues: '审核发现与错误' })
Object.assign(en, { planningReview: 'Planning review', goalDimension: 'Goal', designDimension: 'Workflow design', mermaidDimension: 'Mermaid', agentOpinion: 'Independent Agent', jevOpinion: 'Jev judgment', syntaxCheck: 'Syntax', projectionCheck: 'Projection', semanticCheck: 'Semantics', reviewNotReviewed: 'Not reviewed', checkPass: 'Pass', checkFail: 'Failed', reviewIssues: 'Review findings and errors' })
Object.assign(zh, { reviewUnavailable: '未审核（服务不可用）' })
Object.assign(en, { reviewUnavailable: 'Not reviewed (service unavailable)' })
Object.assign(zh, { diagramType: '图表视角', workflow: '工作流', orchestration: '执行前编排', architecture: '委派架构', sequence: '委派记录时序', dataflow: '合同与证据流', lifecycle: '生命周期快照', progress: '当前有效完成的委派节点', progressUnknown: '无委派节点，进度不适用', progressBoundary: '节点比例不表示工时、正确率或验收通过；失败、阻塞与跳过单独统计。', exportSnapshot: '导出图表快照 JSON', deviations: '状态偏移诊断', omitted: '更早记录未展示', diagramBindingMismatch: '图表版本不一致，保留原流程；请刷新状态' })
Object.assign(en, { diagramType: 'Diagram view', workflow: 'Workflow', orchestration: 'Pre-execution orchestration', architecture: 'Delegation topology', sequence: 'Recorded call sequence', dataflow: 'Contract and evidence', lifecycle: 'Lifecycle snapshot', progress: 'Current completed delegation nodes', progressUnknown: 'No delegation nodes; progress is not applicable', progressBoundary: 'Node ratio does not measure effort, correctness, or acceptance; failures, blocks and skips remain separate.', exportSnapshot: 'Export diagram snapshot JSON', deviations: 'State deviation diagnostics', omitted: 'Older records omitted', diagramBindingMismatch: 'Diagram revision mismatch; retaining the original flow. Refresh status.' })
Object.assign(zh, { unknownNode: '状态未知', projectionPending: '这是待同步的只读投影；图表刷新不会批准新版本执行。' })
Object.assign(en, { unknownNode: 'Unknown state', projectionPending: 'This is a read projection awaiting synchronization. Refreshing diagrams does not authorize the new revision.' })

const textOf = (event) => {
  const content = event?.data?.message?.content
  return Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : ''
}
const readTaskResult = (event) => {
  if (event?.type !== 'tool/result' || !Number.isInteger(event.seq) || event.data?.message?.isError === true) return undefined
  const text = textOf(event)
  const taskId = /^task_id:\s*([A-Za-z0-9][A-Za-z0-9_-]{0,100})/m.exec(text)?.[1]
  if (taskId === undefined) return undefined
  const mermaid = /```mermaid\s*\n([\s\S]*?)\n```/.exec(text)?.[1] ?? /~~~mermaid\s*\n([\s\S]*?)\n~~~/.exec(text)?.[1]
  return { taskId, seq: event.seq, text, mermaid }
}

const taskFlowDefinition = {
  kind: KIND,
  target: 'chat',
  match: (event) => { const result = readTaskResult(event); return result === undefined ? null : { id: result.taskId, role: 'start' } },
  start: (_context, match) => readTaskResult(match.event),
  update: (_context, match) => readTaskResult(match.event),
  buildViewNode: (context) => context.start === undefined || context.state === undefined ? null : { key: context.key, kind: KIND, id: context.id, target: 'chat', anchorSeq: context.start.event.seq, location: context.start.location, visibility: 'visible', data: context.state }
}

/** 浏览器只接收生成器的有界子集，禁止任意 Mermaid 指令和外部资源。 */
const validateSource = (source) => {
  if (typeof source !== 'string' || source.length > 32768) throw new Error('Mermaid source limit')
  const lines = source.trim().split(/\r?\n/)
  if (lines[0] === 'sequenceDiagram') {
    const participants = new Set()
    const messages = []
    for (const line of lines.slice(1)) {
      const participant = /^\s*participant (p_(?:root|\d+)) as ([^"\\<>\r\n]+)$/.exec(line)
      if (participant !== null) { if (participants.has(participant[1])) throw new Error('Duplicate participant'); participants.add(participant[1]); continue }
      const message = /^\s*(p_(?:root|\d+))(?:->>|-->>)(p_(?:root|\d+)): ([^"\\<>\r\n]+)$/.exec(line)
      if (message !== null) { messages.push([message[1], message[2]]); continue }
      if (line === '  Note over p_root: 无可用执行时间记录') continue
      throw new Error('Unsupported sequence directive')
    }
    if (!participants.has('p_root') || participants.size > 32 || messages.length > 64 || messages.some(([from, to]) => !participants.has(from) || !participants.has(to))) throw new Error('Invalid sequence references')
    return
  }
  if (lines[0] === 'stateDiagram-v2') {
    const states = new Set()
    for (const line of lines.slice(1)) {
      const state = /^\s*state "[^"\\<>\r\n]+" as s_(pending|ready|running|succeeded|failed|blocked|skipped|unknown)$/.exec(line)
      if (state === null || states.has(state[1])) throw new Error('Unsupported state directive')
      states.add(state[1])
    }
    if (states.size !== 8) throw new Error('Invalid lifecycle states')
    return
  }
  if (lines[0] !== 'flowchart TD' && lines[0] !== 'flowchart LR') throw new Error('Unsupported diagram')
  // 执行前编排图是另一种有界 flowchart：节点只有 root/recon/slice-N/parN，连线只有依赖边与「同时开工」提示。
  if (/^\s*root\["任务：/.test(lines[1] ?? '')) {
    const ids = new Set()
    const links = []
    for (const line of lines.slice(1)) {
      const node = /^\s*(root|recon|slice-\d{1,3}|par\d{1,3})\["(?:[^"\\<>]|<br\/>)*"\]\s*$/.exec(line)
      if (node !== null) { if (ids.has(node[1])) throw new Error('Duplicate orchestration node'); ids.add(node[1]); continue }
      const edge = /^\s*(root|recon|slice-\d{1,3}) --> (recon|slice-\d{1,3})\s*$/.exec(line)
      if (edge !== null) { links.push([edge[1], edge[2]]); continue }
      const parallel = /^\s*(par\d{1,3}) -\. 同时开工 \.- (recon|slice-\d{1,3})\s*$/.exec(line)
      if (parallel !== null) { links.push([parallel[1], parallel[2]]); continue }
      throw new Error('Unsupported orchestration directive')
    }
    if (ids.size === 0 || ids.size > 32 || links.length > 64 || links.some(([from, to]) => !ids.has(from) || !ids.has(to))) throw new Error('Invalid orchestration nodes or edges')
    return
  }
  const ids = new Set()
  const edges = []
  const classes = []
  for (const line of lines.slice(1)) {
    const node = /^\s*n_([A-Za-z][A-Za-z0-9_-]{0,63})\["([^"\\<>]*)"\]\s*$/.exec(line)
    if (node !== null) { if (ids.has(node[1])) throw new Error('Duplicate node'); ids.add(node[1]); continue }
    const edge = /^\s*n_([A-Za-z][A-Za-z0-9_-]{0,63}) --> n_([A-Za-z][A-Za-z0-9_-]{0,63})\s*$/.exec(line)
    if (edge !== null) { edges.push([edge[1], edge[2]]); continue }
    if (/^\s*classDef (pending|ready|running|succeeded|failed|blocked|skipped|unknown) fill:#(?:f1f5f9|dbeafe|fef3c7|dcfce7|fee2e2|ffedd5|e5e7eb|ede9fe),stroke:#475569,color:#0f172a$/.test(line)) continue
    const nodeClass = /^\s*class n_([A-Za-z][A-Za-z0-9_-]{0,63}) (pending|ready|running|succeeded|failed|blocked|skipped|unknown)$/.exec(line)
    if (nodeClass !== null) { classes.push(nodeClass[1]); continue }
    throw new Error('Unsupported Mermaid directive')
  }
  if (ids.size === 0 || ids.size > 32 || edges.length > 64 || edges.some(([from, to]) => !ids.has(from) || !ids.has(to)) || classes.some((id) => !ids.has(id))) throw new Error('Invalid Mermaid nodes or edges')
}

let mermaidPromise
const loadMermaid = (document_ = globalThis.document) => {
  if (mermaidPromise !== undefined) return mermaidPromise
  mermaidPromise = new Promise((resolve, reject) => {
    if (document_ === undefined) { reject(new Error('Browser DOM unavailable')); return }
    const script = document_.createElement('script')
    script.src = ASSET_URL
    script.async = true
    script.onload = () => {
      const mermaid = globalThis.mermaid
      if (mermaid?.render === undefined || mermaid?.parse === undefined) { reject(new Error('Local Mermaid module unavailable')); return }
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'flowchart'], flowchart: { htmlLabels: false }, maxTextSize: 32768, maxEdges: 64 })
      resolve(mermaid)
    }
    script.onerror = () => { script.remove(); reject(new Error('Local Mermaid asset unavailable')) }
    document_.head.appendChild(script)
  }).catch((error) => { mermaidPromise = undefined; throw error })
  return mermaidPromise
}

const isSafeSvgMarkup = (svg) => typeof svg === 'string' && svg.startsWith('<svg') && !/<(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=|(?:href|src)\s*=\s*["'](?!#)|@import|url\(\s*["']?(?!#)/i.test(svg)
let renderSequence = 0
const renderMermaid = async (source) => {
  validateSource(source)
  const mermaid = await loadMermaid()
  await mermaid.parse(source)
  const { svg } = await mermaid.render(`swarm-flow-${++renderSequence}`, source)
  if (!isSafeSvgMarkup(svg)) throw new Error('Unsafe SVG rejected')
  return svg
}

const styles = {
  card: { padding: 14, margin: '10px 0', border: '1px solid var(--dsw-alias-border-l2, #dbe0e6)', borderRadius: 10, color: 'var(--dsw-alias-label-primary, #1b2733)', overflowWrap: 'anywhere' },
  header: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  status: { color: 'var(--dsw-alias-label-secondary, #596579)', fontSize: 13 },
  button: { marginLeft: 'auto', padding: '4px 10px', border: '1px solid var(--dsw-alias-border-l2, #dbe0e6)', borderRadius: 6, cursor: 'pointer', color: 'inherit', background: 'transparent' },
  diagram: { overflowX: 'auto', padding: '12px 0', maxWidth: '100%' },
  source: { overflowX: 'auto', padding: 10, whiteSpace: 'pre-wrap', fontSize: 12 },
  steps: { paddingLeft: 22, lineHeight: 1.8 }
}

const getTaskFromRpc = (value, taskId) => {
  const task = Array.isArray(value?.tasks) ? value.tasks.find((candidate) => candidate.task_id === taskId) : value?.task ?? value
  if (task === null || typeof task !== 'object' || task.task_id !== taskId) throw new Error('Task response identity mismatch')
  return task
}

const getTaskMarkdown = (view, fallback) => {
  const card = view?.card
  if (card === undefined) return typeof view?.markdown === 'string' ? view.markdown : view?.goal === undefined ? fallback : `### ${view.title ?? view.task_id}\n\n${view.goal}`
  return [`### ${card.title ?? view.task_id}`, `任务：${view.task_id} · 合同 ${view.cardRevision ?? 1} · 流程 ${view.workflowRevision ?? 1}`, `目标：${card.goal ?? ''}`, '验收标准：', ...(Array.isArray(card.acceptance) ? card.acceptance.map((item, i) => `- A${i + 1}：${item}`) : []), `相关文件：${Array.isArray(card.scope) && card.scope.length > 0 ? card.scope.join('、') : '待定位'}`, `性能预算：${card.perf === undefined ? '待测' : Object.entries(card.perf).map(([key, value]) => `${key}=${value}`).join('；') || '待测'}`, ...(view.budget?.max === undefined ? [] : [`委派预算：${view.budget.max === 0 ? '不限' : `${view.budget.max} 次`}；已用 ${view.budget.used ?? 0}`])].join('\n\n')
}

const getDiagramBundle = (view) => {
  const bundle = view?.diagrams
  if (bundle?.format !== 'dsh-agent-swarm/task-diagrams' || bundle.schemaVersion !== 1 || !Array.isArray(bundle.views)) return null
  const binding = bundle.binding
  if (typeof view?.task_id !== 'string' || binding?.taskId !== view.task_id || ['cardRevision', 'workflowRevision', 'requestRevision'].some((key) => binding[key] !== (view[key] ?? 1))) return null
  // 编排视角是可选追加图：旧快照仍是五图，记录过执行前编排的任务多一张；未知视角与重复视角仍然拒绝。
  const requiredKinds = ['workflow', 'architecture', 'sequence', 'dataflow', 'lifecycle']
  const allowedKinds = [...requiredKinds, 'orchestration']
  if (!/^[a-f0-9]{64}$/.test(bundle.snapshotDigest) || new Set(bundle.views.map((item) => item?.kind)).size !== bundle.views.length
    || requiredKinds.some((kind) => !bundle.views.some((item) => item?.kind === kind))
    || bundle.views.some((item) => !allowedKinds.includes(item?.kind) || typeof item?.mermaid !== 'string' || item.mermaid.length > 32768 || typeof item.basis !== 'string' || !Number.isSafeInteger(item.truncated) || item.truncated < 0)
    || !Array.isArray(bundle.diagnostics) || bundle.diagnostics.some((item) => typeof item?.code !== 'string' || typeof item?.message !== 'string')) return null
  const progress = bundle.progress
  if (progress === undefined || !Number.isSafeInteger(progress.total) || progress.total < 0 || !Number.isSafeInteger(progress.completed) || progress.completed < 0 || progress.completed > progress.total
    || progress.percent !== (progress.total === 0 ? null : Math.floor(progress.completed / progress.total * 100)) || !progress.statuses || Object.values(progress.statuses).some((count) => !Number.isSafeInteger(count) || count < 0)
    || Object.values(progress.statuses).reduce((sum, count) => sum + count, 0) !== progress.total || progress.statuses.succeeded !== progress.completed) return null
  return bundle
}
const exportDiagramSnapshot = (bundle) => {
  if (bundle === null) return
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `swarm-${String(bundle.binding.taskId).replace(/[^A-Za-z0-9_-]/g, '_')}-diagrams.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** 分开显示代码检查和两类模型意见；没有结果时明确未审核。 */
const getPlanningReviewView = (review) => {
  const verdict = (value) => ['pass', 'changes_requested', 'unknown', 'needs-clarification', 'review_required', 'unavailable'].includes(value) ? value : 'unknown'
  const jevStatus = (ids) => {
    if (review?.jev?.status !== 'ok') return verdict(review?.jev?.status === 'unavailable' ? 'unavailable' : 'unknown')
    const threshold = review?.reviewPolicy?.reviewAbove ?? 0.8
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return 'unknown'
    const values = ids.map((id) => review.jev.answers?.[id]?.noul)
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) return 'unknown'
    return values.every((value) => value >= threshold) ? 'pass' : 'review_required'
  }
  return {
    present: review !== null && typeof review === 'object',
    goal: { agent: verdict(review?.goalReview?.verdict), jev: jevStatus(['goal_alignment', 'requirement_coverage', 'acceptance_testability']) },
    design: { agent: verdict(review?.designReview?.verdict), jev: jevStatus(['design_sufficiency', 'execution_boundaries', 'failure_bounds']) },
    mermaid: { syntax: review?.mermaidReview?.parserVersion === 'not-run' ? 'unknown' : verdict(review?.mermaidReview?.parseVerdict === 'fail' ? 'changes_requested' : review?.mermaidReview?.parseVerdict), projection: verdict(review?.mermaidReview?.projectionVerdict === 'fail' ? 'changes_requested' : review?.mermaidReview?.projectionVerdict), agent: verdict(review?.mermaidReview?.semanticVerdict), jev: jevStatus(['mermaid_expression']) },
    errors: Array.isArray(review?.errors) ? review.errors.filter((item) => typeof item === 'string') : [],
    findings: Array.isArray(review?.agent?.result?.findings) ? review.agent.result.findings.filter((item) => item !== null && typeof item === 'object').map((item) => ({ location: [item.requirementId, item.acceptanceId, item.nodeId].filter((value) => typeof value === 'string').join(' / '), severity: item.severity, issue: item.issue, evidence: item.evidence, suggestion: item.suggestion })) : [],
    jevReason: typeof review?.jev?.reason === 'string' ? review.jev.reason : undefined
  }
}

function PlanningReviewPanel ({ review, t }) {
  const translate = typeof t === 'function' ? t : (key) => zh[key] ?? key
  const value = getPlanningReviewView(review)
  const label = (status) => status === 'unknown' ? translate('reviewNotReviewed') : status === 'pass' ? translate('checkPass') : status === 'unavailable' ? translate('reviewUnavailable') : translate(status)
  const opinions = (dimension) => `${translate('agentOpinion')}：${label(dimension.agent)}；${translate('jevOpinion')}：${label(dimension.jev)}`
  return h('div', { 'data-swarm-plan-review': '', style: { marginTop: 12, fontSize: 13, lineHeight: 1.7 } },
    h('strong', null, translate('planningReview')),
    h('ul', { style: { paddingLeft: 20, margin: '4px 0' } },
      h('li', { 'data-plan-dimension': 'goal' }, `${translate('goalDimension')} · ${opinions(value.goal)}`),
      h('li', { 'data-plan-dimension': 'design' }, `${translate('designDimension')} · ${opinions(value.design)}`),
      h('li', { 'data-plan-dimension': 'mermaid' }, `${translate('mermaidDimension')} · ${translate('syntaxCheck')}：${label(value.mermaid.syntax)}；${translate('projectionCheck')}：${label(value.mermaid.projection)}；${translate('semanticCheck')}（${translate('agentOpinion')}）：${label(value.mermaid.agent)}；${translate('jevOpinion')}：${label(value.mermaid.jev)}`)),
    value.jevReason === undefined ? null : h('p', { style: { margin: '4px 0' } }, `${translate('jevOpinion')}：${value.jevReason}`),
    value.errors.length === 0 && value.findings.length === 0 ? null : h('details', { open: !['pass', 'pass_with_degradation'].includes(review?.status), 'data-swarm-review-issues': '' }, h('summary', null, translate('reviewIssues')),
      h('ul', { style: { paddingLeft: 20 } }, ...value.errors.map((error, index) => h('li', { key: `error-${index}` }, error)), ...value.findings.map((finding, index) => h('li', { key: `finding-${index}` }, `${finding.severity ?? ''} · ${finding.location || translate('unknown')}：${finding.issue ?? ''}`, typeof finding.evidence === 'string' ? h('p', null, finding.evidence) : null, typeof finding.suggestion === 'string' ? h('p', null, finding.suggestion) : null)))))
}

const EMPTY_TASK_SNAPSHOT = Object.freeze({ value: null, status: 'idle', error: null, updatedAt: null })
const NO_SUBSCRIBE = () => () => undefined
const getEmptySnapshot = () => EMPTY_TASK_SNAPSHOT
const DIAGRAM_KINDS = ['orchestration', 'workflow', 'architecture', 'sequence', 'dataflow', 'lifecycle']
Object.assign(zh, { historical: '历史工具记录 / 被动只读缓存', contractDetails: '任务合同与规划审核', currentBlock: '当前阻塞', progressTab: '任务进度', openProgress: '请打开「任务进度」选项卡查看完整图表', noRecord: '当前任务未记录此视角。', nodeDetails: '节点详情', selectNode: '选择节点查看依赖与当前事实', dependencies: '依赖', noDependencies: '无前置依赖', lastUpdated: '最近更新', live: '实时快照', settledSnapshot: '终态快照', refreshing: '正在刷新', offline: '连接已断开', idle: '尚未读取', unavailableSnapshot: '尚无可用快照', staleSnapshot: '过期快照', readonly: '只读展示；不会批准、派发、恢复或完成任务。' })
Object.assign(en, { historical: 'Historical tool record / passive cache', contractDetails: 'Task contract and planning review', currentBlock: 'Current block', progressTab: 'Task progress', openProgress: 'Open the Task progress tab for all diagrams', noRecord: 'This view was not recorded for the task.', nodeDetails: 'Node details', selectNode: 'Select a node to inspect dependencies and observed state', dependencies: 'Dependencies', noDependencies: 'No dependencies', lastUpdated: 'Last updated', live: 'Current snapshot', settledSnapshot: 'Settled snapshot', refreshing: 'Refreshing', offline: 'Disconnected', idle: 'Not loaded', unavailableSnapshot: 'No valid snapshot yet', staleSnapshot: 'Stale snapshot', readonly: 'Read only; does not approve, delegate, resume or complete tasks.' })

const validateTaskView = (value) => {
  if (value?.diagrams !== undefined && getDiagramBundle(value) === null) throw new Error('Task diagram binding or progress mismatch')
  return value
}
const useTaskSnapshot = (store, root, task, options) => {
  const passive = options?.passive === true
  const source = React.useMemo(() => typeof root === 'string' && typeof task === 'string' ? store?.task(root, task, { passive }) : undefined, [store, root, task, passive])
  return { snapshot: React.useSyncExternalStore(source?.subscribe ?? NO_SUBSCRIBE, source?.getSnapshot ?? getEmptySnapshot), source }
}

function TaskProgressSummary ({ bundle, t }) {
  if (bundle === null) return null
  return h('div', { 'data-swarm-task-progress': '', style: { margin: '10px 0', fontSize: 13 } },
    h('strong', null, bundle.progress.percent === null ? t('progressUnknown') : `${t('progress')}：${bundle.progress.completed}/${bundle.progress.total} (${bundle.progress.percent}%)`),
    bundle.progress.percent === null ? null : h('progress', { value: bundle.progress.completed, max: bundle.progress.total, style: { display: 'block', width: '100%', margin: '6px 0' }, 'aria-label': t('progress') }),
    h('p', { style: { margin: '4px 0' } }, Object.entries(bundle.progress.statuses).map(([status, count]) => `${t(status === 'pending' ? 'nodePending' : status === 'unknown' ? 'unknownNode' : status)} ${count}`).join(' · ')),
    h('small', null, t('progressBoundary')))
}

function Freshness ({ snapshot, t }) {
  const settled = snapshot.value?.acceptance?.status === 'accepted' || snapshot.value?.acceptance?.decision === 'incomplete'
  const label = snapshot.status === 'stale' ? 'staleSnapshot' : snapshot.status === 'unavailable' ? 'unavailableSnapshot' : snapshot.status === 'live' && settled ? 'settledSnapshot' : snapshot.status
  return h('p', { style: styles.status, role: 'status', 'aria-live': 'polite', 'data-swarm-freshness': snapshot.status },
    t(label), snapshot.updatedAt === null ? null : ` · ${t('lastUpdated')} ${new Date(snapshot.updatedAt).toLocaleTimeString()}`,
    snapshot.error === null ? null : ` · ${snapshot.error}`)
}

/** 只绘制当前可见视角；源码相同不重新布局，隐藏时取消结果发布而不假称抢占同步解析。 */
function TaskDiagramPanel ({ view, source, t, preference, setPreference }) {
  const saved = preference ?? {}
  const [kind, setKind] = React.useState(saved.kind ?? 'workflow')
  const [zoom, setZoom] = React.useState(saved.zoom ?? 1)
  const [selected, setSelected] = React.useState(null)
  const [svg, setSvg] = React.useState(null)
  const [renderError, setRenderError] = React.useState(null)
  const [visible, setVisible] = React.useState(globalThis.document?.visibilityState !== 'hidden')
  const bundle = getDiagramBundle(view)
  const diagram = bundle?.views.find((candidate) => candidate.kind === kind)
  const mermaidSource = bundle === null ? source : diagram?.mermaid
  const scroll = React.useRef(null)
  React.useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden')
    globalThis.document?.addEventListener?.('visibilitychange', update)
    return () => globalThis.document?.removeEventListener?.('visibilitychange', update)
  }, [])
  React.useEffect(() => {
    let current = true
    setSvg(null); setRenderError(null)
    if (visible && mermaidSource !== undefined) renderMermaid(mermaidSource).then((value) => { if (current) setSvg({ source: mermaidSource, value }) }).catch((error) => { if (current) setRenderError(String(error.message ?? error)) })
    return () => { current = false }
  }, [mermaidSource, visible])
  React.useEffect(() => {
    if (scroll.current !== null) { scroll.current.scrollTop = saved.scrollTop ?? 0; scroll.current.scrollLeft = saved.scrollLeft ?? 0 }
  }, [])
  const changePreference = (nextKind, nextZoom) => {
    setKind(nextKind); setZoom(nextZoom)
    setPreference?.({ kind: nextKind, zoom: nextZoom })
  }
  const definition = view?.flow?.definition ?? view?.workflowDefinition
  const state = view?.flow?.state ?? view?.workflowState
  const step = definition?.nodes?.find((item) => item.id === selected)
  return h('div', { 'data-swarm-diagram-panel': '' },
    bundle === null ? view?.diagrams === undefined ? null : h('p', { role: 'status' }, t('diagramBindingMismatch')) : h('div', { style: { ...styles.header, margin: '10px 0' } },
      h('label', null, `${t('diagramType')} `, h('select', { value: kind, onChange: (event) => changePreference(event.target.value, 1), 'aria-label': t('diagramType'), 'data-swarm-diagram-type': '', style: { minHeight: 36, maxWidth: '100%' } }, ...DIAGRAM_KINDS.map((item) => h('option', { key: item, value: item }, `${t(item)}${bundle.views.some((candidate) => candidate.kind === item) ? '' : ` · ${t('noRecord')}`}`)))),
      h('button', { type: 'button', style: styles.button, onClick: () => exportDiagramSnapshot(bundle) }, t('exportSnapshot'))),
    bundle !== null && diagram === undefined ? h('p', { role: 'status', 'data-swarm-missing-view': kind }, t('noRecord')) : null,
    diagram === undefined ? null : h('p', { style: styles.status, 'data-swarm-diagram-basis': diagram.kind }, `${diagram.basis}${diagram.truncated > 0 ? `；${t('omitted')} ${diagram.truncated}` : ''} · ${bundle.snapshotDigest.slice(0, 12)}`),
    bundle?.diagnostics.length > 0 ? h('details', { 'data-swarm-diagram-diagnostics': '' }, h('summary', null, `${t('deviations')} (${bundle.diagnostics.length})`), h('ul', null, ...bundle.diagnostics.map((item, index) => h('li', { key: index }, `${item.code}${item.nodeId === undefined ? '' : ` · ${item.nodeId}`}：${item.message}`)))) : null,
    svg === null || svg.source !== mermaidSource || !visible ? null : h('div', null,
      h('div', { style: styles.header }, h('button', { type: 'button', style: { ...styles.button, marginLeft: 0 }, disabled: zoom >= 3, onClick: () => changePreference(kind, Math.min(3, zoom + 0.5)) }, t('zoomIn')), h('button', { type: 'button', style: { ...styles.button, marginLeft: 0 }, disabled: zoom <= 1, onClick: () => changePreference(kind, Math.max(1, zoom - 0.5)) }, t('zoomOut')), h('button', { type: 'button', style: { ...styles.button, marginLeft: 0 }, onClick: () => changePreference(kind, 1) }, t('fit'))),
      h('div', { ref: scroll, style: { ...styles.diagram, maxHeight: '65vh', overflow: 'auto' }, tabIndex: 0, 'aria-label': t('title'), 'data-swarm-diagram-zoom': String(zoom), onScroll: (event) => setPreference?.({ kind, zoom, scrollTop: event.currentTarget.scrollTop, scrollLeft: event.currentTarget.scrollLeft }) }, h('div', { style: { width: `${zoom * 100}%` }, role: 'img', 'aria-label': t(kind), dangerouslySetInnerHTML: { __html: svg.value } }))),
    renderError === null ? null : h('p', { role: 'status' }, `${t('renderError')}：${renderError}`),
    Array.isArray(definition?.nodes) ? h('div', { style: { marginTop: 14 } },
      h('p', { style: styles.status }, t('selectNode')),
      h('ol', { style: styles.steps }, ...definition.nodes.map((node) => h('li', { key: node.id }, h('button', { type: 'button', 'aria-pressed': node.id === selected, onClick: () => setSelected(node.id), style: { ...styles.button, marginLeft: 0, textAlign: 'left' } }, `${node.label} · ${t((state?.nodes?.[node.id]?.status ?? 'pending') === 'pending' ? 'nodePending' : state.nodes[node.id].status)}`)))),
      step === undefined ? null : h('section', { 'data-swarm-node-details': step.id, style: styles.card, 'aria-label': t('nodeDetails') }, h('strong', null, `${step.id} · ${step.label}`), h('p', null, `${step.operation}${step.role === undefined ? '' : ` · ${step.role}`}`), h('p', null, `${t('dependencies')}：${step.dependsOn?.join('、') || t('noDependencies')}`), state?.nodes?.[step.id]?.reason === undefined ? null : h('p', null, state.nodes[step.id].reason))) : null,
    mermaidSource === undefined ? null : h('details', { 'data-swarm-mermaid-source': '' }, h('summary', null, t('source')), h('pre', { style: styles.source }, mermaidSource)))
}

function TaskFlowContent ({ taskId, fallback = '', historicalSource, snapshot = EMPTY_TASK_SNAPSHOT, onRefresh, t, compact = false, progressPage = false, source }) {
  const translate = typeof t === 'function' ? t : (key) => zh[key] ?? key
  const view = snapshot.value
  const planningStatus = compact ? 'historical' : view?.planningReview?.status ?? (view?.workflowMode === 'enforced' ? 'pending' : 'notReviewed')
  const bundle = getDiagramBundle(view)
  const markdown = compact ? fallback : getTaskMarkdown(view, fallback)
  const contract = [
    MarkdownText === undefined ? h('pre', { style: styles.source }, markdown) : h(MarkdownText, { text: markdown, streaming: false, labels: EMPTY_LABELS, variant: 'compact' }),
    compact ? null : h(PlanningReviewPanel, { review: view?.planningReview, t: translate })
  ]
  const progress = h(TaskProgressSummary, { bundle, t: translate })
  const pending = view?.stateRefreshRequired === true ? h('p', { role: 'status', 'data-swarm-projection-pending': '' }, translate('projectionPending')) : null
  const blocker = view?.blockedRecovery?.active === true && typeof view.blockedRecovery.summary === 'string' ? h('p', { role: 'status', 'data-swarm-current-block': '' }, `${translate('currentBlock')}：${view.blockedRecovery.summary}`) : null
  const canvas = compact ? h('p', { style: styles.status }, translate('openProgress')) : h(TaskDiagramPanel, { key: taskId, view, source: view?.flow?.mermaid ?? view?.mermaid ?? historicalSource, t: translate, preference: source?.readPreference(), setPreference: source?.setPreference })
  return h('section', { style: styles.card, 'data-swarm-task-flow': taskId, 'aria-label': translate('title') },
    h('div', { style: styles.header }, h('strong', null, `${translate('title')} · ${taskId}`), h('span', { style: styles.status, 'data-planning-status': compact ? 'historical' : view === null ? 'pending' : planningStatus }, translate(compact ? 'historical' : view === null ? 'pending' : planningStatus)), typeof onRefresh !== 'function' ? null : h('button', { type: 'button', style: styles.button, onClick: onRefresh }, translate('refresh'))),
    h(Freshness, { snapshot, t: translate }),
    ...(progressPage ? [progress, blocker, pending, canvas, h('details', { 'data-swarm-contract-details': '' }, h('summary', null, translate('contractDetails')), ...contract)] : [...contract, progress, blocker, pending, canvas]))
}

function TaskFlowRow (props) {
  const { sessionId, store, node } = props
  const data = node?.data
  const compact = props.progressAvailable === true
  const { snapshot, source } = useTaskSnapshot(store, sessionId, data?.taskId, { passive: compact })
  if (data === undefined) return null
  return h(TaskFlowContent, { taskId: data.taskId, fallback: data.text, historicalSource: data.mermaid, snapshot: compact ? { ...snapshot, status: 'historical' } : snapshot, source, onRefresh: source?.refresh, t: props.t, compact })
}

const inject = ['slots', 'locale', 'uiConversation', 'connection']
function apply (ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'swarm-task-flow: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(taskFlowDefinition), 'swarm-task-flow: event projection')
  const retained = retainTaskViewStore(ctx.get('connection'), validateTaskView)
  ctx.effect(() => retained.release, 'swarm-task-flow: shared reads')
  ctx.slots.inject('conversation.chat.node', function * () {
    yield ctx.slots.register({ name: 'conversation.chat.node', key: KIND, locale: NS, inject: () => ({ store: retained.store, progressAvailable: typeof ctx.slots.entries === 'function' && ctx.slots.entries('conversation.view').some((entry) => entry.options?.id === 'swarm-task-progress') }) }, TaskFlowRow)
  })
}

exports.inject = inject
exports.apply = apply
exports.NS = NS
exports.validateTaskView = validateTaskView
exports.TaskFlowContent = TaskFlowContent
exports.useTaskSnapshot = useTaskSnapshot
exports.dictionaries = { zh, en }
exports.__test__ = { readTaskResult, taskFlowDefinition, validateSource, loadMermaid, isSafeSvgMarkup, getTaskFromRpc, getTaskMarkdown, getPlanningReviewView, PlanningReviewPanel, getDiagramBundle, exportDiagramSnapshot, TaskFlowRow, TaskFlowContent, TaskDiagramPanel, TaskProgressSummary, Freshness, validateTaskView, useTaskSnapshot, zh, en, styles, DIAGRAM_KINDS }
