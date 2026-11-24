import type { LedgerEventType } from './evidence.js';
import type { SwarmEventJournal } from './event-journal.js';
import { type LegacyImportSummary } from './ledger-event-bridge.js';
export interface LegacyEventImportResult extends LegacyImportSummary {
    source: string;
    sourceDigest?: string;
    invalidLines: number;
    rejectedLines: number;
    manifestPath?: string;
}
/**
 * Import one session's legacy JSONL ledger through the deterministic bridge.
 * The manifest contains hashes and counts only, never event payloads.
 */
export declare const importLegacyLedgerFile: (input: {
    ledgerPath: string;
    journal: SwarmEventJournal;
    rootSessionId: string;
    now?: () => Date;
}) => LegacyEventImportResult;
export declare const isLegacyLedgerEventType: (value: string) => value is LedgerEventType;
