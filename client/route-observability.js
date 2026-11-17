// 路由观测只读投影：RPC 返回先经过字段白名单与长度上限，再交给原生 details 折叠展示。
// 本模块不请求或修改控制面，不读取原始 error.message、账号域或凭据。

const React = require('react')
const h = React.createElement

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} RouteObservationRoute
 * @typedef {{ turn: number, step: number }} RouteObservationPosition
 * @typedef {{
 *   maxLogicalAttempts: number|null, logicalAttemptsUsed: number,
 *   maxTransientRetries: number|null, transientRetriesUsed: number,
 *   maxTransientWaitMs: number|null, transientWaitUsedMs: number,
 *   maxHoldWaits: number|null, holdWaitsUsed: number,
 *   maxHoldWaitMs: number|null, holdWaitUsedMs: number
 * }} RouteObservationBudget
 * @typedef {{ requestId: string, scope: 'root'|'child', position: RouteObservationPosition|null, startedAt: number, endedAt: number|null,
 *   final: 'pending'|'succeeded'|'failed'|'cancelled'|'superseded'|'released',
 *   endReason: string|null, terminal: string|null, selections: unknown[], attempts: unknown[], failures: unknown[], ignoredFailures: unknown[],
 *   waits: unknown[], budget: RouteObservationBudget, omittedSelections: number, omittedAttempts: number, omittedFailures: number,
 *   omittedIgnoredFailures: number, omittedWaits: number
 * }} RouteObservationRequest
 * @typedef {{ schemaVersion: 1, generatedAt: number, retainedRequests: number, omittedRequests: number, requests: RouteObservationRequest[] }} RouteObservabilitySnapshot
 */

const FINAL = new Set(['pending', 'succeeded', 'failed', 'cancelled', 'superseded', 'released'])
const SCOPE = new Set(['root', 'child'])
const END_REASON = new Set(['host_success', 'route_terminal', 'signal_aborted', 'manual_pause', 'new_request', 'logical_request_finished', 'agent_released'])
const TERMINAL = new Set(['route_chain_exhausted', 'recovery_attempts_exhausted', 'route_health_persist_failed', 'context_recovery_required'])
const FAILURE_KIND = new Set(['quota_exhausted', 'pool_exhausted', 'insufficient_balance', 'auth_invalid', 'model_unavailable', 'rate_limited', 'network_transient', 'service_transient', 'context_exceeded', 'capability_mismatch', 'protocol_incompatible', 'unknown'])
const IGNORED_REASON = new Set(['stale_request', 'duplicate_failure', 'manual_pause', 'signal_aborted'])
const ROUTE_SOURCE = new Set(['host-request-header', 'selected-admission', 'unavailable'])
const ATTEMPT_OUTCOME = new Set(['started', 'succeeded', 'failed', 'cancelled', 'unsettled'])
const WAIT_REASON = new Set(['network', 'route', 'retry', 'context_compaction'])
const WAIT_OUTCOME = new Set(['waiting', 'completed', 'timeout', 'cancelled', 'unknown'])
const LIMITS = Object.freeze({ requests: 32, selections: 16, attempts: 16, failures: 16, ignoredFailures: 16, waits: 32 })

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeString = (value, maxLength = 128) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength)
  : undefined
