export declare const EXECUTION_LANGUAGES: readonly ['python', 'node'];
export type ExecutionLanguage = (typeof EXECUTION_LANGUAGES)[number];
export interface ExecutionScope {
    projectId: string;
    ownerId: string;
}
export interface ExecutionKernelHandle {
    containerName: string;
    language: ExecutionLanguage;
    ownerPid: number;
}
export interface RuntimeStartRequest {
    scope: ExecutionScope;
    language: ExecutionLanguage;
    kernelId: string;
    limits: RuntimeLimits;
}
export interface RuntimeLimits {
    cpuCount: number;
    memoryBytes: number;
    pidsLimit: number;
}
export interface RuntimeExecutionRequest {
    code: string;
    timeoutMs: number;
    maxOutputBytes: number;
}
export interface ExecutionResult {
    ok: boolean;
    value?: unknown;
    stdout: string;
    stderr: string;
    error?: {
        type: string;
        message: string;
    };
    durationMs: number;
    timedOut?: boolean;
    resultTruncated?: boolean;
}
export interface ExecutionRuntime {
    readonly kind: string;
    start(request: RuntimeStartRequest): Promise<ExecutionKernelHandle>;
    execute(handle: ExecutionKernelHandle, request: RuntimeExecutionRequest): Promise<ExecutionResult>;
    inspect(handle: ExecutionKernelHandle): Promise<'running' | 'stopped' | 'missing'>;
    remove(handle: ExecutionKernelHandle): Promise<void>;
}
export type ExecutionErrorCode = 'INVALID_REQUEST' | 'SCOPE_MISMATCH' | 'KERNEL_NOT_FOUND' | 'KERNEL_BROKEN' | 'LEASE_EXPIRED' | 'FENCING_REJECTED' | 'CAPACITY_EXCEEDED' | 'LIMIT_EXCEEDED' | 'RUNTIME_UNAVAILABLE' | 'EXECUTION_TIMEOUT' | 'EXECUTION_IN_PROGRESS' | 'OUTCOME_UNKNOWN' | 'CANCELLED' | 'CREDENTIAL_REJECTED' | 'GRANT_EXPIRED' | 'GRANT_REVOKED' | 'UPSTREAM_UNAVAILABLE' | 'INTERNAL_ERROR' | 'PROTOCOL_ERROR';
export declare class ExecutionError extends Error {
    readonly code: ExecutionErrorCode;
    constructor(code: ExecutionErrorCode, message: string);
}
