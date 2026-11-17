import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intTaskStore } from '../../src/evidence.js'
import { createFeatureSession } from '../../src/feature-session.js'
import * as featureModule from '../../src/feature-session.js'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import { recoverStateFromJournal } from '../../src/state-journal.js'
import { SWARM_SEGMENT_SPECS } from '../../src/state-chunks.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import { intThreadRegistry } from '../../src/threads.js'
import type { AgentControlRecord } from '../../src/agent-control.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) await cleanup() })
const makeRestored = async (legacy: boolean, wrongChild = false, historicalTransition = false, missingFinalBinding: boolean | 'pending-start' = false,
  editSeed?: (seed: { tasks: ReturnType<typeof intTaskStore>; threads: ReturnType<typeof intThreadRegistry>; controls: AgentControlRecord[]; childId: string }) => void) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-control-restore-'))
  let service: SwarmService | undefined
  cleanups.push(async () => { await service?.dispose().catch(() => undefined); await rm(home, { recursive: true, force: true }) })
  const rootId = 'restored-root'
  const childId = 'persisted-child'
  const pendingStart = missingFinalBinding === 'pending-start'
  const config = getSwarmConfig({ persistence: { enabled: true }, jev: { enabled: false }, planningReview: { enabled: false },
    routes: { 'suan_heng:verify': { chain: [{ provider: 'current', model: 'verify-primary' }, { provider: 'current', model: 'backup' }], upgrade: { enabled: false } },
      'suan_heng:research': { chain: [{ provider: 'wrong-mode', model: 'research' }] } } })
  const tasks = intTaskStore(), threads = intThreadRegistry()
  const card = ValidateTaskCard({ title: '持久验算', goal: '核对结果', acceptance: ['说明依据'], scope: [], flags: {} }).card!
  tasks.AddTask({ taskId: 'T-1', sessionId: rootId, card, gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0,
    cardRevision: 1, workflowRevision: 1, requestRevision: 1, createdAt: 1, updatedAt: 2 })
  tasks.AddDelegation({ delegationId: 'D-1', taskId: 'T-1', role: 'suan_heng', mode: 'verify', roleName: '算衡', status: pendingStart ? 'running' : 'failed', summary: '未完成',
    evidence: [], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 2, childId,
    cardRevision: 1, workflowRevision: 1, requestRevision: 1, route: { provider: 'old-fallback', model: 'last-used' },
    continuationInput: { task_id: 'T-1', role: 'suan_heng', mode: 'verify', prompt: '核对结果', session: 'continue', backend: 'api' },
    ...(missingFinalBinding ? (pendingStart ? {} : { error: 'recovery_required' }) : { session: { kind: 'continuable' as const, threadId: childId, round: 1, appended: false, source: 'rule' as const, reason: 'fixture' } }) })
  if (historicalTransition) tasks.AddDelegation({ delegationId: 'D-2', taskId: 'T-1', role: 'tan_wei', roleName: '探微', status: 'completed',
    summary: '历史交付', evidence: [], attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 3, finishedAt: 4,
    structured: { summary: '历史交付', unresolved: [], findings: [] } })
  threads.Add({ threadId: childId, key: 'suan_heng:verify', role: 'suan_heng', mode: 'verify', rounds: missingFinalBinding ? 0 : 1, busy: pendingStart, closed: Boolean(missingFinalBinding) && !pendingStart, allowWeb: false,
    taskIds: missingFinalBinding ? [] : ['T-1'], history: missingFinalBinding ? [] : [{ delegationId: 'D-1', taskId: 'T-1', request: '核对结果', summary: '未完成', status: 'failed' }], createdAt: 1, lastUsedAt: 2 })
  const controls: AgentControlRecord[] = legacy ? [] : [{ childId: wrongChild ? 'unrelated-child' : childId, parentSessionId: rootId, taskId: 'T-1', delegationId: 'D-1',
    persistent: true, cardRevision: 1, workflowRevision: 1, requestRevision: 1, revision: 1, phase: pendingStart ? 'idle' : missingFinalBinding ? 'recovery-required' : 'paused', paused: !pendingStart, updatedAt: 2,
    ...(missingFinalBinding ? { needsSideEffectReview: true } : {}),
    selectedNext: { provider: 'manual', model: 'human-selected', reasoningEffort: 'max' } }]
  editSeed?.({ tasks, threads, controls, childId })
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
  return { service, rootId, childId, start, activateParent, home }
}

