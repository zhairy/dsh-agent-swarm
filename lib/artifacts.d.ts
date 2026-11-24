export interface ArtifactEntryInfo {
    path: string;
    state: 'file' | 'missing' | 'unknown';
    digest?: string;
    bytes?: number;
    mode?: number;
    resolvedPath?: string;
    reason?: string;
}
export interface ArtifactSnapshotInfo {
    workspaceId: string;
    digest: string;
    entries: ArtifactEntryInfo[];
    complete: boolean;
}
export type ArtifactSnapshot = ArtifactSnapshotInfo;
export interface ArtifactLimitsInfo {
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
    exclude?: readonly string[];
}
/** 仅映射已核验目标的任务路径；目录授权仍由调用方核验，物理读取继续检查真实边界。 */
export declare const getTaskArtifactPath: (target: {
    root: string;
    physical: string;
}, path: string) => string;
/** 工作区标识含真实路径与 profile 边界，不作为访问授权凭据。 */
export declare const getWorkspaceId: (workspace: string, profile?: string) => Promise<string>;
/** 对允许文件的真实内容流式摘要；缺失/未知都保留标记，未知绝不视作有效验证。 */
export declare const getArtifactSnapshot: (workspace: string, paths: readonly string[], options?: ArtifactLimitsInfo) => Promise<ArtifactSnapshotInfo>;
