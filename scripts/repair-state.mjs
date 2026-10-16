#!/usr/bin/env node
// 状态修复命令：清理孤儿委派（所属任务已不存在）并重建任务上的委派索引。
//
// 增量提交路径不会「顺手清理」孤儿记录，而是在校验层显式拒绝（DELEGATION_OWNERSHIP_INDEX）。
// 这个离线命令是那条错误对应的出口：先修复结构、再按完整校验复核，通过后才写回。
//
// 用法: node scripts/repair-state.mjs <state-directory> [--dry-run]
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const directory = args.find((arg) => !arg.startsWith('--'))
if (directory === undefined) {
  console.error('用法: node scripts/repair-state.mjs <state-directory> [--dry-run]')
  process.exit(2)
}

const root = resolve(process.argv[1], '..', '..')
if (!existsSync(join(root, 'lib', 'state-store.js'))) {
  console.error('缺少构建产物 lib/：先运行 npm run build')
  process.exit(2)
}
const { createDurableStateStore } = await import(pathToFileURL(join(root, 'lib/state-store.js')).href)
const { SWARM_LAYOUT_OPTIONS } = await import(pathToFileURL(join(root, 'lib/state-chunks.js')).href)
const { validateFeatureState } = await import(pathToFileURL(join(root, 'lib/feature-session.js')).href)

// 目标目录必须已经是一份状态目录：空目录或新目录会被拒绝，避免顺手把它初始化成空状态。
const target = resolve(directory)
if (!existsSync(join(target, 'snapshot', 'meta.json')) && !existsSync(join(target, 'snapshot.json'))) {
  console.error(JSON.stringify({ directory: target, result: 'rejected', reason: '目标目录里没有可修复的状态快照' }, null, 2))
  process.exit(2)
}

// 修复工具必须能看到损坏状态，因此这里显式关闭业务校验；修复后的完整性由 validateFeatureState 复核。
const store = await createDurableStateStore({
  directory: target, ...SWARM_LAYOUT_OPTIONS, initialState: { schemaVersion: 1 }, validate: () => true
})

try {
  const state = store.read()
  const tasks = Array.isArray(state.tasks) ? state.tasks : []
  const delegations = Array.isArray(state.delegations) ? state.delegations : []
  const taskIds = new Set(tasks.map((task) => task.taskId))
  const ownedByTask = new Map()
  const orphanDelegations = []
  for (const record of delegations) {
    if (!taskIds.has(record.taskId)) { orphanDelegations.push(record.delegationId); continue }
    const list = ownedByTask.get(record.taskId) ?? []
    list.push(record.delegationId)
    ownedByTask.set(record.taskId, list)
  }
  const rebuiltIndexes = []
  for (const task of tasks) {
    const actual = ownedByTask.get(task.taskId) ?? []
    const current = Array.isArray(task.delegationIds) ? task.delegationIds : []
    if (current.length === actual.length && current.every((id, index) => id === actual[index])) continue
    rebuiltIndexes.push({ taskId: task.taskId, before: current.length, after: actual.length })
  }

  const report = { directory: target, orphanDelegations, rebuiltIndexes, dryRun }
  if (orphanDelegations.length === 0 && rebuiltIndexes.length === 0) {
    process.stdout.write(JSON.stringify({ ...report, result: 'nothing-to-repair' }, null, 2) + '\n')
  } else {
    // 先在内存里修好并过一遍完整校验；只有校验通过才写回，避免把状态改成另一种损坏。
    const candidate = structuredClone(state)
    candidate.delegations = delegations.filter((record) => taskIds.has(record.taskId))
    // tasks 本身损坏成非数组时不能直接迭代：交给下面的完整校验去拒绝，而不是抛未捕获异常。
    if (Array.isArray(candidate.tasks)) for (const task of candidate.tasks) task.delegationIds = ownedByTask.get(task.taskId) ?? []
    const firstTask = tasks[0]
    if (firstTask !== undefined && !validateFeatureState(candidate, { rootSessionId: firstTask.sessionId, workspaceId: firstTask.workspaceId ?? '' })) {
      process.stderr.write(JSON.stringify({ ...report, result: 'rejected', reason: '修复后仍未通过完整校验：请人工检查其它字段' }, null, 2) + '\n')
      process.exitCode = 1
    } else if (dryRun) {
      process.stdout.write(JSON.stringify({ ...report, result: 'would-repair' }, null, 2) + '\n')
    } else {
      await store.commit('repair/orphan-delegations', (draft) => {
        draft.delegations = (draft.delegations ?? []).filter((record) => taskIds.has(record.taskId))
        if (Array.isArray(draft.tasks)) for (const task of draft.tasks) task.delegationIds = ownedByTask.get(task.taskId) ?? []
      })
      const repaired = store.read()
      const ok = firstTask === undefined || validateFeatureState(repaired, { rootSessionId: firstTask.sessionId, workspaceId: firstTask.workspaceId ?? '' })
      process.stdout.write(JSON.stringify({ ...report, result: ok ? 'repaired' : 'repaired-but-invalid', sequence: store.getSequence() }, null, 2) + '\n')
      if (!ok) process.exitCode = 1
    }
  }
} finally {
  await store.dispose()
}
