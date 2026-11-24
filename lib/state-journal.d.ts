import type { SwarmEventJournal } from './event-journal.js';
import { type SegmentSpecs, type StatePatch } from './state-chunks.js';
/** Keep a state fragment well below EventJournal's 64 KiB line ceiling after JSON and digest metadata. */
export declare const STATE_JOURNAL_CHUNK_BYTES: number;
export interface StateCommitFact<T> {
    kind: 'snapshot' | 'patch';
    type: string;
    sequence: number;
    previousChecksum: string;
    checksum: string;
    state?: T;
    patch?: StatePatch;
    changes?: Record<string, unknown>;
}
export interface StateJournalIssue {
    commitId?: string;
    sequence?: number;
    reason: string;
}
export interface StateJournalRecovery<T> {
    state?: T;
    sequence: number;
    checksum?: string;
    commits: number;
    incomplete: number;
    issues: StateJournalIssue[];
}
/** Append one state mutation as an incomplete-until-finalized chunk group in the same EventJournal. */
export declare const appendStateCommitToJournal: <T>(journal: SwarmEventJournal, fact: StateCommitFact<T>) => void;
/** Reconstruct the last complete, contiguous state chain. An unfinished tail is ignored, never half-applied. */
export declare const recoverStateFromJournal: <T>(journal: SwarmEventJournal, options: {
    specs: SegmentSpecs;
    validate: (state: unknown) => boolean | {
        ok: boolean;
        issues?: readonly unknown[];
    };
}) => StateJournalRecovery<T>;
export declare const initializeStateJournal: <T>(journal: SwarmEventJournal, state: T, sequence: number, specs: SegmentSpecs) => string | undefined;
