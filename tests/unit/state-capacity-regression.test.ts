import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { createFeatureSession, type FeatureSession } from '../../src/feature-session.js'
import { intTaskStore, type TaskRecord, type TaskStore } from '../../src/evidence.js'
import { intThreadRegistry, type ThreadRegistry } from '../../src/threads.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { getWorkflowDigest, intWorkflowState, type WorkflowDefinition } from '../../src/workflow.js'
import { intRouteHealth } from '../../src/route-health.js'
import { intRouteStateRegistry } from '../../src/route-state.js'
import { SwarmError } from '../../src/util/errors.js'
import type { ContextBindingInfo } from '../../src/context-store.js'
import type { CallConfigLike } from '../../src/host-contract.js'
import type { RouteInfo } from '../../src/routes.js'

const homes: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose().catch(() => undefined)))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const stage = async (maxStateBytes: number): Promise<{ rootId: string; tasks: TaskStore; threads: ThreadRegistry; features: FeatureSession; workspaceId: string; taskId: string }> => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-state-capacity-'))
  homes.push(home)
  const rootId = 'capacity-root'
  const config = getSwarmConfig({ persistence: { enabled: false, maxStateBytes }, jev: { enabled: false }, review: { enabled: false },
    planningReview: { enabled: false }, workflow: { mode: 'advisory' } })
  const workspaceId = await getWorkspaceId(home)
  const card = ValidateTaskCard({ title: '容量回归', goal: '复现状态字节上限', acceptance: ['给出真实证据'], scope: ['src'], flags: {} }).card!
  const definition: WorkflowDefinition = { schemaVersion: 1, mode: 'quick', nodes: [
    { id: 'explore', label: '探索', operation: 'delegate', role: 'tan_wei', dependsOn: [], gates: [], outputContractVersion: '1' },
    { id: 'checkpoint', label: '核对', operation: 'checkpoint', dependsOn: ['explore'], gates: [], outputContractVersion: '1' },
    { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
  ] }
  const task: TaskRecord = { taskId: 'T-1', sessionId: rootId, workspaceId, card, gates: [], triage: { source: 'rules', rulesApplied: [] },
    delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1, cardRevision: 1, workflowRevision: 1, requestRevision: 1,
    workflowDefinition: definition, workflowDigest: getWorkflowDigest(definition), workflowState: intWorkflowState(definition) }
  const tasks = intTaskStore(), threads = intThreadRegistry()
  tasks.AddTask(task)
  const features = await createFeatureSession({ rootSessionId: rootId, cwd: home, dshHome: home, config, tasks, threads, now: () => 1000 })
  disposers.push(features.dispose)
  return { rootId, tasks, threads, features, workspaceId, taskId: task.taskId }
}

const bindingOf = (h: Awaited<ReturnType<typeof stage>>, revision = 1): ContextBindingInfo =>
  ({ rootSessionId: h.rootId, workspaceId: h.workspaceId, taskId: h.taskId, cardRevision: revision, workflowRevision: 1, requestRevision: 1 })

