import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFeatureSession, getTaskRuntimeLineage, inspectFeatureState, type FeatureSession } from '../../src/feature-session.js'
import { createDurableStateStore, canonicalStateJson } from '../../src/state-store.js'
import { SWARM_LAYOUT_OPTIONS, SWARM_SEGMENT_SPECS, LEGACY_SEGMENT_SPECS } from '../../src/state-chunks.js'
import { getSwarmConfig } from '../../src/config.js'
import { intTaskStore, type TaskRecord } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { createProgressGuard, type ProgressGuardState } from '../../src/progress-guard.js'
import { createAuthorizationRepository, type AuthorizationState } from '../../src/authorization-wait.js'
import { IssueVerificationReceipt, IsVerificationReceiptCurrent, RUNTIME_POLICY_VERSION, type VerificationReceipt } from '../../src/verification-receipt.js'
import { getValueDigest } from '../../src/workflow.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { createMemoryHandoffEnvelope } from '../../src/memory-handoff.js'
import { digest } from '../../src/task-model.js'

interface State extends AuthorizationState, ProgressGuardState {
  schemaVersion: 1 | 2
  tasks: TaskRecord[]
  delegations: []
  threads: []
  contexts: []
  budgets: Record<string, never>
  bindings: Record<string, never>
  bindingHistory: Record<string, never>
  messages: Record<string, never>
  messageAcks: Record<string, never>
  experiences: Record<string, never>
}
const homes: string[] = [], close: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of close.splice(0)) await dispose().catch(() => undefined)
  for (const path of homes.splice(0)) await rm(path, { recursive: true, force: true })
})
const home = async () => { const path = await mkdtemp(join(tmpdir(), 'swarm-guards-state-')); homes.push(path); return path }
const expected = { rootSessionId: 'root', workspaceId: 'a'.repeat(64) }
const initial = (schemaVersion: 1 | 2 = 2, scope = expected): State => ({ schemaVersion,
  tasks: [{ taskId: 'T-1', sessionId: scope.rootSessionId, workspaceId: scope.workspaceId,
    card: ValidateTaskCard({ title: '核对授权存储', goal: '安全保存真实任务状态', acceptance: ['来源可验证'], scope: [], flags: {} }).card!,
    gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1,
    requestRevision: 1, cardRevision: 1, workflowRevision: 1 }], delegations: [], threads: [], contexts: [], budgets: {},
  bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {},
  ...(schemaVersion === 2 ? { runtimeControls: {}, progressHistory: {}, authorizationDecisions: {} } : {}) })
const memoryStore = async () => {
  const store = await createDurableStateStore<State>({ directory: '/unused', enabled: false, initialState: initial(), ...SWARM_LAYOUT_OPTIONS,
    validate: raw => inspectFeatureState(raw, expected) })
  close.push(store.dispose)
  return store
}
const authInput = (scope = expected) => ({ binding: { ...scope, taskId: 'T-1', lineageId: getTaskRuntimeLineage({ ...scope, taskId: 'T-1' }), requestRevision: 1, cardRevision: 1, workflowRevision: 1 },
  operationDigest: 'b'.repeat(64), scopeDigest: 'c'.repeat(64), requiresUserDecision: true as const,
  questions: [{ id: 'q', question: '允许继续指定范围吗？', options: [{ label: '允许' }, { label: '拒绝' }] }] })
const featureFixture = async (durable = false) => {
  const path = await home(), workspaceId = await getWorkspaceId(path), scope = { rootSessionId: 'root', workspaceId }
  const config = getSwarmConfig({ persistence: { enabled: durable, directory: join(path, 'state') }, jev: { enabled: false }, workflow: { mode: 'advisory' } })
  const tasks = intTaskStore(), threads = intThreadRegistry()
  tasks.AddTask(initial(2, scope).tasks[0]!)
  const args = { rootSessionId: scope.rootSessionId, cwd: path, dshHome: path, config, tasks, threads, now: () => 1000 }
  const features = await createFeatureSession(args)
  close.push(features.dispose)
  await features.persist('fixture/task', tasks, threads)
  return { path, scope, config, tasks, threads, features, args }
}