const safeNumber = (value, minimum = 0) => typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, value) : undefined
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum ? value : undefined
const safeStatus = (value) => safeInteger(value, 100) !== undefined && value <= 599 ? value : null
const safeNullableNumber = (value, minimum = 0) => safeNumber(value, minimum) ?? null
const safeNullableInteger = (value, minimum = 0) => safeInteger(value, minimum) ?? null
const safeNullableString = (value, allowed, fallback = null) => typeof value === 'string' && allowed.has(value) ? value : fallback
const safeArray = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : []
const boundedOmission = (value, limit, reported) => (safeInteger(reported) ?? 0) + (Array.isArray(value) ? Math.max(0, value.length - limit) : 0)
const safeTraceId = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,96}$`).test(value) ? value : undefined

const sanitizeRoute = (value) => {
  if (!isRecord(value)) return undefined
  const provider = safeString(value.provider)
  const model = safeString(value.model)
  if (provider === undefined || provider === '' || model === undefined || model === '') return undefined
  const reasoningEffort = safeString(value.reasoningEffort, 64)
  return { provider, model, ...(reasoningEffort === undefined || reasoningEffort === '' ? {} : { reasoningEffort }) }
}

const sanitizePosition = (value) => {
  if (!isRecord(value)) return null
  const turn = safeInteger(value.turn)
  const step = safeInteger(value.step)
  return turn === undefined || step === undefined ? null : { turn, step }
}

const sanitizeBudget = (value) => {
  const budget = isRecord(value) ? value : {}
  return {
    maxLogicalAttempts: safeNullableInteger(budget.maxLogicalAttempts),
    logicalAttemptsUsed: safeInteger(budget.logicalAttemptsUsed) ?? 0,
    maxTransientRetries: safeNullableInteger(budget.maxTransientRetries),
    transientRetriesUsed: safeInteger(budget.transientRetriesUsed) ?? 0,
    maxTransientWaitMs: safeNullableInteger(budget.maxTransientWaitMs),
    transientWaitUsedMs: safeInteger(budget.transientWaitUsedMs) ?? 0,
    maxHoldWaits: safeNullableInteger(budget.maxHoldWaits),
    holdWaitsUsed: safeInteger(budget.holdWaitsUsed) ?? 0,
    maxHoldWaitMs: safeNullableInteger(budget.maxHoldWaitMs),
    holdWaitUsedMs: safeInteger(budget.holdWaitUsedMs) ?? 0
  }
}

const sanitizeSelection = (value) => {
  if (!isRecord(value)) return undefined
  const ordinal = safeInteger(value.ordinal, 1)
  const at = safeNumber(value.at)
  const route = sanitizeRoute(value.route)
  if (ordinal === undefined || at === undefined || route === undefined) return undefined
  const attemptId = safeTraceId(value.attemptId, 'att')
  return { ordinal, at, route, attemptId: attemptId === undefined || attemptId === '' ? null : attemptId }
}

const sanitizeAttempt = (value) => {
  if (!isRecord(value)) return undefined
  const attemptId = safeTraceId(value.attemptId, 'att')
  const startedAt = safeNumber(value.startedAt)
  const route = value.route === null ? null : sanitizeRoute(value.route)
  const routeSource = safeNullableString(value.routeSource, ROUTE_SOURCE, 'unavailable')
  const outcome = safeNullableString(value.outcome, ATTEMPT_OUTCOME, 'unsettled')
  if (attemptId === undefined || attemptId === '' || startedAt === undefined || (value.route !== null && route === undefined)) return undefined
  return {
    attemptId,
    startedAt,
    endedAt: safeNullableNumber(value.endedAt),
    route,
    routeSource,
    outcome
  }
}

const sanitizeFailure = (value, ignored) => {
  if (!isRecord(value)) return undefined
  const at = safeNumber(value.at)
  const kind = safeNullableString(value.kind, FAILURE_KIND)
  const route = sanitizeRoute(value.route)
  if (at === undefined || kind === null || route === undefined) return undefined
  const attemptId = safeTraceId(value.attemptId, 'att')
  return {
    at,
    kind,
    route,
    status: safeStatus(value.status),
    retryAfterMs: safeNullableNumber(value.retryAfterMs),
    ...(ignored
      ? { reason: safeNullableString(value.reason, IGNORED_REASON, 'unknown') }
      : {
          attemptId: attemptId === undefined || attemptId === '' ? null : attemptId,
          terminal: safeNullableString(value.terminal, TERMINAL)
        })
  }
}

const sanitizeWait = (value) => {
  if (!isRecord(value)) return undefined
  const waitId = safeTraceId(value.waitId, 'wait')
  const reason = safeNullableString(value.reason, WAIT_REASON)
  const startedAt = safeNumber(value.startedAt)
  if (waitId === undefined || waitId === '' || reason === null || startedAt === undefined) return undefined
  return {
    waitId,
    reason,
    startedAt,
    plannedMs: safeNullableNumber(value.plannedMs),
    endedAt: safeNullableNumber(value.endedAt),
    waitedMs: safeNullableNumber(value.waitedMs),
    outcome: safeNullableString(value.outcome, WAIT_OUTCOME, 'unknown'),
    reportedRecovered: typeof value.reportedRecovered === 'boolean' ? value.reportedRecovered : null,
    route: value.route === null || value.route === undefined ? null : sanitizeRoute(value.route) ?? null,
    failureKind: safeNullableString(value.failureKind, FAILURE_KIND)
  }
}

const compactList = (values, sanitizer) => {
  const result = []
  for (const value of values) {
    const item = sanitizer(value)
    if (item !== undefined) result.push(item)
  }
  return result
}

/**
 * RPC 返回只读白名单投影。
 * @param {unknown} value
 * @returns {RouteObservabilitySnapshot|undefined}
 */
const sanitizeRouteObservability = (value) => {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.requests)) return undefined
  const requests = []
  for (const raw of safeArray(value.requests, LIMITS.requests)) {
    if (!isRecord(raw)) continue
    const requestId = safeTraceId(raw.requestId, 'req')
    const scope = safeNullableString(raw.scope, SCOPE)
    const startedAt = safeNumber(raw.startedAt)
    const final = safeNullableString(raw.final, FINAL)
    if (requestId === undefined || scope === null || startedAt === undefined || final === null) continue
    requests.push({
      requestId,
      scope,
      position: sanitizePosition(raw.position),
      startedAt,
      endedAt: safeNullableNumber(raw.endedAt),
      final,
      endReason: safeNullableString(raw.endReason, END_REASON),
      terminal: safeNullableString(raw.terminal, TERMINAL),
      selections: compactList(safeArray(raw.selections, LIMITS.selections), sanitizeSelection),
      attempts: compactList(safeArray(raw.attempts, LIMITS.attempts), sanitizeAttempt),
      failures: compactList(safeArray(raw.failures, LIMITS.failures), (item) => sanitizeFailure(item, false)),
      ignoredFailures: compactList(safeArray(raw.ignoredFailures, LIMITS.ignoredFailures), (item) => sanitizeFailure(item, true)),
      waits: compactList(safeArray(raw.waits, LIMITS.waits), sanitizeWait),
      budget: sanitizeBudget(raw.budget),
      omittedSelections: boundedOmission(raw.selections, LIMITS.selections, raw.omittedSelections),
      omittedAttempts: boundedOmission(raw.attempts, LIMITS.attempts, raw.omittedAttempts),
      omittedFailures: boundedOmission(raw.failures, LIMITS.failures, raw.omittedFailures),
      omittedIgnoredFailures: boundedOmission(raw.ignoredFailures, LIMITS.ignoredFailures, raw.omittedIgnoredFailures),
      omittedWaits: boundedOmission(raw.waits, LIMITS.waits, raw.omittedWaits)
    })
  }
  return {
    schemaVersion: 1,
    generatedAt: safeNumber(value.generatedAt) ?? 0,
    retainedRequests: requests.length,
    omittedRequests: boundedOmission(value.requests, LIMITS.requests, value.omittedRequests),
    requests
  }
}

const dictionaries = {
  zh: {
    routeObservability: '路由观测',
    routeTraceRequests: '请求',
    routeTraceDroppedRequests: '进程缓存累计省略请求',
    routeTraceProcess: '仅保留在当前进程；进程重启会清空，不是持久审计记录。',
    routeTraceBoundary: '只读事实：不推断额度，不展示原始错误、账号或凭据。',
    routeTraceEmpty: '当前进程尚未记录路由请求。',
    routeTraceRequest: '请求',
    routeTracePosition: '位置',
    routeTraceStarted: '开始',
    routeTraceEnded: '结束',
    routeTraceFinal: '终态',
    routeTraceEndReason: '结束原因',
    routeTraceTerminal: '路由终态',
    routeTraceBudget: '预算与用量',
    routeTraceLogicalAttempts: '逻辑尝试',
    routeTraceTransientRetries: '短重试',
    routeTraceShortWait: '短等待',
    routeTraceHoldWaits: '保持等待',
    routeTraceHoldWaitCount: '等待次数',
    routeTraceSelections: '准入选择',
    routeTraceAttempts: '实际 attempt',
    routeTraceFailures: '失败事实',
    routeTraceIgnoredFailures: '未归属到当前请求的迟到失败',
    routeTraceWaits: '等待与恢复',
    routeTraceOmitted: '更早记录已丢弃',
    routeTraceNoItems: '无记录',
    routeTraceAttemptAssociation: '关联 attempt',
    routeTracePlanned: '计划',
    routeTraceActual: '实际',
    routeTraceReportedNetwork: '联网探测报告',
    routeTraceOutcome: '结果',
    routeTraceRetryAfter: '上游提示重试',
    routeTraceStatus: 'HTTP 状态',
    routeTraceScopeRoot: '主会话',
    routeTraceScopeChild: '子智能体',
    routeTraceFinalPending: '进行中',
    routeTraceFinalSucceeded: '成功',
    routeTraceFinalFailed: '失败',
    routeTraceFinalCancelled: '已取消',
    routeTraceFinalSuperseded: '被新请求替换',
    routeTraceFinalReleased: '已释放',
    routeTraceWaitNetwork: '网络',
    routeTraceWaitRoute: '路由恢复',
    routeTraceWaitRetry: '重试退避',
    routeTraceWaitCompaction: '上下文压缩',
    routeTraceWaitWaiting: '等待中',
    routeTraceWaitCompleted: '等待结束',
    routeTraceWaitTimeout: '超时',
    routeTraceWaitCancelled: '已取消',
    routeTraceWaitUnknown: '未知',
    routeTraceSeconds: '秒',
    routeTraceMilliseconds: '毫秒',
    routeTraceYes: '是',
    routeTraceNo: '否'
  },
  en: {
    routeObservability: 'Route observability',
    routeTraceRequests: 'requests',
    routeTraceDroppedRequests: 'process cache requests omitted',
    routeTraceProcess: 'Retained only in this process; a process restart clears the trace. This is not a durable audit record.',
    routeTraceBoundary: 'Read-only facts: quota is not inferred, and raw errors, identities, and credentials are not shown.',
    routeTraceEmpty: 'No route requests have been observed in this process.',
    routeTraceRequest: 'Request',
    routeTracePosition: 'position',
    routeTraceStarted: 'started',
    routeTraceEnded: 'ended',
    routeTraceFinal: 'final',
    routeTraceEndReason: 'end reason',
    routeTraceTerminal: 'route terminal',
    routeTraceBudget: 'Budget and usage',
    routeTraceLogicalAttempts: 'logical attempts',
    routeTraceTransientRetries: 'short retries',
    routeTraceShortWait: 'short wait',
    routeTraceHoldWaits: 'hold waits',
    routeTraceHoldWaitCount: 'wait count',
    routeTraceSelections: 'Admission selections',
    routeTraceAttempts: 'Observed attempts',
    routeTraceFailures: 'Failure facts',
    routeTraceIgnoredFailures: 'Stale failures not attributed to the current request',
    routeTraceWaits: 'Waits and recovery',
    routeTraceOmitted: 'older entries dropped',
    routeTraceNoItems: 'No records',
    routeTraceAttemptAssociation: 'attempt association',
    routeTracePlanned: 'planned',
    routeTraceActual: 'actual',
    routeTraceReportedNetwork: 'network probe reported',
    routeTraceOutcome: 'outcome',
    routeTraceRetryAfter: 'upstream retry hint',
    routeTraceStatus: 'HTTP status',
    routeTraceScopeRoot: 'root',
    routeTraceScopeChild: 'child',
    routeTraceFinalPending: 'in progress',
    routeTraceFinalSucceeded: 'succeeded',
    routeTraceFinalFailed: 'failed',
    routeTraceFinalCancelled: 'cancelled',
    routeTraceFinalSuperseded: 'superseded',
    routeTraceFinalReleased: 'released',
    routeTraceWaitNetwork: 'network',
    routeTraceWaitRoute: 'route recovery',
    routeTraceWaitRetry: 'retry backoff',
    routeTraceWaitCompaction: 'context compaction',
    routeTraceWaitWaiting: 'waiting',
    routeTraceWaitCompleted: 'wait completed',
    routeTraceWaitTimeout: 'timed out',
    routeTraceWaitCancelled: 'cancelled',
    routeTraceWaitUnknown: 'unknown',
    routeTraceSeconds: 's',
    routeTraceMilliseconds: 'ms',
    routeTraceYes: 'yes',
    routeTraceNo: 'no'
  }
}

const routeText = (route) => {
  if (route === null || route === undefined) return '—'
  return `${route.model} · ${route.provider}${route.reasoningEffort === undefined ? '' : ` · ${route.reasoningEffort}`}`
}

const timeText = (value) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  try { return new Date(value).toISOString().replace('T', ' ').replace('.000Z', 'Z') } catch { return '—' }
}

const durationText = (value, t) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (value < 1000) return `${Math.round(value)} ${t('routeTraceMilliseconds')}`
  return `${Math.round(value / 1000)} ${t('routeTraceSeconds')}`
}

const budgetLine = (label, used, max) => `${label}：${used}/${max ?? '—'}`

const budgetWaitLine = (label, usedMs, maxMs, t) => `${label}：${durationText(usedMs, t)} / ${maxMs === null ? '—' : durationText(maxMs, t)}`

const emptyLine = (t) => h('p', { style: { margin: '4px 0', color: 'var(--dsw-alias-label-secondary, #596579)' } }, t('routeTraceNoItems'))

const listSection = (title, items, t) => h('section', { style: { marginTop: 10 } },
  h('strong', null, title),
  items.length === 0 ? emptyLine(t) : h('ul', { style: { margin: '5px 0', paddingInlineStart: 22 } }, ...items.map((text, index) => h('li', { key: index }, text))))

function RouteRequestTrace ({ request, t }) {
  const position = request.position === null ? '' : ` · ${t('routeTracePosition')} ${request.position.turn}/${request.position.step}`
  const requestSummary = `${request.requestId} · ${t(request.scope === 'root' ? 'routeTraceScopeRoot' : 'routeTraceScopeChild')} · ${t(`routeTraceFinal${request.final[0].toUpperCase()}${request.final.slice(1)}`)}${request.terminal === null ? '' : ` · ${request.terminal}`}${position}`
  const budget = request.budget
  const selectionItems = request.selections.map((selection) => `#${selection.ordinal} · ${timeText(selection.at)} · ${routeText(selection.route)} · ${t('routeTraceAttemptAssociation')} ${selection.attemptId ?? '—'}`)
  const attemptItems = request.attempts.map((attempt) => `${attempt.attemptId} · ${routeText(attempt.route)} · ${attempt.routeSource} · ${attempt.outcome} · ${timeText(attempt.startedAt)} → ${timeText(attempt.endedAt)}`)
  const failureItems = request.failures.map((failure) => `${timeText(failure.at)} · ${failure.kind} · ${routeText(failure.route)} · ${t('routeTraceStatus')} ${failure.status ?? '—'} · ${t('routeTraceRetryAfter')} ${durationText(failure.retryAfterMs, t)} · ${t('routeTraceAttemptAssociation')} ${failure.attemptId ?? '—'}${failure.terminal === null ? '' : ` · ${failure.terminal}`}`)
  const ignoredItems = request.ignoredFailures.map((failure) => `${timeText(failure.at)} · ${failure.kind} · ${failure.reason} · ${routeText(failure.route)}`)
  const waitItems = request.waits.map((wait) => `${timeText(wait.startedAt)} · ${t(`routeTraceWait${wait.reason === 'context_compaction' ? 'Compaction' : wait.reason[0].toUpperCase()}${wait.reason === 'context_compaction' ? '' : wait.reason.slice(1)}`)} · ${t('routeTracePlanned')} ${durationText(wait.plannedMs, t)} · ${t('routeTraceActual')} ${durationText(wait.waitedMs, t)} · ${t(`routeTraceWait${wait.outcome[0].toUpperCase()}${wait.outcome.slice(1)}`)}${wait.reportedRecovered === null ? '' : ` · ${t('routeTraceReportedNetwork')} ${t(wait.reportedRecovered ? 'routeTraceYes' : 'routeTraceNo')}`}${wait.route === null ? '' : ` · ${routeText(wait.route)}`}`)
  const omittedTotal = request.omittedSelections + request.omittedAttempts + request.omittedFailures + request.omittedIgnoredFailures + request.omittedWaits
  return h('details', { style: { marginTop: 8, border: '1px solid var(--dsw-alias-border-l2, #d6dde8)', borderRadius: 8, padding: '6px 10px' } },
    h('summary', null, requestSummary),
    h('div', { style: { paddingTop: 6 } },
      h('p', { style: { margin: '4px 0' } }, `${t('routeTraceStarted')} ${timeText(request.startedAt)} · ${t('routeTraceEnded')} ${timeText(request.endedAt)} · ${t('routeTraceFinal')} ${t(`routeTraceFinal${request.final[0].toUpperCase()}${request.final.slice(1)}`)}${request.endReason === null ? '' : ` · ${t('routeTraceEndReason')} ${request.endReason}`}`),
      request.terminal === null ? null : h('p', { style: { margin: '4px 0' } }, `${t('routeTraceTerminal')}：${request.terminal}`),
      omittedTotal === 0 ? null : h('p', { role: 'status', style: { margin: '4px 0', color: 'var(--dsw-alias-state-warn-primary, #d9480f)' } }, `${t('routeTraceOmitted')}：${omittedTotal}`),
      h('section', { style: { marginTop: 10 } },
        h('strong', null, t('routeTraceBudget')),
        h('dl', { style: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '3px 12px', margin: '5px 0' } },
          h('dt', null, t('routeTraceLogicalAttempts')), h('dd', { style: { margin: 0 } }, budgetLine(t('routeTraceLogicalAttempts'), budget.logicalAttemptsUsed, budget.maxLogicalAttempts)),
          h('dt', null, t('routeTraceTransientRetries')), h('dd', { style: { margin: 0 } }, budgetLine(t('routeTraceTransientRetries'), budget.transientRetriesUsed, budget.maxTransientRetries)),
          h('dt', null, t('routeTraceShortWait')), h('dd', { style: { margin: 0 } }, budgetWaitLine(t('routeTraceShortWait'), budget.transientWaitUsedMs, budget.maxTransientWaitMs, t)),
          h('dt', null, t('routeTraceHoldWaits')), h('dd', { style: { margin: 0 } }, budgetWaitLine(t('routeTraceHoldWaits'), budget.holdWaitUsedMs, budget.maxHoldWaitMs, t)),
          h('dt', null, t('routeTraceHoldWaitCount')), h('dd', { style: { margin: 0 } }, budgetLine(t('routeTraceHoldWaitCount'), budget.holdWaitsUsed, budget.maxHoldWaits)))),
      listSection(t('routeTraceSelections'), selectionItems, t),
      listSection(t('routeTraceAttempts'), attemptItems, t),
      listSection(t('routeTraceFailures'), failureItems, t),
      listSection(t('routeTraceIgnoredFailures'), ignoredItems, t),
      listSection(t('routeTraceWaits'), waitItems, t)))
}

