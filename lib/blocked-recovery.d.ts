import { type GateId } from './policy.js';
import type { DelegableRoleId } from './role-registry.js';
export type BlockedCause = 'provider-protocol' | 'route-exhausted' | 'planning-service' | 'no-progress' | 'missing-gate' | 'verification-gap' | 'unknown';
export interface BlockedRecoveryView {
    active: boolean;
    blocked: boolean;
    cause: BlockedCause;
    summary: string;
    evidence: string[];
    recommendedRoles: Array<{
        role: DelegableRoleId;
        reason: string;
    }>;
    nextAction: 'delegate-readonly-diagnosis' | 'switch-route' | 'delegate-gate' | 'revise-plan' | 'wait-external' | 'none';
    allowReadOnlyAutoDelegate: boolean;
    requiresUser: boolean;
}
interface RecoveryFailureInfo {
    kind: string;
    provider: string;
    model: string;
    message: string;
    code?: string;
    status?: number;
}
interface RecoveryStateInfo {
    terminal?: string;
    completed?: boolean;
    lastFailure?: RecoveryFailureInfo;
}
interface TaskStateInfo {
    acceptance?: {
        status: 'accepted' | 'blocked' | 'recorded';
        missing: string[];
        unresolved: string[];
    };
    checkpoint?: {
        convergence?: {
            blocked?: boolean;
        };
        unresolved?: string[];
        nextAction?: string;
    };
    planningReview?: {
        status?: string;
    };
}
interface GateStateInfo {
    gate: GateId;
    satisfied: boolean;
    missing?: string;
}
export interface BlockedRecoveryInputInfo {
    task: TaskStateInfo;
    gates: GateStateInfo[];
    recovery?: RecoveryStateInfo | null;
}
/**
 * 只根据当前任务、门禁和路由事实给出恢复处方。
 * 这里不自动执行工具，也不绕过任务门禁；天枢读取结果后再选择只读诊断或对应专家。
 */
export declare const getBlockedRecovery: (input: BlockedRecoveryInputInfo) => BlockedRecoveryView;
export {};
