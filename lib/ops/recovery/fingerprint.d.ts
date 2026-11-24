import type { FailureEvent } from './schema.js';
export declare const getFailureFingerprint: (event: FailureEvent) => {
    fingerprint: string;
    canonicalJson: string;
};
