import type { LedgerEvent, LedgerEventType } from './evidence.js';
import type { SwarmEvent, SwarmEventJournal, SwarmEventType } from './event-journal.js';
export type LegacyImportSummary = {
    imported: number;
    skipped: number;
    unsupported: number;
};
export declare const getLegacyEventType: (type: LedgerEventType) => SwarmEventType | undefined;
export declare const LEGACY_JOURNAL_PAYLOAD_MAX_BYTES: number;
/** Append one legacy fact to the V2 journal and return the accepted event. */
export declare const appendLegacyEventToJournal: (journal: SwarmEventJournal, event: LedgerEvent) => SwarmEvent | undefined;
/** Import old ledger lines without mutating the ledger or inventing unsupported facts. */
export declare const importLegacyLedgerEvents: (journal: SwarmEventJournal, events: readonly LedgerEvent[]) => LegacyImportSummary;
