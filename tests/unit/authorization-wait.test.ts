import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDurableStateStore, type DurableStateStore } from '../../src/state-store.js'
import { createAuthorizationRepository, getAuthorizationQuestions, isAuthorizationApplicable, isAuthorizationWaiting, reduceAuthorizationDecision, ValidateAuthorizationDecision,
  type AuthorizationBinding, type AuthorizationState, type ConsumeAuthorizationAnswer, type PrepareAuthorizationInput } from '../../src/authorization-wait.js'

interface State extends AuthorizationState { schemaVersion: 2 }
const binding: AuthorizationBinding = { rootSessionId: 'root', workspaceId: 'workspace', taskId: 'T-1', lineageId: 'goal-1', requestRevision: 2, cardRevision: 3, workflowRevision: 4, nodeId: 'write-node' }
const input: PrepareAuthorizationInput = { binding, operationDigest: 'a'.repeat(64), scopeDigest: 'b'.repeat(64), requiresUserDecision: true,
  questions: [{ id: 'operation', question: '允许修改指定的维护文件吗？', options: [{ label: '允许此范围' }, { label: '拒绝' }, { label: '仅只读' }] }],
  approvalRules: [{ questionId: 'operation', approveLabels: ['允许此范围'], declineLabels: ['拒绝'] }] }
const createStore = (directory = '/unused', enabled = false): Promise<DurableStateStore<State>> => createDurableStateStore<State>({ directory, enabled,
  initialState: { schemaVersion: 2 }, segments: { authorizationDecisions: { kind: 'dict' } } })
const fixture = async (options: Parameters<typeof createAuthorizationRepository<State>>[1] = {}) => {
  const store = await createStore(), repo = createAuthorizationRepository(store, { now: () => 1000, ...options })
  const prepared = await repo.prepare(input)
  const waiting = await repo.dispatchKnown(prepared.decision.id, { callId: 'call-1', questionDigest: prepared.decision.questionDigest })
  const answer = (selected = ['允许此范围'], custom?: string): ConsumeAuthorizationAnswer => ({ callId: 'call-1',
    answers: [{ id: 'operation', selected, ...(custom === undefined ? {} : { custom }) }], origin: { kind: 'tool-result', callId: 'call-1' },
    binding: { ...binding, requestRevision: 3 }, operationDigest: input.operationDigest, scopeDigest: input.scopeDigest })
  return { store, repo, prepared, waiting, answer }
}