describe('feature state capacity', () => {
  it('rejects over-budget material before it enters the store and keeps the state committable', async () => {
    const h = await stage(256 * 1024)
    const binding = bindingOf(h)
    const chunk = (marker: string) => marker + 'x'.repeat(64 * 1024)
    let added = 0
    for (let index = 0; index < 8; index++) {
      try {
        h.features.addContext({ binding, layer: 'L2', kind: 'evidence', text: chunk(`chunk-${index}:`) })
        added += 1
      } catch (error) {
        expect(error).toBeInstanceOf(SwarmError)
        expect((error as SwarmError).code).toBe('CAPACITY_EXCEEDED')
        expect((error as Error).message).toContain('容量预算')
        expect((error as Error).message).toContain('persistence.maxStateBytes')
        break
      }
    }
    expect(added).toBeGreaterThanOrEqual(2)
    expect(added).toBeLessThan(8)
    // 预检发生在写入之前：被拒材料不进入材料清单，也不产生幽灵条目。
    expect(h.features.contexts.List(binding)).toHaveLength(added)
    await expect(h.features.persist('fixture/after-rejection', h.tasks, h.threads)).resolves.toBeUndefined()
    expect(h.features.store.getStateBytes()).toBeLessThanOrEqual(h.features.store.maxStateBytes)
    // 提交后仍可继续做任务级写入：容量拒绝不会把会话打成不可写。
    h.tasks.UpdateTask(h.taskId, { updatedAt: 1001 })
    await expect(h.features.persist('fixture/after-rejection-2', h.tasks, h.threads)).resolves.toBeUndefined()
  })

  it('still allows a net-shrink task replace at the budget boundary and frees capacity for later commits', async () => {
    const h = await stage(256 * 1024)
    const stale = bindingOf(h, 1)
    const chunk = (marker: string) => marker + 'y'.repeat(64 * 1024)
    let added = 0
    for (let index = 0; index < 8; index++) {
      try { h.features.addContext({ binding: stale, layer: 'L2', kind: 'author-reasoning', text: chunk(`old-${index}:`) }); added += 1 }
      catch { break }
    }
    expect(added).toBeGreaterThanOrEqual(2)
    h.tasks.UpdateTask(h.taskId, { cardRevision: 2, contextRefs: [] })
    const batch = h.features.prepareTaskContexts(bindingOf(h, 2), [{ layer: 'L0', kind: 'contract', text: '{"goal":"rebuilt"}' }])
    expect(batch.replaced).toHaveLength(added)
    batch.commit()
    batch.finalize()
    expect(h.features.contexts.List(bindingOf(h, 2))).toHaveLength(1)
    await expect(h.features.persist('fixture/shrunk', h.tasks, h.threads)).resolves.toBeUndefined()
    // 收缩后材料预算重新可用。
    expect(() => h.features.addContext({ binding: bindingOf(h, 2), layer: 'L2', kind: 'evidence', text: chunk('after-shrink:') })).not.toThrow()
  })

  it('keeps memory-mode route health out of the task state so a full state can never fail the request boundary again', async () => {
    const h = await stage(256 * 1024)
    const binding = bindingOf(h)
    for (let index = 0; index < 8; index++) {
      try { h.features.addContext({ binding, layer: 'L2', kind: 'evidence', text: `fill-${index}:` + 'z'.repeat(64 * 1024) }) }
      catch { break }
    }
    const sequenceBefore = h.features.store.getSequence()
    const route: RouteInfo = { provider: 'synthetic', model: 'capacity' }
    let clock = 0
    const health = intRouteHealth(() => clock)
    health.record(route, { provider: route.provider, model: route.model, kind: 'quota_exhausted', message: 'capacity fixture' })
    clock = 5000
    // 与 service 新接线一致：健康只走有界 sidecar；内存态不写任务状态、不产生 route_health_persist_failed。
    const registry = intRouteStateRegistry(undefined, undefined, {
      health, now: () => clock,
      onHealthChange: async (snapshot) => { await h.features.persistRouteHealth(snapshot) }
    })
    const child = { id: 'capacity-child', session: { header: { parentSession: h.rootId } } }
    registry.AddChild(child.id, { chain: [route], role: 'tan_wei' })
    registry.BeginRequestStep(child.id, 0, 0)
    expect(registry.RequestRouteRetry(route, child.id, { force: true }).ok).toBe(true)
    const call: CallConfigLike = { provider: route.provider, model: route.model }
    expect(registry.getRequestOverride(child, call, undefined)).toMatchObject(route)
    registry.MarkRequestStarted(child.id, 'attempt-1', route)
    registry.MarkRequestSucceeded(child.id)
    await expect(registry.WaitHealthReady(child.id)).resolves.toBeUndefined()
    expect(registry.getTerminal(child.id)).toBeUndefined()
    // 健康快照不进入任务状态，也不推进状态序列号。
    expect(h.features.store.getSequence()).toBe(sequenceBefore)
    expect(h.features.store.read().routeHealth).toBeUndefined()
  })
})
