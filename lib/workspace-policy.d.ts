export interface WorkspaceRuleSource {
    path: string;
    digest: string;
    text: string;
}
export interface WorkspacePlan {
    mode: 'primary' | 'linked' | 'blocked';
    reason: string;
    repositoryRoot: string;
    branch: string;
    head: string;
    sources: Array<{
        path: string;
        digest: string;
    }>;
    evidence: string[];
    allowedModes: Array<'primary' | 'linked'>;
    decisionSource: 'rules' | 'rules+jev' | 'legacy-default';
    judgment?: {
        choice: 'primary' | 'linked' | 'blocked';
        confidence: number;
    };
    worktreeCountAtPlanning: number;
    digest: string;
}
export declare const getWorkspaceFactsDigest: (plan: WorkspacePlan) => string;
export declare const ValidateWorkspacePlan: (value: unknown) => value is WorkspacePlan;
/** 这里只识别项目硬限制，不能把模型的规划结论变成写权限。未配置时保留原 linked 流程。 */
export declare const getWorkspacePlan: (input: {
    repositoryRoot: string;
    branch: string;
    head: string;
    sources: WorkspaceRuleSource[];
    worktreeCount?: number;
}) => WorkspacePlan;
/** Jev 只解释规则；低置信、矛盾或超出硬约束的判断一律不能激活写入。 */
export declare const applyWorkspaceJudgment: (plan: WorkspacePlan, judgment?: WorkspacePlan['judgment']) => WorkspacePlan;
/** 当前合同与保留记录必须属于同一逻辑项目；linked 的分支允许区别于主仓库分支。 */
export declare const assertWorkspacePlanBinding: (plan: WorkspacePlan | undefined, record: {
    kind?: 'primary' | 'linked';
    repositoryRoot: string;
    branch: string;
    baseCommit: string;
}) => void;
export declare const blockWorkspacePlan: (plan: WorkspacePlan, reason: string) => WorkspacePlan;
