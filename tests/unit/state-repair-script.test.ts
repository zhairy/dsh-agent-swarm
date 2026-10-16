import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { SWARM_LAYOUT_OPTIONS } from '../../src/state-chunks.js'

const execFileAsync = promisify(execFile)
const directories: string[] = []
const stores: DurableStateStore<Record<string, unknown>>[] = []
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'swarm-repair-')); directories.push(path); return path }
const track = <T extends Record<string, unknown>>(store: DurableStateStore<T & Record<string, unknown>>) => { stores.push(store as DurableStateStore<Record<string, unknown>>); return store }
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose().catch(() => undefined)))
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// 修复命令走构建产物；没有构建时跳过（CI 会在 build 之后再跑测试的流程里覆盖）。
const hasBuild = existsSync(join(process.cwd(), 'lib', 'state-store.js'))

/** 最小合法 FeatureState：修复后必须能过完整校验，因此 fixture 本身要满足契约。 */
const emptyState = () => ({
  schemaVersion: 1, tasks: [] as unknown[], delegations: [] as unknown[], threads: [], contexts: [],
  budgets: {}, bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {}
})
const task = () => ({
  taskId: 'T-1', sessionId: 'root', workspaceId: 'ws',
  card: { title: 'repair fixture', goal: 'repair orphan delegations', acceptance: ['index matches records'], scope: [], flags: {} },
  gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: [] as string[],
  rounds: 0, createdAt: 0, updatedAt: 0, cardRevision: 1, workflowRevision: 1, requestRevision: 1
})
const delegation = (delegationId: string, taskId: string) => ({
  delegationId, taskId, role: 'tan_wei', status: 'failed', summary: '', unresolved: [], evidence: [],
  startedAt: 0, cardRevision: 1, workflowRevision: 1, requestRevision: 1
})
const runRepair = async (target: string, extra: string[] = []) => {
  try {
    const { stdout } = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'repair-state.mjs'), target, ...extra])
    return JSON.parse(stdout) as Record<string, unknown>
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    let parsed: Record<string, unknown> | undefined
    try { parsed = JSON.parse(failure.stdout ?? '') as Record<string, unknown> } catch { parsed = undefined }
    return { ...(parsed ?? { stdout: failure.stdout ?? '' }), stderr: failure.stderr ?? '', processCode: failure.code }
  }
}

const seedBrokenState = async () => {
  const path = await directory()
  const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: emptyState(), validate: () => true }))
  await store.commit('fixture/broken', (draft) => {
    draft.tasks = [{ ...task(), delegationIds: ['D-1', 'D-2'] }]
    draft.delegations = [delegation('D-1', 'T-1'), delegation('D-2', 'T-9')]
  })
  await store.dispose()
  stores.splice(stores.findIndex((candidate) => candidate.directory === path), 1)
  return path
}

describe('state repair command', () => {
  it.skipIf(!hasBuild)('removes orphan delegations and rebuilds the task index', async () => {
    const path = await seedBrokenState()
    const dry = await runRepair(path, ['--dry-run'])
    expect(dry).toMatchObject({ result: 'would-repair', orphanDelegations: ['D-2'] })
    // dry-run 不写入：状态仍然是损坏的那一份。
    const untouched = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: { schemaVersion: 1 }, validate: () => true }))
    expect((untouched.read().delegations as unknown[]).length).toBe(2)
    await untouched.dispose()
    stores.splice(stores.findIndex((candidate) => candidate.directory === path), 1)

    const repaired = await runRepair(path)
    expect(repaired).toMatchObject({ result: 'repaired', orphanDelegations: ['D-2'] })
    const reopened = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: { schemaVersion: 1 }, validate: () => true }))
    expect((reopened.read().delegations as Array<{ delegationId: string; taskId: string }>).map((record) => [record.delegationId, record.taskId])).toEqual([['D-1', 'T-1']])
    expect((reopened.read().tasks as Array<{ delegationIds: string[] }>)[0]!.delegationIds).toEqual(['D-1'])
  })

  it.skipIf(!hasBuild)('reports nothing to repair on a consistent state', async () => {
    const path = await directory()
    const store = track(await createDurableStateStore({ directory: path, ...SWARM_LAYOUT_OPTIONS, initialState: emptyState(), validate: () => true }))
    await store.commit('fixture/clean', (draft) => {
      draft.tasks = [{ ...task(), delegationIds: ['D-1'] }]
      draft.delegations = [delegation('D-1', 'T-1')]
    })
    await store.dispose()
    stores.splice(stores.findIndex((candidate) => candidate.directory === path), 1)
    expect(await runRepair(path)).toMatchObject({ result: 'nothing-to-repair' })
  })

  it('refuses to run without a target directory', async () => {
    const failure = await execFileAsync(process.execPath, [join(process.cwd(), 'scripts', 'repair-state.mjs')]).catch((error: unknown) => error as { code?: number; stderr?: string })
    expect(failure).toMatchObject({ code: 2 })
  })

  it.skipIf(!hasBuild)('refuses an empty directory instead of initialising a fresh state', async () => {
    const empty = await directory()
    const result = await runRepair(empty)
    expect(result).toMatchObject({ processCode: 2 })
    expect(String((result as { stderr?: string }).stderr)).toContain('没有可修复的状态快照')
    // 目录里不应出现 owner/snapshot 等新建文件。
    expect(existsSync(join(empty, 'owner.json'))).toBe(false)
    expect(existsSync(join(empty, 'snapshot'))).toBe(false)
  })
})
