import type { DurableStateStore } from './state-store.js';
import type { TaskRecord } from './evidence.js';
import { RUNTIME_POLICY_VERSION } from './verification-receipt.js';
export type ProgressAction = 'plan-review' | 'delegate' | 'checkpoint' | 'root-round';
export interface ProgressWaitHandle {
    id: string;
    kind: 'tool' | 'user' | 'authorization' | 'goal';
    state: 'open' | 'settled' | 'unknown';
    openedAt: number;
    deadlineAt?: number;
}
export interface ProgressControl {
    lineageId: string;
    rootSessionId: string;
    workspaceId: string;
    taskIds: string[];
    policyVersion: typeof RUNTIME_POLICY_VERSION;
    status: 'active' | 'stalled' | 'exhausted';
    historyCount: number;
    activations: number;
    recoveries: number;
    replans: number;
    lastFingerprint?: string;
    taskGraphs?: Record<string, string>;
    lastUserEvent?: string;
    reason?: string;
    legacyBaseline: boolean;
    observedFacts?: Record<string, string>;
    waitHandles?: Record<string, ProgressWaitHandle>;
}
export interface ProgressSignature {
    fingerprint: string;
    canonical: string;
    action: ProgressAction;
    hits: number;
    at: number;
}
export interface ProgressPage {
    lineageId: string;
    page: number;
    items: ProgressSignature[];
}
export interface ProgressGuardState {
    runtimeControls?: Record<string, ProgressControl>;
    progressHistory?: Record<string, ProgressPage>;
}
export interface ProgressObservation {
    lineageId: string;
    taskId?: string;
    action: ProgressAction;
    projection: unknown;
    graphDigest?: string;
    waitHandle?: ProgressWaitHandle;
    waiting?: boolean;
    recoveryEvent?: string;
    replan?: boolean;
    legacyBaseline?: boolean;
}
export declare const ValidateProgressControl: (value: unknown) => value is ProgressControl;
export declare const ValidateProgressPage: (value: unknown) => value is ProgressPage;
/** 忽略显示标签/节点UUID；保留角色、操作、输出合同、必需门禁与真实依赖方向。 */
export declare const getWorkflowStructure: (task: TaskRecord) => Array<{
    shape: string;
    status: string;
}>;
export declare const getProgressProjection: (task: TaskRecord, extra?: Record<string, unknown>) => unknown;
/** 分页历史只装载一次索引；每次仅改一个≤32项的页，不复制TaskRecord里的全历史Set。 */
export declare const createProgressGuard: <T extends ProgressGuardState>(store: DurableStateStore<T>, now?: () => number, scope?: {
    rootSessionId: string;
    workspaceId: string;
}) => {
    get: (lineageId: string) => ProgressControl | undefined;
    forTask: (taskId: string) => ProgressControl | undefined;
    lineageFor: (task: TaskRecord, workspaceId: string) => string;
    bindTask: (task: TaskRecord, workspaceId: string, rootScopeLineage?: string) => Promise<string>;
    recordFact: (taskId: string, locator: string, content: string) => Promise<void>;
    observe: (input: ProgressObservation) => Promise<ProgressControl>;
};
