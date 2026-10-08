import { describe, expect, it } from 'vitest'
import {
  ParseSessionPlan,
  getRuleSessionPlan,
  getSessionQuestions,
  getSessionState,
  intChildEndHub,
  intThreadRegistry,
  type ThreadInfo
} from '../../src/threads.js'

const thread = (patch: Partial<ThreadInfo> = {}): ThreadInfo => ({
  threadId: 'th-1', key: 'zhu_jian', role: 'zhu_jian', rounds: 1, busy: false, closed: false, allowWeb: false, taskIds: ['T-1'],
  history: [{ delegationId: 'D-1', taskId: 'T-1', request: '实现登录', summary: '已实现', status: 'completed' }], createdAt: 1, lastUsedAt: 1, ...patch
})

const options = { repeatAbove: 0.5, sameCategoryAbove: 0.5 }

describe('会话方式：衡鉴判断', () => {
  it('有候选会话且同类时追加；不同类但还会再调用时新建；否则一次性', () => {
    expect(ParseSessionPlan({ repeat: { noul: 0.9 }, same_category: { noul: 0.8 } }, { ...options, thread: thread() }))
      .toMatchObject({ kind: 'continue', threadId: 'th-1', source: 'jev', sameCategory: 0.8 })
    expect(ParseSessionPlan({ repeat: { noul: 0.7 }, same_category: { noul: 0.2 } }, { ...options, thread: thread() }))
      .toMatchObject({ kind: 'new', repeat: 0.7, sameCategory: 0.2 })
    expect(ParseSessionPlan({ repeat: { noul: 0.3 } }, options)).toMatchObject({ kind: 'oneshot', repeat: 0.3 })
    expect(ParseSessionPlan({ repeat: { noul: 0.6 } }, options)).toMatchObject({ kind: 'new' })
    expect(ParseSessionPlan({ supported: { noul: 1 } }, options)).toBeUndefined()
  })

  it('有候选会话时才问是否同类；状态只含脱敏后的请求与最近几轮', () => {
    expect(Object.keys(getSessionQuestions(false))).toEqual(['repeat'])
    expect(Object.keys(getSessionQuestions(true))).toEqual(['repeat', 'same_category'])
    const state = getSessionState({ roleName: '铸剑', goal: 'g', request: '按审查意见修改 sk-abcdefghijklmn', thread: thread() })
    expect(state.new_request).not.toContain('sk-abcdefghijklmn')
    expect(state.existing_session).toEqual({ rounds: 1, recent: [{ request: '实现登录', summary: '已实现' }] })
    expect(getSessionState({ roleName: '算衡', mode: 'verify', goal: 'g', request: 'r' })).not.toHaveProperty('existing_session')
  })

  it('非法或缺失的概率不决定会话，阈值比较不提前舍入', () => {
    for (const noul of [-0.1, 1.1, NaN, Infinity]) {
      expect(ParseSessionPlan({ repeat: { noul } }, options)).toBeUndefined()
      expect(ParseSessionPlan({ repeat: { noul: 0.9 }, same_category: { noul } }, { ...options, thread: thread() })).toBeUndefined()
    }
    expect(ParseSessionPlan({ repeat: { noul: 0.9 } }, { ...options, thread: thread() })).toBeUndefined()
    expect(ParseSessionPlan({ repeat: { noul: 0.499 } }, options)).toMatchObject({ kind: 'oneshot', repeat: 0.499 })
    expect(ParseSessionPlan({ repeat: { noul: 0.9 }, same_category: { noul: 0.499 } }, { ...options, thread: thread() })).toMatchObject({ kind: 'new', sameCategory: 0.499 })
  })

  it('Jev 不可用时按规则：同一任务已有会话就追加；编辑、执行、验证、审查角色开连续会话；其余一次性', () => {
    expect(getRuleSessionPlan({ role: 'tan_wei', taskId: 'T-1', thread: thread({ role: 'tan_wei', key: 'tan_wei' }), reason: 'x' })).toMatchObject({ kind: 'continue', source: 'rules' })
    expect(getRuleSessionPlan({ role: 'zhu_jian', taskId: 'T-2', thread: thread(), reason: 'x' })).toMatchObject({ kind: 'new' })
    expect(getRuleSessionPlan({ role: 'bo_wen', taskId: 'T-1', reason: 'missing-api-key' })).toMatchObject({ kind: 'oneshot', reason: expect.stringContaining('missing-api-key') })
  })
})

describe('连续会话登记表', () => {
  it('候选只含同一路由键下空闲、未关闭的会话，最近使用的在前；记录一轮后释放', () => {
    const threads = intThreadRegistry()
    threads.Add(thread({ threadId: 'a', lastUsedAt: 1 }))
    threads.Add(thread({ threadId: 'b', lastUsedAt: 5 }))
    threads.Add(thread({ threadId: 'c', busy: true }))
    threads.Add(thread({ threadId: 'd', closed: true }))
    threads.Add(thread({ threadId: 'e', key: 'fu_he', role: 'fu_he' }))
    expect(threads.getCandidates('zhu_jian').map((t) => t.threadId)).toEqual(['b', 'a'])
    threads.Update('b', { busy: true })
    expect(threads.getCandidates('zhu_jian').map((t) => t.threadId)).toEqual(['a'])
    const after = threads.AddRound('b', { delegationId: 'D-9', taskId: 'T-2', request: 'r', summary: 's', status: 'failed' }, 99)
    expect(after).toMatchObject({ busy: false, rounds: 2, taskIds: ['T-1', 'T-2'], lastUsedAt: 99 })
    expect(threads.AddRound('zz', { delegationId: 'D', taskId: 'T', request: '', summary: '', status: 'completed' }, 1)).toBeUndefined()
    expect(threads.list()).toHaveLength(5)
  })
})

describe('结束事件', () => {
  it('先登记再触发；没有等待者的结束被忽略；取消时拒绝', async () => {
    const hub = intChildEndHub()
    hub.Emit({ id: 'x', stopReason: 'completed' })
    const first = hub.wait('x', new AbortController().signal)
    const second = hub.wait('x', new AbortController().signal)
    hub.Emit({ id: 'x', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '1' }] })
    hub.Emit({ id: 'x', stopReason: 'error' })
    await expect(first).resolves.toMatchObject({ stopReason: 'completed' })
    await expect(second).resolves.toMatchObject({ stopReason: 'error' })
    const controller = new AbortController()
    const cancelled = hub.wait('y', controller.signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow('aborted')
    hub.Emit({ id: 'y', stopReason: 'completed' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(hub.wait('z', aborted.signal)).rejects.toThrow('aborted')
  })

  it('消费记录按次取走', () => {
    const hub = intChildEndHub()
    expect(hub.TakeConsumed('x')).toBe(false)
    hub.MarkConsumed('x')
    hub.MarkConsumed('x')
    expect(hub.TakeConsumed('x')).toBe(true)
    expect(hub.TakeConsumed('x')).toBe(true)
    expect(hub.TakeConsumed('x')).toBe(false)
  })
})
