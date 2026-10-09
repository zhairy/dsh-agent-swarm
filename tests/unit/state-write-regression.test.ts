import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { digest } from '../../src/task-model.js'
import type { AgentLike, SubagentStartRequestLike } from '../../src/host-contract.js'
import type { EvidenceConsumptionNotice } from '../../src/evidence-assessment.js'
import type { DelegationRecord, TaskRecord } from '../../src/evidence.js'
import { validateFeatureState } from '../../src/feature-session.js'
import { ROLE_TAG_PATTERN } from '../../src/role-registry.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'
import type { WorkflowDefinition } from '../../src/workflow.js'

const services: SwarmService[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose().catch(() => undefined)))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

const make = async (options: { onStart?: (role: keyof typeof VALID_OUTPUTS, home: string) => Promise<void> } = {}) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-state-write-regression-'))
  homes.push(home)
  await mkdir(join(home, 'src'))
  await writeFile(join(home, 'src', 'math.ts'), 'export const stableSum = (values: number[]) => values.reduce((a, b) => a + b, 0)\n')
  const root: AgentLike = { id: 'state-regression-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const config = getSwarmConfig({ jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false },
    persistence: { enabled: true }, workflow: { mode: 'advisory' }, agents: { session: 'oneshot', maxRetries: 0 } })
  let childSequence = 0
  const start = vi.fn(async (_provider: string, request: SubagentStartRequestLike) => {
    const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as keyof typeof VALID_OUTPUTS
    await options.onStart?.(role, home)
    return { id: 'state-regression-child-' + ++childSequence,
      result: Promise.resolve({ output: [], stopReason: 'completed', structured: role === 'tan_wei'
        ? { summary: '读取求和函数', unresolved: [], findings: [{ path: 'src/math.ts', symbol: 'stableSum', callChain: ['stableSum'], evidence: '使用 reduce，初值 0' }] }
        : role === 'ji_feng' ? { summary: '已执行一次真实文件修改', unresolved: [], changedFiles: ['src/math.ts'], localChecks: [] }
        : structuredClone(VALID_OUTPUTS[role]) }), dispose: async () => undefined }
  })
  const service = intSwarmService({ getConfig: () => config, getLlm: () => undefined,
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }), start }),
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => ['read', 'glob', 'grep', 'swarm_context_read'].map((name) => ({ name })) }),
    getAttachments: () => undefined, getCredentials: () => undefined,
    fetch: async () => { throw new Error('No live network is allowed in this regression') },
    dshHome: home, gitStatus: async () => undefined,
    probe: async () => ({ ok: true, vision: true }), sleep: async () => undefined })
  services.push(service)
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  const card = { title: '只读探索', goal: '验证真实求和实现', acceptance: ['给出当前源码证据'], scope: ['src/math.ts'], flags: {},
    workflow: { schemaVersion: 1, mode: 'quick', nodes: [
      { id: 'explore', label: '探索源码', operation: 'delegate', role: 'tan_wei', dependsOn: [], gates: [], outputContractVersion: '1' },
      { id: 'checkpoint', label: '核对证据', operation: 'checkpoint', dependsOn: ['explore'], gates: [], outputContractVersion: '1' },
      { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
    ] } }
  type State = { delegations: DelegationRecord[]; tasks: TaskRecord[]; contexts: unknown[] }
  const latestCommit = async () => {
    const directory = join(home, 'share', 'dsh-agent-swarm', 'state', await getWorkspaceId(home), digest(root.id))
    const [snapshot, journal] = await Promise.all([readFile(join(directory, 'snapshot.json'), 'utf8'), readFile(join(directory, 'journal.jsonl'), 'utf8')])
    const envelopes = [JSON.parse(snapshot), ...journal.split('\n').filter(Boolean).map((line) => JSON.parse(line))] as Array<{ sequence: number; state: State }>
    return envelopes.reduce((latest, entry) => entry.sequence > latest.sequence ? entry : latest)
  }
  const state = async () => (await latestCommit()).state
  return { service, root, exec, card, state, latestCommit, home, start }
}

