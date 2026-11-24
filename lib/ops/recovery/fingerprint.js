import { createHash } from 'node:crypto';
/** 仅规范故障语义；执行 owner/attempt 保留在 Host 见证中，不靠随机 ID 重置去重。 */
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalize = (raw, root) => raw
    .replace(new RegExp(`${escapePattern(root)}(?=[/\\\\\\s),:]|$)`, 'g'), '.')
    .replace(/\b\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?\b/g, '<time>')
    .replace(/\b(?:timestamp|time_ms|epoch_ms|epoch)\s*[=:]\s*\d+(?:\.\d+)?/gi, 'timestamp=<time>')
    .replace(/\b(?:pid|ppid)\s*(?:[=:]\s*|\s+)\d+/gi, 'pid=<pid>')
    .replace(/\b(?:retry|retries|retry_count|attempt_count)\s*[=:]\s*\d+/gi, 'retry=<retry>')
    .replace(/\b(session|container)(?:[_-]?id)?\s*[=:]\s*[\w.-]+/gi, '$1=<id>')
    .replace(/\b[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}\b/gi, '<uuid>')
    .replace(/\/(?:tmp|var\/tmp)\/[^/\s]+/g, '<tmp>')
    .replace(/(\b[\w./\\-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|cpp|c|h|rb|sh)):\d+(?::\d+)?\b/gi, '$1:<line>')
    .replace(/\bline\s+\d+/gi, 'line <line>')
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer <redacted>')
    .replace(/\b(api[_-]?key|token|password)\s*[=:]\s*[^\s,;]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ').trim();
export const getFailureFingerprint = (event) => {
    const canonicalJson = JSON.stringify({ failure_kind: event.failureKind, exception_type: normalize(event.exceptionType, event.projectRoot),
        message: normalize(event.message, event.projectRoot), task_type: event.taskType, tool_name: event.toolName,
        affected_files: [...new Set(event.affectedFiles.map(f => normalize(f, event.projectRoot)))].sort() });
    return { canonicalJson, fingerprint: createHash('sha256').update(canonicalJson).digest('hex') };
};
//# sourceMappingURL=fingerprint.js.map