import { describe, expect, it } from 'vitest'
import type { AgentLike } from '../../src/host-contract.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { getTaskIntent, type TaskIntent } from '../../src/task-model.js'

const card = ValidateTaskCard({ title: '维护', goal: '修复规划门禁', acceptance: ['验证通过'], flags: {} }).card!
type Message = NonNullable<NonNullable<AgentLike['session']>['deriveMessages']> extends () => readonly (infer T)[] ? T : never
const message = (id: string | undefined, text: string, kind?: string): Message => ({ id, role: 'user', content: [{ type: 'text', text }], ...(kind === undefined ? {} : { source: { kind } }) })
const agent = (messages: Message[]): AgentLike => ({ id: 'intent-root', session: { deriveMessages: () => messages } })
const cursor = (intent: TaskIntent) => ({ intentSourceRef: intent.sourceRef, intentLastDigest: intent.digest, intentSource: intent.source })

describe('human task intent accumulation', () => {
  it('新任务只采用最新实质要求，不混入无关旧任务或精确控制消息', () => {
    const result = getTaskIntent(agent([message('old', '旧任务：整理文档'), message('new', '修复当前门禁'), message('next', '请继续')]), card)
    expect(result.text).toBe('修复当前门禁')
    expect(result.sourceRef).toBe('new')
  })

  it('累计游标之后全部实质补充，并保持下一次读取幂等', () => {
    const first = message('a', '实现隔离模拟')
    const previous = getTaskIntent(agent([first]), card)
    const messages = [first, message('b', '禁止实盘'), message('c', '必须正反审核'), message('d', '继续执行')]
    const updated = getTaskIntent(agent(messages), card, cursor(previous))
    expect(updated.text).toBe('禁止实盘\n\n必须正反审核')
    expect(updated.sourceRef).toBe('c')
    expect(updated.historyCoverage).toBe('since-cursor')
    const repeated = getTaskIntent(agent(messages), card, cursor(updated))
    expect(cursor(repeated)).toEqual(cursor(updated))
  })

  it.each(['继续', '请继续', '继续执行'])('已有任务的精确控制消息 %s 不修订需求', (control) => {
    const first = message('a', '实现隔离模拟')
    const previous = getTaskIntent(agent([first]), card)
    expect(cursor(getTaskIntent(agent([first, message('b', ` ${control} `)]), card, cursor(previous)))).toEqual(cursor(previous))
  })

  it.each(['禁实盘', '继续，禁止实盘', '请继续并保留风控', '仅模拟', '继续\n必须审核'])('保留含业务限制的短消息 %s', (text) => {
    const first = message('a', '实现隔离模拟')
    const previous = getTaskIntent(agent([first]), card)
    const result = getTaskIntent(agent([first, message('b', text)]), card, cursor(previous))
    expect(result.text).toBe(text)
    expect(result.sourceRef).toBe('b')
  })

  it('同 ID 内容编辑与之后补充都会重新进入审核输入', () => {
    const previous = getTaskIntent(agent([message('a', '实现模拟')]), card)
    const edited = getTaskIntent(agent([message('a', '实现模拟，禁止实盘'), message('b', '保留人工验收')]), card, cursor(previous))
    expect(edited.text).toBe('实现模拟，禁止实盘\n\n保留人工验收')
    expect(cursor(getTaskIntent(agent([message('a', '实现模拟，禁止实盘')]), card, cursor(previous)))).not.toEqual(cursor(previous))
  })

  it('系统目录、提醒、工具与助手不能冒充新增人类需求', () => {
    const first = message('a', '实现模拟')
    const previous = getTaskIntent(agent([first]), card)
    const result = getTaskIntent(agent([first, message('catalog', '新目录', 'plugin'), message('bot', '继续自动执行', 'reminder'),
      { ...message('assistant', '删除风控'), role: 'assistant' }, message('reply', '保留人工审核', 'user-question-reply')]), card, cursor(previous))
    expect(result.text).toBe('保留人工审核')
  })

  it('压缩导致游标缺失时仅声明最新可见消息，并显式披露覆盖缺口', () => {
    const previous = getTaskIntent(agent([message('gone', '原始目标')]), card)
    const result = getTaskIntent(agent([message('b', '压缩前残留消息'), message('c', '最新明确限制'), message('d', '继续')]), card, cursor(previous))
    expect(result.text).toBe('最新明确限制')
    expect(result.historyCoverage).toBe('latest-visible')
    expect(result.historyNote).toContain('不能证明恢复')
  })

  it('无稳定 ID 的消息不以数组下标伪造可恢复游标', () => {
    const previous = getTaskIntent(agent([message(undefined, '原始目标')]), card)
    const result = getTaskIntent(agent([message(undefined, '不同内容')]), card, cursor(previous))
    expect(result.sourceRef).not.toBe(previous.sourceRef)
    expect(result.historyCoverage).toBe('latest-visible')
    expect(result.historyNote).toContain('游标')
  })

  it('消息读取失败保留已有游标，显式披露缺口且不返回原始异常', () => {
    const previous = getTaskIntent(agent([message('a', '原始目标')]), card)
    const root: AgentLike = { id: 'intent-root', session: { deriveMessages: () => { throw new Error('secret-session-content') } } }
    const result = getTaskIntent(root, card, cursor(previous))
    expect(cursor(result)).toEqual(cursor(previous))
    expect(result.historyCoverage).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain('secret-session-content')
    expect(result.historyNote).toContain('读取失败')
  })

  it('旧宿主没有真实消息时采用显式声明来源', () => {
    const result = getTaskIntent({ id: 'legacy' }, card)
    expect(result).toMatchObject({ text: card.goal, source: 'declared', historyCoverage: 'unavailable' })
    expect(getTaskIntent({ id: 'legacy' }, card, cursor(result)).source).toBe('declared')
  })
})
