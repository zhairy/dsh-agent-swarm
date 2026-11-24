import type { AgentLike } from './host-contract.js';
import type { DelegationRecord, TaskRecord } from './evidence.js';
import type { TaskCard } from './policy.js';
import type { ContextBindingInfo } from './context-store.js';
export interface TaskIntent {
    text: string;
    source: 'host' | 'declared';
    sourceRef: string;
    /** 游标只绑定最后一条实质消息；text 可以包含自上次游标之后的多条补充。 */
    digest: string;
    historyCoverage?: 'since-cursor' | 'latest-visible' | 'unavailable';
    historyNote?: string;
    refs?: Array<{
        source: string;
        text: string;
    }>;
}
export interface TaskIntentCursorInfo {
    intentSourceRef?: string;
    intentLastDigest?: string;
    intentSource?: 'host' | 'declared';
}
export declare const digest: (value: unknown) => string;
/** 使用公开的消息推导接口读取用户需求，不读取已废弃的同步 session.events。 */
export declare const getTaskIntent: (agent: AgentLike, card: TaskCard, previous?: TaskIntentCursorInfo) => TaskIntent;
export declare const getTaskIntentRefs: (task: Pick<TaskRecord, 'intentRefs' | 'intentText' | 'taskId' | 'requestRevision' | 'card'>) => Array<{
    source: string;
    text: string;
}>;
/** 同一消息编辑替换原位置；新增消息顺序追加，不把聚合全文假归给最后一个消息 ID。 */
export declare const mergeTaskIntentRefs: (task: TaskRecord | undefined, intent: TaskIntent) => Array<{
    source: string;
    text: string;
}>;
export declare const getTaskIntentText: (refs: readonly {
    source: string;
    text: string;
}[]) => string;
export declare const getSemanticCardDigest: (card: TaskCard) => string;
export declare const getTaskBinding: (task: TaskRecord) => {
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision: number;
};
/** Every task-scoped capability shares the same version comparison; missing legacy versions mean 1. */
export declare const isTaskVersionCurrent: (task: TaskRecord, binding: {
    cardRevision?: number;
    workflowRevision?: number;
    requestRevision?: number;
}) => boolean;
export declare const getTaskContextBinding: (task: TaskRecord, workspaceId: string) => ContextBindingInfo;
export declare const getCurrentDelegations: (task: TaskRecord, records: DelegationRecord[], artifactDigest?: string) => DelegationRecord[];
