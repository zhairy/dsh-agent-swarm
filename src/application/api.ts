import type { RouteInfo } from '../domain/routing/routes.js'

export interface LoggerLike {
  info: (message: string) => void
  warn: (message: string) => void
}

/** Process-local planning observation; never an approval or durable execution fact. */
export interface PlanningRunView {
  task_id: string
  snapshotDigest: string
  startedAt: number
  elapsedMs: number
  timeoutMs: number
  agentStage: 'pending' | 'probing' | 'starting' | 'reviewing' | 'settled'
  jevStage: 'pending' | 'running' | 'settled'
  reviewerId?: string
  route?: string
  routeSource?: 'selected-initial' | 'agent-loop-attempt'
  actualRoute?: RouteInfo
}

export interface RootUpgradeView {
  taskIds: string[]
  reasons: string[]
  chain: string[]
  cancelledByUser?: boolean
  suppressedByUserSelection?: boolean
  selectedModel?: string
}
