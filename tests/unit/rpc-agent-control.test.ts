import { describe, expect, it, vi } from 'vitest'
import { getRpcRoutes, RunRpcMethod } from '../../src/rpc.js'
import type { JevHub } from '../../src/jev-hub.js'

const jev = {} as JevHub
const signal = new AbortController().signal
describe('agent-control RPC boundary', () => {
  it('registers real optional handlers while preserving legacy Jev/task routes', async () => {
    const agentView = vi.fn(async (parentSessionId: string, childId: string) => ({ parentSessionId, childId, revision: 2 }))
    const agentControl = vi.fn(async (input) => ({ accepted: true, ...input }))
    const deps = { taskView: () => ({}), agentView, agentControl }
    expect(getRpcRoutes(() => jev)).toHaveLength(2)
    expect(getRpcRoutes(() => jev, { taskView: deps.taskView })).toHaveLength(4)
    expect(getRpcRoutes(() => jev, deps).map((route) => route.path)).toEqual(['/api/swarm.jevStatus', '/api/swarm.jevHealth', '/api/swarm.taskView', '/api/swarm.agentView', '/api/swarm.agentControl', '/api/swarm-assets/mermaid.min.js'])
    expect(await RunRpcMethod(jev, 'agentView', signal, { parentSessionId: 'root', childId: 'child' }, deps)).toMatchObject({ ok: true, value: { revision: 2 } })
    expect(await RunRpcMethod(jev, 'agentControl', signal, { parentSessionId: 'root', childId: 'child', expectedRevision: 2, action: 'select', route: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' }, interruptRunning: true }, deps)).toMatchObject({ ok: true })
    expect(agentControl).toHaveBeenCalledTimes(1)
  })
  it('rejects unbounded IDs, route policy injection, nonbooleans and force without explicit retry', async () => {
    const handler = vi.fn()
    const base = { parentSessionId: 'root', childId: 'child', expectedRevision: 1, action: 'select', route: { provider: 'codex', model: 'm' } }
    for (const input of [
      { ...base, childId: 'x'.repeat(129) }, { ...base, expectedRevision: NaN },
      { ...base, route: { ...base.route, policy: { quotaDomainId: 'other-account' } } },
      { ...base, interruptRunning: 'yes' }, { ...base, forceRetry: true }, { ...base, path: '/etc/passwd' },
      { ...base, action: 'continue' }, { parentSessionId: 'root', childId: 'child', expectedRevision: 1, action: 'continue', steering: 'x'.repeat(8001) }
    ]) expect(await RunRpcMethod(jev, 'agentControl', signal, input, { agentControl: handler })).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(handler).not.toHaveBeenCalled()
    // Pure read continuation does not require a blanket side-effect checkbox; service checks its trusted binding.
    expect(await RunRpcMethod(jev, 'agentControl', signal, { parentSessionId: 'root', childId: 'child', expectedRevision: 1, action: 'continue' }, { agentControl: async () => ({ accepted: true }) })).toMatchObject({ ok: true })
  })
})
