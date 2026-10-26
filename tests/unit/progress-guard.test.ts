import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { createProgressGuard, getProgressProjection, ValidateProgressControl, ValidateProgressPage,
  type ProgressControl, type ProgressGuardState, type ProgressPage } from '../../src/progress-guard.js'
import { getCanonicalJson, getValueDigest } from '../../src/workflow.js'
import { RUNTIME_POLICY_VERSION } from '../../src/verification-receipt.js'
import { ValidateTaskCard } from '../../src/policy.js'
import type { TaskRecord } from '../../src/evidence.js'

interface State extends ProgressGuardState {
  schemaVersion: 2
  runtimeControls: Record<string, ProgressControl>
  progressHistory: Record<string, ProgressPage>
}
const scope = { rootSessionId: 'progress-root', workspaceId: 'a'.repeat(64) }
const stores: DurableStateStore<State>[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})
const empty = (): State => ({ schemaVersion: 2, runtimeControls: {}, progressHistory: {} })
const validate = (raw: unknown): boolean => {
  const state = raw as State
  return state.schemaVersion === 2 && Object.values(state.runtimeControls).every(ValidateProgressControl)
    && Object.values(state.progressHistory).every(ValidateProgressPage)
}
const createStore = async (options: { durable?: boolean; directory?: string; initialState?: State; maxStateBytes?: number; validate?: (raw: unknown) => boolean } = {}) => {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), 'swarm-progress-'))
  if (options.directory === undefined) directories.push(directory)
  const store = await createDurableStateStore<State>({ directory, enabled: options.durable ?? false,
    initialState: options.initialState ?? empty(), segments: { runtimeControls: { kind: 'dict' }, progressHistory: { kind: 'dict' } },
    snapshotEvery: 16, maxStateBytes: options.maxStateBytes ?? 4 * 1024 * 1024, validate: options.validate ?? validate })
  stores.push(store)
  return store
}
const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({
  taskId: 'T-1', sessionId: scope.rootSessionId, workspaceId: scope.workspaceId,
  card: ValidateTaskCard({ title: '进展守卫回归', goal: '仅凭真实变化继续任务', acceptance: ['历史循环不能靠改名重置'], scope: ['src/a.ts', 'src/b.ts'], flags: {} }).card!,
  gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [], rounds: 0,
  createdAt: 1, updatedAt: 1, requestRevision: 1, cardRevision: 1, workflowRevision: 1,
  intentSource: 'host', intentSourceRef: 'user-message-1',
  workflowDefinition: { schemaVersion: 1, mode: 'quick', nodes: [
    { id: 'analysis', label: '分析', operation: 'delegate', role: 'mou_ding', dependsOn: [], gates: [], outputContractVersion: '1' },
    { id: 'checkpoint', label: '检查点', operation: 'checkpoint', dependsOn: ['analysis'], gates: [], outputContractVersion: '1' },
    { id: 'accept', label: '验收', operation: 'accept', dependsOn: ['checkpoint'], gates: [], outputContractVersion: '1' }
  ] }, ...patch
})
const fixture = async (options: Parameters<typeof createStore>[0] = {}) => {
  const store = await createStore(options), guard = createProgressGuard(store, () => 1000, scope)
  const current = task(), lineageId = await guard.bindTask(current, scope.workspaceId)
  const observe = (projection: unknown, extra: Partial<Parameters<typeof guard.observe>[0]> = {}) => guard.observe({ lineageId, taskId: current.taskId, action: 'delegate', projection, ...extra })
  return { store, guard, current, lineageId, observe }
}
const entries = (store: DurableStateStore<State>) => Object.values(store.read().progressHistory).flatMap(page => page.items)

