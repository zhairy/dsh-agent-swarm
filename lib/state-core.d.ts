export declare class StateStoreError extends Error {
    readonly code: 'RECOVERY_REQUIRED' | 'STATE_INVALID' | 'STATE_TOO_LARGE' | 'STORE_CLOSED' | 'OWNER_ACTIVE';
    constructor(code: 'RECOVERY_REQUIRED' | 'STATE_INVALID' | 'STATE_TOO_LARGE' | 'STORE_CLOSED' | 'OWNER_ACTIVE', message: string);
}
/**
 * Reject non-JSON, accessors and credential fields before persistence; never silently redact recovery state.
 * 每次提交/分片编码都走这里：分片级增量提交与全量提交共享同一套安全与规范性检查。
 */
export declare const canonicalStateJson: (value: unknown) => string;
export declare const checksumText: (text: string) => string;
export declare const checksum: (value: unknown) => string;
/**
 * Deep-freeze one already-validated plain JSON value; frozen snapshots make reference identity a safe change signal.
 * 已冻结的值直接返回：分片值在编码时已递归冻结，容器级冻结因此只需遍历顶层段。
 */
export declare const deepFreeze: <T>(value: T) => T;