describe('restored service child routing fences', () => {
  it('原始快照的idle控制/running委派先经冷恢复封闭，再补缺失绑定', async () => {
    const { service, rootId, childId, start, activateParent } = await makeRestored(false, false, false, 'pending-start')
    expect(await service.getAgentViewForRpc(rootId, childId)).toMatchObject({ phase: 'recovery-required', paused: true, needsSideEffectReview: true })
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
  })
  it('修复事实落盘失败时不发布可用恢复视图，也不消费或重放旧任务', async () => {
    const { service, rootId, childId, start, activateParent, home } = await makeRestored(false, false, false, true)
    const create = featureModule.createFeatureSession
    vi.spyOn(featureModule, 'createFeatureSession').mockImplementation(async options => {
      const feature = await create(options), persist = feature.persist
      feature.persist = async (type, tasks, threads) => {
        if (type === 'agent-control/recovery-binding-repaired') throw new Error('fixture-durable-repair-denied')
        return persist(type, tasks, threads)
      }
      return feature
    })
    await expect(service.getAgentViewForRpc(rootId, childId)).rejects.toThrow('fixture-durable-repair-denied')
    await expect(service.getAgentViewForRpc(rootId, childId)).rejects.toThrow('fixture-durable-repair-denied')
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
    const journal = createSwarmEventJournal({ directory: join(home, 'share/dsh-agent-swarm/events-v2'), rootSessionId: rootId })
    const recovered = recoverStateFromJournal<{ delegations: Array<{ delegationId: string; session?: unknown }> }>(journal, { specs: SWARM_SEGMENT_SPECS, validate: () => true })
    expect(recovered.issues).toEqual([])
    expect(recovered.state?.delegations.find(record => record.delegationId === 'D-1')?.session).toBeUndefined()
  })
  it.each(['mode', 'role', 'route-key', 'explicit-oneshot', 'explicit-wrong-thread', 'late-invalid-control'] as const)('不把其他身份错配当成缺失绑定兼容：%s', async variant => {
    const { service, rootId, childId, start, activateParent } = await makeRestored(false, false, false, true, ({ tasks, threads, controls, childId }) => {
      if (variant === 'mode') threads.Update(childId, { mode: 'research', key: 'suan_heng:research' })
      if (variant === 'role') threads.Update(childId, { role: 'bo_wen', key: 'bo_wen' })
      if (variant === 'route-key') threads.Update(childId, { key: 'suan_heng:research' })
      if (variant === 'explicit-oneshot') tasks.UpdateDelegation('D-1', { session: { kind: 'oneshot', appended: false, source: 'rule', reason: 'explicit fixture' } })
      if (variant === 'explicit-wrong-thread') tasks.UpdateDelegation('D-1', { session: { kind: 'continuable', threadId: 'foreign-child', appended: false, source: 'rule', reason: 'explicit fixture' } })
      if (variant === 'late-invalid-control') controls.push({ ...controls[0], childId: 'later-invalid-child' })
    })
    await expect(service.getAgentViewForRpc(rootId, childId)).rejects.toThrow('身份不一致')
    expect(service.routeState.getChild(childId)).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
  })
  it('恢复结果提交前丢失的连续绑定元信息，旧子会话仍暂停且不重放', async () => {
    const { service, rootId, childId, start, activateParent } = await makeRestored(false, false, false, true)
    expect(await service.getAgentViewForRpc(rootId, childId)).toMatchObject({ childId, persistent: true, phase: 'recovery-required', paused: true, needsSideEffectReview: true })
    const child = { id: childId, session: { header: { parentSession: rootId } } }
    expect(() => service.routeState.getRequestOverride(child, { provider: 'old', model: 'old' }, undefined)).toThrow()
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
  })
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
  it('restores a validated historical failed-to-completed snapshot without replaying lifecycle transitions', async () => {
    const { service, rootId, childId, start, activateParent } = await makeRestored(false, false, true)
    expect(await service.getAgentViewForRpc(rootId, childId)).toMatchObject({ childId, delegationId: 'D-1', persistent: true, phase: 'paused' })
    expect(service.routeState.getChildRole(childId)).toBe('suan_heng')
    expect(start).not.toHaveBeenCalled()
    expect(activateParent).not.toHaveBeenCalled()
  })
})
