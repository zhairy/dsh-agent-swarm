import type { SwarmEvent, SwarmEventJournal } from './event-journal.js';
export type OutboxStatus = 'pending' | 'delivered' | 'failed' | 'blocked';
export interface OutboxIntent {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    createdAt: number;
    maxAttempts?: number;
}
export interface OutboxRecord extends OutboxIntent {
    status: OutboxStatus;
    attempts: number;
    nextAt: number;
    lastError?: string;
    deliveredAt?: number;
}
export interface OutboxHandler {
    (record: OutboxRecord): void | Promise<void>;
}
/** Embed the outbox intent in the same EventJournal line as its enabling fact. */
export declare const appendWithOutbox: (journal: SwarmEventJournal, value: Parameters<SwarmEventJournal['append']>[0], intent?: OutboxIntent) => SwarmEvent | undefined;
export declare const makeOutboxIntent: (input: {
    identity: string;
    kind: string;
    payload: Record<string, unknown>;
    createdAt: number;
    maxAttempts?: number;
}) => OutboxIntent;
export declare const getOutboxRecords: (journal: SwarmEventJournal) => OutboxRecord[];
export interface OutboxDispatchResult {
    delivered: number;
    failed: number;
    skipped: number;
}
/** Durable at-least-once dispatch; handlers must make their own external operation idempotent by `record.id`. */
export declare const dispatchOutbox: (journal: SwarmEventJournal, handlers: ReadonlyMap<string, OutboxHandler>, options?: {
    now?: () => number;
    limit?: number;
    includeBlocked?: boolean;
}) => Promise<OutboxDispatchResult>;
