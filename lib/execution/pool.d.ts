import { type ExecutionErrorCode, type ExecutionLanguage, type ExecutionResult, type ExecutionRuntime, type ExecutionScope, type RuntimeLimits } from './runtime.js';
interface KernelRecord {
    kernelId: string;
    containerName: string;
    language: ExecutionLanguage;
    projectId: string;
    ownerId: string;
    isDirty: boolean;
    state: 'warm' | 'claimed' | 'broken';
    stopped?: boolean;
    fence: number;
    leaseId?: string;
    leaseExpiresAt?: number;
    createdAt: number;
    lastUsedAt: number;
}
export interface OperationStatusInput {
    scope: ExecutionScope;
    operationId: string;
}
export interface CancelExecutionInput extends OperationStatusInput {
    kernelId: string;
}
export interface ExecutionOperationStatus {
    operationId: string;
    kernelId?: string;
    state: 'running' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
    found?: boolean;
    resultExpired?: boolean;
    startedAt?: number;
    completedAt?: number;
    result?: ExecutionResult;
    resultDigest?: string;
    resultTruncated?: boolean;
    error?: {
        code: ExecutionErrorCode;
        message: string;
    };
    stopped?: boolean;
}
export interface ExecutionPoolLimits extends RuntimeLimits {
    maxCodeBytes: number;
    maxOutputBytes: number;
}
export interface ExecutionPoolOptions {
    runtime: ExecutionRuntime;
    statePath: string;
    totalCapacity: number;
    perScopeCapacity: number;
    defaultLeaseMs: number;
    maxLeaseMs: number;
    defaultWallClockMs?: number;
    maxWallClockMs?: number;
    limits?: Partial<ExecutionPoolLimits>;
    clock: () => number;
    advanceClock?: (milliseconds: number) => void;
}
export interface ExecutionLease {
    kernelId: string;
    containerName: string;
    language: ExecutionLanguage;
    leaseId: string;
    fence: number;
    leaseExpiresAt: number;
    isDirty: boolean;
}
export interface ClaimExecutionInput {
    scope: ExecutionScope;
    language: ExecutionLanguage;
    leaseMs?: number;
}
export interface WarmExecutionInput {
    scope: ExecutionScope;
    language: ExecutionLanguage;
    count: number;
}
export interface ExecuteInput {
    operationId: string;
    scope: ExecutionScope;
    kernelId: string;
    leaseId: string;
    fence: number;
    language: ExecutionLanguage;
    code: string;
    timeoutMs?: number;
}
export interface ReleaseExecutionInput {
    scope: ExecutionScope;
    kernelId: string;
    leaseId: string;
    fence: number;
}
export interface ReconnectExecutionInput {
    scope: ExecutionScope;
    kernelId: string;
    leaseMs?: number;
}
export interface ExecutionKernelSummary extends ExecutionLease {
    projectId: string;
    ownerId: string;
    state: KernelRecord['state'];
}
export interface ExecutionPool {
    claim(input: ClaimExecutionInput): Promise<ExecutionLease>;
    warm(input: WarmExecutionInput): Promise<ExecutionKernelSummary[]>;
    execute(input: ExecuteInput): Promise<ExecutionResult>;
    operationStatus(input: OperationStatusInput): Promise<ExecutionOperationStatus>;
    cancel(input: CancelExecutionInput): Promise<{
        stopped: true;
    }>;
    release(input: ReleaseExecutionInput): Promise<ExecutionLease>;
    reconnect(input: ReconnectExecutionInput): Promise<ExecutionLease>;
    list(scope: ExecutionScope): Promise<ExecutionKernelSummary[]>;
    shutdown(options?: {
        removeKernels?: boolean;
    }): Promise<void>;
}
export declare const createExecutionPool: (options: ExecutionPoolOptions) => Promise<ExecutionPool>;
export {};
