import { randomUUID } from 'node:crypto'
import type { LedgerEvent, LedgerEventType } from './evidence.js'
import type { SwarmEventJournal, SwarmEventType } from './event-journal.js'

const EVENT_TYPES: Readonly<Partial<Record<LedgerEventType, SwarmEventType>>> = {
  'task/card': 'ticket/admitted',
  'delegation/queued': 'assignment/queued',
  'delegation/running': 'assignment/started',
  'delegation/completed': 'assignment/ended',
  'delegation/failed': 'assignment/ended',
  'delegation/blocked': 'assignment/ended',
  'route/skipped': 'route/skipped',
  'route/fallback': 'route/fallback',
  'route/recovered': 'route/recovered',
  'review/assessment': 'review/recorded',
  'accept/decision': 'acceptance/recorded',
  'worktree/created': 'worktree/bound',
  'workflow/checkpoint': 'evidence/recorded'
}

const ACTORS: Readonly<Partial<Record<SwarmEventType, 'router' | 'worker' | 'host' | 'watchdog' | 'person'>>> = {
  'ticket/admitted': 'router',
  'assignment/queued': 'router',
  'assignment/started': 'host',
  'assignment/ended': 'worker',
  'route/skipped': 'router',
  'route/fallback': 'router',
  'route/recovered': 'router',
  'review/recorded': 'worker',
  'acceptance/recorded': 'router',
  'worktree/bound': 'worker',
  'evidence/recorded': 'worker'
}

/** Mirror legacy ledger facts into the new journal without changing legacy behavior. */
export const appendLegacyEventToJournal = (journal: SwarmEventJournal, event: LedgerEvent): void => {
  const type = EVENT_TYPES[event.type]
  if (type === undefined) return
  const eventId = randomUUID()
  journal.append({
    eventId: `evt-${eventId}`,
    idempotencyKey: `${event.sessionId}:${event.type}:${event.delegationId ?? event.taskId ?? event.ts}:${eventId}`,
    ...(event.taskId === undefined ? {} : { ticketId: event.taskId }),
    ...(event.delegationId === undefined ? {} : { assignmentId: event.delegationId }),
    type,
    actor: { kind: ACTORS[type] ?? 'host', id: event.delegationId ?? event.taskId ?? event.sessionId },
    payload: { legacyType: event.type, legacyData: event.data }
  })
}