describe('FeatureState schema-2安全隔离与旧格式兼容', () => {
  it('schema1保持可读但拒绝伪装成旧格式的新安全字段，schema2要求完整空集合', () => {
    expect(inspectFeatureState(initial(1), expected).ok).toBe(true)
    expect(inspectFeatureState(initial(2), expected).ok).toBe(true)
    for (const key of ['runtimeControls', 'progressHistory', 'authorizationDecisions']) {
      expect(inspectFeatureState({ ...initial(1), [key]: {} }, expected)).toMatchObject({ ok: false, issues: [{ code: 'GUARD_SCHEMA_VERSION' }] })
      const incomplete = initial(2) as unknown as Record<string, unknown>
      delete incomplete[key]
      expect(inspectFeatureState(incomplete, expected).ok).toBe(false)
    }
    expect(inspectFeatureState({ ...initial(2), schemaVersion: '2' }, expected).ok).toBe(false)
  })
  it('新FeatureSession暴露共享仓库，日常persist不覆盖已落账的授权和进展', async () => {
    const f = await featureFixture()
    expect(f.features.store.read().schemaVersion).toBe(2)
    expect(f.features.store.durable).toBe(false)
    const lineageId = getTaskRuntimeLineage({ ...f.scope, taskId: 'T-1' })
    await f.features.progress.observe({ lineageId, action: 'delegate', projection: { evidence: 1 } })
    const decision = (await f.features.authorizations.prepare(authInput(f.scope))).decision
    await f.features.authorizations.dispatchKnown(decision.id, { callId: 'call-1', questionDigest: decision.questionDigest })
    f.tasks.UpdateTask('T-1', { updatedAt: 2 })
    await f.features.persist('fixture/ordinary-write', f.tasks, f.threads)
    expect(f.features.progress.get(lineageId)).toMatchObject({ historyCount: 1, activations: 1 })
    expect(f.features.authorizations.get(decision.id)).toMatchObject({ phase: 'waiting', hostCallId: 'call-1' })
    expect(inspectFeatureState(f.features.store.read(), f.scope).ok).toBe(true)
  })
  it('控制谱系和历史页必须有实际任务归属，错key/孤儿/丢页/重复记录拒绝', async () => {
    const store = await memoryStore(), progress = createProgressGuard(store, () => 1, expected)
    const lineageId = getTaskRuntimeLineage({ ...expected, taskId: 'T-1' })
    await progress.observe({ lineageId, action: 'checkpoint', projection: { evidence: 1 } })
    const valid = store.read(), pageKey = Object.keys(valid.progressHistory!)[0]!
    expect(inspectFeatureState(valid, expected).ok).toBe(true)
    const wrongKey = structuredClone(valid)
    wrongKey.progressHistory!['wrong-key'] = wrongKey.progressHistory![pageKey]!
    delete wrongKey.progressHistory![pageKey]
    expect(inspectFeatureState(wrongKey, expected).ok).toBe(false)
    const missingControl = structuredClone(valid)
    delete missingControl.runtimeControls![lineageId]
    expect(inspectFeatureState(missingControl, expected).ok).toBe(false)
    const lostPage = structuredClone(valid)
    delete lostPage.progressHistory![pageKey]
    expect(inspectFeatureState(lostPage, expected).ok).toBe(false)
    const duplicate = structuredClone(valid)
    duplicate.progressHistory![pageKey]!.items.push(structuredClone(duplicate.progressHistory![pageKey]!.items[0]!))
    duplicate.runtimeControls![lineageId]!.historyCount++
    expect(inspectFeatureState(duplicate, expected).ok).toBe(false)
    const malformed = structuredClone(valid)
    malformed.progressHistory![pageKey]!.items[0]!.canonical = 'invalid-json'
    expect(inspectFeatureState(malformed, expected)).toMatchObject({ ok: false, issues: [{ path: '$.progressHistory[0]' }] })
    await expect(progress.observe({ lineageId: 'e'.repeat(64), action: 'checkpoint', projection: {} })).rejects.toThrow('RUNTIME_CONTROL_OWNER')
  })
  it('授权记录拒绝跨任务/跨根/未来版本，历史适用绑定不冒充当前授权', async () => {
    const store = await memoryStore(), repo = createAuthorizationRepository(store)
    const decision = (await repo.prepare(authInput())).decision
    const valid = store.read()
    expect(inspectFeatureState(valid, expected).ok).toBe(true)
    for (const key of ['rootSessionId', 'workspaceId', 'taskId', 'lineageId'] as const) {
      const bad = structuredClone(valid)
      const record = bad.authorizationDecisions![decision.id]!
      record.questionBinding[key] = 'other'
      // Keep the record internally self-consistent to exercise the FeatureState owner guard.
      record.dedupKey = getValueDigest({ rootSessionId: record.questionBinding.rootSessionId, workspaceId: record.questionBinding.workspaceId,
        taskId: record.questionBinding.taskId, lineageId: record.questionBinding.lineageId, operationDigest: record.operationDigest, scopeDigest: record.scopeDigest, policyVersion: 1 })
      expect(inspectFeatureState(bad, expected).ok).toBe(false)
    }
    const future = structuredClone(valid)
    future.authorizationDecisions![decision.id]!.questionBinding.requestRevision = 2
    expect(inspectFeatureState(future, expected)).toMatchObject({ ok: false, issues: [{ code: 'AUTHORIZATION_DECISION_VERSION' }] })
    const changed = structuredClone(valid)
    changed.tasks[0]!.requestRevision = 3
    expect(inspectFeatureState(changed, expected).ok).toBe(true)
  })
  it('旧accepted只保留历史事实，receipt需正确归属且不能绑定未来版本', () => {
    const state = initial(1), task = state.tasks[0]!
    task.acceptance = { decision: 'accept', status: 'accepted', summary: '历史验收', missing: [], unresolved: [], stopReason: 'done', resolutions: [], at: 10 }
    expect(inspectFeatureState(state, expected).ok).toBe(true)
    const receipt = IssueVerificationReceipt({ ...expected, taskId: task.taskId, cardRevision: 1, workflowRevision: 1, requestRevision: 1,
      questionVersion: 'question-v1', policyVersion: RUNTIME_POLICY_VERSION, artifactDigest: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64), decisionDigest: 'd'.repeat(64) }, ['independent-reviewer'], 10)
    const newer = { ...state, schemaVersion: 2 as const, runtimeControls: {}, progressHistory: {}, authorizationDecisions: {} }
    Object.assign(newer.tasks[0]!.acceptance!, { verificationReceipt: receipt })
    expect(inspectFeatureState(newer, expected).ok).toBe(true)
    expect(inspectFeatureState({ ...newer, schemaVersion: 1 }, expected).ok).toBe(false)
    newer.tasks[0]!.requestRevision = 2
    expect(inspectFeatureState(newer, expected).ok).toBe(true)
    expect(IsVerificationReceiptCurrent(receipt, { ...receipt.binding, requestRevision: 2 })).toBe(false)
    for (const corrupt of [
      { ...receipt, binding: { ...receipt.binding, rootSessionId: 'other' } },
      { ...receipt, binding: { ...receipt.binding, taskId: 'T-2' } },
      { ...receipt, binding: { ...receipt.binding, workflowRevision: 9 } }
    ]) {
      Object.assign(newer.tasks[0]!.acceptance!, { verificationReceipt: corrupt as VerificationReceipt })
      expect(inspectFeatureState(newer, expected).ok).toBe(false)
    }
  })
  it.each(['3.1.2', '3.1.3'] as const)('受支持的%s内存交接保留控制历史，待答复恢复为核对态', async sourceVersion => {
    const f = await featureFixture(), decision = (await f.features.authorizations.prepare(authInput(f.scope))).decision
    await f.features.authorizations.dispatchKnown(decision.id, { callId: 'call-1', questionDigest: decision.questionDigest })
    const lineageId = getTaskRuntimeLineage({ ...f.scope, taskId: 'T-1' })
    await f.features.progress.observe({ lineageId, action: 'delegate', projection: { evidence: 'same' } })
    let source = f.features.store.read() as unknown as State
    // A 3.1.2 producer has only schema1; a 3.1.3 producer preserves its real guards.
    if (sourceVersion === '3.1.2') source = initial(1, f.scope)
    const directory = join(f.path, 'share', 'dsh-agent-swarm', 'maintenance', f.scope.workspaceId, digest(f.scope.rootSessionId))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const pending = join(directory, 'pending.json')
    await writeFile(pending, canonicalStateJson(createMemoryHandoffEnvelope({ ...f.scope, state: source, sourceVersion })), { mode: 0o600 })
    await f.features.dispose()
    const restored = await createFeatureSession({ ...f.args, tasks: intTaskStore(), threads: intThreadRegistry() })
    close.push(restored.dispose)
    expect(restored.store.read().schemaVersion).toBe(2)
    expect(restored.store.durable).toBe(false)
    if (sourceVersion === '3.1.3') {
      expect(restored.authorizations.get(decision.id)).toMatchObject({ phase: 'reconcile-required', hostCallId: 'call-1' })
      expect(restored.progress.get(lineageId)).toMatchObject({ historyCount: 1, activations: 1 })
    } else expect(restored.authorizations.forTask('T-1')).toEqual([])
    expect(await readFile(pending, 'utf8')).toContain(sourceVersion)
    await restored.commitRecovery()
    await expect(readFile(pending, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([{ layout: 1, snapshot: false }, { layout: 1, snapshot: true }, { layout: 2, snapshot: false }, { layout: 2, snapshot: true }])('旧layout$layout（snapshot=$snapshot）可恢复到schema2并继续新dict增量写入', async ({ layout, snapshot }) => {
    const path = await home(), workspaceId = await getWorkspaceId(path), scope = { rootSessionId: 'root', workspaceId }
    const directory = join(path, 'state', workspaceId, digest(scope.rootSessionId))
    const strip = (specs: typeof SWARM_SEGMENT_SPECS) => Object.fromEntries(Object.entries(specs).filter(([name]) => !['runtimeControls', 'progressHistory', 'authorizationDecisions'].includes(name)))
    const old = await createDurableStateStore<State>({ directory, initialState: initial(1, scope), segments: strip(layout === 2 ? SWARM_SEGMENT_SPECS : LEGACY_SEGMENT_SPECS),
      legacySegments: strip(LEGACY_SEGMENT_SPECS), layoutVersion: layout, snapshotEvery: snapshot ? 1 : 64, validate: raw => inspectFeatureState(raw, scope) })
    close.push(old.dispose)
    await old.commit('old/write', draft => { draft.tasks[0]!.updatedAt = 2 })
    await old.dispose()
    const features: FeatureSession = await createFeatureSession({ rootSessionId: scope.rootSessionId, cwd: path, dshHome: path,
      config: getSwarmConfig({ persistence: { enabled: true, directory: join(path, 'state') } }), tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 1000 })
    close.push(features.dispose)
    expect(features.store.read().schemaVersion).toBe(2)
    await features.progress.observe({ lineageId: getTaskRuntimeLineage({ ...scope, taskId: 'T-1' }), action: 'checkpoint', projection: { evidence: 1 } })
    expect(features.store.read().progressHistory).toBeDefined()
  })
})
