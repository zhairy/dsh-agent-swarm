import type { TaskStore } from './evidence.js';
import type { SwarmEventJournal } from './event-journal.js';
import type { AuthorizationDecision } from './authorization-wait.js';
export interface StateImportInput {
    journal: SwarmEventJournal;
    store: Pick<TaskStore, 'getTasks' | 'getTaskDelegations'>;
    rootSessionId: string;
    workspaceId: string;
    sourcePath: string;
    schemaVersion: number;
    now?: () => Date;
    /** The one-time migration writes a manifest; subsequent post-commit projection syncs do not. */
    writeManifest?: boolean;
    /** Initial migration backups; the importer copies these before publishing the manifest. */
    backupPaths?: readonly string[];
    authorizationDecisions?: Readonly<Record<string, AuthorizationDecision>>;
}
export interface StateImportReport {
    sourceDigest: string;
    imported: number;
    skipped: number;
    mapping: Array<{
        taskId: string;
        stage: string;
        eventId: string;
        title: string;
    }>;
    authorizationMappings: Array<{
        id: string;
        taskId: string;
        phase: string;
        eventId: string;
    }>;
    unrecoverable: Array<{
        kind: 'task' | 'delegation';
        id: string;
        reason: string;
    }>;
    projectionMismatches: Array<{
        taskId: string;
        expected: string;
        observed?: string;
    }>;
    manifestPath?: string;
}
/**
 * Import the committed 3.1.x/3.2.x TaskStore projection once into the V2 event
 * history. Event identities derive from immutable source facts, so restarting the
 * importer appends no duplicate facts. The manifest contains only structural
 * identifiers and digests; card goals, prompts and evidence bodies stay in the
 * authoritative state store.
 */
export declare const importFeatureStateToJournal: (input: StateImportInput) => StateImportReport;
