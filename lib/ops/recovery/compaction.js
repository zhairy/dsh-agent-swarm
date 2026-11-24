/** 决策不修改模型/历史；只有 Host 验证的真实缩减可进入其原子提交入口。 */
export const getModelSwitchRecoveryDecision = (input) => {
    const finiteCount = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!finiteCount(input.framedSummaryTokens) || !finiteCount(input.shadowedTokens) || input.shadowedTokens === 0)
        throw new Error('COMPACTION_INVALID_MEASUREMENT');
    const maximumFramedSummaryTokens = input.shadowedTokens - 1;
    const canShrink = finiteCount(input.candidateFramedTokens) && input.candidateFramedTokens < input.shadowedTokens
        && input.essentialFactsPreserved === true && finiteCount(input.fixedOverheadTokens) && finiteCount(input.targetWindowTokens)
        && input.candidateFramedTokens + input.fixedOverheadTokens < input.targetWindowTokens;
    return { failureKind: 'MODEL_SWITCH_COMPACTION_FAILED',
        preservedModel: input.previousModel === undefined ? undefined : structuredClone(input.previousModel), quotaFault: false,
        action: canShrink ? 'retry_after_verified_shrink' : 'manual_required', maximumFramedSummaryTokens,
        reason: canShrink ? 'Host-verified shorter summary; preserve the original model and original commit guard'
            : `previous request model preserved; require framed summary < ${input.shadowedTokens} and a verified capacity/essential-facts witness; no quota fallback` };
};
export const getCompactionCounts = (message) => {
    const match = /\((\d+)\s+estimated framed tokens\s*>=\s*(\d+)\)/.exec(message);
    return match === null ? undefined : { framedSummaryTokens: Number(match[1]), shadowedTokens: Number(match[2]) };
};
//# sourceMappingURL=compaction.js.map