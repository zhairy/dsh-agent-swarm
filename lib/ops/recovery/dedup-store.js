import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { emptyBudget, validateBudget, validateReviewReport } from './schema.js';
export const FAILURE_BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];
const iso = (now) => {
    if (!Number.isSafeInteger(now) || now < 0)
        throw new Error('RECOVERY_STORE: invalid clock');
    return new Date(now).toISOString();
};
const outcomeOf = (raw) => {
    if (raw === null)
        return {};
    try {
        const value = JSON.parse(raw);
        if (value !== null && typeof value === 'object' && !Array.isArray(value))
            return value;
    }
    catch (error) {
        if (!(error instanceof SyntaxError))
            throw error;
    }
    // last_outcome 的 SQL 合同是 TEXT，普通原因是合法值，不代表损坏的待交回记录。
    return { reason: raw };
};
/** 仅新作用域数据库使用该迁移；所有状态结算均检查 claim token，不恢复旧写权。 */
export const createDedupStore = (file) => {
    if (resolve(file) !== file || realpathSync.native(dirname(file)) !== dirname(file)
        || existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1))
        throw new Error('RECOVERY_STORE: noncanonical database path');
    const db = new DatabaseSync(file);
    try {
        chmodSync(file, 0o600);
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
        db.exec('BEGIN IMMEDIATE');
        const version = db.prepare('PRAGMA user_version').get();
        if (version.user_version === 0) {
            const sql = readFileSync(new URL('./migrations/0001_failure_dedup.sql', import.meta.url), 'utf8');
            db.exec(sql.slice(sql.indexOf('CREATE TABLE')));
            db.exec('PRAGMA user_version=1');
        }
        else if (version.user_version !== 1)
            throw new Error('unsupported recovery schema version');
        db.exec('COMMIT');
    }
    catch (error) {
        db.close();
        throw new Error(`RECOVERY_STORE: initialize ${file}`, { cause: error });
    }
    const get = (fingerprint) => db.prepare('SELECT fingerprint, failure_kind, canonical_json, first_seen_at, last_seen_at, occurrence_count, status, claim_token, claimed_at, attempt_count, next_eligible_at, last_outcome, last_repair_task_id, budget_consumed_json FROM failure_dedup WHERE fingerprint=?').get(fingerprint);
    const transaction = (work) => {
        db.exec('BEGIN IMMEDIATE');
        try {
            const result = work();
            db.exec('COMMIT');
            return result;
        }
        catch (error) {
            db.exec('ROLLBACK');
            throw new Error(`RECOVERY_STORE: transaction ${file}`, { cause: error });
        }
    };
    const owned = (fingerprint, token) => {
        const row = get(fingerprint);
        if (row?.status !== 'claimed' || row.claim_token !== token || token.length === 0)
            throw new Error('RECOVERY_STORE: stale claim token or illegal transition');
        return row;
    };
    const budgetJson = (row, raw) => {
        const budget = validateBudget(raw), previous = row.budget_consumed_json === null ? emptyBudget() : validateBudget(JSON.parse(row.budget_consumed_json));
        if (['wall_ms', 'tool_calls', 'writes', 'write_bytes', 'retries'].some(k => budget[k] < previous[k]))
            throw new Error('RECOVERY_STORE: cannot refund consumed budget');
        return JSON.stringify(budget);
    };
    const finish = (fingerprint, token, status, budget, reason, now, next, report) => transaction(() => {
        const row = owned(fingerprint, token), encoded = budgetJson(row, budget);
        const outcome = JSON.stringify({ retryCounts: outcomeOf(row.last_outcome).retryCounts, reason: reason.slice(0, 16384), ...(report === undefined ? {} : { report: validateReviewReport(report), handoff: status === 'succeeded' ? 'pending' : 'none', handoffKey: `repair:${token}` }) });
        const result = db.prepare('UPDATE failure_dedup SET status=?, claim_token=NULL, claimed_at=NULL, next_eligible_at=?, last_outcome=?, budget_consumed_json=?, updated_at=? WHERE fingerprint=? AND status=\'claimed\' AND claim_token=?')
            .run(status, next === null ? null : iso(next), outcome, encoded, iso(now), fingerprint, token);
        if (Number(result.changes) !== 1)
            throw new Error('RECOVERY_STORE: owner lost');
    });
    return {
        get,
        lastReport: (fingerprint) => {
            const value = outcomeOf(get(fingerprint)?.last_outcome ?? null).report;
            return value === undefined ? undefined : validateReviewReport(value);
        },
        retryCounts: (fingerprint) => outcomeOf(get(fingerprint)?.last_outcome ?? null).retryCounts,
        assertClaim: (fingerprint, token) => { owned(fingerprint, token); },
        observe: (input, now) => {
            if (!/^[a-f0-9]{64}$/.test(input.fingerprint) || createHash('sha256').update(input.canonicalJson).digest('hex') !== input.fingerprint || input.canonicalJson.length > 65536)
                throw new Error('RECOVERY_STORE: invalid fingerprint/canonical JSON');
            const when = iso(now);
            db.prepare('INSERT INTO failure_dedup (fingerprint,failure_kind,canonical_json,first_seen_at,last_seen_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(fingerprint) DO UPDATE SET last_seen_at=excluded.last_seen_at, occurrence_count=failure_dedup.occurrence_count+1, updated_at=excluded.updated_at')
                .run(input.fingerprint, input.failureKind, input.canonicalJson, when, when, when, when);
            return get(input.fingerprint);
        },
        claim: (fingerprint, now) => transaction(() => {
            const when = iso(now), token = randomUUID();
            const before = get(fingerprint), outcome = outcomeOf(before?.last_outcome ?? null);
            if (before?.status === 'succeeded' && before.next_eligible_at !== null && before.next_eligible_at <= when && outcome.handoff !== 'pending') {
                // 成功后的 24h 是新修复 episode；冷却内不重置，失败重试也不重置预算。
                db.prepare('UPDATE failure_dedup SET status=\'pending\',attempt_count=0,budget_consumed_json=NULL,last_outcome=?,updated_at=? WHERE fingerprint=? AND status=\'succeeded\'').run(JSON.stringify({ reason: 'new episode after successful cooldown', retryCounts: {} }), when, fingerprint);
            }
            else if (before?.status === 'failed' && before.next_eligible_at !== null && before.next_eligible_at <= when) {
                db.prepare('UPDATE failure_dedup SET status=\'pending\',updated_at=? WHERE fingerprint=? AND status=\'failed\'').run(when, fingerprint);
            }
            const result = db.prepare('UPDATE failure_dedup SET status=\'claimed\', claim_token=?, claimed_at=?, attempt_count=attempt_count+1, updated_at=?, last_repair_task_id=? WHERE fingerprint=? AND status=\'pending\' AND (next_eligible_at IS NULL OR next_eligible_at<=?)').run(token, when, when, `repair:${token}`, fingerprint, when);
            return Number(result.changes) === 1 ? get(fingerprint) : undefined;
        }),
        checkpoint: (fingerprint, token, budget, now, retryCounts) => transaction(() => {
            const row = owned(fingerprint, token), encoded = budgetJson(row, budget), previous = outcomeOf(row.last_outcome);
            if (retryCounts !== undefined && (Object.keys(retryCounts).length > 256 || Object.entries(retryCounts).some(([key, n]) => key.length > 256 || !Number.isSafeInteger(n) || n < 0)
                || Object.values(retryCounts).reduce((sum, n) => sum + n, 0) !== budget.retries))
                throw new Error('RECOVERY_STORE: invalid retry ledger');
            const result = db.prepare('UPDATE failure_dedup SET budget_consumed_json=?,last_outcome=?,updated_at=? WHERE fingerprint=? AND status=\'claimed\' AND claim_token=?').run(encoded, JSON.stringify({ ...previous, ...(retryCounts === undefined ? {} : { retryCounts }) }), iso(now), fingerprint, token);
            if (Number(result.changes) !== 1)
                throw new Error('RECOVERY_STORE: owner lost');
        }),
        succeed: (fingerprint, token, budget, reason, now, report) => finish(fingerprint, token, 'succeeded', budget, reason, now, now + 86_400_000, report),
        fail: (fingerprint, token, budget, reason, now, report) => {
            const row = owned(fingerprint, token), attempt = row.attempt_count;
            finish(fingerprint, token, attempt >= 5 ? 'manual_required' : 'failed', budget, reason, now, now + FAILURE_BACKOFF_MS[Math.min(attempt - 1, 4)], report);
        },
        manual: (fingerprint, token, budget, reason, now, report) => finish(fingerprint, token, 'manual_required', budget, reason, now, null, report),
        release: (fingerprint, token, noActionStarted, now) => {
            if (noActionStarted !== true)
                throw new Error('RECOVERY_STORE: release requires confirmed unsent work');
            const row = owned(fingerprint, token);
            finish(fingerprint, token, 'pending', row.budget_consumed_json === null ? emptyBudget() : validateBudget(JSON.parse(row.budget_consumed_json)), 'unsent claim released', now, null);
        },
        expireStaleClaims: (now) => now < 900_000 ? 0 : Number(db.prepare('UPDATE failure_dedup SET status=\'manual_required\', claim_token=NULL, last_outcome=\'stale claim: side effects unknown, no automatic takeover\', updated_at=? WHERE status=\'claimed\' AND claimed_at<=?').run(iso(now), iso(now - 900_000)).changes),
        pendingHandoffs: () => {
            const rows = db.prepare('SELECT fingerprint,last_outcome FROM failure_dedup WHERE status=\'succeeded\'').all();
            return rows.flatMap(row => {
                const outcome = outcomeOf(row.last_outcome);
                return outcome.handoff === 'pending' && typeof outcome.handoffKey === 'string' ? [{ fingerprint: row.fingerprint, key: outcome.handoffKey, report: validateReviewReport(outcome.report) }] : [];
            });
        },
        acknowledgeHandoff: (fingerprint, key, now) => transaction(() => {
            const row = get(fingerprint);
            if (row?.status !== 'succeeded' || row.last_repair_task_id !== key || row.last_outcome === null)
                throw new Error('RECOVERY_STORE: stale handoff');
            const outcome = JSON.parse(row.last_outcome);
            if (outcome.handoffKey !== key)
                throw new Error('RECOVERY_STORE: handoff key mismatch');
            db.prepare('UPDATE failure_dedup SET last_outcome=?,updated_at=? WHERE fingerprint=? AND status=\'succeeded\' AND last_repair_task_id=?').run(JSON.stringify({ ...outcome, handoff: 'delivered' }), iso(now), fingerprint, key);
        }),
        close: () => db.close()
    };
};
//# sourceMappingURL=dedup-store.js.map