import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadTaskViewStoreModule } from './client-module-loader.js'

interface ElementInfo { type: unknown; props: Record<string, unknown>; children: unknown[] }

const loadRouteModule = (): any => {
  const module = { exports: {} as any }
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementInfo => ({ type, props: props ?? {}, children })
  }
  new Function('require', 'module', 'exports', readFileSync(join(__dirname, '../../client/route-observability.js'), 'utf8'))((id: string) => {
    if (id === 'react') return React
    throw new Error(`unexpected require ${id}`)
  }, module, module.exports)
  return module.exports
}

const elements = (node: unknown): ElementInfo[] => {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || node === undefined || typeof node !== 'object' || !('children' in node)) return []
  const element = node as ElementInfo
  return [element, ...element.children.flatMap(elements)]
}

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node as ElementInfo).children.map(textOf).join('')
}

const route = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' }
const snapshot = {
  schemaVersion: 1,
  generatedAt: 1_800_000_000_000,
  retainedRequests: 1,
  omittedRequests: 2,
  requests: [{
    requestId: 'req_safe-correlation',
    scope: 'root',
    position: { turn: 3, step: 1 },
    startedAt: 1_799_999_990_000,
    endedAt: 1_800_000_000_000,
    final: 'failed',
    endReason: 'route_terminal',
    terminal: 'route_chain_exhausted',
    selections: [{ ordinal: 1, at: 1_799_999_991_000, route, attemptId: 'att_safe-correlation' }],
    attempts: [{
      attemptId: 'att_safe-correlation',
      startedAt: 1_799_999_991_100,
      endedAt: 1_799_999_995_000,
      route,
      routeSource: 'host-request-header',
      outcome: 'failed'
    }],
    failures: [{
      at: 1_799_999_995_000,
      kind: 'rate_limited',
      route,
      status: 429,
      retryAfterMs: 30_000,
      attemptId: 'att_safe-correlation',
      terminal: null
    }],
    ignoredFailures: [],
    waits: [{
      waitId: 'wait_safe-correlation',
      reason: 'route',
      startedAt: 1_799_999_995_000,
      plannedMs: 30_000,
      endedAt: 1_799_999_995_500,
      waitedMs: 500,
      outcome: 'cancelled',
      reportedRecovered: null,
      route,
      failureKind: 'rate_limited'
    }],
    budget: {
      maxLogicalAttempts: 8,
      logicalAttemptsUsed: 8,
      maxTransientRetries: 1,
      transientRetriesUsed: 1,
      maxTransientWaitMs: 5000,
      transientWaitUsedMs: 500,
      maxHoldWaits: 32,
      holdWaitsUsed: 3,
      maxHoldWaitMs: 120_000,
      holdWaitUsedMs: 90_000
    },
    omittedSelections: 0,
    omittedAttempts: 0,
    omittedFailures: 0,
    omittedIgnoredFailures: 0,
    omittedWaits: 1
  }]
}

