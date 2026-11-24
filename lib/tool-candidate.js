const boundedText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const boundedRefs = (value, required = false) => Array.isArray(value) && (!required || value.length > 0) && value.length <= 16 && value.every(ref => boundedText(ref, 512));
export const ValidateToolCandidate = (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return false;
    const entry = raw;
    return Object.keys(entry).every(key => ['kind', 'version', 'artifactRefs', 'permissions', 'testRefs', 'rollback', 'evaluation', 'executionEnabled'].includes(key))
        && (entry.kind === 'skill' || entry.kind === 'tool') && boundedText(entry.version, 128)
        && boundedRefs(entry.artifactRefs, true) && boundedRefs(entry.permissions) && boundedRefs(entry.testRefs, true)
        && boundedText(entry.rollback, 2000) && entry.evaluation === 'unavailable' && entry.executionEnabled === false;
};
//# sourceMappingURL=tool-candidate.js.map