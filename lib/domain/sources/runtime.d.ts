import type { SwarmConfigInfo } from '../../config.js';
import type { SwarmEventJournal } from '../../event-journal.js';
import { type SourceInstance, type SourceSubscription, type TriggerDecision, type TriggerFact, type TriggerInput } from './model.js';
export interface SourceAdapter<Raw = unknown> {
    readonly kind: string;
    normalize(input: {
        source: SourceInstance;
        raw: Raw;
        at: Date;
    }): TriggerInput | {
        filtered: string;
    };
}
export interface SourceIngestResult {
    status: 'accepted' | 'would-accept' | 'ignored' | 'filtered' | 'duplicate';
    reason: string;
    trigger?: TriggerFact;
    decision?: TriggerDecision;
    outboxId?: string;
    fanoutTicketIds: string[];
    evalRequired: boolean;
}
export interface SourceTriggerStatus {
    sources: Array<Pick<SourceInstance, 'id' | 'kind' | 'enabled' | 'selfActor'> & {
        lastAt?: string;
        received: number;
        accepted: number;
        observed: number;
        filtered: number;
    }>;
    counts: {
        received: number;
        accepted: number;
        observed: number;
        filtered: number;
    };
    outboxPending: number;
    outboxFailed: number;
    threads: number;
    subscriptions: number;
}
/** Journal-only Source/Trigger adapter. Source instances, triggers and decisions are reconstructed from events. */
export declare const createSourceTriggerRuntime: (input: {
    journal: SwarmEventJournal;
    config: () => SwarmConfigInfo;
    now?: () => number;
}) => {
    registerAdapter(adapter: SourceAdapter): () => void;
    configure(source: SourceInstance): SourceInstance;
    subscribe(inputValue: {
        sourceId: string;
        threadId: string;
        ticketId: string;
        contextOnly?: boolean;
    }): SourceSubscription;
    unsubscribe(subscriptionIdValue: string): boolean;
    unsubscribeTicket(ticketIdValue: string): number;
    ingest(sourceIdValue: string, raw: TriggerInput, options?: {
        hasActiveTicket?: boolean;
    }): SourceIngestResult;
    ingestRaw(sourceIdValue: string, raw: unknown, options?: {
        hasActiveTicket?: boolean;
    }): SourceIngestResult;
    status(): SourceTriggerStatus;
    dispose(): void;
};
export declare const sourceTriggerFromSessionEvent: (input: {
    sessionId: string;
    event: {
        type: string;
        seq?: number;
        data?: unknown;
    };
    sourceId: string;
}) => TriggerInput | {
    filtered: string;
};
