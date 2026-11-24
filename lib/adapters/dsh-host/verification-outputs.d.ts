import type { AgentLike, PluginContextLike } from '../../host-contract.js';
export type VerificationOutputErrorCode = 'VERIFICATION_OUTPUT_INVALID' | 'VERIFICATION_OUTPUT_BOUNDARY_REQUIRED' | 'VERIFICATION_OUTPUT_POLICY_DENIED' | 'VERIFICATION_OUTPUT_POLICY_CHANGED' | 'VERIFICATION_OUTPUT_PATH_REJECTED' | 'VERIFICATION_OUTPUT_REPORT_EXISTS' | 'VERIFICATION_OUTPUT_IDENTITY_REJECTED' | 'VERIFICATION_OUTPUT_ALIAS_REJECTED' | 'VERIFICATION_OUTPUT_CANCELLED' | 'VERIFICATION_OUTPUT_FAILED';
export interface VerificationOutputRequest {
    repositoryRoot: string;
    attemptId: string;
}
export interface VerificationOutputDirectoryIdentity {
    path: string;
    type: 'directory' | 'file';
    identity: string;
}
export interface VerificationOutputResult {
    temporaryRoot: string;
    reportRoot: string;
    attemptKey: string;
    directoryIdentity: {
        repositoryRoot: string;
        temporaryRoot: string;
        reportRoot: string;
        reportParent: string;
        gitEntryPath: string;
        gitPath: string;
        gitType: 'directory';
    };
    identities: {
        repositoryRoot: VerificationOutputDirectoryIdentity;
        gitEntry: VerificationOutputDirectoryIdentity;
        gitPath: VerificationOutputDirectoryIdentity;
        temporaryRoot: VerificationOutputDirectoryIdentity;
        reportParent: VerificationOutputDirectoryIdentity;
        reportRoot: VerificationOutputDirectoryIdentity;
    };
    writeScopes: readonly [string, string];
    protectedRoots: readonly [string, string];
    policyFingerprint: string;
}
export interface VerificationOutputPort {
    prepare: (agent: AgentLike, request: VerificationOutputRequest, signal: AbortSignal) => Promise<VerificationOutputResult>;
}
interface VerificationOutputErrorOptions {
    cause?: unknown;
    uncertain?: boolean;
}
export declare class VerificationOutputError extends Error {
    readonly code: VerificationOutputErrorCode;
    readonly uncertain: boolean;
    constructor(code: VerificationOutputErrorCode, message: string, options?: VerificationOutputErrorOptions);
}
export declare const createVerificationOutputPort: (ctx: PluginContextLike) => VerificationOutputPort;
export {};