describe('进展守卫的全历史新意与任务谱系', () => {
  it('A/B/A 不增加历史容量，第三次命中 A 后停滞而不是无限往返', async () => {
    const f = await fixture()
    expect(await f.observe({ evidence: 'A' })).toMatchObject({ status: 'active', historyCount: 1, activations: 1 })
    await f.observe({ evidence: 'B' })
    expect(await f.observe({ evidence: 'A' })).toMatchObject({ status: 'active', historyCount: 2, activations: 3 })
    await f.observe({ evidence: 'B' })
    expect(await f.observe({ evidence: 'A' })).toMatchObject({ status: 'stalled', historyCount: 2, activations: 5, reason: expect.stringContaining('LOOP_DETECTED') })
    expect(entries(f.store).map(item => item.hits).sort()).toEqual([2, 3])
    const sequence = f.store.getSequence()
    expect(await f.observe({ evidence: 'C' })).toMatchObject({ status: 'stalled', historyCount: 2, activations: 5 })
    expect(f.store.getSequence()).toBe(sequence)
  })

  it('周期为 w+1 的循环也会命中全历史索引，不能逃逸长度 w 的局部观察窗', async () => {
    const f = await fixture(), window = 4
    for (let round = 0; round < 2 * (window + 1); round++) await f.observe({ phase: round % (window + 1) })
    const stopped = await f.observe({ phase: 0 })
    expect(stopped).toMatchObject({ status: 'stalled', historyCount: window + 1, activations: 2 * (window + 1) + 1 })
    expect(entries(f.store).find(item => item.canonical === getCanonicalJson({ phase: 0 }))?.hits).toBe(3)
  })

  it('只换任务标题、节点 label/id、排列或合同修订号不产生结构新意', async () => {
    const f = await fixture(), original = getProgressProjection(f.current)
    await f.observe(original)
    const renamed = structuredClone(f.current)
    renamed.card.title = '不同展示标题'; renamed.card.goal = '同一证据重新表述'
    renamed.card.scope.reverse(); renamed.cardRevision = 7; renamed.requestRevision = 9; renamed.workflowRevision = 11
    const renamedIds = new Map(renamed.workflowDefinition!.nodes.map(node => [node.id, `new_${node.id}`]))
    for (const node of renamed.workflowDefinition!.nodes) {
      node.id = renamedIds.get(node.id)!
      node.label = '另一个标签'
      node.dependsOn = node.dependsOn.map(id => renamedIds.get(id)!)
    }
    renamed.workflowDefinition!.nodes.reverse()
    expect(getProgressProjection(renamed)).toEqual(original)
    await f.observe(getProgressProjection(renamed))
    expect(await f.observe(getProgressProjection({ ...renamed, workflowRevision: 99 }))).toMatchObject({ status: 'stalled', historyCount: 1, activations: 3 })
  })

  it('同一真实宿主请求创建 T-2 时继续原谱系，不重置 T-1 的计数与重复历史', async () => {
    const f = await fixture()
    await f.observe({ evidence: 'same' }); await f.observe({ evidence: 'same' })
    const next = task({ taskId: 'T-2', cardRevision: 9 })
    expect(f.guard.lineageFor(next, scope.workspaceId)).toBe(f.lineageId)
    expect(await f.guard.bindTask(next, scope.workspaceId)).toBe(f.lineageId)
    expect(f.guard.forTask('T-2')).toMatchObject({ taskIds: ['T-1', 'T-2'], historyCount: 1, activations: 2 })
    expect(await f.observe({ evidence: 'same' }, { taskId: 'T-2' })).toMatchObject({ status: 'stalled', historyCount: 1, activations: 3 })
    expect(f.guard.forTask('T-1')).toEqual(f.guard.forTask('T-2'))
  })

  it('declared 不同任务不会因相同文本或来源引用误合，新的真实宿主请求也独立', async () => {
    const store = await createStore(), guard = createProgressGuard(store, () => 1000, scope)
    const first = task({ intentSource: 'declared' }), second = task({ taskId: 'T-2', intentSource: 'declared' })
    const a = await guard.bindTask(first, scope.workspaceId), b = await guard.bindTask(second, scope.workspaceId)
    expect(a).not.toBe(b)
    for (let index = 0; index < 3; index++) await guard.observe({ lineageId: a, taskId: 'T-1', action: 'delegate', projection: { evidence: 'same' } })
    expect(await guard.observe({ lineageId: b, taskId: 'T-2', action: 'delegate', projection: { evidence: 'same' } })).toMatchObject({ status: 'active', historyCount: 1, activations: 1 })
    const host = task({ taskId: 'T-3', intentSourceRef: 'different-real-message' })
    expect(await guard.bindTask(host, scope.workspaceId)).not.toBe(a)
    expect(guard.forTask('T-1')?.status).toBe('stalled')
  })
})

