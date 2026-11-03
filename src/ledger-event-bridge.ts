import { createHash } from 'node:crypto'
import type { LedgerEvent, LedgerEventType } from './evidence.js'
import type { SwarmEvent, SwarmEventJournal, SwarmEventType } from './event-journal.js'

const EVENT_TYPES: Readonly<Partial<Record<LedgerEventType, SwarmEventType>>> = {
  'task/card': 'ticket/admitted',
  'delegation/queued': 'assignment/queued',
  'delegation/running': 'assignment/started',
  'delegation/completed': 'assignment/ended',
  'delegation/failed': 'assignment/ended',
  'delegation/blocked': 'assignment/ended',
  'delegation/retry': 'assignment/queued',
  'agent/manual-continue': 'ticket/state-changed',
  'session/plan': 'ticket/state-changed',
  'state/recovered': 'ticket/state-changed',
  'route/skipped': 'route/skipped',
  'route/upgrade': 'route/selected',
  'route/fallback': 'route/fallback',
  'route/recovery-probe': 'route/recovered',
  'route/recovered': 'route/recovered',
  'jev/call': 'evidence/recorded',
  'native/call': 'evidence/recorded',
  'review/assessment': 'review/recorded',
  'workflow/review': 'review/recorded',
  'workflow/stale': 'evidence/recorded',
  'math/computed': 'evidence/recorded',
  'message/send': 'evidence/recorded',
  'message/ack': 'evidence/recorded',
  'experience/candidate': 'evidence/recorded',
  'accept/decision': 'acceptance/recorded',
  'worktree/created': 'worktree/bound',
  'workflow/checkpoint': 'evidence/recorded'
}

const ACTORS: Readonly<Partial<Record<SwarmEventType, 'router' | 'worker' | 'host' | 'watchdog' | 'person'>>> = {
  'ticket/admitted': 'router',
  'assignment/queued': 'router',
  'assignment/started': 'host',
  'assignment/ended': 'worker',
  'ticket/state-changed': 'host',
  'route/selected': 'router',
  'route/skipped': 'router',
  'route/fallback': 'router',
  'route/recovered': 'router',
  'review/recorded': 'worker',
  'acceptance/recorded': 'router',
  'worktree/bound': 'worker',
  'evidence/recorded': 'worker'
}

export type LegacyImportSummary = { imported: number; skipped: number; unsupported: number }

export const getLegacyEventType = (type: LedgerEventType): SwarmEventType | undefined => EVENT_TYPES[type]

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

/** Deterministic identity makes restart/reimport exactly-once at the journal boundary. */
const legacyIdentity = (event: LedgerEvent): string => sha256(JSON.stringify([
  event.sessionId, event.ts, event.type, event.taskId ?? null, event.delegationId ?? null, event.data
]))

/** Append one legacy fact to the V2 journal and return the accepted event. */
export const appendLegacyEventToJournal = (journal: SwarmEventJournal, event: LedgerEvent): SwarmEvent | undefined => {
  const type = EVENT_TYPES[event.type]
  if (type === undefined) return undefined
  const identity = legacyIdentity(event)
  return journal.append({
    eventId: `evt-legacy-${identity}`,
    idempotencyKey: `legacy:${identity}`,
    ...(event.taskId === undefined ? {} : { ticketId: event.taskId }),
    ...(event.delegationId === undefined ? {} : { assignmentId: event.delegationId }),
    type,
    actor: { kind: ACTORS[type] ?? 'host', id: event.delegationId ?? event.taskId ?? event.sessionId },
    payload: { legacyType: event.type, legacyData: event.data }
  })
}

/** Import old ledger lines without mutating the ledger or inventing unsupported facts. */
export const importLegacyLedgerEvents = (journal: SwarmEventJournal, events: readonly LedgerEvent[]): LegacyImportSummary => {
  const summary: LegacyImportSummary = { imported: 0, skipped: 0, unsupported: 0 }
  for (const event of events) {
    if (getLegacyEventType(event.type) === undefined) { summary.unsupported++; continue }
    if (appendLegacyEventToJournal(journal, event) === undefined) summary.skipped++
    else summary.imported++
  }
  return summary
}
