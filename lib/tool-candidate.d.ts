/** 候选是受限引用，不是可执行配置；缺真实沙箱时始终隔离。 */
export interface ToolCandidateMetadata {
    kind: 'skill' | 'tool';
    version: string;
    artifactRefs: string[];
    permissions: string[];
    testRefs: string[];
    rollback: string;
    evaluation: 'unavailable';
    executionEnabled: false;
}
export declare const ValidateToolCandidate: (raw: unknown) => raw is ToolCandidateMetadata;
