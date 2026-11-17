import { describe, expect, it, vi } from 'vitest'
import { getNativeIntegrationView } from '../../src/native-integrations.js'

describe('native DSH integration projection', () => {
  it('reads todo, time, plan, goal, jobs and tool availability without duplicating host state', () => {
    const stateOf = vi.fn((_session: unknown, key: string) => {
      if (key === 'todos') return [
        { content: 'inspect', status: 'completed' },
        { content: 'implement', status: 'in_progress' },
        { content: 'Bearer secret-token', status: 'pending' }
      ]
      if (key === 'timeContext') return { lastMessageTime: 3, lastInjectionTime: 2, lastTurnInjectionTime: 1 }
      if (key === 'plan') return { active: true, wanted: null, running: { commandId: 'cmd-1', wanted: false }, activeAtLastHeader: true }
      return undefined
    })
    const goal = { id: 'G-1', revision: 2, phase: 'active' as const, activation: 'armed' as const, roundsStarted: 1, maxGoalRounds: 8 }
    const view = getNativeIntegrationView({
      projections: { stateOf }, session: { id: 's' }, agent: { id: 'a', session: { id: 's' } } as any,
      goals: { get: () => goal, disarm: () => goal } as any,
      jobs: { list: () => [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'completed' }, { id: 'j3', status: 'failed' }], kill: vi.fn(), wait: vi.fn() } as any,
      tools: { register: vi.fn(), guard: vi.fn(), schemas: () => [{ name: 'ask_user_question' }, { name: 'todo_write' }, { name: 'create_worktree' }] } as any
    })
    expect(view.availability).toEqual({ askUser: true, todo: true, timeContext: true, planMode: true, goal: true, jobs: true, worktree: true })
    expect(view.todos).toMatchObject({ total: 3, scanned: 3, pending: 1, inProgress: 1, completed: 1 })
    expect(view.todos?.items[2]?.content).toContain('[已脱敏]')
    expect(view.timeContext).toEqual({ lastMessageTime: 3, lastInjectionTime: 2, lastTurnInjectionTime: 1 })
    expect(view.planMode).toEqual({ active: true, pending: true })
    expect(view.goal).toEqual(goal)
    expect(view.jobs).toEqual({ total: 3, running: 1, stopping: 0, completed: 1, failedOrKilled: 1 })
  })

  it('degrades to explicit unavailability when host projections are absent or fail', () => {
    const view = getNativeIntegrationView({
      projections: { stateOf: () => { throw new Error('projection unavailable') } }, session: {},
      goals: { get: () => { throw new Error('goal unavailable') }, disarm: vi.fn() } as any,
      jobs: { list: () => { throw new Error('jobs unavailable') }, kill: vi.fn(), wait: vi.fn() } as any
    })
    expect(view).toEqual({ availability: { askUser: false, todo: false, timeContext: false, planMode: false, goal: true, jobs: true, worktree: false } })
  })
})
