// 2.6.0 增量分片存储的独立对抗性验证：不依赖仓库自带用例，按恢复语义与日志不变量逐项攻击。
// 覆盖：随机差分（内存镜像 vs 分片日志回放）、幂等短路、超限/截断/篡改、布局指纹、
// 混合代际日志、并发互斥、legacy 快照与日志重叠的崩溃窗口、整段补丁的类型一致性。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve('.')
const { createDurableStateStore, canonicalStateJson, StateStoreError } = await import(pathToFileURL(join(root, 'lib/state-store.js')).href)
const { ChunkedState } = await import(pathToFileURL(join(root, 'lib/state-chunks.js')).href)

const SPECS = Object.freeze({
  tasks: { kind: 'list', keyOf: (value) => value.taskId },
  contexts: { kind: 'list', keyOf: (value) => value.ref },
  bindings: { kind: 'dict' }
})

const hashText = (text) => createHash('sha256').update(text).digest('hex')
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ' :: ' + detail}`)
}
const attempt = async (name, run) => {
  try {
    const detail = await run()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}
const tempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-adversarial-'))
  return directory
}
const initialState = () => ({ schemaVersion: 1, tasks: [], contexts: [], bindings: {}, notes: { seed: true } })
const open = (directory, overrides = {}) => createDurableStateStore({
  directory, segments: SPECS, initialState: initialState(), validate: () => true, ...overrides
})
/** 手工写出 2.5.2 形态的目录：快照为 sequence 0，日志为 v1 全量行（不依赖旧构建产物）。 */
const writeLegacyDirectory = async (directory, states) => {
  const empty = initialState()
  await writeFile(join(directory, 'snapshot.json'), canonicalStateJson({ schemaVersion: 1, sequence: 0, checksum: hashText(canonicalStateJson(empty)), state: empty }) + '\n')
  let previous = hashText(canonicalStateJson(empty))
  const lines = states.map((state, index) => {
    const payload = { schemaVersion: 1, sequence: index + 1, type: 'legacy/add', previousChecksum: previous, checksum: hashText(canonicalStateJson(state)), state }
    previous = payload.checksum
    return canonicalStateJson({ ...payload, entryChecksum: hashText(canonicalStateJson(payload)) })
  })
  await writeFile(join(directory, 'journal.jsonl'), lines.join('\n') + '\n')
  return lines.length
}

const assertInvariants = (store, label) => {
  const state = store.read()
  const encoded = Buffer.byteLength(canonicalStateJson(state), 'utf8')
  assert.equal(store.getStateBytes(), encoded, `${label}: stateBytes 与 canonical 编码不一致`)
  const expectedRoot = ChunkedState.fromState(state, SPECS, { verified: true }).rootChecksum()
  assert.equal(store.getRootChecksum(), expectedRoot, `${label}: 根哈希与内容不一致`)
}

const mulberry32 = (seed) => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed)
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
  return ((t ^ t >>> 14) >>> 0) / 4294967296
}

await attempt('随机差分：分片日志回放必须等于独立内存镜像', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  const random = mulberry32(20261016)
  // 独立镜像：只按补丁语义直接操作普通对象/数组，不复用被测实现。
  const mirror = initialState()
  let taskSeq = 0
  let contextSeq = 0
  const operations = 120
  for (let step = 0; step < operations; step++) {
    const choice = Math.floor(random() * 6)
    const patch = {}
    const before = canonicalStateJson(mirror)
    if (choice === 0) {
      const taskId = `T-${++taskSeq}`
      const task = { taskId, title: `t${taskSeq}`, delegationIds: [] }
      patch.set = { tasks: { [taskId]: task } }
      mirror.tasks.push(task)
    } else if (choice === 1 && mirror.tasks.length > 0) {
      const index = Math.floor(random() * mirror.tasks.length)
      const current = mirror.tasks[index]
      const next = { ...current, title: `${current.title}-v${step}` }
      patch.set = { tasks: { [current.taskId]: next } }
      mirror.tasks[index] = next
    } else if (choice === 2 && mirror.tasks.length > 0) {
      const index = Math.floor(random() * mirror.tasks.length)
      const [dropped] = mirror.tasks.splice(index, 1)
      patch.remove = { tasks: [dropped.taskId] }
    } else if (choice === 3 && mirror.tasks.length > 1) {
      const shuffled = [...mirror.tasks]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      mirror.tasks = shuffled
      patch.order = { tasks: shuffled.map((task) => task.taskId) }
    } else if (choice === 4) {
      const ref = `ctx-${++contextSeq}`
      const context = { ref, text: 'x'.repeat(Math.floor(random() * 64)) }
      patch.set = { contexts: { [ref]: context } }
      mirror.contexts.push(context)
    } else {
      const key = `k-${Math.floor(random() * 20)}`
      if (mirror.bindings[key] === undefined) {
        mirror.bindings[key] = { value: step }
        patch.set = { bindings: { [key]: { value: step } } }
      } else {
        delete mirror.bindings[key]
        patch.remove = { bindings: [key] }
      }
    }
    const result = await store.update(`random/${step}`, { patch })
    const expectedChanged = canonicalStateJson(mirror) !== before
    assert.equal(result.changed, expectedChanged, `step ${step}: changed=${result.changed}，镜像期望 ${expectedChanged}`)
    assert.deepStrictEqual(store.read(), mirror, `step ${step}: 内存状态与镜像不一致`)
    assertInvariants(store, `step ${step}`)
  }
  // 追加一条同规模的全量 v2 行作对照：增量行必须显著小于整份状态行。
  await store.commit('final/full', () => {})
  const expected = { state: store.read(), root: store.getRootChecksum(), bytes: store.getStateBytes(), sequence: store.getSequence() }
  await store.dispose()
  const reopened = await open(directory)
  assert.deepStrictEqual(reopened.read(), expected.state)
  assert.equal(reopened.getRootChecksum(), expected.root)
  assert.equal(reopened.getStateBytes(), expected.bytes)
  assert.equal(reopened.getSequence(), expected.sequence)
  await reopened.dispose()
  const lineBytes = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => Buffer.byteLength(line, 'utf8'))
  const fullLineBytes = lineBytes.at(-1)
  const maxIncremental = Math.max(...lineBytes.slice(0, -1))
  assert.ok(maxIncremental < fullLineBytes, `最大增量行 ${maxIncremental}B 不应达到全量行 ${fullLineBytes}B`)
  await rm(directory, { recursive: true, force: true })
  return `${operations} 步差分一致；最大增量行 ${maxIncremental}B < 全量行 ${fullLineBytes}B`
})

await attempt('幂等短路：逐字节相同的 set 不写日志、不消耗序列号', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'same' } } } } })
  const linesAfterFirst = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).length
  const first = { sequence: store.getSequence(), root: store.getRootChecksum(), bytes: store.getStateBytes() }
  const repeated = await store.update('task/add-again', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'same' } } } } })
  const linesAfterRepeat = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).length
  assert.deepStrictEqual(repeated, { sequence: first.sequence, changed: false })
  assert.equal(linesAfterRepeat, linesAfterFirst, '幂等提交不应追加日志行')
  assert.equal(store.getRootChecksum(), first.root)
  assert.equal(store.getStateBytes(), first.bytes)
  await store.dispose()
  await rm(directory, { recursive: true, force: true })
  return `序列号保持 ${first.sequence}`
})

await attempt('截断日志（无换行结尾）必须拒绝恢复', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'v' } } } } })
  await store.dispose()
  const raw = await readFile(join(directory, 'journal.jsonl'), 'utf8')
  await writeFile(join(directory, 'journal.jsonl'), raw.trimEnd())
  await assert.rejects(open(directory), (error) => error instanceof StateStoreError && error.code === 'RECOVERY_REQUIRED')
  await rm(directory, { recursive: true, force: true })
  return 'RECOVERY_REQUIRED'
})

await attempt('篡改链哈希或分片编码必须拒绝恢复', async () => {
  const scenarios = [
    ['previousChecksum', (line) => { line.previousChecksum = hashText('forged') }],
    ['checksum', (line) => { line.checksum = hashText('forged') }],
    ['chunk', (line) => { const tasks = line.changes.tasks; const key = Object.keys(tasks.set)[0]; tasks.set[key] = tasks.set[key].replace('v', 'w') }]
  ]
  const details = []
  for (const [name, mutate] of scenarios) {
    const directory = await tempDirectory()
    const store = await open(directory)
    await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'v' } } } } })
    await store.dispose()
    const lines = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
    mutate(lines[0])
    // entryChecksum 必须同步重算，否则拒绝原因退化为“行自校验失败”，无法证明链/分片校验生效。
    const { entryChecksum, ...payload } = lines[0]
    const forged = { ...payload, entryChecksum: hashText(canonicalStateJson(payload)) }
    await writeFile(join(directory, 'journal.jsonl'), canonicalStateJson(forged) + '\n')
    await assert.rejects(open(directory), (error) => error instanceof StateStoreError && error.code === 'RECOVERY_REQUIRED', `${name} 未被拒绝`)
    details.push(name)
    await rm(directory, { recursive: true, force: true })
  }
  return details.join(',')
})

await attempt('段布局指纹不匹配必须显式拒绝', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'v' } } } } })
  await store.dispose()
  await assert.rejects(
    createDurableStateStore({ directory, segments: {}, initialState: initialState(), validate: () => true }),
    (error) => error instanceof StateStoreError && error.code === 'RECOVERY_REQUIRED' && /chunk layout/.test(error.message)
  )
  await rm(directory, { recursive: true, force: true })
  return 'different chunk layout'
})

await attempt('v2 行之后出现新的 v1 全量行必须拒绝恢复', async () => {
  const directory = await tempDirectory()
  await writeLegacyDirectory(directory, [{ ...initialState(), tasks: [{ taskId: 'T-1', title: 'legacy', delegationIds: [] }] }])
  const store = await open(directory)
  await store.update('task/retitle', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'v2', delegationIds: [] } } } } })
  const finalState = store.read()
  await store.dispose()
  const lines = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const upgradeLine = lines.at(-1)
  assert.equal(upgradeLine.schemaVersion, 2, '前置条件：升级后第一条应是 v2 行')
  // 伪造“升级后仍按 2.5.2 规则写全量 v1 行”：序号紧随 v2 行，行自校验一致。
  const payload = { schemaVersion: 1, sequence: upgradeLine.sequence + 1, type: 'forged/legacy', previousChecksum: upgradeLine.checksum, checksum: hashText(canonicalStateJson(finalState)), state: finalState }
  await appendFile(join(directory, 'journal.jsonl'), canonicalStateJson({ ...payload, entryChecksum: hashText(canonicalStateJson(payload)) }) + '\n')
  await assert.rejects(open(directory), (error) => error instanceof StateStoreError && error.code === 'RECOVERY_REQUIRED' && /mixes legacy/.test(error.message))
  await rm(directory, { recursive: true, force: true })
  return 'Journal mixes legacy entries after upgraded entries'
})

await attempt('并发 update 必须串行且全部落盘', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  await Promise.all(Array.from({ length: 16 }, (_, index) => store.update(`parallel/${index}`, { patch: { set: { tasks: { [`T-${index}`]: { taskId: `T-${index}`, title: `p${index}` } } } } })))
  assert.equal(store.getSequence(), 16)
  for (let index = 0; index < 16; index++) assert.ok(store.read().tasks.some((task) => task.taskId === `T-${index}`), `T-${index} 丢失`)
  await store.dispose()
  const reopened = await open(directory)
  assert.equal(reopened.getSequence(), 16)
  assert.equal(reopened.read().tasks.length, 16)
  await reopened.dispose()
  await rm(directory, { recursive: true, force: true })
  return '16/16 落盘'
})

await attempt('build 形式收到的基线必须冻结（改不动已提交状态）', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'v' } } } } })
  await assert.rejects(store.update('task/mutate', { build: (state) => {
    state.tasks[0].title = 'hacked'
    return {}
  } }), (error) => error instanceof TypeError)
  assert.equal(store.read().tasks[0].title, 'v')
  await store.dispose()
  await rm(directory, { recursive: true, force: true })
  return 'TypeError + 状态未变'
})

await attempt('journal 超限时先写快照再清空，恢复仍一致', async () => {
  const directory = await tempDirectory()
  const store = await open(directory, { maxJournalBytes: 4096, snapshotEvery: 4096 })
  const payload = 'y'.repeat(2048)
  for (let index = 0; index < 6; index++) {
    await store.update(`context/add/${index}`, { patch: { set: { contexts: { [`ctx-${index}`]: { ref: `ctx-${index}`, text: payload } } } } })
  }
  const expected = { state: store.read(), sequence: store.getSequence(), root: store.getRootChecksum() }
  await store.dispose()
  const reopened = await open(directory)
  assert.deepStrictEqual(reopened.read(), expected.state)
  assert.equal(reopened.getSequence(), expected.sequence)
  assert.equal(reopened.getRootChecksum(), expected.root)
  await reopened.dispose()
  await rm(directory, { recursive: true, force: true })
  return `sequence=${expected.sequence}`
})

await attempt('legacy 崩溃窗口：快照已写、日志未清空、行号与快照重叠时必须可恢复', async () => {
  const directory = await tempDirectory()
  const one = { ...initialState(), tasks: [{ taskId: 'T-1', title: 'one', delegationIds: [] }] }
  const two = { ...initialState(), tasks: [...one.tasks, { taskId: 'T-2', title: 'two', delegationIds: [] }] }
  assert.equal(await writeLegacyDirectory(directory, [one, two]), 2, '前置条件：日志应保留 2 条 v1 行')
  // 模拟 2.5.2 压缩在“快照已落盘、journal 清空未完成”之间崩溃留下的目录形态。
  await writeFile(join(directory, 'snapshot.json'), canonicalStateJson({ schemaVersion: 1, sequence: 2, checksum: hashText(canonicalStateJson(two)), state: two }) + '\n')
  const upgraded = await open(directory)
  assert.deepStrictEqual(upgraded.read(), two)
  await upgraded.update('task/retitle', { patch: { set: { tasks: { 'T-2': { taskId: 'T-2', title: 'two-v2', delegationIds: [] } } } } })
  await upgraded.dispose()
  const reopened = await open(directory)
  assert.equal(reopened.read().tasks[1].title, 'two-v2')
  await reopened.dispose()
  await rm(directory, { recursive: true, force: true })
  return '恢复到 seq=2 并续写 v2'
})

await attempt('声明的 list 段缺席时，whole 补丁必须显式拒绝而不是固化段类型', async () => {
  const directory = await tempDirectory()
  const store = await createDurableStateStore({ directory, segments: SPECS, initialState: { schemaVersion: 1 }, validate: () => true })
  await assert.rejects(store.update('seed/whole', { patch: { whole: { tasks: [{ taskId: 'T-1', title: 'seed' }] } } }),
    (error) => error instanceof StateStoreError && error.code === 'STATE_INVALID')
  // 拒绝后同一段仍按声明类型接受分片补丁。
  await store.update('task/add', { patch: { set: { tasks: { 'T-1': { taskId: 'T-1', title: 'chunked' } } } } })
  assert.equal(store.read().tasks[0].title, 'chunked')
  await store.dispose()
  const reopened = await createDurableStateStore({ directory, segments: SPECS, initialState: { schemaVersion: 1 }, validate: () => true })
  assert.equal(reopened.read().tasks[0].title, 'chunked')
  await reopened.dispose()
  await rm(directory, { recursive: true, force: true })
  return 'STATE_INVALID 后段类型保持 list'
})

await attempt('补丁中的 undefined 值必须以 STATE_INVALID 拒绝且不落盘', async () => {
  const directory = await tempDirectory()
  const store = await open(directory)
  const before = { sequence: store.getSequence(), lines: (await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).length }
  const codes = []
  for (const patch of [{ set: { tasks: { 'T-x': undefined } } }, { whole: { tasks: undefined } }]) {
    try {
      await store.update('task/undefined', { patch })
      codes.push('none')
    } catch (error) {
      codes.push(error instanceof StateStoreError ? error.code : error?.constructor?.name ?? String(error))
    }
  }
  assert.deepStrictEqual(codes, ['STATE_INVALID', 'STATE_INVALID'])
  assert.equal(store.getSequence(), before.sequence)
  assert.equal((await readFile(join(directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean).length, before.lines)
  await store.dispose()
  await rm(directory, { recursive: true, force: true })
  return `拒绝码=${codes.join(',')}`
})

const failed = results.filter((item) => !item.ok)
console.log(`\nsummary: ${results.length - failed.length}/${results.length} passed`)
const outputPath = process.argv[2]
if (outputPath !== undefined) {
  const digests = {}
  for (const name of ['state-store.js', 'state-chunks.js', 'state-core.js']) {
    digests[name] = hashText(await readFile(join(root, 'lib', name), 'utf8'))
  }
  await writeFile(outputPath, JSON.stringify({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    node: process.version,
    target: 'lib/state-store.js + lib/state-chunks.js (built from src)',
    moduleDigests: digests,
    script: 'scripts/verify-incremental-adversarial.mjs',
    summary: { total: results.length, passed: results.length - failed.length },
    results
  }, null, 2) + '\n')
}
if (failed.length > 0) {
  console.log(failed.map((item) => `- ${item.name}: ${item.detail}`).join('\n'))
  process.exitCode = 1
}
