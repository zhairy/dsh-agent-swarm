/** A lifecycle-only fold of the real Host's validated inspection and parent catalog.
 * This proves durable lineage and a closed last turn, never workspace side effects. */
export interface ChildRecoveryEvidence {
    parentSessionId: string;
    childId: string;
    continuable: boolean;
    settled: boolean;
    stopReason?: string;
    turn?: number;
    turnStartedAt?: number;
    settledAt?: number;
    reason?: string;
    /** A closed model turn is never a certificate that process resources exited. */
    writerQuiescent?: false;
}
export declare const inspectOwnedJobHistory: (events: readonly unknown[], childId: string) => {
    complete: boolean;
    reason?: string;
};
/** Read one exact Host observation without activating a Session or retaining its lease. */
export declare const readHostInspection: (input: {
    sessionId: string;
    controller?: {
        inspect?: (id: string) => Promise<unknown>;
    };
    query?: {
        observeSession?: (id: string, options: {
            projectionMode: 'none';
            signal: AbortSignal;
        }) => Promise<{
            header: unknown;
            inheritedEventCount: number;
            events: readonly unknown[];
            [Symbol.dispose]: () => void;
        }>;
    };
    signal: AbortSignal;
}) => Promise<unknown | undefined>;
/** Restore intent, never the SDK's last automatically selected fallback header. */
export declare const inspectRootPreference: (inspection: unknown) => {
    provider: string;
    model: string;
    reasoningEffort?: string;
} | undefined;
export declare const inspectChildRecovery: (input: {
    parentSessionId: string;
    childId: string;
    inspection: unknown;
    catalog: unknown;
    notBefore?: number;
}) => ChildRecoveryEvidence;
