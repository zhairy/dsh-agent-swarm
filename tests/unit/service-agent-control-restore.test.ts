import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intTaskStore } from '../../src/evidence.js'
import { createFeatureSession } from '../../src/feature-session.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import { intThreadRegistry } from '../../src/threads.js'
import type { AgentControlRecord } from '../../src/agent-control.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
const makeRestored = async (legacy: boolean, wrongChild = false) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-control-restore-'))
  let service: SwarmService | undefined
  cleanups.push(async () => { await service?.dispose().catch(() => undefined); await rm(home, { recursive: true, force: true }) })
  const rootId = 'restored-root'
  const childId = 'persisted-child'
  const config = getSwarmConfig({ persistence: { enabled: true }, jev: { enabled: false }, planningReview: { enabled: false },
    routes: { 'suan_heng:verify': { chain: [{ provider: 'current', model: 'verify-primary' }, { provider: 'current', model: 'backup' }], upgrade: { enabled: false } },
      'suan_heng:research': { chain: [{ provider: 'wrong-mode', model: 'research' }] } } })
  const tasks = intTaskStore(), threads = intThreadRegistry()
  const card = ValidateTaskCard({ title: '持久验算', goal: '核对结果', acceptance: ['说明依据'], scope: [], flags: {} }).card!
  tasks.AddTask({ taskId: 'T-1', sessionId: rootId, card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0,
    cardRevision: 1, workflowRevision: 1, requestRevision: 1, createdAt: 1, updatedAt: 2 })
  tasks.AddDelegation({ delegationId: 'D-1', taskId: 'T-1', role: 'suan_heng', mode: 'verify', roleName: '算衡', status: 'failed', summary: '未完成',
    evidence: [], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 2, childId,
    cardRevision: 1, workflowRevision: 1, requestRevision: 1, route: { provider: 'old-fallback', model: 'last-used' },
    continuationInput: { task_id: 'T-1', role: 'suan_heng', mode: 'verify', prompt: '核对结果', session: 'continue', backend: 'api' },
    session: { kind: 'continuable', threadId: childId, round: 1, appended: false, source: 'rule', reason: 'fixture' } })
  threads.Add({ threadId: childId, key: 'suan_heng:verify', role: 'suan_heng', mode: 'verify', rounds: 1, busy: false, closed: false, allowWeb: false,
    taskIds: ['T-1'], history: [{ delegationId: 'D-1', taskId: 'T-1', request: '核对结果', summary: '未完成', status: 'failed' }], createdAt: 1, lastUsedAt: 2 })
  const controls: AgentControlRecord[] = legacy ? [] : [{ childId: wrongChild ? 'unrelated-child' : childId, parentSessionId: rootId, taskId: 'T-1', delegationId: 'D-1',
    persistent: true, cardRevision: 1, workflowRevision: 1, requestRevision: 1, revision: 1, phase: 'paused', paused: true, updatedAt: 2,
    selectedNext: { provider: 'manual', model: 'human-selected', reasoningEffort: 'max' } }]
  const feature = await createFeatureSession({ rootSessionId: rootId, cwd: home, dshHome: home, config, tasks, threads, now: () => 100,
    ...(legacy ? {} : { getAgentControls: () => controls }) })
  await feature.persist('fixture/paused', tasks, threads)
  await feature.dispose()
  const start = vi.fn(), activateParent = vi.fn()
  service = intSwarmService({ getConfig: () => config, getLlm: () => undefined, getSubagents: () => ({ list: () => [], getProvider: () => undefined, start }),
    getTools: () => undefined, getCredentials: () => undefined, getAttachments: () => undefined, dshHome: home,
    fetch: async () => { throw new Error('A cold metadata view must not call external judgment or models') },
    getAgent: () => undefined, inspectParent: async () => ({ agentPreset: 'tian-shu', cwd: home }), activateParent,
    probe: async () => ({ ok: true, vision: false }), now: () => 100 })
  return { service, rootId, childId, start, activateParent }
}

describe('restored service child routing fences', () => {
  it.each([false, true])('restores managed routing and pause before cold view without activating or generating (legacy=%s)', async (legacy) => {
    const { service, rootId, childId, start, activateParent } = await makeRestored(legacy)
    expect(await service.getAgentViewForRpc(rootId, childId)).toMatchObject({ childId, persistent: true, phase: 'paused', paused: true })
    expect(service.routeState.getChildRole(childId)).toBe('suan_heng')
    expect(service.routeState.getChild(childId)?.route).toMatchObject(legacy ? { provider: 'current', model: 'verify-primary' } : { provider: 'manual', model: 'human-selected', reasoningEffort: 'max' })
    const child = { id: childId, session: { header: { parentSession: rootId } } }
    expect(() => service.routeState.getRequestOverride(child, { provider: 'old-fallback', model: 'last-used' }, undefined)).toThrow('人工暂停')
    service.routeState.ReleaseAgent(childId)
    expect(service.routeState.getChildRole(childId)).toBe('suan_heng')
    expect(service.routeState.isManualPaused(childId)).toBe(true)
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
  })
  it('rejects a control whose persisted child lineage does not match its actual delegation and thread', async () => {
    const { service, rootId, start, activateParent } = await makeRestored(false, true)
    await expect(service.getAgentViewForRpc(rootId, 'unrelated-child')).rejects.toThrow('身份不一致')
    expect(service.routeState.getChild('unrelated-child')).toBeUndefined()
    await expect(service.getAgentViewForRpc(rootId, 'unrelated-child')).rejects.toThrow('身份不一致')
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
  })
})
