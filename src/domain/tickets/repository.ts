import type { DelegationRecord, TaskRecord, TaskStore, TaskStoreDirty } from '../../evidence.js'
import { SwarmError } from '../../util/errors.js'
import { projectTicketLifecycle, type TicketProjection } from './lifecycle.js'

const stageKey = (value: TicketProjection['stage']): string => value.stage === 'working' || value.stage === 'person'
  ? `${value.stage}:${value.action}`
  : value.stage === 'ended' ? `ended:${value.outcome}` : value.stage

const ALLOWED_STAGE_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  created: ['created', 'working:queued', 'working:running', 'person:review', 'person:blocked', 'person:failed', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  'working:queued': ['working:queued', 'working:running', 'person:review', 'person:blocked', 'person:failed', 'idle', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  'working:running': ['working:running', 'working:queued', 'person:review', 'person:blocked', 'person:failed', 'idle', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  'person:review': ['person:review', 'working:queued', 'working:running', 'person:blocked', 'person:failed', 'idle', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  'person:blocked': ['person:blocked', 'person:failed', 'working:queued', 'working:running', 'idle', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  'person:failed': ['person:failed', 'person:blocked', 'working:queued', 'working:running', 'idle', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  idle: ['idle', 'working:queued', 'working:running', 'person:review', 'person:blocked', 'person:failed', 'ended:accepted', 'ended:rejected', 'ended:incomplete'],
  'ended:accepted': ['ended:accepted'],
  'ended:rejected': ['ended:rejected', 'working:queued', 'working:running', 'person:review'],
  'ended:incomplete': ['ended:incomplete', 'working:queued', 'working:running', 'person:review']
}

export const ValidateTicketTransition = (from: TicketProjection, to: TicketProjection): void => {
  const revisionChanged = to.revisions.card > from.revisions.card
    || to.revisions.workflow > from.revisions.workflow
    || to.revisions.request > from.revisions.request
  if (from.stage.stage === 'ended' && from.stage.outcome === 'accepted' && revisionChanged) return
  if (from.stage.stage === 'ended' && from.stage.outcome !== 'accepted') return
  const allowed = ALLOWED_STAGE_TRANSITIONS[stageKey(from.stage)]
  if (allowed === undefined || !allowed.includes(stageKey(to.stage))) {
    throw new SwarmError('INVALID_TRANSITION', `Ticket ${from.ticketId} 不允许从 ${stageKey(from.stage)} 变为 ${stageKey(to.stage)}`)
  }
}

export interface TicketRepository extends TaskStore {
  projection: (taskId: string) => TicketProjection | undefined
  projectionAll: () => TicketProjection[]
}

/** TaskStore adapter enforcing Ticket lifecycle and Assignment revision boundaries. */
export const intTicketRepository = (store: TaskStore): TicketRepository => {
  const projection = (taskId: string): TicketProjection | undefined => {
    const task = store.getTask(taskId)
    return task === undefined ? undefined : projectTicketLifecycle(task, store.getTaskDelegations(taskId))
  }
  const assertSimulated = (task: TaskRecord, delegations: readonly DelegationRecord[]): TicketProjection => {
    const before = projectTicketLifecycle(task, store.getTaskDelegations(task.taskId))
    const after = projectTicketLifecycle(task, delegations)
    ValidateTicketTransition(before, after)
    return after
  }
  return {
    AddTask: (task) => store.AddTask(task),
    getTask: (taskId) => store.getTask(taskId),
    UpdateTask: (taskId, patch) => {
      const before = store.getTask(taskId)
      if (before === undefined) return store.UpdateTask(taskId, patch)
      const simulated = { ...before, ...patch, updatedAt: before.updatedAt + 1 }
      const delegations = store.getTaskDelegations(taskId)
      ValidateTicketTransition(projectTicketLifecycle(before, delegations), projectTicketLifecycle(simulated, delegations))
      return store.UpdateTask(taskId, patch)
    },
    AddDelegation: (record) => {
      const task = store.getTask(record.taskId)
      if (task === undefined) return store.AddDelegation(record)
      assertSimulated(task, [...store.getTaskDelegations(record.taskId), record])
      store.AddDelegation(record)
    },
    UpdateDelegation: (delegationId, patch) => {
      const current = store.getDelegation(delegationId)
      if (current === undefined) return store.UpdateDelegation(delegationId, patch)
      const task = store.getTask(current.taskId)
      if (task === undefined) return store.UpdateDelegation(delegationId, patch)
      const simulated = store.getTaskDelegations(current.taskId).map((record) => record.delegationId === delegationId ? { ...record, ...patch } : record)
      assertSimulated(task, simulated)
      return store.UpdateDelegation(delegationId, patch)
    },
    getDelegation: (delegationId) => store.getDelegation(delegationId),
    getTaskDelegations: (taskId) => store.getTaskDelegations(taskId),
    getTasks: () => store.getTasks(),
    ...(store.takeDirty === undefined ? {} : { takeDirty: () => store.takeDirty!() }),
    ...(store.restoreDirty === undefined ? {} : { restoreDirty: (dirty: TaskStoreDirty) => store.restoreDirty!(dirty) }),
    ...(store.RollbackTask === undefined ? {} : { RollbackTask: (taskId: string, previous: TaskRecord | undefined, expected: { cardRevision: number; workflowRevision: number; requestRevision: number }) => store.RollbackTask!(taskId, previous, expected) }),
    projection,
    projectionAll: () => store.getTasks().map((task) => projectTicketLifecycle(task, store.getTaskDelegations(task.taskId)))
  }
}
