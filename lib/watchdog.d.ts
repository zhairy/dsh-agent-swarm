export interface WatchdogConfig {
    heartbeatMs: number;
    suspectAfterMisses: number;
    inputRetryBaseMs: number;
    inputRetryMaxMs: number;
    quarantineOnUnknownWrite: boolean;
}
export declare const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig;
export interface WatchdogAssignment {
    id: string;
    ticketId: string;
    state: 'queued' | 'running' | 'ended';
    startedAt: number;
    lastHeartbeatAt?: number;
    unknownSideEffect?: boolean;
}
export interface PendingInput {
    id: string;
    firstAttemptAt: number;
    attempts: number;
    lastError?: string;
}
export interface WatchdogTicket {
    id: string;
    activeAssignmentId?: string;
    pendingInputs: PendingInput[];
    leaseExpiresAt?: number;
    quarantined?: boolean;
}
export interface WatchdogInput {
    now: number;
    assignments: readonly WatchdogAssignment[];
    tickets: readonly WatchdogTicket[];
    config?: Partial<WatchdogConfig>;
}
export interface WatchdogAlert {
    id: string;
    severity: 'info' | 'warning' | 'critical';
    kind: 'stale-assignment' | 'input-delivery' | 'lease-expired' | 'unknown-side-effect';
    ticketId?: string;
    assignmentId?: string;
    detail: string;
}
/** Inspect persisted facts only; the watchdog never launches a new write or replays an assignment. */
export declare const inspectWatchdog: (input: WatchdogInput) => {
    alerts: WatchdogAlert[];
    quarantineTicketIds: string[];
};
export interface SwarmWatchdog {
    evaluate: (input: Omit<WatchdogInput, 'config'>) => ReturnType<typeof inspectWatchdog>;
    updateConfig: (value: Partial<WatchdogConfig>) => void;
}
export declare const createSwarmWatchdog: (options?: {
    config?: Partial<WatchdogConfig>;
    onAlert?: (alert: WatchdogAlert) => void;
}) => SwarmWatchdog;
