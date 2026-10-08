// 流程是宿主状态的派生只读视图；RPC 失败时保留真实工具结果与源码，不伪造通过状态。
const React = require('react')
const h = React.createElement
let MarkdownText
try { MarkdownText = require('@deepseek-ai/dsh-client-ui-primitives').MarkdownText } catch { MarkdownText = undefined }

const NS = 'swarmTaskFlow'
const KIND = 'swarm-task-flow'
const ASSET_URL = '/api/swarm-assets/mermaid.min.js'
const EMPTY_LABELS = Object.freeze({ code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' })
const zh = { title: '任务流程', refresh: '刷新状态', source: 'Mermaid 源码', loading: '读取任务状态…', unavailable: '任务状态暂不可用', renderError: '图形展示不可用，仍可读取源码与步骤', pending: '流程已生成，等待审核', nodePending: '待执行', reviewing: '审核中', pass: '已审核', pass_with_degradation: '降级审核', changes_requested: '需修正', unknown: '审核未确定', 'needs-clarification': '待澄清', review_required: '需独立复核', stale: '审核失效', ready: '可执行', running: '执行中', succeeded: '已完成', failed: '失败', blocked: '阻塞', skipped: '跳过', generated: '流程已生成', workflowMode: '流程模式' }
const en = { title: 'Task flow', refresh: 'Refresh status', source: 'Mermaid source', loading: 'Loading task state…', unavailable: 'Task state unavailable', renderError: 'Diagram unavailable; source and steps remain readable', pending: 'Generated, awaiting review', nodePending: 'Pending', reviewing: 'Reviewing', pass: 'Reviewed', pass_with_degradation: 'Reviewed with degradation', changes_requested: 'Changes requested', unknown: 'Review undetermined', 'needs-clarification': 'Needs clarification', review_required: 'Independent review required', stale: 'Review stale', ready: 'Ready', running: 'Running', succeeded: 'Completed', failed: 'Failed', blocked: 'Blocked', skipped: 'Skipped', generated: 'Flow generated', workflowMode: 'Flow mode' }
Object.assign(zh, { zoomIn: '放大', zoomOut: '缩小', fit: '适应宽度' })
Object.assign(en, { zoomIn: 'Zoom in', zoomOut: 'Zoom out', fit: 'Fit width' })
Object.assign(zh, { planningReview: '规划审核', goalDimension: '目标', designDimension: '流程设计', mermaidDimension: 'Mermaid', agentOpinion: '独立 Agent', jevOpinion: 'Jev 判断', syntaxCheck: '语法', projectionCheck: '投影', semanticCheck: '语义', notReviewed: '未审核', checkPass: '通过', checkFail: '未通过', reviewIssues: '审核发现与错误' })
Object.assign(en, { planningReview: 'Planning review', goalDimension: 'Goal', designDimension: 'Workflow design', mermaidDimension: 'Mermaid', agentOpinion: 'Independent Agent', jevOpinion: 'Jev judgment', syntaxCheck: 'Syntax', projectionCheck: 'Projection', semanticCheck: 'Semantics', notReviewed: 'Not reviewed', checkPass: 'Pass', checkFail: 'Failed', reviewIssues: 'Review findings and errors' })
Object.assign(zh, { reviewUnavailable: '未审核（服务不可用）' })
Object.assign(en, { reviewUnavailable: 'Not reviewed (service unavailable)' })

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
  if (lines[0] !== 'flowchart TD') throw new Error('Unsupported diagram')
  const ids = new Set()
  const edges = []
  for (const line of lines.slice(1)) {
    const node = /^\s*n_([A-Za-z][A-Za-z0-9_-]{0,63})\["([^"\\<>]*)"\]\s*$/.exec(line)
    if (node !== null) { if (ids.has(node[1])) throw new Error('Duplicate node'); ids.add(node[1]); continue }
    const edge = /^\s*n_([A-Za-z][A-Za-z0-9_-]{0,63}) --> n_([A-Za-z][A-Za-z0-9_-]{0,63})\s*$/.exec(line)
    if (edge !== null) { edges.push([edge[1], edge[2]]); continue }
    throw new Error('Unsupported Mermaid directive')
  }
  if (ids.size === 0 || ids.size > 32 || edges.length > 64 || edges.some(([from, to]) => !ids.has(from) || !ids.has(to))) throw new Error('Invalid Mermaid nodes or edges')
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
  const label = (status) => status === 'unknown' ? translate('notReviewed') : status === 'pass' ? translate('checkPass') : status === 'unavailable' ? translate('reviewUnavailable') : translate(status)
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

/** 只从当前会话 RPC 读取；旧响应和卸载后的结果不能覆盖最新视图。 */
function TaskFlowRow (props) {
  const { node, sessionId, loadTask, t } = props
  const translate = typeof t === 'function' ? t : (key) => zh[key] ?? key
  const data = node?.data
  const [view, setView] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [svg, setSvg] = React.useState(null)
  const [renderError, setRenderError] = React.useState(null)
  const [refresh, setRefresh] = React.useState(0)
  const [zoom, setZoom] = React.useState(1)
  React.useEffect(() => {
    let active = true
    setView(null)
    setError(null)
    if (typeof sessionId !== 'string' || typeof data?.taskId !== 'string' || typeof loadTask !== 'function') { setError(translate('unavailable')); return () => { active = false } }
    loadTask(sessionId, data.taskId).then((value) => { if (active) setView(getTaskFromRpc(value, data.taskId)) }).catch((cause) => { if (active) setError(String(cause.message ?? cause)) })
    return () => { active = false }
  }, [sessionId, data?.taskId, data?.seq, loadTask, refresh])
  const source = view?.flow?.mermaid ?? view?.mermaid ?? data?.mermaid
  React.useEffect(() => {
    let active = true
    setSvg(null)
    setRenderError(null)
    if (source !== undefined) renderMermaid(source).then((value) => { if (active) setSvg(value) }).catch((cause) => { if (active) setRenderError(String(cause.message ?? cause)) })
    return () => { active = false }
  }, [source, refresh])
  if (data === undefined) return null
  const definition = view?.flow?.definition ?? view?.workflowDefinition
  const state = view?.flow?.state ?? view?.workflowState
  const planningStatus = view?.planningReview?.status ?? 'pending'
  const markdown = getTaskMarkdown(view, data.text)
  return h('section', { style: styles.card, 'data-swarm-task-flow': data.taskId, 'aria-label': translate('title') },
    h('div', { style: styles.header }, h('strong', null, `${translate('title')} · ${data.taskId}`), h('span', { style: styles.status, 'data-planning-status': view === null ? 'pending' : planningStatus }, translate(view === null ? 'pending' : planningStatus)), h('button', { type: 'button', style: styles.button, onClick: () => setRefresh((value) => value + 1) }, translate('refresh'))),
    error === null ? view === null ? h('p', { role: 'status' }, translate('loading')) : null : h('p', { role: 'status' }, `${translate('unavailable')}：${error}`),
    MarkdownText === undefined ? h('pre', { style: styles.source }, markdown) : h(MarkdownText, { text: markdown, streaming: false, labels: EMPTY_LABELS, variant: 'compact' }),
    h(PlanningReviewPanel, { review: view?.planningReview, t }),
    svg === null ? null : h('div', null,
      h('div', { style: styles.header }, h('button', { type: 'button', style: { ...styles.button, marginLeft: 0 }, disabled: zoom >= 3, onClick: () => setZoom((value) => Math.min(3, value + 0.5)) }, translate('zoomIn')), h('button', { type: 'button', style: { ...styles.button, marginLeft: 0 }, disabled: zoom <= 1, onClick: () => setZoom((value) => Math.max(1, value - 0.5)) }, translate('zoomOut')), h('button', { type: 'button', style: { ...styles.button, marginLeft: 0 }, onClick: () => setZoom(1) }, translate('fit'))),
      h('div', { style: styles.diagram, tabIndex: 0, 'aria-label': translate('title'), 'data-swarm-diagram-zoom': String(zoom) }, h('div', { style: { width: `${zoom * 100}%` }, role: 'img', 'aria-label': translate('title'), dangerouslySetInnerHTML: { __html: svg } }))),
    renderError === null ? null : h('p', { role: 'status' }, `${translate('renderError')}：${renderError}`),
    Array.isArray(definition?.nodes) ? h('ol', { style: styles.steps }, ...definition.nodes.map((step) => h('li', { key: step.id }, `${step.label} · ${translate((state?.nodes?.[step.id]?.status ?? 'pending') === 'pending' ? 'nodePending' : state.nodes[step.id].status)}${state?.nodes?.[step.id]?.reason === undefined ? '' : `：${state.nodes[step.id].reason}`}`))) : null,
    source === undefined ? null : h('details', { 'data-swarm-mermaid-source': '' }, h('summary', null, translate('source')), h('pre', { style: styles.source }, source)))
}

const inject = ['slots', 'locale', 'uiConversation', 'connection']
function apply (ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'swarm-task-flow: dictionaries')
  ctx.effect(() => ctx.uiConversation.events.register(taskFlowDefinition), 'swarm-task-flow: event projection')
  const loadTask = async (sessionId, taskId) => {
    const result = await ctx.get('connection').rpc.call('/api', 'swarm.taskView', { sessionId, taskId })
    if (result?.ok !== true) throw new Error(result?.error?.message ?? 'Task RPC unavailable')
    return result.value
  }
  ctx.slots.inject('conversation.chat.node', function * () {
    yield ctx.slots.register({ name: 'conversation.chat.node', key: KIND, locale: NS, inject: () => ({ loadTask }) }, TaskFlowRow)
  })
}

exports.inject = inject
exports.apply = apply
exports.NS = NS
exports.__test__ = { readTaskResult, taskFlowDefinition, validateSource, loadMermaid, isSafeSvgMarkup, getTaskFromRpc, getTaskMarkdown, getPlanningReviewView, PlanningReviewPanel, TaskFlowRow }