describe('read-only route observability client projection', () => {
  it('whitelists fields and removes raw errors, account identifiers and unbounded extras', () => {
    const { sanitizeRouteObservability } = loadRouteModule()
    const unsafe = {
      ...snapshot,
      accountId: 'account-private',
      requests: [{
        ...snapshot.requests[0],
        error: { message: 'raw provider error token=secret' },
        selections: [{ ...snapshot.requests[0]!.selections[0], message: 'private' }],
        attempts: [{ ...snapshot.requests[0]!.attempts[0], token: 'secret' }],
        failures: [{ ...snapshot.requests[0]!.failures[0], message: 'secret provider body', quotaDomainId: 'account-domain' }],
        waits: [{ ...snapshot.requests[0]!.waits[0], error: 'secret' }]
      }]
    }
    const safe = sanitizeRouteObservability(unsafe)
    expect(safe).toMatchObject({
      schemaVersion: 1,
      omittedRequests: 2,
      requests: [{
        requestId: 'req_safe-correlation',
        failures: [{ kind: 'rate_limited', status: 429, retryAfterMs: 30_000 }],
        waits: [{ reason: 'route', waitedMs: 500, outcome: 'cancelled' }]
      }]
    })
    const serialized = JSON.stringify(safe)
    for (const secret of ['account-private', 'raw provider error', 'token=secret', 'secret provider body', 'account-domain']) expect(serialized).not.toContain(secret)
  })

  it('renders a native collapsible trace with request, failure, budget, wait and boundedness facts', () => {
    const module = loadRouteModule()
    const t = (key: string) => module.dictionaries.zh[key] ?? key
    const panel = module.RouteObservabilityPanel({ value: snapshot, t })
    const requestPanel = module.__test__.RouteRequestTrace({ request: module.sanitizeRouteObservability(snapshot).requests[0], t })
    const nodes = elements([panel, requestPanel])
    const details = nodes.filter((node) => node.type === 'details')
    expect(details.some((node) => node.props['data-swarm-route-observability'] === '')).toBe(true)
    expect(details.length).toBeGreaterThanOrEqual(2)
    expect(nodes.filter((node) => node.type === 'summary').every((node) => node.children.every((child: unknown) => typeof child !== 'object' || child === null))).toBe(true)
    const text = textOf([panel, requestPanel])
    expect(text).toContain('路由观测')
    expect(text).toContain('进程重启会清空')
    expect(text).toContain('丢弃')
    expect(text).toContain('rate_limited')
    expect(text).toContain('90 秒')
    expect(text).toContain('32')
    expect(text).not.toContain('error.message')
    expect(text).not.toContain('account')
  })

  it('returns no panel for absent or invalid optional data', () => {
    const module = loadRouteModule()
    expect(module.sanitizeRouteObservability(undefined)).toBeUndefined()
    expect(module.sanitizeRouteObservability({ schemaVersion: 99, requests: [] })).toBeUndefined()
    expect(module.RouteObservabilityPanel({ value: null, t: (key: string) => key })).toBeNull()
  })
})

const loadTaskFlow = () => {
  const routeModule = loadRouteModule()
  const source = readFileSync(join(__dirname, '../../client/task-flow.js'), 'utf8')
  const module = { exports: {} as any }
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementInfo => ({ type, props: props ?? {}, children }),
    useState: (initial: unknown) => [initial, vi.fn()],
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: () => undefined
  }
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'react') return React
    if (name === '@swarm/task-view-store') return loadTaskViewStoreModule()
    if (name === '@swarm/route-observability') return routeModule
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: 'MarkdownText' }
    throw new Error(`unexpected require ${name}`)
  }, module, module.exports)
  return { ...module.exports, routeModule }
}

describe('taskView route observability wiring', () => {
  it('sanitizes the RPC field and renders it only in the full read-only progress view', () => {
    const flow = loadTaskFlow()
    const validated = flow.validateTaskView({
      task_id: 'T-1',
      rootSessionId: 'root',
      routeObservability: {
        ...snapshot,
        requests: [{ ...snapshot.requests[0], message: 'must not survive' }]
      }
    })
    expect(validated.routeObservability).toMatchObject({ schemaVersion: 1, omittedRequests: 2 })
    expect(JSON.stringify(validated)).not.toContain('must not survive')
    const t = (key: string) => flow.dictionaries.zh[key] ?? key
    const full = flow.__test__.TaskFlowContent({
      taskId: 'T-1',
      progressPage: true,
      snapshot: { value: validated, status: 'live', error: null, updatedAt: 1 },
      t
    })
    expect(elements(full).some((node) => node.type === flow.__test__.RouteObservabilityPanel && node.props.value === validated.routeObservability)).toBe(true)
    const compact = flow.__test__.TaskFlowContent({
      taskId: 'T-1',
      compact: true,
      snapshot: { value: validated, status: 'historical', error: null, updatedAt: 1 },
      t
    })
    expect(elements(compact).some((node) => node.type === flow.__test__.RouteObservabilityPanel)).toBe(false)
  })
})
