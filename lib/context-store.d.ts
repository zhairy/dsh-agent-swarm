export declare const DEFAULT_CONTEXT_PAGE_CHARS = 8000;
export interface ContextBindingInfo {
    rootSessionId: string;
    workspaceId: string;
    taskId: string;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    threadId?: string;
    blindReview?: boolean;
}
export interface ContextArtifactInfo {
    ref: string;
    digest: string;
    binding: ContextBindingInfo;
    layer: 'L0' | 'L1' | 'L2';
    kind: 'contract' | 'source' | 'evidence' | 'history' | 'experience' | 'author-reasoning';
    text: string;
    allowThreads?: string[];
}
export interface ContextPageInfo {
    ref: string;
    digest: string;
    layer: ContextArtifactInfo['layer'];
    kind: ContextArtifactInfo['kind'];
    text: string;
    cursor: string;
    nextCursor: string | null;
    truncated: boolean;
    totalBytes: number;
    cardRevision: number;
    workflowRevision: number;
    requestRevision?: number;
    requestedLimit: number;
    effectiveLimit: number;
    maxPageChars: number;
    limitClamped: boolean;
    returnedChars: number;
    charUnit: 'utf16-code-units';
}
export interface PreparedTaskContextReplacement {
    /** Detached snapshots; the live store is unchanged until commit succeeds. */
    readonly artifacts: ContextArtifactInfo[];
    readonly replaced: ContextArtifactInfo[];
    commit: () => void;
    /** Release rollback capacity after the caller's durable transaction succeeds. */
    finalize: () => void;
    /** Refuses to overwrite changes made to the same task after this commit. */
    rollback: () => void;
}
export interface ContextStore {
    Add: (input: Omit<ContextArtifactInfo, 'ref' | 'digest'>) => ContextArtifactInfo;
    PrepareTaskReplace: (binding: ContextBindingInfo, inputs: Array<Omit<ContextArtifactInfo, 'ref' | 'digest' | 'binding'>>) => PreparedTaskContextReplacement;
    Restore: (artifact: unknown, expectedBinding?: ContextBindingInfo) => ContextArtifactInfo;
    /** 当前全部存活材料在完整状态里的编码字节数（含 JSON 转义），用于容量准入；只读读数。 */
    getTotalEncodedBytes: () => number;
    Read: (binding: ContextBindingInfo, ref: string, options?: {
        cursor?: string;
        limit?: number;
        expectedDigest?: string;
    }) => ContextPageInfo;
    List: (binding: ContextBindingInfo) => Array<Pick<ContextPageInfo, 'ref' | 'digest' | 'layer' | 'kind' | 'totalBytes' | 'cardRevision' | 'workflowRevision' | 'requestRevision'>>;
    DelTask: (rootSessionId: string, taskId: string) => void;
    /** 取走并清空自上次确认以来被新增/替换或删除的材料引用；缺失时调用方回退全量快照提交。 */
    takeDirty?: () => ContextStoreDirty;
    /** 提交失败时把取走的脏键放回；成功路径不需要调用。 */
    restoreDirty?: (dirty: ContextStoreDirty) => void;
}
/** 材料存储的增量脏键：set 为新增/替换，removed 为删除。 */
export interface ContextStoreDirty {
    readonly set: readonly string[];
    readonly removed: readonly string[];
}
/** 受控引用读取；ID 不是授权，始终检查根、工作区、任务、版本与盲审权限。 */
export declare const intContextStore: (limits?: {
    maxArtifacts?: number;
    maxArtifactBytes?: number;
    maxPageChars?: number;
    getByteBudget?: () => number;
}) => ContextStore;
/** 只有相同语义版本才能在专家续会话里省略完整任务背景。 */
