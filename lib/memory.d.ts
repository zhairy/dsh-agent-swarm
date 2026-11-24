import type { ExperienceEntry } from './experience.js';
export interface MemoryQuery {
    text?: string;
    problemClass?: string;
    excludeTaskId?: string;
    maxMatches?: number;
    maxChars?: number;
    maxAgeMs?: number;
}
export interface MemoryReference {
    id: string;
    problemClass: string;
    summary: string;
    summaryTruncated: boolean;
    source: ExperienceEntry['source'];
    appliesWhen: string[];
    doesNotApplyWhen: string[];
    verification: string[];
    counterexamples: string[];
    operatorVersions: string[];
    reviewer: string;
    reviewArtifactDigest: string;
    createdAt: number;
    expiresAt: number;
    applicabilityUnverified: true;
}
export interface MemoryQueryResult {
    matches: MemoryReference[];
    totalChars: number;
    truncated: boolean;
    requiresVerification: true;
    retrieval: 'bounded-lexical';
}
/** Local lexical hints, never embeddings, current evidence, model output reuse or proof. */
export declare const queryReviewedExperiences: (entries: readonly ExperienceEntry[], query: MemoryQuery, now?: number) => MemoryQueryResult;
/** JSON is quoted reference material, never an instruction or current acceptance result. */
export declare const formatMemoryReferences: (result: MemoryQueryResult) => string;
/** Exact path deduplication only; it does not claim aliases/symlinks are identical. */
export declare const deduplicateContextPaths: (paths: readonly string[]) => string[];
