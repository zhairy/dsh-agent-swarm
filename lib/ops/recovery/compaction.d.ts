import type { RouteInfo } from '../../domain/routing/routes.js';
export interface CompactionRecoveryInput {
    previousModel?: RouteInfo;
    framedSummaryTokens: number;
    shadowedTokens: number;
    fixedOverheadTokens?: number;
    targetWindowTokens?: number;
    candidateFramedTokens?: number;
    /** 仅接受可信 Host 的完整性见证，不能由摘要模型自报。 */
    essentialFactsPreserved?: boolean;
}
/** 决策不修改模型/历史；只有 Host 验证的真实缩减可进入其原子提交入口。 */
export declare const getModelSwitchRecoveryDecision: (input: CompactionRecoveryInput) => {
    failureKind: 'MODEL_SWITCH_COMPACTION_FAILED';
    preservedModel: RouteInfo | undefined;
    quotaFault: false;
    action: "manual_required" | "retry_after_verified_shrink";
    maximumFramedSummaryTokens: number;
    reason: string;
};
export declare const getCompactionCounts: (message: string) => {
    framedSummaryTokens: number;
    shadowedTokens: number;
} | undefined;
