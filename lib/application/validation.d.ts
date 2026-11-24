import type { AcceptanceRecord, AssessmentInfo } from '../evidence.js';
import { getAcceptanceCheck, type FindingResolution } from '../policy.js';
export interface AcceptInputInfo {
    task_id: string;
    decision: 'accept' | 'reject' | 'incomplete';
    summary: string;
    unresolved: string[];
    stopReason: string;
    findingResolutions: FindingResolution[];
    verification_token?: string;
}
export interface AcceptResultInfo {
    task_id: string;
    status: AcceptanceRecord['status'];
    missing: string[];
    roundsUsed: number;
    maxAutoFixRounds: number;
    gates: ReturnType<typeof getAcceptanceCheck>['statuses'];
    assessment?: AssessmentInfo;
    completionScope?: 'phase' | 'request';
    deferred?: string[];
    verification_token?: string;
}
export declare const ValidateAcceptInput: (raw: unknown) => {
    input?: AcceptInputInfo;
    errors: string[];
};
