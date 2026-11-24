import { type ExecutionScope } from './runtime.js';
export interface CredentialGrantConfig {
    name: string;
    origin: string;
    secret: string;
    allowedMethods?: string[];
    allowedPathPrefixes?: string[];
}
export interface CredentialBrokerOptions {
    clock: () => number;
    fetchImpl: typeof fetch;
    grants: CredentialGrantConfig[];
    upstreamTimeoutMs?: number;
    maxResponseBytes?: number;
}
export interface CredentialGrant {
    grantId: string;
    token: string;
    credentialName: string;
    allowedOrigin: string;
    expiresAt: number;
}
export interface ProxyCredentialInput {
    scope: ExecutionScope;
    token: string;
    method: string;
    path: string;
    body?: string;
    contentType?: string;
}
export interface ProxyCredentialResult {
    status: number;
    headers: Record<string, string>;
    body: unknown;
}
export declare class CredentialBroker {
    private readonly clock;
    private readonly fetchImpl;
    private readonly credentials;
    private readonly grantsByTokenHash;
    private readonly grantsById;
    private readonly upstreamTimeoutMs;
    private readonly maxResponseBytes;
    constructor(options: CredentialBrokerOptions);
    issue(input: {
        scope: ExecutionScope;
        credentialName: string;
        ttlMs: number;
    }): Promise<CredentialGrant>;
    proxy(input: ProxyCredentialInput): Promise<ProxyCredentialResult>;
    revoke(input: {
        scope: ExecutionScope;
        grantId: string;
    }): Promise<void>;
}