describe('complete durable state remains writable across effective workflow changes', () => {
  it('rolls back an unsent reservation when the real journal refuses its admission write', async () => {
    const runtime = await make()
    const task = await runtime.service.AddTaskCard(runtime.card, runtime.exec())
    const directory = join(runtime.home, 'share', 'dsh-agent-swarm', 'state', await getWorkspaceId(runtime.home), digest(runtime.root.id))
    const journal = join(directory, 'journal.jsonl'), backup = join(directory, 'original-journal.jsonl')
    await rename(journal, backup)
    await symlink(backup, journal)
    try {
      await expect(runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '不得真正启动',
        request_id: 'failed-admission-request', backend: 'api', session: 'oneshot' }, runtime.exec())).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
      expect(runtime.start).not.toHaveBeenCalled()
      const status = runtime.service.getStatus({ task_id: task.task_id }, runtime.exec())
      expect(status.tasks[0]!.flow?.state?.nodes.explore).toMatchObject({ status: 'ready' })
      expect(status.executionBudgets[0]!.reservations).toHaveLength(1)
      expect(status.executionBudgets[0]!.reservations[0]).toMatchObject({ source: 'delegate', state: 'cancelled' })
    } finally {
      await rm(journal)
      await rename(backup, journal)
    }
    // A changed payload with the same ID reaches the fail-closed state store,
    // rather than conflicting with a phantom pending request left in memory.
    await expect(runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '同ID改输入仍不得启动',
      request_id: 'failed-admission-request', backend: 'api', session: 'oneshot' }, runtime.exec())).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED', message: expect.stringContaining('previous durable write failed')
    })
    expect(runtime.start).not.toHaveBeenCalled()
    expect(runtime.service.getStatus({ task_id: task.task_id }, runtime.exec()).tasks[0]!.flow?.state?.nodes.explore.status).toBe('ready')
    expect((await runtime.state()).tasks[0]!.requestIds?.['failed-admission-request']).toBeUndefined()
  })
  it('keeps historical exploration and its assessment bound to the original revision when a real edit adds verification', async () => {
    const runtime = await make()
    const task = await runtime.service.AddTaskCard(runtime.card, runtime.exec())
    const explored = await runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '检查真实求和函数', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(explored.evidenceAssessment).toMatchObject({ status: 'unknown', binding: { workflowRevision: task.workflowRevision } })
    // An allowed root edit is a documented trigger for an additional G_VERIFY.
    const dispatchedEdit = { name: 'edit', agent: runtime.root, arguments: { path: join(runtime.home, 'src/math.ts') } }
    expect(runtime.service.getGuardReason(dispatchedEdit)).toBeUndefined()
    runtime.service.ObserveToolDispatch(dispatchedEdit)
    // A read-only status request may reconcile the workflow, but must never
    // rewrite an assessment's original execution identity or poison later writes.
    const reconciled = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec()).tasks[0]!
    expect(reconciled.workflowRevision).toBeGreaterThan(task.workflowRevision)
    const next = await runtime.service.delegate({ task_id: task.task_id, role: 'fu_he', prompt: '核对编辑后的结果', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(next.status).toBe('completed')
    const current = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec()).tasks[0]!
    expect(current.workflowRevision).toBeGreaterThan(task.workflowRevision)
    const saved = await runtime.state()
    expect(validateFeatureState(saved, { rootSessionId: runtime.root.id, workspaceId: await getWorkspaceId(runtime.home) })).toBe(true)
    const historical = saved.delegations.find((record) => record.delegationId === explored.delegationId)!
    expect(historical.workflowRevision).toBe(explored.workflowRevision)
    expect(historical.evidenceAssessment?.binding.workflowRevision).toBe(explored.workflowRevision)
    await expect(runtime.service.ReviewPlan({ task_id: task.task_id, bypass_cache: true }, runtime.exec())).resolves.toBeDefined()
    const listed = await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec()) as { materials: Array<{ ref: string }> }
    for (const material of listed.materials) {
      const page = await runtime.service.ReadContext({ task_id: task.task_id, ref: material.ref }, runtime.exec()) as { evidenceAssessment?: EvidenceConsumptionNotice }
      expect(page.evidenceAssessment?.mayUseForImplementation).not.toBe(true)
    }
  })

  it('makes an old successful gate runnable again without promoting its historical result to the new workflow', async () => {
    const runtime = await make()
    const card = structuredClone(runtime.card) as Omit<typeof runtime.card, 'workflow'> & { workflow: WorkflowDefinition }
    card.flags = { hasVisualInput: true }
    card.workflow.nodes.splice(1, 0, { id: 'vision', label: '核对界面', operation: 'delegate', role: 'guan_xiang', dependsOn: ['explore'], gates: ['G_VISION'], outputContractVersion: '1' })
    card.workflow.nodes.find((node) => node.id === 'checkpoint')!.dependsOn = ['explore', 'vision']
    const task = await runtime.service.AddTaskCard(card, runtime.exec())
    await runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '检查真实求和函数', backend: 'api', session: 'oneshot' }, runtime.exec())
    const oldVision = await runtime.service.delegate({ task_id: task.task_id, node_id: 'vision', role: 'guan_xiang', prompt: '核对当前产物', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(oldVision.status).toBe('completed')
    const dispatchedEdit = { name: 'edit', agent: runtime.root, arguments: { path: join(runtime.home, 'src/math.ts') } }
    expect(runtime.service.getGuardReason(dispatchedEdit)).toBeUndefined()
    runtime.service.ObserveToolDispatch(dispatchedEdit)
    const reconciled = runtime.service.getStatus({ task_id: task.task_id }, runtime.exec()).tasks[0]!
    expect(reconciled.workflowRevision).toBeGreaterThan(task.workflowRevision)
    await runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '为新流程核对当前源码', backend: 'api', session: 'oneshot' }, runtime.exec())
    const freshVision = await runtime.service.delegate({ task_id: task.task_id, node_id: 'vision', role: 'guan_xiang', prompt: '核对编辑后的当前产物', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(freshVision.status).toBe('completed')
    expect(freshVision.delegationId).not.toBe(oldVision.delegationId)
    expect(freshVision.workflowRevision).toBe(reconciled.workflowRevision)
    const historical = (await runtime.state()).delegations.find((record) => record.delegationId === oldVision.delegationId)!
    expect(historical.workflowRevision).toBe(oldVision.workflowRevision)
  })

  it('does not turn guard-only checks or repeated readonly status/view into state mutations', async () => {
    const runtime = await make()
    const task = await runtime.service.AddTaskCard(runtime.card, runtime.exec())
    await runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '检查当前源码', backend: 'api', session: 'oneshot' }, runtime.exec())
    const before = await runtime.latestCommit()
    for (let index = 0; index < 10; index++) {
      expect(runtime.service.getGuardReason({ name: 'edit', agent: runtime.root, arguments: { path: join(runtime.home, 'src/math.ts') } })).toBeUndefined()
      const status = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec()).tasks[0]!
      expect(status.workflowRevision).toBe(task.workflowRevision)
      expect(status.gates.some((gate) => gate.gate === 'G_VERIFY')).toBe(false)
      runtime.service.getTaskViewForRpc(runtime.root.id, task.task_id)
    }
    expect(await runtime.latestCommit()).toEqual(before)
    runtime.service.ObserveToolDispatch({ name: 'edit', agent: runtime.root, arguments: { path: join(runtime.home, 'src/math.ts') } })
    const firstProjection = runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec())
    for (let index = 0; index < 10; index++) {
      expect(runtime.service.getStatus({ task_id: task.task_id, verbose: true }, runtime.exec())).toEqual(firstProjection)
      runtime.service.getTaskViewForRpc(runtime.root.id, task.task_id)
    }
    expect(await runtime.latestCommit()).toEqual(before)
  })

  it('does not repeat an actually completed writer while adding verification to its workflow', async () => {
    let writes = 0
    const runtime = await make({ onStart: async (role, home) => {
      if (role === 'ji_feng') { writes++; await writeFile(join(home, 'src/math.ts'), `export const actualWriterExecutions = ${writes}\n`) }
    } })
    const card = structuredClone(runtime.card) as Omit<typeof runtime.card, 'workflow'> & { workflow: WorkflowDefinition }
    card.workflow.nodes.splice(1, 0, { id: 'implementation', label: '执行一次修改', operation: 'delegate', role: 'ji_feng', dependsOn: ['explore'], gates: [], outputContractVersion: '1' })
    card.workflow.nodes.find((node) => node.id === 'checkpoint')!.dependsOn = ['explore', 'implementation']
    const task = await runtime.service.AddTaskCard(card, runtime.exec())
    await runtime.service.delegate({ task_id: task.task_id, node_id: 'explore', role: 'tan_wei', prompt: '检查修改前实现', backend: 'api', session: 'oneshot' }, runtime.exec())
    const written = await runtime.service.delegate({ task_id: task.task_id, node_id: 'implementation', role: 'ji_feng', prompt: '只执行一次修改', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(written.status).toBe('completed')
    expect(writes).toBe(1)
    const current = (await runtime.state()).tasks.find((entry) => entry.taskId === task.task_id)!
    expect(current.workflowRevision).toBeGreaterThan(task.workflowRevision)
    expect(current.workflowState?.nodes.implementation).toMatchObject({ status: 'skipped', reason: expect.stringContaining('不自动重放') })
    expect((await runtime.state()).delegations.find((record) => record.delegationId === written.delegationId)?.workflowRevision).toBe(task.workflowRevision)
    for (let index = 0; index < 5; index++) runtime.service.getStatus({ task_id: task.task_id }, runtime.exec())
    await runtime.service.ReviewPlan({ task_id: task.task_id, bypass_cache: true }, runtime.exec())
    const verification = await runtime.service.delegate({ task_id: task.task_id, node_id: 'verification', role: 'fu_he', prompt: '验证已执行修改，不重复写入', backend: 'api', session: 'oneshot' }, runtime.exec())
    expect(verification).toMatchObject({ status: 'completed', nodeId: 'verification', workflowRevision: current.workflowRevision })
    expect(validateFeatureState(await runtime.state(), { rootSessionId: runtime.root.id, workspaceId: await getWorkspaceId(runtime.home) })).toBe(true)
    expect(writes).toBe(1)
    expect(runtime.start.mock.calls.filter(([, request]) => ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] === 'ji_feng')).toHaveLength(1)
    expect(await readFile(join(runtime.home, 'src/math.ts'), 'utf8')).toBe('export const actualWriterExecutions = 1\n')
  })
})
