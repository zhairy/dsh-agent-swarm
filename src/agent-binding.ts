import type { DurableStateStore } from './state-store.js'

export interface AgentBinding {
  agentId: string
  rootSessionId: string
  workspaceId: string
  taskId: string
  nodeId: string
  attemptId: string
  threadId: string
  role: string
  cardRevision: number
  workflowRevision: number
  requestRevision?: number
  permissions: string[]
  generation: number
  leaseEpoch: number
  state: 'active' | 'suspended' | 'revoked'
  blindReview?: boolean
  revocationReason?: 'completed' | 'superseded' | 'cancelled' | 'untrusted'
}
export interface BindingState {
  bindings: Record<string, AgentBinding>
  bindingHistory: Record<string, AgentBinding>
}
export type BindingInput = Omit<AgentBinding, 'generation' | 'leaseEpoch' | 'state' | 'revocationReason'>
export class BindingError extends Error {
  constructor (readonly code: 'BINDING_INVALID' | 'BINDING_INACTIVE' | 'PERMISSION_DENIED' | 'STALE_BINDING', message: string) { super(message); this.name = 'BindingError' }
}
export const bindingKey = (binding: Pick<AgentBinding, 'agentId' | 'generation' | 'leaseEpoch'>): string => binding.agentId + ':' + binding.generation + ':' + binding.leaseEpoch
export const validateBinding = (raw: unknown): raw is AgentBinding => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const value = raw as AgentBinding
  const identifiers = ['agentId', 'rootSessionId', 'workspaceId', 'taskId', 'nodeId', 'attemptId', 'threadId', 'role'] as const
  return identifiers.every((key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(value[key])) &&
    ['cardRevision', 'workflowRevision', 'generation', 'leaseEpoch'].every((key) => Number.isSafeInteger(value[key as keyof AgentBinding]) && (value[key as 'generation'] as number) >= 1) &&
    (value.requestRevision === undefined || (Number.isSafeInteger(value.requestRevision) && value.requestRevision >= 1)) &&
    ['active', 'suspended', 'revoked'].includes(value.state) && Array.isArray(value.permissions) && value.permissions.every((permission) => typeof permission === 'string' && permission.length <= 64) &&
    (value.blindReview === undefined || typeof value.blindReview === 'boolean')
}
export interface AgentBindingRegistry {
  bind: (input: BindingInput) => Promise<AgentBinding>
  get: (agentId: string) => AgentBinding | undefined
  requireActive: (agentId: string, permission?: string) => AgentBinding
  getHistorical: (binding: Pick<AgentBinding, 'agentId' | 'generation' | 'leaseEpoch'>) => AgentBinding | undefined
  revoke: (agentId: string, reason?: AgentBinding['revocationReason']) => Promise<void>
  suspend: (agentId: string) => Promise<void>
  completeBlindReview: (agentId: string) => Promise<void>
}

/** Only host/service lifecycle code calls bind; tool parameters never create identities. */
export const createAgentBindingRegistry = <T extends BindingState>(store: DurableStateStore<T>): AgentBindingRegistry => {
  const get = (agentId: string) => store.readPath === undefined ? store.read().bindings[agentId] : store.readPath<AgentBinding>(['bindings', agentId])
  const requireActive: AgentBindingRegistry['requireActive'] = (agentId, permission) => {
    const binding = get(agentId)
    if (binding === undefined || binding.state !== 'active') throw new BindingError('BINDING_INACTIVE', 'No active host-bound attempt for this agent')
    if (permission !== undefined && !binding.permissions.includes(permission)) throw new BindingError('PERMISSION_DENIED', 'Agent lacks capability: ' + permission)
    return binding
  }
  return {
    get, requireActive,
    bind: async (input) => {
      let binding!: AgentBinding
      await store.commit('binding/bind', (draft) => {
        const old = draft.bindings[input.agentId]
        if (old !== undefined) {
          const revoked: AgentBinding = { ...old, state: 'revoked', revocationReason: 'superseded' }
          draft.bindingHistory[bindingKey(old)] = revoked
        }
        binding = { ...input, requestRevision: input.requestRevision ?? 1, permissions: [...new Set(input.permissions)], generation: (old?.generation ?? 0) + 1, leaseEpoch: (old?.leaseEpoch ?? 0) + 1, state: 'active' }
        if (!validateBinding(binding)) throw new BindingError('BINDING_INVALID', 'Invalid host binding')
        draft.bindings[input.agentId] = binding
        draft.bindingHistory[bindingKey(binding)] = binding
      })
      return structuredClone(binding)
    },
    getHistorical: (binding) => store.readPath === undefined ? store.read().bindingHistory[bindingKey(binding)] : store.readPath<AgentBinding>(['bindingHistory', bindingKey(binding)]),
    revoke: async (agentId, reason = 'untrusted') => {
      await store.commit('binding/revoke', (draft) => {
        const old = draft.bindings[agentId]
        if (old === undefined) return
        const next: AgentBinding = { ...old, state: 'revoked', revocationReason: reason }
        draft.bindings[agentId] = next; draft.bindingHistory[bindingKey(old)] = next
      })
    },
    suspend: async (agentId) => {
      await store.commit('binding/suspend', (draft) => {
        const old = draft.bindings[agentId]
        if (old === undefined) return
        const next: AgentBinding = { ...old, state: 'suspended' }
        draft.bindings[agentId] = next; draft.bindingHistory[bindingKey(old)] = next
      })
    },
    completeBlindReview: async (agentId) => {
      await store.commit('binding/blind-review-complete', (draft) => {
        const old = draft.bindings[agentId]
        if (old === undefined || old.state !== 'active') throw new BindingError('BINDING_INACTIVE', 'No active review attempt')
        const next: AgentBinding = { ...old, blindReview: false }
        draft.bindings[agentId] = next; draft.bindingHistory[bindingKey(old)] = next
      })
    }
  }
}
