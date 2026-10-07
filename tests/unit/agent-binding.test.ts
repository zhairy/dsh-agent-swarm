import { describe, expect, it } from 'vitest'
import { createDurableStateStore } from '../../src/state-store.js'
import { createAgentBindingRegistry, type BindingInput, type BindingState } from '../../src/agent-binding.js'

const input: BindingInput = { agentId: 'actual-host-child', rootSessionId: 'root', workspaceId: 'workspace', taskId: 'task', nodeId: 'node', attemptId: 'attempt', threadId: 'thread', role: 'suan_heng', cardRevision: 1, workflowRevision: 1, permissions: ['pure-calc', 'message-read'], blindReview: true }
describe('host-owned agent binding generations', () => {
  it('atomically replaces old attempts, keeps history and revokes capabilities on end', async () => {
    const store = await createDurableStateStore<BindingState>({ directory: '/unused', enabled: false, initialState: { bindings: {}, bindingHistory: {} } })
    const registry = createAgentBindingRegistry(store)
    const first = await registry.bind(input)
    expect(registry.requireActive(input.agentId, 'pure-calc')).toEqual(first)
    expect(() => registry.requireActive(input.agentId, 'message-send')).toThrow('capability')
    await registry.completeBlindReview(input.agentId)
    expect(registry.requireActive(input.agentId).blindReview).toBe(false)
    const second = await registry.bind({ ...input, attemptId: 'new-attempt', taskId: 'new-task' })
    expect(second.generation).toBe(first.generation + 1)
    expect(second.leaseEpoch).toBe(first.leaseEpoch + 1)
    expect(registry.getHistorical(first)).toMatchObject({ state: 'revoked', revocationReason: 'superseded', taskId: 'task' })
    await registry.suspend(input.agentId)
    expect(() => registry.requireActive(input.agentId)).toThrow('active')
    await registry.revoke(input.agentId, 'untrusted')
    expect(registry.get(input.agentId)).toMatchObject({ state: 'revoked', revocationReason: 'untrusted' })
    await expect(registry.bind({ ...input, cardRevision: 0 })).rejects.toMatchObject({ code: 'BINDING_INVALID' })
    expect(registry.get(input.agentId)?.generation).toBe(second.generation)
    await store.dispose()
  })
})