describe('持久授权决定与纯状态机', () => {
  it('并发登记同一操作只创建一次，换revision或随机问题ID不重置等待', async () => {
    const store = await createStore(), repo = createAuthorizationRepository(store)
    const values = await Promise.all(Array.from({ length: 8 }, (_, index) => repo.prepare({ ...input, binding: { ...binding, requestRevision: 2 + index } })))
    expect(new Set(values.map(value => value.decision.id)).size).toBe(1)
    expect(values.filter(value => !value.reused)).toHaveLength(1)
    const repeated = await repo.prepare({ ...input, questions: [{ ...input.questions[0]!, id: 'random-id' }], approvalRules: [] })
    expect(repeated.reused).toBe(true)
    expect(repeated.decision.questions[0]?.id).toBe('operation')
    expect(repo.forTask('T-1', 'root')).toHaveLength(1)
    expect(repo.forTask('T-1', 'another-root')).toEqual([])
    await store.dispose()
  })
  it('派发未知保留原决定，真实call绑定不可换成重复提问', async () => {
    const f = await fixture()
    const unknown = await f.repo.dispatchUnknown(f.waiting.id, 'reply-receipt-lost')
    expect(unknown).toMatchObject({ phase: 'reconcile-required', hostCallId: 'call-1' })
    expect(isAuthorizationWaiting(unknown)).toBe(true)
    await expect(f.repo.dispatchKnown(unknown.id, { callId: 'new-question', questionDigest: unknown.questionDigest })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect((await f.repo.dispatchKnown(unknown.id, { callId: 'call-1', questionDigest: unknown.questionDigest })).phase).toBe('waiting')
    await expect(f.repo.dispatchKnown(unknown.id, { callId: 'call-1', questionDigest: 'c'.repeat(64) })).rejects.toThrow('问题合同')
    await f.store.dispose()
  })
  it('真实答案随requestRevision前进不自我过期，重复消费幂等但不扩展范围', async () => {
    const f = await fixture()
    const approved = await f.repo.consumeAnswer(f.waiting.id, f.answer())
    expect(approved).toMatchObject({ phase: 'approved', questionBinding: { requestRevision: 2 }, appliesToBinding: { requestRevision: 3 } })
    expect(isAuthorizationApplicable(approved, { ...binding, requestRevision: 3 }, input.operationDigest, input.scopeDigest)).toBe(true)
    expect(isAuthorizationApplicable(approved, binding, input.operationDigest, input.scopeDigest)).toBe(false)
    expect(isAuthorizationApplicable(approved, { ...binding, requestRevision: 3 }, input.operationDigest, 'c'.repeat(64))).toBe(false)
    const sequence = f.store.getSequence()
    expect(await f.repo.consumeAnswer(f.waiting.id, f.answer())).toEqual(approved)
    expect(f.store.getSequence()).toBe(sequence)
    await expect(f.repo.consumeAnswer(f.waiting.id, f.answer(['拒绝']))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
    await f.store.dispose()
  })
  it('没有服务器审批规则时普通偏好答复只结束等待，不授予额外工具许可', async () => {
    const store = await createStore(), repo = createAuthorizationRepository(store)
    const prepared = (await repo.prepare({ ...input, approvalRules: [] })).decision
    await repo.dispatchKnown(prepared.id, { callId: 'call-1', questionDigest: prepared.questionDigest })
    const answer: ConsumeAuthorizationAnswer = { callId: 'call-1', answers: [{ id: 'operation', selected: ['允许此范围'] }], origin: { kind: 'tool-result', callId: 'call-1' }, binding,
      operationDigest: input.operationDigest, scopeDigest: input.scopeDigest }
    const result = await repo.consumeAnswer(prepared.id, answer)
    expect(result.phase).toBe('answered')
    expect(isAuthorizationWaiting(result)).toBe(false)
    expect(isAuthorizationApplicable(result, binding, input.operationDigest, input.scopeDigest)).toBe(false)
    await store.dispose()
  })
  it('拒绝、跳过、只读、自定义答案不批准，记录中不包含问题正文或自由文本', async () => {
    for (const [selected, custom, phase] of [
      [['拒绝'], undefined, 'declined'], [[], undefined, 'answered'], [['仅只读'], undefined, 'answered'],
      [[], 'sensitive-custom-body', 'answered'], [['允许此范围'], '但范围需要另行确认', 'answered']
    ] as const) {
      const f = await fixture()
      const result = await f.repo.consumeAnswer(f.waiting.id, f.answer([...selected], custom))
      expect(result.phase).toBe(phase)
      expect(ValidateAuthorizationDecision(result)).toBe(true)
      expect(JSON.stringify(f.store.read())).not.toContain('sensitive-custom-body')
      expect(JSON.stringify(result)).not.toContain(input.questions[0]!.question)
      expect(JSON.stringify(result)).not.toContain('允许此范围')
      await f.store.dispose()
    }
  })
  it('无应答者不批准，取消或失效后迟到答案不能复活动作', async () => {
    const f = await fixture()
    const unavailable = await f.repo.unavailable(f.waiting.id, 'host-answer-channel-unavailable')
    expect(unavailable.phase).toBe('unavailable')
    expect(isAuthorizationWaiting(unavailable)).toBe(true)
    const cancelled = await f.repo.cancel(f.waiting.id, 'user-cancelled')
    await expect(f.repo.consumeAnswer(f.waiting.id, f.answer())).rejects.toThrow('迟到答复')
    expect((await f.repo.dispatchUnknown(f.waiting.id, 'late-network-error')).phase).toBe('cancelled')
    expect((await f.repo.dispatchKnown(f.waiting.id, { callId: 'call-1', questionDigest: cancelled.questionDigest })).phase).toBe('cancelled')
    const invalidated = await f.repo.invalidate(f.waiting.id, 'operation-removed')
    expect(invalidated.phase).toBe('invalidated')
    expect(f.repo.get(f.waiting.id)?.phase).toBe('invalidated')
    await f.store.dispose()
  })
  it('错来源、跨根、旧需求、改范围、旧流程和非法选项都拒绝', async () => {
    const f = await fixture()
    for (const bad of [
      { ...f.answer(), origin: { kind: 'mcp-text', callId: 'call-1' } },
      { ...f.answer(), origin: { kind: 'tool-result', callId: 'wrong-call' } },
      { ...f.answer(), binding: { ...binding, rootSessionId: 'other' } },
      { ...f.answer(), binding: { ...binding, requestRevision: 1 } },
      { ...f.answer(), binding: { ...binding, workflowRevision: 5 } },
      { ...f.answer(), scopeDigest: 'c'.repeat(64) },
      { ...f.answer(), answers: [{ id: 'operation', selected: ['不存在'] }] },
      { ...f.answer(), answers: [{ id: 'operation', selected: ['允许此范围', '允许此范围'] }] },
      { ...f.answer(), answers: [{ id: 'wrong-question', selected: ['允许此范围'] }] }
    ]) await expect(f.repo.consumeAnswer(f.waiting.id, bad as ConsumeAuthorizationAnswer)).rejects.toBeInstanceOf(Error)
    expect(f.repo.get(f.waiting.id)?.phase).toBe('waiting')
    await f.store.dispose()
  })
  it('持久记录validator拒绝伪造approved、超量字段、主体错配和未记录的答复', async () => {
    const f = await fixture()
    expect(ValidateAuthorizationDecision({ ...f.waiting, phase: 'approved' })).toBe(false)
    expect(ValidateAuthorizationDecision({ ...f.waiting, customSecret: 'not-allowed' })).toBe(false)
    const approved = await f.repo.consumeAnswer(f.waiting.id, f.answer())
    expect(ValidateAuthorizationDecision({ ...approved, approvalRules: [] })).toBe(false)
    expect(ValidateAuthorizationDecision({ ...approved, appliesToBinding: { ...approved.appliesToBinding, rootSessionId: 'other-root' } })).toBe(false)
    await f.store.dispose()
  })
  it('容量满显式拒绝且不清旧记录，换lineage不能绕过单任务容量', async () => {
    const f = await fixture({ maxEntries: 2, maxPerTask: 1 })
    await expect(f.repo.prepare({ ...input, binding: { ...binding, lineageId: 'new-lineage' }, scopeDigest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
    await f.repo.prepare({ ...input, binding: { ...binding, taskId: 'T-2' } })
    await expect(f.repo.prepare({ ...input, binding: { ...binding, taskId: 'T-3' } })).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
    expect(f.repo.get(f.waiting.id)?.phase).toBe('waiting')
    await f.store.dispose()
  })
  it('提交失败不发布暂态许可或读取缓存', async () => {
    const store = await createStore()
    const broken: DurableStateStore<State> = { ...store, update: async (_type, write) => {
      if ('build' in write) await write.build(store.read())
      throw new Error('disk-write-failed')
    } }
    const repo = createAuthorizationRepository(broken, { id: () => 'auth-fixed' })
    expect(repo.forTask('T-1')).toEqual([])
    await expect(repo.prepare(input)).rejects.toThrow('disk-write-failed')
    expect(repo.get('auth-fixed')).toBeUndefined()
    expect(store.getSequence()).toBe(0)
    await store.dispose()
  })
  it('重启恢复等待和取消，读取副本不能修改事实', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swarm-auth-'))
    try {
      const first = await createStore(directory, true), a = createAuthorizationRepository(first)
      const prepared = (await a.prepare(input)).decision
      await a.dispatchKnown(prepared.id, { callId: 'call-1', questionDigest: prepared.questionDigest })
      await first.dispose()
      const second = await createStore(directory, true), b = createAuthorizationRepository(second)
      const recovered = b.get(prepared.id)!
      expect(recovered).toMatchObject({ phase: 'waiting', hostCallId: 'call-1' })
      recovered.phase = 'approved'
      expect(b.get(prepared.id)?.phase).toBe('waiting')
      await b.cancel(prepared.id, 'user-cancelled')
      await second.dispose()
      const third = await createStore(directory, true), c = createAuthorizationRepository(third)
      expect(c.get(prepared.id)?.phase).toBe('cancelled')
      await third.dispose()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('纯reducer对坏事件、坏格式和策略重叠保守拒绝', async () => {
    const f = await fixture()
    expect(() => reduceAuthorizationDecision(f.waiting, { type: 'cancel', reason: '' }, 1)).toThrow('原因')
    expect(() => reduceAuthorizationDecision({ ...f.waiting, phase: 'approved' }, { type: 'cancel', reason: 'stop' }, 1)).toThrow('记录')
    await expect(f.repo.prepare({ ...input, requiresUserDecision: false } as unknown as PrepareAuthorizationInput)).rejects.toThrow('实际缺少')
    await expect(f.repo.prepare({ ...input, approvalRules: [{ questionId: 'operation', approveLabels: ['允许此范围'], declineLabels: ['允许此范围'] }] })).rejects.toThrow('问题')
    expect(getAuthorizationQuestions([{ id: 'same', question: 'x' }, { id: 'same', question: 'y' }])).toBeUndefined()
    expect(getAuthorizationQuestions([{ id: 'q', question: 'x', multi_select: true, multiSelect: false }])).toBeUndefined()
    await f.store.dispose()
  })
})
