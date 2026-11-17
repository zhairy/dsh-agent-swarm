import type { AgentLike, GoalsLike, JobsLike, SessionProjectionsLike, ToolsLike } from './host-contract.js'
import { getRedactedValue } from './evidence.js'
import type { GoalViewLike } from './host-contract.js'

export interface NativeIntegrationView {
  availability: {
    askUser: boolean
    todo: boolean
    timeContext: boolean
    planMode: boolean
    goal: boolean
    jobs: boolean
    worktree: boolean
  }
  todos?: { total: number; scanned: number; pending: number; inProgress: number; completed: number; items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }> }
  timeContext?: { lastMessageTime: number | null; lastInjectionTime: number | null; lastTurnInjectionTime: number | null }
  planMode?: { active: boolean; pending: boolean }
  goal?: Pick<GoalViewLike, 'id' | 'revision' | 'phase' | 'activation' | 'roundsStarted' | 'maxGoalRounds'>
  jobs?: { total: number; running: number; stopping: number; completed: number; failedOrKilled: number }
}

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

const getTodos = (raw: unknown): NativeIntegrationView['todos'] | undefined => {
  if (raw === undefined) return undefined
  if (raw === null) return { total: 0, scanned: 0, pending: 0, inProgress: 0, completed: 0, items: [] }
  if (!Array.isArray(raw)) return undefined
  const scanned = raw.slice(0, 256).flatMap((value) => {
    const item = object(value)
    if (item === undefined || typeof item.content !== 'string' || !['pending', 'in_progress', 'completed'].includes(String(item.status))) return []
    const content = getRedactedValue(item.content)
    return [{ content: String(content).slice(0, 240), status: item.status as 'pending' | 'in_progress' | 'completed' }]
  })
  const items = scanned.slice(0, 64)
  return {
    total: raw.length,
    scanned: scanned.length,
    pending: scanned.filter((item) => item.status === 'pending').length,
    inProgress: scanned.filter((item) => item.status === 'in_progress').length,
    completed: scanned.filter((item) => item.status === 'completed').length,
    items
  }
}

const getTimeContext = (raw: unknown): NativeIntegrationView['timeContext'] | undefined => {
  const value = object(raw)
  if (value === undefined) return undefined
  return {
    lastMessageTime: timestamp(value.lastMessageTime),
    lastInjectionTime: timestamp(value.lastInjectionTime),
    lastTurnInjectionTime: timestamp(value.lastTurnInjectionTime)
  }
}

const getPlanMode = (raw: unknown): NativeIntegrationView['planMode'] | undefined => {
  const value = object(raw)
  if (value === undefined || typeof value.active !== 'boolean') return undefined
  const running = object(value.running)
  const wanted = running?.wanted ?? value.wanted
  const pending = typeof value.pending === 'boolean'
    ? value.pending
    : typeof wanted === 'boolean' && wanted !== value.active
  return { active: value.active, pending }
}

const getGoal = (goals: GoalsLike | undefined, agent: AgentLike | undefined): NativeIntegrationView['goal'] | undefined => {
  if (goals?.get === undefined || agent === undefined) return undefined
  try {
    const goal = goals.get(agent)
    if (goal === undefined) return undefined
    return { id: goal.id, revision: goal.revision, phase: goal.phase, activation: goal.activation, roundsStarted: goal.roundsStarted, maxGoalRounds: goal.maxGoalRounds }
  } catch { return undefined }
}

const getJobs = (jobs: JobsLike | undefined, agent: AgentLike | undefined): NativeIntegrationView['jobs'] | undefined => {
  if (jobs?.list === undefined || agent === undefined) return undefined
  try {
    const rows = jobs.list(agent.id).slice(0, 512)
    return {
      total: rows.length,
      running: rows.filter((row) => row.status === 'running').length,
      stopping: rows.filter((row) => row.status === 'stopping').length,
      completed: rows.filter((row) => row.status === 'completed').length,
      failedOrKilled: rows.filter((row) => row.status === 'failed' || row.status === 'killed').length
    }
  } catch { return undefined }
}

const getToolAvailability = (tools: ToolsLike | undefined): { askUser: boolean; todo: boolean; worktree: boolean } => {
  try {
    const names = new Set(tools?.schemas().map((item) => item.name) ?? [])
    return { askUser: names.has('ask_user_question'), todo: names.has('todo_write'), worktree: names.has('create_worktree') }
  } catch { return { askUser: false, todo: false, worktree: false } }
}

/** Read native DSH projections without creating a second task, plan or job state store. */
export const getNativeIntegrationView = (input: {
  projections?: SessionProjectionsLike
  goals?: GoalsLike
  jobs?: JobsLike
  tools?: ToolsLike
  session?: unknown
  agent?: AgentLike
}): NativeIntegrationView => {
  const stateOf = input.projections?.stateOf
  const read = (key: string): unknown => {
    if (stateOf === undefined || input.session === undefined) return undefined
    try { return stateOf.call(input.projections, input.session, key) } catch { return undefined }
  }
  const todoState = read('todos')
  const timeState = read('timeContext')
  const planState = read('plan')
  const todos = getTodos(todoState)
  const timeContext = getTimeContext(timeState)
  const planMode = getPlanMode(planState)
  const goal = getGoal(input.goals, input.agent)
  const jobs = getJobs(input.jobs, input.agent)
  const tools = getToolAvailability(input.tools)
  return {
    availability: {
      askUser: tools.askUser,
      todo: todoState !== undefined,
      timeContext: timeContext !== undefined,
      planMode: planMode !== undefined,
      goal: goal !== undefined || input.goals?.get !== undefined,
      jobs: jobs !== undefined || input.jobs?.list !== undefined,
      worktree: tools.worktree
    },
    ...(todos === undefined ? {} : { todos }),
    ...(timeContext === undefined ? {} : { timeContext }),
    ...(planMode === undefined ? {} : { planMode }),
    ...(goal === undefined ? {} : { goal }),
    ...(jobs === undefined ? {} : { jobs })
  }
}
