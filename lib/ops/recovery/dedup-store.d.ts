import { type BudgetConsumed, type ReviewReport } from './schema.js';
export type DedupStatus = 'pending' | 'claimed' | 'succeeded' | 'failed' | 'manual_required';
export interface DedupRow {
    fingerprint: string;
    failure_kind: string;
    canonical_json: string;
    first_seen_at: string;
    last_seen_at: string;
    occurrence_count: number;
    status: DedupStatus;
    claim_token: string | null;
    claimed_at: string | null;
    attempt_count: number;
    next_eligible_at: string | null;
    last_outcome: string | null;
    last_repair_task_id: string | null;
    budget_consumed_json: string | null;
}
export interface DedupClaim extends DedupRow {
    claim_token: string;
}
export declare const FAILURE_BACKOFF_MS: readonly [60000, 300000, 1800000, 7200000, 21600000];
/** 仅新作用域数据库使用该迁移；所有状态结算均检查 claim token，不恢复旧写权。 */
export declare const createDedupStore: (file: string) => {
    get: (fingerprint: string) => DedupRow | undefined;
    lastReport: (fingerprint: string) => ReviewReport | undefined;
    retryCounts: (fingerprint: string) => Record<string, number> | undefined;
    assertClaim: (fingerprint: string, token: string) => void;
    observe: (input: {
        fingerprint: string;
        canonicalJson: string;
        failureKind: string;
    }, now: number) => DedupRow;
    claim: (fingerprint: string, now: number) => DedupClaim | undefined;
    checkpoint: (fingerprint: string, token: string, budget: BudgetConsumed, now: number, retryCounts?: Record<string, number>) => void;
    succeed: (fingerprint: string, token: string, budget: BudgetConsumed, reason: string, now: number, report?: ReviewReport) => void;
    fail: (fingerprint: string, token: string, budget: BudgetConsumed, reason: string, now: number, report?: ReviewReport) => void;
    manual: (fingerprint: string, token: string, budget: BudgetConsumed, reason: string, now: number, report?: ReviewReport) => void;
    release: (fingerprint: string, token: string, noActionStarted: boolean, now: number) => void;
    expireStaleClaims: (now: number) => number;
    pendingHandoffs: () => Array<{
        fingerprint: string;
        key: string;
        report: ReviewReport;
    }>;
    acknowledgeHandoff: (fingerprint: string, key: string, now: number) => void;
    close: () => void;
};
export type DedupStore = ReturnType<typeof createDedupStore>;
