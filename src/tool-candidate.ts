/** 候选是受限引用，不是可执行配置；缺真实沙箱时始终隔离。 */
export interface ToolCandidateMetadata {
  kind: 'skill' | 'tool'
  version: string
  artifactRefs: string[]
  permissions: string[]
  testRefs: string[]
  rollback: string
  evaluation: 'unavailable'
  executionEnabled: false
}

const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const boundedRefs = (value: unknown, required = false): value is string[] => Array.isArray(value) && (!required || value.length > 0) && value.length <= 16 && value.every(ref => boundedText(ref, 512))

export const ValidateToolCandidate = (raw: unknown): raw is ToolCandidateMetadata => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const entry = raw as Record<string, unknown>
  return Object.keys(entry).every(key => ['kind', 'version', 'artifactRefs', 'permissions', 'testRefs', 'rollback', 'evaluation', 'executionEnabled'].includes(key))
    && (entry.kind === 'skill' || entry.kind === 'tool') && boundedText(entry.version, 128)
    && boundedRefs(entry.artifactRefs, true) && boundedRefs(entry.permissions) && boundedRefs(entry.testRefs, true)
    && boundedText(entry.rollback, 2000) && entry.evaluation === 'unavailable' && entry.executionEnabled === false
}
