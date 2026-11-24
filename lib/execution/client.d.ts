import type { ExecutionOperationStatus } from './pool.js';
import { ExecutionError, type ExecutionLanguage, type ExecutionResult, type ExecutionScope } from './runtime.js';
export type { ExecutionOperationStatus } from './pool.js';
export interface ExecutionDaemonRequestOptions {
    signal?: AbortSignal;
    /** Internal commit witness used to distinguish pre-wire cancellation from an uncertain execution. */
    onCommitted?: () => void;
}
export interface CancelExecutionInput {
    operationId: string;
}
export interface CancelExecutionResult {
    stopped: boolean;
    operationId?: string;
    kernelId?: string;
}
export interface ExecutionResultWithOperationId extends ExecutionResult {
    operationId: string;
}
export declare class ExecutionUncertainError extends ExecutionError {
    readonly operationId: string;
    readonly kernelId: string;
    readonly sideEffectState: 'unknown';
    readonly stopState: 'stopped' | 'unknown';
    readonly cause?: unknown;
    constructor(options: {
        operationId: string;
        kernelId: string;
        stopState: 'stopped' | 'unknown';
        cause?: unknown;
    });
}
export declare class ExecutionScopeBlockedError extends ExecutionError {
    readonly projectId: string;
    readonly operationId: string;
    readonly blockedOperationId: string;
    readonly sideEffectState: 'unknown';
    constructor(options: {
        projectId: string;
        operationId: string;
        blockedOperationId: string;
    });
}
export interface ExecutionDaemonTransportOptions {
    socketPath: string;
    requestTimeoutMs?: number;
}
export interface ExecutionDaemonClientOptions {
    socketPath: string;
    scope: ExecutionScope;
    requestTimeoutMs?: number;
}
export interface AcquireExecutionInput {
    language: ExecutionLanguage;
    leaseMs?: number;
    reuseKernelId?: string;
}
export interface ExecuteCellInput {
    code: string;
    timeoutMs?: number;
    operationId?: string;
    signal?: AbortSignal;
}
export interface ExecutionKernelLease {
    kernelId: string;
    containerName: string;
    language: ExecutionLanguage;
    leaseId: string;
    fence: number;
    leaseExpiresAt: number;
    isDirty: boolean;
}
export interface ExecutionKernelInspection extends ExecutionKernelLease {
    projectId: string;
    ownerId: string;
    state: 'warm' | 'claimed' | 'broken';
}
export interface ExecutionDaemonHealth {
    status: 'ok';
    protocolVersion: number;
    pid: number;
}
export interface ExecutionCapabilities {
    protocolVersion: number;
    languages: ExecutionLanguage[];
    credentialProxy: boolean;
    runtime?: unknown;
}
export interface IssueExecutionCredentialInput {
    credentialName: string;
    ttlMs: number;
}
export interface ExecutionCredentialGrant {
    grantId: string;
    token: string;
    credentialName: string;
    allowedOrigin: string;
    expiresAt: number;
}
export declare class ExecutionDaemonTransport {
    readonly socketPath: string;
    private readonly requestTimeoutMs;
    constructor(options: ExecutionDaemonTransportOptions | string);
    request<T>(operation: string, payload: unknown, options?: ExecutionDaemonRequestOptions): Promise<T>;
}
export declare class ExecutionDaemonClient {
    readonly socketPath: string;
    private readonly scope;
    private readonly transport;
    constructor(options: ExecutionDaemonClientOptions);
    health(): Promise<ExecutionDaemonHealth>;
    capabilities(): Promise<ExecutionCapabilities>;
    acquire(input: AcquireExecutionInput): Promise<ExecutionKernelLease>;
    private cancelInternal;
    execute(leaseValue: ExecutionKernelLease, input: ExecuteCellInput): Promise<ExecutionResultWithOperationId>;
    cancel(leaseValue: ExecutionKernelLease, input: CancelExecutionInput): Promise<CancelExecutionResult>;
    operationStatus(operationIdValue: string): Promise<ExecutionOperationStatus>;
    inspect(kernelId: string): Promise<ExecutionKernelInspection>;
    release(leaseValue: ExecutionKernelLease): Promise<ExecutionKernelLease>;
    listKernels(): Promise<ExecutionKernelInspection[]>;
    issueCredential(input: IssueExecutionCredentialInput): Promise<ExecutionCredentialGrant>;
    revokeCredential(grantId: string): Promise<void>;
}
