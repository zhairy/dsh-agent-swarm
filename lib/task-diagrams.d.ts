import type { DelegationRecord, TaskRecord } from './evidence.js';
import { getTaskBinding } from './task-model.js';
import { type WorkflowNodeStatus } from './workflow.js';
export declare const TASK_DIAGRAM_VERSION = "1";
export declare const TASK_DIAGRAM_KINDS: readonly ['workflow', 'architecture', 'sequence', 'dataflow', 'lifecycle', 'orchestration'];
export type TaskDiagramKind = typeof TASK_DIAGRAM_KINDS[number];
export type TaskDiagramStatus = WorkflowNodeStatus | 'unknown';
export declare const TASK_DIAGRAM_LIMITS: Readonly<{
    history: 32;
    sourceBytes: 32768;
    exportBytes: 1048576;
}>;
export interface TaskDiagramNode {
    id: string;
    label: string;
    status: TaskDiagramStatus;
    operation: string;
    role?: string;
    dependsOn: string[];
}
export interface TaskDiagramDelegation {
    id: string;
    nodeId: string | null;
    attemptId: string | null;
    role: string;
    status: string;
    current: boolean;
    startedAt: number | null;
    endedAt: number | null;
    evidenceCount: number;
}
export interface TaskDiagramView {
    kind: TaskDiagramKind;
    title: string;
    basis: string;
    mermaid: string;
    sourceDigest: string;
    truncated: number;
}
export interface TaskDiagrams {
    format: 'dsh-agent-swarm/task-diagrams';
    schemaVersion: 1;
    generatorVersion: string;
    binding: ReturnType<typeof getTaskBinding>;
    snapshotDigest: string;
    workflowDigest: string | null;
    progress: {
        total: number;
        completed: number;
        percent: number | null;
        statuses: Record<TaskDiagramStatus, number>;
        accepted: boolean;
        basis: string;
    };
    diagnostics: Array<{
        code: string;
        nodeId?: string;
        delegationId?: string;
        message: string;
    }>;
    source: {
        nodes: TaskDiagramNode[];
        delegations: TaskDiagramDelegation[];
        delegationTotal: number;
        contextCount: number;
        planningStatus: string;
        acceptanceStatus: string | null;
    };
    views: TaskDiagramView[];
}
/** Five readonly views, one version-bound snapshot. Rendering never publishes state or passes a gate. */
export declare const getTaskDiagrams: (task: TaskRecord, records: DelegationRecord[], delegationBindingTask?: TaskRecord) => TaskDiagrams;
/** Integrity check for an explicit user export, never an execution authorization. */
export declare const ValidateTaskDiagrams: (raw: unknown) => string[];
export declare const ARCHIFY_CONTRACT: Readonly<{
    repository: "https://github.com/tt-a1i/archify";
    commit: "58ab0b98d2d0def8e49dced705c7b566936723ec";
    version: "3.0.1";
}>;
/** Explicit export only. IR uses the inspected upstream schemas; Archify is not a runtime dependency. */
export declare const getArchifyTaskDiagrams: (snapshot: TaskDiagrams) => {
    contract: typeof ARCHIFY_CONTRACT;
    snapshotDigest: string;
    diagrams: Array<{
        kind: TaskDiagramKind;
        ir: Record<string, unknown> | null;
        reason?: string;
    }>;
};
