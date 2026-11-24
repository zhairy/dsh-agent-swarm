/** A bounded execution queue. It schedules requests; workflow admission remains authoritative. */
export declare const SCHEDULING_STRATEGIES: readonly ['fifo', 'priority', 'roundRobin'];
export type SchedulingStrategy = typeof SCHEDULING_STRATEGIES[number];
export interface SchedulingOptions {
    strategy: SchedulingStrategy;
    maxActive: number;
    maxPending: number;
}
export declare const DEFAULT_SCHEDULING_OPTIONS: SchedulingOptions;
export declare class SchedulerError extends Error {
    readonly code: 'SCHEDULER_FULL' | 'SCHEDULER_CLOSED' | 'SCHEDULER_INVALID';
    constructor(code: 'SCHEDULER_FULL' | 'SCHEDULER_CLOSED' | 'SCHEDULER_INVALID', message: string);
}
export interface DelegationScheduler {
    run: <T>(work: () => T | Promise<T>, input: {
        group: string;
        priority?: number;
        signal?: AbortSignal;
    }) => Promise<T>;
    status: () => {
        strategy: SchedulingStrategy;
        active: number;
        pending: number;
        maxActive: number;
        maxPending: number;
        disposed: boolean;
    };
    /** Cancels only queued requests; already started work remains owned by its original signal. */
    dispose: () => void;
}
export declare const createDelegationScheduler: (input?: {
    getOptions?: () => SchedulingOptions;
}) => DelegationScheduler;
