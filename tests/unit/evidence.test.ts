import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ValidateTransition,
  getLedgerEvents,
  getLedgerPath,
  getRedactedValue,
  intLedger,
  intTaskStore,
  type DelegationRecord,
  type TaskRecord
} from '../../src/evidence.js'
import { ValidateTaskCard, type TaskCard } from '../../src/policy.js'

const card = ValidateTaskCard({ title: 't', goal: 'g', acceptance: ['a'] }).card as TaskCard

const makeTask = (taskId = 'T-1'): TaskRecord => ({
  taskId, sessionId: 's', card, gates: [], triage: { source: 'rules', rulesApplied: [] },
  delegationIds: [], rounds: 0, createdAt: 1, updatedAt: 1
})

const makeDelegation = (delegationId = 'D-1'): DelegationRecord => ({
  delegationId, taskId: 'T-1', role: 'fu_he', roleName: '复核', status: 'queued', summary: '', evidence: [],
  attempts: [], independence: 'n/a', hardIsolation: true, unresolved: [], startedAt: 1
})

describe('状态机', () => {
  it('只允许合法迁移，终态不可再变', () => {
    expect(ValidateTransition('queued', 'running')).toBe(true)
    expect(ValidateTransition('queued', 'blocked')).toBe(true)
    expect(ValidateTransition('running', 'completed')).toBe(true)
    expect(ValidateTransition('completed', 'running')).toBe(false)
    expect(ValidateTransition('failed', 'completed')).toBe(false)
  })
})

describe('intTaskStore', () => {
  it('任务与委派的增改查，记录不可变更新', () => {
    const store = intTaskStore()
    store.AddTask(makeTask())
    const before = store.getTask('T-1')
    store.UpdateTask('T-1', { rounds: 1 })
    expect(before?.rounds).toBe(0)
    expect(store.getTask('T-1')?.rounds).toBe(1)
    store.AddDelegation(makeDelegation())
    expect(store.getTask('T-1')?.delegationIds).toEqual(['D-1'])
    const running = store.UpdateDelegation('D-1', { status: 'running' })
    expect(running.status).toBe('running')
    store.UpdateDelegation('D-1', { status: 'completed', summary: 'ok' })
    expect(store.getTaskDelegations('T-1').map((d) => d.summary)).toEqual(['ok'])
    expect(store.getTasks()).toHaveLength(1)
    expect(store.getDelegation('nope')).toBeUndefined()
  })

  it('非法迁移与未知对象抛错', () => {
    const store = intTaskStore()
    store.AddTask(makeTask())
    store.AddDelegation(makeDelegation())
    store.UpdateDelegation('D-1', { status: 'blocked' })
    expect(() => store.UpdateDelegation('D-1', { status: 'running' })).toThrow('不允许')
    expect(() => store.UpdateDelegation('D-x', { summary: '' })).toThrow('未知委派')
    expect(() => store.UpdateTask('T-x', { rounds: 1 })).toThrow('未知任务')
    expect(() => store.AddDelegation({ ...makeDelegation('D-2'), taskId: 'T-x' })).toThrow('未知任务')
  })
  it('rejects duplicate identities and cross-task migration without corrupting either index', () => {
    const store = intTaskStore()
    store.AddTask(makeTask()); store.AddTask(makeTask('T-2'))
    store.AddDelegation(makeDelegation())
    const before = store.getTask('T-1')
    expect(() => store.AddTask(makeTask())).toThrow('重复任务')
    expect(() => store.AddDelegation({ ...makeDelegation(), taskId: 'T-2' })).toThrow('重复委派')
    expect(() => store.UpdateDelegation('D-1', { taskId: 'T-2' })).toThrow('不能')
    expect(() => store.UpdateDelegation('D-1', { delegationId: 'D-new' })).toThrow('不能')
    expect(() => store.UpdateTask('T-1', { taskId: 'T-new' })).toThrow('不能')
    expect(() => store.UpdateTask('T-1', { delegationIds: [] })).toThrow('原子')
    expect(store.getTask('T-1')).toBe(before)
    expect(store.getTaskDelegations('T-1')).toEqual([makeDelegation()])
    expect(store.getTaskDelegations('T-2')).toEqual([])
    expect(store.getDelegation('D-1')?.taskId).toBe('T-1')
  })
  it('does not publish an orphan if preparing the owning task fails', () => {
    const store = intTaskStore()
    const task = makeTask()
    store.AddTask(task)
    Object.defineProperty(task, 'delegationIds', { get: () => { throw new Error('cannot read association') } })
    expect(() => store.AddDelegation(makeDelegation())).toThrow('cannot read association')
    expect(store.getDelegation('D-1')).toBeUndefined()
  })
})

describe('账本', () => {
  const dirs: string[] = []
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

  it('脱敏后追加 JSONL，可读回；坏行被跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swarm-ledger-'))
    dirs.push(dir)
    const ledger = intLedger(join(dir, 'nested'), 'session:1/x')
    expect(ledger.path).toBe(getLedgerPath(join(dir, 'nested'), 'session:1/x'))
    expect(ledger.path.endsWith('session_1_x.jsonl')).toBe(true)
    ledger.AddLedgerEvent({ type: 'task/card', taskId: 'T-1', data: { note: 'Bearer abc.def', list: ['sk-abcdefghijk'] } })
    ledger.AddLedgerEvent({ type: 'delegation/queued', taskId: 'T-1', delegationId: 'D-1', data: {} })
    writeFileSync(ledger.path, `${readFileSync(ledger.path, 'utf8')}not-json\n`)
    const events = getLedgerEvents(ledger.path)
    expect(events.map((e) => e.type)).toEqual(['task/card', 'delegation/queued'])
    expect(JSON.stringify(events[0])).not.toContain('abc.def')
    expect(events[0]?.sessionId).toBe('session:1/x')
    expect(getLedgerEvents(join(dir, 'missing.jsonl'))).toEqual([])
  })

  it('写入失败时调用 onError 而不抛出', () => {
    const errors: unknown[] = []
    const base = mkdtempSync(join(tmpdir(), 'swarm-ledger-'))
    dirs.push(base)
    const file = join(base, 'file')
    writeFileSync(file, 'x')
    const ledger = intLedger(join(file, 'sub'), 's', (error) => errors.push(error))
    ledger.AddLedgerEvent({ type: 'jev/call', data: {} })
    expect(errors).toHaveLength(1)
  })

  it('getRedactedValue 深度处理并截断长字符串', () => {
    const value = getRedactedValue({ a: ['token=abc'], b: { c: 'x'.repeat(3000) }, n: 1 }) as { a: string[]; b: { c: string }; n: number }
    expect(value.a[0]).toContain('[已脱敏]')
    expect(value.b.c.length).toBeLessThanOrEqual(2000)
    expect(value.n).toBe(1)
  })
})