describe('分页、重启与提交失败', () => {
  it.each([false, true])('65 条历史按 32/32/1 分页，durable=%s 重建索引仍识别最早条目', async durable => {
    const f = await fixture({ durable })
    for (let index = 0; index < 65; index++) await f.observe({ evidence: index })
    const pages = Object.values(f.store.read().progressHistory).sort((a, b) => a.page - b.page)
    expect(pages.map(page => page.items.length)).toEqual([32, 32, 1])
    expect(pages.every(ValidateProgressPage)).toBe(true)
    const sequence = f.store.getSequence()
    let restoredStore = f.store
    if (durable) {
      await f.store.dispose()
      restoredStore = await createStore({ durable: true, directory: f.store.directory })
      expect(restoredStore.getSequence()).toBe(sequence)
    }
    const restored = createProgressGuard(restoredStore, () => 2000, scope)
    expect(restored.forTask('T-1')).toMatchObject({ historyCount: 65, activations: 65 })
    const observation = { lineageId: f.lineageId, taskId: 'T-1', action: 'delegate' as const, projection: { evidence: 0 } }
    expect(await restored.observe(observation)).toMatchObject({ status: 'active', historyCount: 65, activations: 66 })
    expect(await restored.observe(observation)).toMatchObject({ status: 'stalled', historyCount: 65, activations: 67 })
    expect(entries(restoredStore)).toHaveLength(65)
  })

  it('真实存储校验在 build 后拒绝提交，失败条目不会污染内存索引', async () => {
    let reject = false
    const f = await fixture({ validate: raw => !reject && validate(raw) })
    await f.observe({ evidence: 'A' })
    const state = f.store.read(), sequence = f.store.getSequence(), checksum = f.store.getRootChecksum()
    reject = true
    await expect(f.observe({ evidence: 'B' })).rejects.toMatchObject({ code: 'STATE_INVALID' })
    expect(f.store.read()).toEqual(state)
    expect(f.store.getSequence()).toBe(sequence)
    expect(f.store.getRootChecksum()).toBe(checksum)
    reject = false
    expect(await f.observe({ evidence: 'B' })).toMatchObject({ status: 'active', historyCount: 2, activations: 2 })
    expect(entries(f.store).find(item => item.canonical === getCanonicalJson({ evidence: 'B' }))?.hits).toBe(1)
  })

  it('真实 journal I/O 失败保持已提交状态，重开后 B 仍是首次新证据', async () => {
    const f = await fixture({ durable: true })
    await f.observe({ evidence: 'A' })
    const journal = join(f.store.directory, 'journal.jsonl'), committed = await readFile(journal, 'utf8')
    const sequence = f.store.getSequence(), state = f.store.read()
    await rm(journal); await mkdir(journal)
    await expect(f.observe({ evidence: 'B' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(f.store.read()).toEqual(state)
    expect(f.store.getSequence()).toBe(sequence)
    await expect(f.observe({ evidence: 'B' })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    await f.store.dispose()
    await rm(journal, { recursive: true }); await writeFile(journal, committed, { mode: 0o600 })
    const reopened = await createStore({ durable: true, directory: f.store.directory })
    const restored = createProgressGuard(reopened, () => 2000, scope)
    expect(await restored.observe({ lineageId: f.lineageId, taskId: 'T-1', action: 'delegate', projection: { evidence: 'B' } })).toMatchObject({ status: 'active', historyCount: 2, activations: 2 })
    expect(entries(reopened).find(item => item.canonical === getCanonicalJson({ evidence: 'B' }))?.hits).toBe(1)
  })
})

describe('等待、有限容量与真实证据恢复', () => {
  it('同一在途工作等待不新增 sequence、activation、历史或恢复预算', async () => {
    const f = await fixture()
    await f.observe({ evidence: 'A' })
    const state = f.store.read(), sequence = f.store.getSequence()
    for (let index = 0; index < 5; index++) await f.observe({ evidence: 'ignored while waiting' }, { waiting: true, replan: true, recoveryEvent: `not-a-new-dispatch-${index}` })
    expect(f.store.read()).toEqual(state)
    expect(f.store.getSequence()).toBe(sequence)
    const unknown = 'f'.repeat(64)
    await f.guard.observe({ lineageId: unknown, action: 'root-round', projection: {}, waiting: true })
    expect(f.guard.get(unknown)).toBeUndefined()
    expect(f.store.getSequence()).toBe(sequence)
  })

  it('1024 条全历史容量用尽后 exhausted，真实新事实或新恢复事件也不能自动清历史复活', async () => {
    const current = task(), lineageId = getValueDigest({ rootSessionId: current.sessionId, workspaceId: scope.workspaceId, userSource: current.intentSourceRef })
    const initial = empty()
    initial.runtimeControls[lineageId] = { lineageId, ...scope, taskIds: [current.taskId], policyVersion: RUNTIME_POLICY_VERSION, status: 'active', historyCount: 1024, activations: 1024, recoveries: 0, replans: 0, legacyBaseline: false }
    for (let index = 0; index < 1024; index++) {
      const page = Math.floor(index / 32), key = `${lineageId}:${page}`, projection = { evidence: index }
      initial.progressHistory[key] ??= { lineageId, page, items: [] }
      initial.progressHistory[key]!.items.push({ fingerprint: getValueDigest({ action: 'delegate', projection }), canonical: getCanonicalJson(projection), action: 'delegate', hits: 1, at: 1000 })
    }
    const store = await createStore({ initialState: initial }), guard = createProgressGuard(store, () => 2000, scope)
    expect(await guard.observe({ lineageId, taskId: 'T-1', action: 'delegate', projection: { evidence: 'new' } })).toMatchObject({ status: 'exhausted', historyCount: 1024, activations: 1024 })
    await guard.recordFact('T-1', 'b'.repeat(64), 'c'.repeat(64))
    expect(await guard.observe({ lineageId, taskId: 'T-1', action: 'delegate', projection: { evidence: 'newer' }, recoveryEvent: 'real-user-message-2' })).toMatchObject({ status: 'exhausted', historyCount: 1024, activations: 1024 })
    expect(entries(store)).toHaveLength(1024)
    expect(guard.forTask('T-1')?.recoveries).toBe(0)
  })

  it('状态余量不足时保留诊断空间并拒绝新激活，不能以恢复事件绕过字节容量', async () => {
    const f = await fixture({ maxStateBytes: 32768 })
    expect(await f.observe({ evidence: 'new' })).toMatchObject({ status: 'exhausted', historyCount: 0, activations: 0 })
    expect(await f.observe({ evidence: 'new' }, { recoveryEvent: 'real-user-message-2' })).toMatchObject({ status: 'exhausted', historyCount: 0, activations: 0 })
    expect(entries(f.store)).toEqual([])
    expect(f.store.getStateBytes()).toBeLessThan(f.store.maxStateBytes)
  })

  it('recordFact 相同内容不恢复；真实内容变化恢复 stalled，保留全部旧签名', async () => {
    const f = await fixture(), locator = 'b'.repeat(64), before = 'c'.repeat(64), after = 'd'.repeat(64)
    await f.guard.recordFact('T-1', locator, before)
    for (let index = 0; index < 3; index++) await f.observe({ evidence: 'A' })
    expect(f.guard.forTask('T-1')?.status).toBe('stalled')
    const sequence = f.store.getSequence(), history = f.store.read().progressHistory
    await f.guard.recordFact('T-1', locator, before)
    expect(f.store.getSequence()).toBe(sequence)
    expect(f.guard.forTask('T-1')?.status).toBe('stalled')
    await f.guard.recordFact('T-1', locator, after)
    expect(f.guard.forTask('T-1')).toMatchObject({ status: 'active', recoveries: 1, historyCount: 1, activations: 3, observedFacts: { [locator]: after } })
    expect(f.store.read().progressHistory).toEqual(history)
    expect(await f.observe({ evidence: 'A', observedContent: after })).toMatchObject({ status: 'active', historyCount: 2, activations: 4 })
    expect(await f.observe({ evidence: 'A' })).toMatchObject({ status: 'stalled', historyCount: 2, activations: 5 })
  })

  it('同一个恢复事件不能反复补充预算，第五个恢复窗口变为不可自动恢复的 exhausted', async () => {
    const f = await fixture()
    await f.observe({ evidence: 0 })
    for (let index = 1; index <= 4; index++) {
      const event = `real-user-message-${index}`
      expect(await f.observe({ evidence: index }, { recoveryEvent: event })).toMatchObject({ status: 'active', recoveries: index, historyCount: index + 1 })
      await f.observe({ evidence: index }, { recoveryEvent: event })
      expect(f.guard.get(f.lineageId)?.recoveries).toBe(index)
    }
    expect(await f.observe({ evidence: 5 }, { recoveryEvent: 'real-user-message-5' })).toMatchObject({ status: 'exhausted', recoveries: 4, historyCount: 5 })
    await f.guard.recordFact('T-1', 'b'.repeat(64), 'c'.repeat(64))
    expect(f.guard.get(f.lineageId)?.status).toBe('exhausted')
    expect(entries(f.store)).toHaveLength(5)
  })

  it('自动重规划最多四次，第五次不创建激活或新历史，换事件不能重开预算', async () => {
    const f = await fixture()
    for (let index = 0; index < 4; index++) expect(await f.observe({ evidence: index }, { replan: true })).toMatchObject({ status: 'active', replans: index + 1 })
    expect(await f.observe({ evidence: 4 }, { replan: true })).toMatchObject({ status: 'exhausted', replans: 4, activations: 4, historyCount: 4 })
    expect(await f.observe({ evidence: 5 }, { recoveryEvent: 'new-host-message' })).toMatchObject({ status: 'exhausted', replans: 4, activations: 4, historyCount: 4 })
  })
})
