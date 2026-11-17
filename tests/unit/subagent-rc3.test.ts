import { describe, it, expect, vi } from 'vitest'
import { startChild } from '../../src/adapters/dsh-host/subagent.js'

describe('子代理协议兼容', () => {
  const input = () => ({ provider: 'spawn', label: '任务', childId: 'child', name: 'worker', prompt: [], parent: {} as never, signal: new AbortController().signal, agentPreset: 'expert' })
  it('rc.3 顶层参数只启动一次并绑定 dispose 接收者', async () => {
    const activation = { childId: 'child', name: 'worker', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: vi.fn(function () { expect(this).toBe(activation); return Promise.resolve() }) }
    const args = input()
    const startActivation = vi.fn(async (spec) => { expect(spec.request).toBeUndefined(); expect(spec.parent).toBeDefined(); expect(spec.agentPreset).toBe('expert'); expect(spec.name).toBe('worker'); expect(spec.delivery).toBe('caller'); expect(spec.signal).toBe(args.signal); expect(spec.childId).toBe(args.childId); return activation })
    const run = await startChild({ listDescendants: vi.fn(), startActivation } as never, args)
    expect(startActivation).toHaveBeenCalledTimes(1)
    await run.dispose()
  })
  it('rc.1 保留嵌套 request', async () => {
    const startActivation = vi.fn(async (spec) => { expect(spec.request.agentPreset).toBe('expert'); expect(spec.childId).toBe('child'); return { childId: 'child', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {} } })
    await startChild({ startActivation } as never, input())
  })
  it('旧 start 协议保留 persona、toolFilter 和取消信号', async () => {
    const args = { ...input(), persona: '角色', toolFilter: { allow: ['read'] } }
    const start = vi.fn(async (provider, spec) => {
      expect(provider).toBe('spawn'); expect(spec.persona).toBe('角色'); expect(spec.toolFilter).toEqual(args.toolFilter); expect(spec.signal).toBe(args.signal)
      return { id: 'old', result: Promise.resolve({ output: [], stopReason: 'aborted' }), dispose: async () => {} }
    })
    const run = await startChild({ start } as never, args)
    expect(run.id).toBe('old')
    expect((await run.result).stopReason).toBe('aborted')
  })
  it('启动失败禁止重试另一协议', async () => {
    const startActivation = vi.fn(async () => { throw new Error('startup') })
    await expect(startChild({ listDescendants: vi.fn(), startActivation } as never, input())).rejects.toThrow('startup')
    expect(startActivation).toHaveBeenCalledTimes(1)
  })
})
