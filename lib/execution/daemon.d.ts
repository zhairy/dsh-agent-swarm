import type { CredentialBroker } from './credential-broker.js';
import type { ExecutionPool } from './pool.js';
export interface ExecutionDaemonLogger {
    info(message: string, context?: Record<string, unknown>): void;
    error(message: string, context?: Record<string, unknown>): void;
}
export interface ExecutionDaemonOptions {
    runtimeDirectory: string;
    pool: ExecutionPool;
    credentialBroker?: CredentialBroker;
    capabilities?: () => Promise<unknown>;
    logger?: ExecutionDaemonLogger;
    shutdownRuntime?: (options: {
        removeKernels: boolean;
    }) => Promise<void>;
}
export interface ExecutionDaemonPaths {
    runtimeDirectory: string;
    controlSocketPath: string;
    proxySocketPath: string;
}
export interface ExecutionDaemon {
    start(): Promise<ExecutionDaemonPaths>;
    close(options?: {
        removeKernels?: boolean;
    }): Promise<void>;
}
export declare const createExecutionDaemon: (options: ExecutionDaemonOptions) => ExecutionDaemon;
