import { describe, expect, it } from 'vitest'
import type { LedgerEvent } from '../../src/evidence.js'
import { ParseCreatedWorktree, intWorktreeRegistry } from '../../src/worktree-binding.js'

const created = (suffix = 'one') => ({
  path: `/repo/.agents/worktrees/${suffix}`,
  branch: `ticket/${suffix}`,
  baseCommit: 'abc123',
  repositoryRoot: '/repo'
})

describe('DSH native Git worktree binding', () => {
  it('只解析官方工具声明的绝对路径结果，兼容文本渲染', () => {
    expect(ParseCreatedWorktree(created())).toEqual(created())
    expect(ParseCreatedWorktree({ isError: false, content: [{ type: 'text', text: JSON.stringify(created('two')) }] })).toEqual(created('two'))
    expect(ParseCreatedWorktree({ ...created(), path: 'relative/path' })).toBeUndefined()
    expect(ParseCreatedWorktree({ ...created(), path: '/outside/worktree' })).toBeUndefined()
    expect(ParseCreatedWorktree({ ...created(), path: '/repo' })).toBeUndefined()
    expect(ParseCreatedWorktree({ isError: true, path: '/repo/worktree' })).toBeUndefined()
  })

  it('任务和专家绑定唯一路径，不把一个工作树复用于其它任务或执行身份', () => {
    let time = 1
    const registry = intWorktreeRegistry({ now: () => ++time })
    const binding = registry.bind({ ...created(), agentId: 'ji_feng-1', taskId: 'T-1', delegationId: 'D-1' })
    expect(binding).toMatchObject({ ...created(), state: 'active', retention: 'manual-only', createdAt: 2 })
    expect(registry.findByAgent('ji_feng-1')).toEqual(binding)
    expect(registry.findByTask('T-1')).toEqual([binding])
    expect(registry.canCreate({ agentId: 'ji_feng-1', taskId: 'T-1' })).toContain('第二棵')
    expect(registry.canCreate({ agentId: 'zhu_jian-1', taskId: 'T-1' })).toContain('当前任务已经绑定')
    expect(() => registry.bind({ ...created(), agentId: 'zhu_jian-1', taskId: 'T-2', delegationId: 'D-2' })).toThrow('其它任务或专家')
    expect(registry.canCreate({ agentId: 'zhu_jian-1', taskId: 'T-2' })).toBeUndefined()
  })

  it('重启后从账本恢复为 recovery-required，保留路径供人工处理而不自动删除', () => {
    const event: LedgerEvent = {
      ts: '2026-11-02T00:00:00.000Z', type: 'worktree/created', sessionId: 'root', taskId: 'T-1', delegationId: 'D-1',
      data: { ...created(), agentId: 'ji_feng-1', createdAt: 123 }
    }
    const registry = intWorktreeRegistry()
    registry.hydrate([event, { ...event, delegationId: 'D-2', data: { ...event.data, path: '/repo/.agents/worktrees/second', branch: 'second' } }])
    expect(registry.findByTask('T-1')).toEqual([expect.objectContaining({ ...created(), agentId: 'ji_feng-1', state: 'recovery-required', retention: 'manual-only' })])
  })
})
