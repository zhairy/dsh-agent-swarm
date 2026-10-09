import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { createFeatureSession, validateFeatureState } from '../../src/feature-session.js'
import { intTaskStore, type DelegationRecord, type TaskRecord } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { digest } from '../../src/task-model.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { getWorkflowDigest, intWorkflowState, type WorkflowDefinition } from '../../src/workflow.js'
import { createMemoryHandoffEnvelope } from '../../src/memory-handoff.js'
import { atomicStateFile, canonicalStateJson } from '../../src/state-store.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike } from '../../src/host-contract.js'
import type { AgentControlRecord } from '../../src/agent-control.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const homes: string[] = []
const services: SwarmService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose().catch(() => undefined)))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const stage = async (status?: 'running' | 'queued', sourceVersion: '2.3.0' | '2.3.1' | '2.3.2' = '2.3.0') => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-memory-handoff-service-'))
  homes.push(home)
  await writeFile(join(home, 'source.ts'), 'export const preserved = 42\n')
  const root: AgentLike = { id: 'memory-handoff-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const config = getSwarmConfig({ persistence: { enabled: false }, jev: { enabled: false }, review: { enabled: false },
    planningReview: { enabled: false }, workflow: { mode: 'advisory' }, execution: { maxCalls: 9 } })
  const workspaceId = await getWorkspaceId(home)
  const card = ValidateTaskCard({ title: '保留原任务', goal: '检查已有源码，保留原始结果', acceptance: ['绑定真实源码'], scope: ['source.ts'], flags: {} }).card!
  const definition: WorkflowDefinition = { schemaVersion: 1, mode: 'quick', nodes: [
    { id: 'explore', label: '探索源码', operation: 'delegate', role: 'tan_wei', dependsOn: [], gates: [], outputContractVersion: '1' },
    { id: 'checkpoint', label: '核对', operation: 'checkpoint', dependsOn: ['explore'], gates: [], outputContractVersion: '1' },
    { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
  ] }
  const task: TaskRecord = { taskId: 'T-1', sessionId: root.id, workspaceId, card, gates: [], triage: { source: 'rules', rulesApplied: [] },
    delegationIds: [], rounds: 0, createdAt: 100, updatedAt: 100, cardRevision: 2, workflowRevision: 4, requestRevision: 1,
    workflowDefinition: definition, workflowDigest: getWorkflowDigest(definition), workflowState: intWorkflowState(definition) }
  task.workflowState!.nodes.explore = { status: 'succeeded', attemptId: 'original-attempt' }
  const raw = structuredClone(VALID_OUTPUTS.tan_wei)
  const original: DelegationRecord = { delegationId: 'D-1', taskId: task.taskId, role: 'tan_wei', roleName: '探微', status: 'completed',
    summary: '原始探索不得丢失', structured: raw, evidence: [], unresolved: [], attempts: [], hardIsolation: true, independence: 'n/a',
    startedAt: 110, cardRevision: 2, workflowRevision: 4, requestRevision: 1, nodeId: 'explore', attemptId: 'original-attempt' }
  const tasks = intTaskStore(), threads = intThreadRegistry()
  tasks.AddTask(task); tasks.AddDelegation(original)
  const controls: AgentControlRecord[] = []
  const childId = 'original-persistent-child'
  if (status !== undefined) {
    tasks.AddDelegation({ delegationId: 'D-2', taskId: task.taskId, role: 'mou_ding', roleName: '谋定', status, summary: '', evidence: [], unresolved: [],
      attempts: [], hardIsolation: true, independence: 'n/a', startedAt: 120, cardRevision: 2, workflowRevision: 4, requestRevision: 1,
      childId, session: { kind: 'continuable', threadId: childId, appended: false, source: 'explicit', reason: '保留真实持续会话身份' },
      continuationInput: { task_id: task.taskId, role: 'mou_ding', prompt: '原始未结算请求', session: 'continue', backend: 'api' } })
    threads.Add({ threadId: childId, key: 'mou_ding', role: 'mou_ding', rounds: 0, busy: true, closed: false, allowWeb: false,
      taskIds: [task.taskId], history: [], createdAt: 120, lastUsedAt: 120 })
    controls.push({ childId, parentSessionId: root.id, taskId: task.taskId, delegationId: 'D-2', persistent: true,
      cardRevision: 2, workflowRevision: 4, requestRevision: 1, revision: 3, phase: 'running', paused: false, updatedAt: 120,
      actual: { attemptId: 'host-attempt-1', delegationId: 'D-2', route: { provider: 'fixture', model: 'original-model' },
        observedAt: 120, state: 'running', source: 'agent-loop-attempt' } })
  }
  const feature = await createFeatureSession({ rootSessionId: root.id, cwd: home, dshHome: home, config, tasks, threads,
    now: () => 130, getAgentControls: () => structuredClone(controls),
    getRuntime: () => ({ rootEditAt: 0, taskSequence: 7, counters: { native: 2, jev: 7, review: 3, session: 4 }, rootUpgradeExplicit: [] }) })
  try {
    const budget = feature.budgetFor(task)
    budget.reserve({ id: 'original-delegation-reservation', source: 'delegate' })
    budget.start('original-delegation-reservation')
    budget.settle('original-delegation-reservation', { inputTokens: 42, outputTokens: 7, costUsd: 0.001 })
    budget.observeJev({ inputTokens: 12, outputTokens: 3, costUsd: 0.000001 }, 1)
    await feature.persist('fixture/original-memory-state', tasks, threads)
    const state = feature.store.read()
    expect(validateFeatureState(state, { rootSessionId: root.id, workspaceId })).toBe(true)
    const directory = join(home, 'share', 'dsh-agent-swarm', 'maintenance', workspaceId, digest(root.id))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const pending = join(directory, 'pending.json')
    const write = async () => atomicStateFile(directory, 'pending.json', canonicalStateJson(createMemoryHandoffEnvelope({ rootSessionId: root.id, workspaceId, state, sourceVersion })))
    await write()
    return { home, root, config, workspaceId, state, pending, directory, write, raw, childId }
  } finally { await feature.dispose() }
}