/**
 * 可折叠、只读、有界路由 trace。
 * @param {{ value?: unknown, t?: (key: string) => string }} props
 */
function RouteObservabilityPanel ({ value, t }) {
  const snapshot = sanitizeRouteObservability(value)
  if (snapshot === undefined) return null
  const translate = typeof t === 'function' ? t : (key) => dictionaries.zh[key] ?? key
  const summary = `${translate('routeObservability')} · ${snapshot.requests.length} ${translate('routeTraceRequests')}${snapshot.omittedRequests > 0 ? ` · ${translate('routeTraceDroppedRequests')} ${snapshot.omittedRequests}` : ''}`
  return h('details', { 'data-swarm-route-observability': '', style: { margin: '10px 0', border: '1px solid var(--dsw-alias-border-l2, #d6dde8)', borderRadius: 10, padding: '8px 12px' } },
    h('summary', null, summary),
    h('div', { style: { paddingTop: 8 } },
      h('p', { role: 'note', style: { margin: '4px 0' } }, translate('routeTraceProcess')),
      h('p', { role: 'note', style: { margin: '4px 0', color: 'var(--dsw-alias-label-secondary, #596579)' } }, translate('routeTraceBoundary')),
      snapshot.omittedRequests > 0 ? h('p', { role: 'status', style: { margin: '4px 0', color: 'var(--dsw-alias-state-warn-primary, #d9480f)' } }, `${translate('routeTraceDroppedRequests')}：${snapshot.omittedRequests}`) : null,
      snapshot.requests.length === 0 ? emptyLine(translate) : h('ol', { style: { margin: '6px 0', paddingInlineStart: 22 } },
        ...snapshot.requests.map((request) => h('li', { key: request.requestId }, h(RouteRequestTrace, { request, t: translate }))))))
}

exports.RouteObservabilityPanel = RouteObservabilityPanel
exports.sanitizeRouteObservability = sanitizeRouteObservability
exports.dictionaries = dictionaries
exports.LIMITS = LIMITS
exports.__test__ = { RouteObservabilityPanel, RouteRequestTrace, sanitizeRouteObservability, routeText, timeText, durationText, LIMITS }
