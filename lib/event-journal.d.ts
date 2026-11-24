export declare const EVENT_JOURNAL_SCHEMA: 'dsh-agent-swarm/event/v2';
export declare const EVENT_JOURNAL_MAX_LINE_BYTES: number;
export declare const EVENT_JOURNAL_SEAL_BYTES: number;
export type SwarmEventType = 'request/received' | 'host/event-filtered' | 'ticket/admitted' | 'ticket/state-changed' | 'ticket/quarantined' | 'assignment/queued' | 'assignment/started' | 'assignment/heartbeat' | 'assignment/ended' | 'route/selected' | 'route/skipped' | 'route/fallback' | 'route/recovered' | 'evidence/recorded' | 'review/recorded' | 'acceptance/recorded' | 'worktree/bound' | 'worktree/restored' | 'workspace/verification-outputs' | 'watchdog/alert' | 'state/journal-begin' | 'state/journal-chunk' | 'state/journal-commit' | 'source/configured' | 'source/trigger-received' | 'source/trigger-filtered' | 'source/trigger-evaluated' | 'thread/opened' | 'subscription/created' | 'subscription/ended' | 'outbox/delivered' | 'outbox/failed';
export interface EventRevision {
    request: number;
    card: number;
    workflow: number;
    leaseEpoch: number;
}
export interface SwarmEventInput {
    eventId: string;
    idempotencyKey: string;
    ticketId?: string;
    assignmentId?: string;
    type: SwarmEventType;
    actor: {
        kind: 'router' | 'worker' | 'host' | 'watchdog' | 'person';
        id: string;
    };
    policyVersion?: string;
    revision?: Partial<EventRevision>;
    payload?: Record<string, unknown>;
}
export interface SwarmEvent extends SwarmEventInput {
    schema: typeof EVENT_JOURNAL_SCHEMA;
    rootSessionId: string;
    seq: number;
    at: string;
    previousDigest: string;
    digest: string;
    payload: Record<string, unknown>;
}
export interface JournalIssue {
    line: number;
    reason: 'invalid-json' | 'invalid-shape' | 'digest-mismatch' | 'sequence-mismatch' | 'duplicate-id';
}
export interface SwarmProjection {
    schemaVersion: 2;
    sequence: number;
    tickets: Record<string, {
        stage: string;
        updatedAt: string;
        quarantined: boolean;
    }>;
    routes: Record<string, {
        lastEvent: string;
        failures: number;
        recoveredAt?: string;
    }>;
    alerts: Array<{
        id: string;
        severity: string;
        detail: string;
        at: string;
    }>;
}
export declare const emptyProjection: () => SwarmProjection;
/** Pure projection reducer; rebuilding the same event stream always yields the same view. */
export declare const reduceSwarmEvents: (events: readonly SwarmEvent[], initial?: SwarmProjection) => SwarmProjection;
export interface SwarmEventJournal {
    readonly path: string;
    readonly maxLineBytes: number;
    /** Set when an immutable sealed segment is corrupt; active-tail repair does not set it. */
    readonly fatalError?: string;
    append: (input: SwarmEventInput) => SwarmEvent | undefined;
    read: () => {
        events: SwarmEvent[];
        issues: JournalIssue[];
    };
    query: (predicate: (event: Readonly<SwarmEvent>) => boolean) => SwarmEvent[];
    queryTypes: (types: readonly SwarmEventType[]) => SwarmEvent[];
    queryOutbox: () => SwarmEvent[];
    summary: () => {
        sequence: number;
        issues: number;
    };
    project: () => SwarmProjection;
    segments: () => readonly string[];
}
/** Append-only, checksummed JSONL journal. It records facts but never replays external side effects. */
export declare const createSwarmEventJournal: (input: {
    directory: string;
    rootSessionId: string;
    now?: () => Date;
    sealAfterBytes?: number;
    maxLineBytes?: number;
}) => SwarmEventJournal;