const runtime = (fixture: Awaited<ReturnType<typeof stage>>) => {
  const start = vi.fn(async () => { throw new Error('Cold recovery must never spawn work') })
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('Cold recovery must never invoke a model') })
  const service = intSwarmService({ getConfig: () => fixture.config, getLlm: () => undefined,
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }), start }),
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => [{ name: 'read' }] }),
    getAttachments: () => undefined, getCredentials: () => undefined, fetch, dshHome: fixture.home,
    probe: async () => ({ ok: true, vision: true }), gitStatus: async () => undefined })
  services.push(service)
  const exec = () => ({ agent: fixture.root, signal: new AbortController().signal })
  return { service, exec, start, fetch }
}

describe('memory handoff through the actual service cold initialization boundary', () => {
  it.each(['2.3.0', '2.3.1', '2.3.2'] as const)('restores %s T-1, immutable output, revisions and budget, consumes once, and never imports again', async (sourceVersion) => {
    const fixture = await stage(undefined, sourceVersion)
    const before = await readFile(fixture.pending, 'utf8')
    const restored = runtime(fixture)
    await restored.service.WaitAgentReady(fixture.root)
    const status = restored.service.getStatus({ task_id: 'T-1', verbose: true }, restored.exec())
    expect(status.tasks).toHaveLength(1)
    expect(status.tasks[0]).toMatchObject({ task_id: 'T-1', cardRevision: 2, workflowRevision: 4, requestRevision: 1,
      delegations: [expect.objectContaining({ delegationId: 'D-1', structured: fixture.raw, summary: '原始探索不得丢失' })] })
    expect(status.executionBudgets[0]).toMatchObject({ task_id: 'T-1', reservations: [expect.objectContaining({ id: 'original-delegation-reservation', state: 'settled', usage: { inputTokens: 42, outputTokens: 7, costUsd: 0.001 } })],
      jev: { attempts: 1, inputTokens: 12, outputTokens: 3 } })
    expect(status.usage).toEqual({ nativeCalls: 2, jevCalls: 7, reviewCalls: 3, sessionCalls: 4 })
    expect(fixture.config.persistence.enabled).toBe(false)
    await expect(readFile(fixture.pending)).rejects.toMatchObject({ code: 'ENOENT' })
    const consumed = await readdir(fixture.directory)
    expect(consumed).toHaveLength(1); expect(consumed[0]).toMatch(/^consumed-/)
    expect(await readFile(join(fixture.directory, consumed[0]!), 'utf8')).toBe(before)
    await restored.service.WaitAgentReady(fixture.root)
    expect(await readdir(fixture.directory)).toEqual(consumed)
    const next = await restored.service.AddTaskCard({ title: '新的独立任务', goal: '保留任务编号高水位', acceptance: ['编号不复用'], scope: ['source.ts'], flags: {} }, restored.exec())
    expect(next.task_id).toBe('T-8')
    expect(restored.service.getStatus({}, restored.exec()).usage).toEqual(status.usage)
    expect(restored.start).not.toHaveBeenCalled(); expect(restored.fetch).not.toHaveBeenCalled()
    await restored.service.dispose()
    const later = runtime(fixture)
    await later.service.WaitAgentReady(fixture.root)
    expect(later.service.getStatus({}, later.exec()).tasks).toEqual([])
    expect(await readdir(fixture.directory)).toEqual(consumed)
    expect(later.start).not.toHaveBeenCalled(); expect(later.fetch).not.toHaveBeenCalled()
  })

  it.each(['queued', 'running'] as const)('converts %s work to recovery-required without spawning or model calls', async (status) => {
    const fixture = await stage(status)
    const restored = runtime(fixture)
    await restored.service.WaitAgentReady(fixture.root)
    const view = await restored.service.getAgentViewForRpc(fixture.root.id, fixture.childId) as AgentControlRecord
    expect(view).toMatchObject({ phase: 'recovery-required', paused: true, actual: { state: 'unknown' } })
    const saved = restored.service.getStatus({ task_id: 'T-1', verbose: true }, restored.exec()).tasks[0]!
    expect(saved.delegations.find((record) => record.delegationId === 'D-2')).toMatchObject({ status: 'failed', error: 'recovery_required' })
    await expect(restored.service.ControlAgentForRpc({ parentSessionId: fixture.root.id, childId: fixture.childId, expectedRevision: view.revision, action: 'continue' }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(restored.start).not.toHaveBeenCalled(); expect(restored.fetch).not.toHaveBeenCalled()
    expect(fixture.config.persistence.enabled).toBe(false)
  })

  it.each(['schema', 'lineage'] as const)('preserves pending bytes when %s validation rejects initialization', async (damage) => {
    const fixture = await stage('running')
    if (damage === 'schema') fixture.state.tasks[0]!.workflowRevision = 0
    else { fixture.state.threads[0]!.role = 'tan_wei'; fixture.state.threads[0]!.key = 'tan_wei' }
    await fixture.write()
    const before = await readFile(fixture.pending, 'utf8')
    const rejected = runtime(fixture)
    await expect(rejected.service.WaitAgentReady(fixture.root)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await readFile(fixture.pending, 'utf8')).toBe(before)
    expect(await readdir(fixture.directory)).toEqual(['pending.json'])
    expect(rejected.start).not.toHaveBeenCalled(); expect(rejected.fetch).not.toHaveBeenCalled()
    expect(fixture.config.persistence.enabled).toBe(false)
  })
})
