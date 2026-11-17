import { describe, expect, it } from 'vitest'
import { createRouteEngine } from '../../src/application/routing/engine.js'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteHealth } from '../../src/domain/routing/health.js'
import { intRouteObservability } from '../../src/route-observability.js'

const childA = { id: 'child-observation-a', session: { header: { parentSession: 'root-observation' } } }
const childB = { id: 'child-observation-b', session: { header: { parentSession: 'root-observation' } } }
const primary = { provider: 'codex', model: 'route-primary' }
const backup = { provider: 'claude', model: 'route-backup' }

describe('bounded route observability', () => {
  it('keeps only bounded request and wait history while reporting omissions', () => {
    let at = 0
    const trace = intRouteObservability({
      now: () => at,
      maxRequests: 2,
      maxWaits: 1
    })

    for (const requestId of ['request-alpha-secret', 'request-beta-secret', 'request-gamma-secret']) {
      at += 10
      trace.BeginRequest({ agentId: 'agent-internal-secret', requestId, scope: 'root', at })
      const waitId = trace.BeginWait({
        agentId: 'agent-internal-secret',
        requestId,
        reason: 'route',
        at: ++at,
        plannedMs: 30
      })
      at += 30
      trace.EndWait(waitId, { at, waitedMs: 30, outcome: 'completed' })
      const secondWaitId = trace.BeginWait({
        agentId: 'agent-internal-secret',
        requestId,
        reason: 'retry',
        at: ++at,
        plannedMs: 10
      })
      at += 10
      trace.EndWait(secondWaitId, { at, waitedMs: 10, outcome: 'completed' })
      trace.AddFailure({
        agentId: 'agent-internal-secret',
        requestId,
        at: ++at,
        kind: 'rate_limited',
        route: primary,
        status: 429,
        retryAfterMs: 30
      })
    }

    const snapshot = trace.getSnapshot()
    expect(snapshot.requests).toHaveLength(2)
    expect(snapshot.omittedRequests).toBe(1)
    expect(snapshot.requests.map((request) => request.omittedWaits)).toEqual([1, 1])
    expect(JSON.stringify(snapshot)).not.toContain('request-alpha-secret')
    expect(JSON.stringify(snapshot)).not.toContain('agent-internal-secret')
    expect(JSON.stringify(snapshot)).not.toContain('raw provider error')
    snapshot.requests[0]!.waits.length = 0
    expect(trace.getSnapshot().requests[0]!.waits).toHaveLength(1)
  })

  it('correlates request selections with actual host attempts and redacts sensitive identifiers and errors', async () => {
    let at = 100
    const config = getSwarmConfig({ agents: { networkWaitMs: 0 } })
    const registry = createRouteEngine(undefined, undefined, { now: () => at })
    const logicalRequestId = 'delegation-account-secret'
    const hostAttemptId = 'attempt-token-secret'
    registry.AddChild(childA.id, {
      chain: [primary, backup],
      role: 'shu_ji',
      persistent: true,
      logicalRequestId
    })
    registry.BeginRequestStep(childA.id, 3, 7)

    expect(await registry.AdmitRequest(childA, primary, 'shu_ji', config)).toMatchObject(primary)
    at += 5
    registry.MarkRequestStarted(childA.id, hostAttemptId, primary)
    at += 10
    expect(await registry.getErrorAction({
      agent: childA,
      turn: 3,
      step: 7,
      provider: primary.provider,
      failure: {
        code: 'AUTH',
        status: 401,
        requestId: 'provider-request-account-secret',
        quotaDomainId: 'account-secret',
        message: 'invalid api key sk-token-secret raw provider error'
      }
    }, undefined, 'shu_ji', config)).toEqual({ kind: 'retry' })
    at += 2
    expect(await registry.AdmitRequest(childA, primary, 'shu_ji', config)).toMatchObject(backup)
    registry.MarkRequestSucceeded(childA.id)

    const snapshot = registry.getRouteObservability([childA.id])
    const request = snapshot.requests[0]!
    expect(request).toMatchObject({
      scope: 'child',
      position: { turn: 3, step: 7 },
      final: 'succeeded',
      endReason: 'host_success',
      budget: {
        maxLogicalAttempts: 8,
        logicalAttemptsUsed: 2,
        maxTransientRetries: 1,
        transientRetriesUsed: 0
      }
    })
    expect(request.selections).toHaveLength(2)
    expect(request.selections[0]).toMatchObject({
      ordinal: 1,
      route: { provider: primary.provider, model: primary.model },
      attemptId: request.attempts[0]!.attemptId
    })
    expect(request.attempts[0]).toMatchObject({
      route: { provider: primary.provider, model: primary.model },
      routeSource: 'host-request-header',
      outcome: 'failed'
    })
    expect(request.failures[0]).toMatchObject({
      kind: 'auth_invalid',
      status: 401,
      retryAfterMs: null,
      attemptId: request.attempts[0]!.attemptId,
      route: { provider: primary.provider, model: primary.model }
    })
    expect(request.selections[1]).toMatchObject({
      ordinal: 2,
      route: { provider: backup.provider, model: backup.model },
      attemptId: null
    })
    const serialized = JSON.stringify(snapshot)
    for (const secret of [
      logicalRequestId,
      hostAttemptId,
      'provider-request-account-secret',
      'account-secret',
      'sk-token-secret',
      'invalid api key'
    ]) expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('quotaDomainId')
  })

  it('records route wait timing and cancels only the request whose signal aborted', async () => {
    let at = 0
    const health = intRouteHealth(() => at)
    const config = getSwarmConfig({ agents: { networkWaitMs: 120_000 } })
    const waitingController = new AbortController()
    const registry = createRouteEngine(undefined, undefined, {
      now: () => at,
      health,
      sleep: async (ms) => {
        at += ms
        waitingController.abort()
      }
    })
    registry.AddChild(childA.id, {
      chain: [primary],
      role: 'shu_ji',
      persistent: true,
      logicalRequestId: 'request-cancelled'
    })
    registry.BeginRequestStep(childA.id, 1, 1)
    registry.ObserveRouteFailure(primary, {
      code: 'RATE_LIMIT',
      status: 429,
      providerRetryAfterMs: 90_000,
      message: 'requests per minute exceeded'
    }, config)

    await expect(registry.AdmitRequest(childA, primary, 'shu_ji', config, false, waitingController.signal))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })

    registry.AddChild(childB.id, {
      chain: [backup],
      role: 'zhu_jian',
      persistent: true,
      logicalRequestId: 'request-concurrent'
    })
    registry.BeginRequestStep(childB.id, 1, 1)
    expect(await registry.AdmitRequest(childB, backup, 'zhu_jian', config)).toMatchObject(backup)
    registry.MarkRequestSucceeded(childB.id)

    const snapshot = registry.getRouteObservability([childA.id, childB.id])
    const cancelled = snapshot.requests.find((request) => request.position?.turn === 1 && request.scope === 'child' && request.final === 'cancelled')
    const succeeded = snapshot.requests.find((request) => request.final === 'succeeded')
    expect(cancelled).toMatchObject({
      final: 'cancelled',
      endReason: 'signal_aborted',
      waits: [{
        reason: 'route',
        plannedMs: 90_000,
        waitedMs: 90_000,
        outcome: 'cancelled',
        reportedRecovered: null
      }]
    })
    expect(cancelled?.budget.holdWaitsUsed).toBe(1)
    expect(cancelled?.budget.holdWaitUsedMs).toBe(90_000)
    expect(succeeded).toMatchObject({ final: 'succeeded', failures: [], endReason: 'host_success' })
  })

  it('keeps concurrent agents isolated and does not copy one failure into the other request', async () => {
    const config = getSwarmConfig({ agents: { networkWaitMs: 0 }, routes: { shu_ji: { chain: [primary, backup] } } })
    const registry = createRouteEngine(undefined, undefined, { now: () => 10 })
    for (const [agent, route, requestId] of [
      [childA, primary, 'request-a'],
      [childB, backup, 'request-b']
    ] as const) {
      registry.AddChild(agent.id, { chain: route === primary ? [primary, backup] : [backup], role: 'shu_ji', persistent: true, logicalRequestId: requestId })
      registry.BeginRequestStep(agent.id, 1, 0)
      expect(await registry.AdmitRequest(agent, route, 'shu_ji', config)).toMatchObject(route)
      registry.MarkRequestStarted(agent.id, `attempt-${requestId}`, route)
    }

    expect(await registry.getErrorAction({
      agent: childA,
      turn: 1,
      step: 0,
      provider: primary.provider,
      failure: { code: 'AUTH', status: 401, message: 'invalid credentials' }
    }, undefined, 'shu_ji', config)).toEqual({ kind: 'retry' })
    registry.MarkRequestSucceeded(childB.id)

    const snapshot = registry.getRouteObservability()
    expect(snapshot.requests).toHaveLength(2)
    const first = snapshot.requests.find((request) => request.failures.length === 1)!
    const second = snapshot.requests.find((request) => request.final === 'succeeded')!
    expect(first.requestId).not.toBe(second.requestId)
    expect(second.failures).toEqual([])
    expect(second.attempts).toMatchObject([{ outcome: 'succeeded', route: backup }])
  })
})
