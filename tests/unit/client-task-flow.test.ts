import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

interface ElementInfo { type: unknown; props: Record<string, unknown>; children: unknown[] }
const loadModule = () => {
  const source = readFileSync(join(__dirname, '../../client/task-flow.js'), 'utf8')
  const module = { exports: {} as any }
  const effects: Array<() => unknown> = []
  const React = {
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ElementInfo => ({ type, props: props ?? {}, children }),
    useState: (initial: unknown) => [initial, vi.fn()],
    useEffect: (effect: () => unknown) => effects.push(effect)
  }
  new Function('require', 'module', 'exports', source)((name: string) => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: 'MarkdownText' }
    throw new Error(`unexpected require ${name}`)
  }, module, module.exports)
  return { ...module.exports, effects }
}
const event = (seq = 1, text = 'task_id: T-1（任务卡已记录）\n```mermaid\nflowchart TD\n  n_a["分析"]\n```') => ({ type: 'tool/result', seq, data: { message: { content: [{ type: 'text', text }], isError: false } } })
const textOf = (element: any): string => typeof element === 'string' ? element : element === null || element === undefined ? '' : (element.children ?? []).map(textOf).join('')

afterEach(() => vi.unstubAllGlobals())
describe('真实任务流程客户端投影', () => {
  it('三维审核区分别显示模型意见和代码结论，缺项不显示通过', () => {
    const { getPlanningReviewView, PlanningReviewPanel } = loadModule().__test__
    const empty = getPlanningReviewView(undefined)
    expect(empty.goal.agent).toBe('unknown')
    expect(empty.mermaid.syntax).toBe('unknown')
    expect(textOf(PlanningReviewPanel({ review: undefined }))).toContain('未审核')
    const review = { status: 'review_required', goalReview: { verdict: 'pass' }, designReview: { verdict: 'changes_requested' }, mermaidReview: { parserVersion: '11.12.0', parseVerdict: 'pass', projectionVerdict: 'pass', semanticVerdict: 'pass' }, reviewPolicy: { reviewAbove: 0.8 }, jev: { status: 'ok', answers: { goal_alignment: { noul: 0.2 }, requirement_coverage: { noul: 0.95 }, acceptance_testability: { noul: 0.95 }, design_sufficiency: { noul: 0.9 }, execution_boundaries: { noul: 0.9 }, failure_bounds: { noul: 0.9 }, mermaid_expression: { noul: 0.95 } } }, agent: { result: { findings: [{ severity: 'high', requirementId: 'R1', nodeId: 'verification', issue: '缺少验证', evidence: '没有实际测试步骤', suggestion: '增加复核' }] } }, errors: ['目标仍需定向复核'] }
    const view = getPlanningReviewView(review)
    expect(view.goal.agent).toBe('pass')
    expect(view.goal.jev).toBe('review_required')
    expect(view.mermaid.syntax).toBe('pass')
    const text = textOf(PlanningReviewPanel({ review }))
    expect(text).toContain('独立 Agent')
    expect(text).toContain('Jev 判断')
    expect(text).toContain('R1 / verification')
    expect(text).toContain('缺少验证')
    expect(text).toContain('目标仍需定向复核')
    review.mermaidReview.parserVersion = 'not-run'
    expect(getPlanningReviewView(review).mermaid.syntax).toBe('unknown')
  })
  it('只从持久工具结果识别任务；同 taskId 更新而非追加重复图', () => {
    const { readTaskResult, taskFlowDefinition } = loadModule().__test__
    expect(readTaskResult({ ...event(), type: 'assistant/message' })).toBeUndefined()
    expect(readTaskResult({ ...event(), seq: undefined })).toBeUndefined()
    expect(readTaskResult(event(1, '没有任务标识'))).toBeUndefined()
    expect(taskFlowDefinition.match(event(1))).toEqual({ id: 'T-1', role: 'start' })
    expect(taskFlowDefinition.match(event(2))).toEqual({ id: 'T-1', role: 'start' })
    const start = { event: event(), location: { kind: 'step' } }
    const state = taskFlowDefinition.start({}, start)
    const node = taskFlowDefinition.buildViewNode({ key: 'key', id: 'T-1', state, start })
    expect(node.anchorSeq).toBe(1)
    expect(node.data.mermaid).toContain('flowchart TD')
    expect(taskFlowDefinition.update({}, { event: event(3) }).seq).toBe(3)
  })

  it('客户端拒绝指令、HTML、未知节点和不受限图，不把源码交给任意执行', () => {
    const { validateSource, isSafeSvgMarkup } = loadModule().__test__
    expect(() => validateSource('flowchart TD\n  n_a["正常 #34; 引号"]\n  n_b["验收"]\n  n_a --> n_b')).not.toThrow()
    for (const source of ['flowchart TD\nclick a "https://external"', 'flowchart TD\n  n_a["<b>HTML</b>"]', 'flowchart TD\n  n_a --> n_missing', '%%{init:{}}%%\nflowchart TD\n  n_a["a"]']) expect(() => validateSource(source)).toThrow()
    expect(isSafeSvgMarkup('<svg><g id="a"></g></svg>')).toBe(true)
    expect(isSafeSvgMarkup('<svg><script>alert(1)</script></svg>')).toBe(false)
    expect(isSafeSvgMarkup('<svg><a href="https://external"></a></svg>')).toBe(false)
  })

  it('RPC 必须绑定当前任务；失败保留原文，不渲染虚假已审核状态', async () => {
    const module = loadModule()
    const { getTaskFromRpc, TaskFlowRow } = module.__test__
    expect(getTaskFromRpc({ tasks: [{ task_id: 'T-1', goal: '真实目标' }] }, 'T-1').goal).toBe('真实目标')
    expect(() => getTaskFromRpc({ task_id: 'other' }, 'T-1')).toThrow('identity')
    const node = TaskFlowRow({ node: { data: { taskId: 'T-1', seq: 1, text: '真实工具内容' } }, sessionId: 'session', loadTask: vi.fn().mockRejectedValue(new Error('not authorized')) })
    expect(textOf(node)).toContain('等待审核')
    expect(textOf(node)).not.toContain('已审核')
    expect(node.children.some((child: any) => child?.type === 'MarkdownText' && child.props.text === '真实工具内容')).toBe(true)
  })

  it('注册标准节点与真实 RPC，失败不会吞成成功值', async () => {
    const module = loadModule()
    let registration: any
    let effect: any
    const call = vi.fn().mockResolvedValue({ ok: true, value: { task_id: 'T-1' } })
    const context = {
      effect: (run: () => unknown) => run(),
      locale: { register: vi.fn() }, uiConversation: { events: { register: vi.fn() } },
      get: (name: string) => { expect(name).toBe('connection'); return { rpc: { call } } },
      slots: { inject: (_name: string, run: () => unknown) => { effect = run }, register: (spec: any) => { registration = spec; return () => {} } }
    }
    module.apply(context)
    const generator = effect()
    generator.next()
    const { loadTask } = registration.inject()
    expect(await loadTask('session', 'T-1')).toEqual({ task_id: 'T-1' })
    expect(call).toHaveBeenCalledWith('/api', 'swarm.taskView', { sessionId: 'session', taskId: 'T-1' })
    call.mockResolvedValue({ ok: false, error: { message: 'not authorized' } })
    await expect(loadTask('session', 'T-1')).rejects.toThrow('not authorized')
  })

  it('Mermaid 本地懒加载并用 strict；两个请求复用同一加载', async () => {
    const { loadMermaid } = loadModule().__test__
    const initialize = vi.fn()
    vi.stubGlobal('mermaid', { initialize, render: vi.fn(), parse: vi.fn() })
    const script: any = { remove: vi.fn() }
    const document = { createElement: vi.fn(() => script), head: { appendChild: vi.fn((element: any) => queueMicrotask(() => element.onload())) } }
    const first = loadMermaid(document)
    const second = loadMermaid(document)
    expect(first).toBe(second)
    await first
    expect(script.src).toBe('/api/swarm-assets/mermaid.min.js')
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: 'strict', flowchart: { htmlLabels: false } }))
  })
})
