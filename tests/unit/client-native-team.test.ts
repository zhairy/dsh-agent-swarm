import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const loadModule = (): any => {
  const react = {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (value: unknown) => [value, vi.fn()],
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot()
  }
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', readFileSync(join(__dirname, '../../client/native-team-projection.js'), 'utf8'))((id: string) => {
    if (id === 'react') return react
    throw new Error(`optional module unavailable: ${id}`)
  }, module, module.exports)
  return module.exports
}

describe('原生团队只读投影', () => {
  const nativeTeam = loadModule()
  const { getTeamSummary, getLeadSessionId, openTeammateSession } = nativeTeam.__test__

  it('只接受合法的成员和任务视图，单 Lead 且无任务时不显示入口', () => {
    expect(getTeamSummary(undefined)).toBeUndefined()
    expect(getTeamSummary({ members: [{ id: 'lead', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] })).toBeUndefined()
    expect(getTeamSummary({
      members: [
        { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'child', name: 'reviewer', role: 'teammate', phase: 'active' }
      ],
      tasks: [{ id: 'task-1', subject: 'review', status: 'pending', blockedBy: [], writeScopes: [] }]
    })).toMatchObject({ memberCount: 2, taskCount: 1, truncated: false })
  })

  it('从子会话找到 Lead，并用普通 continuable 地址导航而不发送 Team 消息', () => {
    const sessions = {
      binding: () => ({ session: { getSnapshot: () => ({ subagent: { address: { parentSessionId: 'lead' } } }) } }),
      retainInfo: () => ({ getSnapshot: () => ({ retainedBy: { mainView: 1 } }) })
    }
    const openSession = vi.fn()
    expect(getLeadSessionId(sessions, 'child')).toBe('lead')
    expect(openTeammateSession({ sessions, uiWorkspace: { openSession } }, 'child', 'peer')).toBe(true)
    expect(openSession).toHaveBeenCalledWith({ parentSessionId: 'lead', childSessionId: 'peer', mode: 'continuable' })
  })

  it('只读入口注入 sessions/uiWorkspace，不使用任何团队控制服务', () => {
    expect(nativeTeam.inject).toEqual(['slots', 'locale', 'sessions', 'uiWorkspace'])
  })
})
