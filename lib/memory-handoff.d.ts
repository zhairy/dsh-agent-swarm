import { type StateValidationResult } from './state-store.js';
declare const SOURCE_VERSIONS: readonly ['2.3.0', '2.3.1', '2.3.2', '2.4.0', '2.9.0', '2.9.2', '3.1.0', '3.1.1', '3.1.2', '3.1.3', '3.1.4'];
export type MemoryHandoffSourceVersion = typeof SOURCE_VERSIONS[number];
export interface MemoryHandoffEnvelope<T> {
    schemaVersion: 1;
    sourceVersion: MemoryHandoffSourceVersion;
    rootSessionId: string;
    workspaceId: string;
    checksum: string;
    state: T;
}
export interface LoadedMemoryHandoff<T> {
    state: T;
    sourceVersion: MemoryHandoffSourceVersion;
    /** Call only after the feature session and host recovery initialize successfully. */
    commitConsumption: () => Promise<string>;
}
export interface MemoryHandoffInput {
    dshHome: string;
    rootSessionId: string;
    workspaceId: string;
    persistenceEnabled: boolean;
    validate: (raw: unknown) => StateValidationResult;
}
/** Trusted maintenance code can use the exact envelope format without exposing a new tool/RPC. */
export declare const createMemoryHandoffEnvelope: <T>(input: Pick<MemoryHandoffInput, 'rootSessionId' | 'workspaceId'> & {
    state: T;
    sourceVersion: MemoryHandoffSourceVersion;
}) => MemoryHandoffEnvelope<T>;
/** A deliberately narrow, one-time bridge for an explicitly staged supported in-memory source session.
 * No caller-controlled filename, automatic normalization or durable-state replacement is accepted. */
export declare const loadMemoryHandoff: <T>(input: MemoryHandoffInput) => Promise<LoadedMemoryHandoff<T> | undefined>;
export {};
