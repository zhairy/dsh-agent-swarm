const DECISIONS = ['accept', 'reject', 'incomplete'];
const isResolution = (value) => {
    const record = value;
    return record !== null && typeof record === 'object' && typeof record.delegationId === 'string'
        && typeof record.index === 'number' && typeof record.resolution === 'string';
};
export const ValidateAcceptInput = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return { errors: ['参数必须是对象'] };
    const value = raw;
    const errors = [];
    if (typeof value.task_id !== 'string' || value.task_id === '')
        errors.push('task_id 必须是非空字符串');
    if (!DECISIONS.includes(value.decision))
        errors.push('decision 必须是 accept / reject / incomplete 之一');
    if (typeof value.summary !== 'string')
        errors.push('summary 必须是字符串');
    if (typeof value.stopReason !== 'string' || value.stopReason.trim() === '')
        errors.push('stopReason 必须是非空字符串');
    if (value.verification_token !== undefined && (typeof value.verification_token !== 'string' || !/^vr-[a-f0-9-]{36}$/.test(value.verification_token)))
        errors.push('verification_token 必须是服务器签发的receipt ID');
    if (value.verification_token !== undefined && value.decision !== 'accept')
        errors.push('verification_token 只适用于accept');
    const unresolved = value.unresolved ?? [];
    if (!Array.isArray(unresolved) || unresolved.some((item) => typeof item !== 'string'))
        errors.push('unresolved 必须是字符串数组');
    const resolutions = value.findingResolutions ?? [];
    if (!Array.isArray(resolutions) || !resolutions.every(isResolution))
        errors.push('findingResolutions 每项需要 delegationId、index、resolution');
    if (errors.length > 0)
        return { errors };
    return {
        input: {
            task_id: value.task_id,
            decision: value.decision,
            summary: value.summary,
            unresolved: unresolved,
            stopReason: value.stopReason,
            findingResolutions: resolutions,
            ...(value.verification_token === undefined ? {} : { verification_token: value.verification_token })
        },
        errors: []
    };
};
//# sourceMappingURL=validation.js.map