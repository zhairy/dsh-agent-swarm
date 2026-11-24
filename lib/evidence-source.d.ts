import type { ObservedExternalSource } from './evidence-assessment.js';
export declare class EvidenceSourceError extends Error {
    readonly code: 'SOURCE_URL_REJECTED' | 'SOURCE_ADDRESS_REJECTED' | 'SOURCE_REDIRECT_REJECTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_TOO_LARGE' | 'SOURCE_CONTENT_UNSUPPORTED';
    constructor(code: 'SOURCE_URL_REJECTED' | 'SOURCE_ADDRESS_REJECTED' | 'SOURCE_REDIRECT_REJECTED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_TOO_LARGE' | 'SOURCE_CONTENT_UNSUPPORTED', message: string);
}
export interface EvidenceSourcePolicy {
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    now?: () => number;
    /** Test/host DNS adapter; every returned address is still subjected to the public-address policy. */
    resolveAddresses?: (hostname: string) => Promise<Array<{
        address: string;
        family: number;
    }>>;
}
/** Conservative globally routable destination policy, including IPv4-in-IPv6/tunnel exclusions. */
export declare const isPublicEvidenceAddress: (address: string) => boolean;
export declare const validateEvidenceSourceUrl: (input: string) => URL;
/** Parse text without executing scripts, fetching subresources, cookies or external resource loaders. */
export declare const extractEvidenceSourceText: (body: string, contentType: string) => string;
/** DNS is validated and pinned for each redirect hop; environment proxy agents and credentials are not inherited. */
export declare const createPublicEvidenceSourceResolver: (policy?: EvidenceSourcePolicy) => ((input: string, signal?: AbortSignal) => Promise<ObservedExternalSource>);
