import { createHash } from 'node:crypto';
import { getRedactedValue } from './evidence.js';
const EVENT_TYPES = {
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
};
const ACTORS = {
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
};
export const getLegacyEventType = (type) => EVENT_TYPES[type];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const LEGACY_JOURNAL_PAYLOAD_MAX_BYTES = 32 * 1024;
const LEGACY_SUMMARY_KEY_LIMIT = 32;
const LEGACY_SUMMARY_KEY_CHARS = 96;
const summarizeKey = (key) => String(getRedactedValue(key)).slice(0, LEGACY_SUMMARY_KEY_CHARS);
const summarizeShape = (event) => Object.entries(event.data).slice(0, LEGACY_SUMMARY_KEY_LIMIT).map(([key, value]) => ({
    key: summarizeKey(key),
    kind: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    ...(Array.isArray(value) ? { size: value.length } : {})
}));
const legacyPayload = (event) => {
    const encoded = JSON.stringify(event.data);
    const originalBytes = Buffer.byteLength(encoded);
    if (originalBytes <= LEGACY_JOURNAL_PAYLOAD_MAX_BYTES)
        return { legacyType: event.type, legacyData: event.data };
    return {
        legacyType: event.type,
        legacyDataTruncated: true,
        legacyDataBytes: originalBytes,
        legacyDataSha256: sha256(encoded),
        legacyDataKeyCount: Object.keys(event.data).length,
        legacyDataSample: summarizeShape(event)
    };
};
/** Deterministic identity makes restart/reimport exactly-once at the journal boundary. */
const legacyIdentity = (event) => sha256(JSON.stringify([
    event.sessionId, event.ts, event.type, event.taskId ?? null, event.delegationId ?? null, event.data
]));
/** Append one legacy fact to the V2 journal and return the accepted event. */
export const appendLegacyEventToJournal = (journal, event) => {
    const type = EVENT_TYPES[event.type];
    if (type === undefined)
        return undefined;
    const identity = legacyIdentity(event);
    return journal.append({
        eventId: `evt-legacy-${identity}`,
        idempotencyKey: `legacy:${identity}`,
        ...(event.taskId === undefined ? {} : { ticketId: event.taskId }),
        ...(event.delegationId === undefined ? {} : { assignmentId: event.delegationId }),
        type,
        actor: { kind: ACTORS[type] ?? 'host', id: event.delegationId ?? event.taskId ?? event.sessionId },
        payload: legacyPayload(event)
    });
};
/** Import old ledger lines without mutating the ledger or inventing unsupported facts. */
export const importLegacyLedgerEvents = (journal, events) => {
    const summary = { imported: 0, skipped: 0, unsupported: 0 };
    for (const event of events) {
        if (getLegacyEventType(event.type) === undefined) {
            summary.unsupported++;
            continue;
        }
        if (appendLegacyEventToJournal(journal, event) === undefined)
            summary.skipped++;
        else
            summary.imported++;
    }
    return summary;
};
//# sourceMappingURL=ledger-event-bridge.js.map