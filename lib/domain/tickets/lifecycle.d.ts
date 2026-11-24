import type { DelegationRecord, TaskRecord } from '../../evidence.js';
export declare const ACCEPT_MODES: readonly ['off', 'observe', 'auto'];
export type AcceptMode = typeof ACCEPT_MODES[number];
export type MandateStrength = 'explicit' | 'inferred';
export interface Mandate {
    id: string;
    strength: MandateStrength;
    policyVersion: string;
    scope: string[];
    matchedRules: string[];
    originTriggerId: string;
    createdAt: number;
    expiresAt?: number;
}
export interface AdmissionRequest {
    mode: AcceptMode;
    strength: MandateStrength;
    matchedRules: readonly string[];
    enabledRules: readonly string[];
    budgetAvailable: boolean;
    hostPermitted: boolean;
}
export type AdmissionDecision = {
    kind: 'accept';
    mandateRequired: true;
} | {
    kind: 'observe';
    wouldAccept: true;
    reason: 'observe-mode';
} | {
    kind: 'ignore';
    reason: 'off-mode' | 'no-matched-rule' | 'budget-exhausted' | 'host-denied';
};
export type TicketStage = {
    stage: 'created';
} | {
    stage: 'person';
    action: 'blocked' | 'failed' | 'review';
} | {
    stage: 'working';
    action: 'queued' | 'running';
} | {
    stage: 'idle';
} | {
    stage: 'ended';
    outcome: 'accepted' | 'rejected' | 'incomplete';
};
export interface TicketProjection {
    ticketId: string;
    title: string;
    stage: TicketStage;
    revisions: {
        request: number;
        card: number;
        workflow: number;
    };
    assignmentIds: string[];
    activeAssignmentId?: string;
    canRetry: boolean;
    mandate?: Mandate;
}
/** Stable projection key used by the event journal and migration manifest. */
export declare const getTicketStageKey: (stage: TicketProjection['stage']) => string;
/** Decide proactive admission without granting any host or workspace permission. */
export declare const evaluateProactiveAdmission: (request: AdmissionRequest) => AdmissionDecision;
/** A resumed or queued inferred ticket must still satisfy the current policy. */
export declare const revalidateMandate: (mandate: Mandate, current: Pick<AdmissionRequest, 'mode' | 'enabledRules'>, at: number) => boolean;
/** Project the existing task/delegation records into the v3.2.0 ticket lifecycle. */
export declare const projectTicketLifecycle: (task: TaskRecord, delegations: readonly DelegationRecord[]) => TicketProjection;
