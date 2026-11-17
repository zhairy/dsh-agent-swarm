import { createHash } from 'node:crypto'
import { getRedactedText } from './jev.js'

export interface WorkspaceRuleSource { path: string; digest: string; text: string }
export interface WorkspacePlan {
  mode: 'primary' | 'linked' | 'blocked'
  reason: string
  repositoryRoot: string
  branch: string
  head: string
  sources: Array<{ path: string; digest: string }>
  evidence: string[]
  allowedModes: Array<'primary' | 'linked'>
  decisionSource: 'rules' | 'rules+jev' | 'legacy-default'
  judgment?: { choice: 'primary' | 'linked' | 'blocked'; confidence: number }
  worktreeCountAtPlanning: number
  digest: string
}
// StateStore 会规范化对象键序；摘要使用固定元组，不能依赖 JSON 属性插入顺序。
const planDigest = (plan: Omit<WorkspacePlan, 'digest'>): string => createHash('sha256').update(JSON.stringify([
  plan.mode, plan.reason, plan.repositoryRoot, plan.branch, plan.head, plan.sources.map(s => [s.path, s.digest]),
  plan.evidence, plan.allowedModes, plan.decisionSource, plan.judgment === undefined ? null : [plan.judgment.choice, plan.judgment.confidence], plan.worktreeCountAtPlanning
])).digest('hex')
export const getWorkspaceFactsDigest = (plan: WorkspacePlan): string => createHash('sha256').update(JSON.stringify([
  plan.repositoryRoot, plan.branch, plan.head, plan.sources.map(s => [s.path, s.digest]), plan.evidence
])).digest('hex')

export const ValidateWorkspacePlan = (value: unknown): value is WorkspacePlan => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as WorkspacePlan
  if (!['primary', 'linked', 'blocked'].includes(plan.mode) || typeof plan.reason !== 'string' || plan.reason.length > 4096
    || typeof plan.repositoryRoot !== 'string' || !plan.repositoryRoot.startsWith('/') || typeof plan.branch !== 'string'
    || !/^[a-f0-9]{40,64}$/.test(plan.head) || !Array.isArray(plan.sources) || plan.sources.length > 2
    || plan.sources.some(s => !s || typeof s !== 'object' || !['AGENTS.md', 'agent.md'].includes(s.path) || !/^[a-f0-9]{64}$/.test(s.digest))
    || !Array.isArray(plan.evidence) || plan.evidence.length > 12 || plan.evidence.some(x => typeof x !== 'string' || x.length > 1024)
    || !Array.isArray(plan.allowedModes) || plan.allowedModes.length > 2 || plan.allowedModes.some(x => !['primary', 'linked'].includes(x))
    || !['rules', 'rules+jev', 'legacy-default'].includes(plan.decisionSource) || !Number.isSafeInteger(plan.worktreeCountAtPlanning) || plan.worktreeCountAtPlanning < 1
    || plan.judgment !== undefined && (!plan.judgment || typeof plan.judgment !== 'object' || !['primary', 'linked', 'blocked'].includes(plan.judgment.choice) || !Number.isFinite(plan.judgment.confidence) || plan.judgment.confidence < 0 || plan.judgment.confidence > 1)) return false
  if (new Set(plan.allowedModes).size !== plan.allowedModes.length || plan.mode !== 'blocked' && !plan.allowedModes.includes(plan.mode)
    || plan.decisionSource === 'rules+jev' && plan.judgment === undefined
    || plan.judgment !== undefined && plan.mode !== 'blocked' && (plan.judgment.choice !== plan.mode || plan.judgment.confidence < 0.9)) return false
  return plan.digest === planDigest(plan)
}

/** 这里只识别项目硬限制，不能把模型的规划结论变成写权限。未配置时保留原 linked 流程。 */
export const getWorkspacePlan = (input: { repositoryRoot: string; branch: string; head: string; sources: WorkspaceRuleSource[]; worktreeCount?: number }): WorkspacePlan => {
  const worktreeCount = input.worktreeCount ?? 1
  if (!Number.isSafeInteger(worktreeCount) || worktreeCount < 1) throw new Error('Host 工作树清单无效')
  const rules = input.sources.map(s => s.text.replace(/```[\s\S]*?```/g, '')).join('\n')
  const primary = /(?:唯一|单一|单个|单棵).{0,12}(?:主|基线|开发)?工作树|(?:禁止|不得|不允许)[^。\n]{0,100}(?:git worktree add|linked worktree|第二\s*(?:checkout|工作树))|(?:only|single|sole)[^\n.]{0,30}(?:primary|main|working)\s*(?:tree|worktree)|single\s+(?:git\s+)?worktree|dsh\.workspace\s*:\s*primary/i.test(rules)
  const linkedRequired = /(?:必须|要求)[^。\n]{0,25}(?:独立|隔离|linked).{0,8}(?:工作树|worktree)|dsh\.workspace\s*:\s*linked/i.test(rules)
  const evidence = input.sources.flatMap(s => s.text.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => /工作树|worktree|checkout|dsh\.workspace/i.test(line)).map(line => getRedactedText(`${s.path}: ${line.trim()}`, 1024))).slice(0, 12)
  const ambiguous = !primary && !linkedRequired && evidence.length > 0
  const mode = primary && (linkedRequired || worktreeCount !== 1) || ambiguous ? 'blocked' : primary ? 'primary' : 'linked'
  const value = { mode, reason: primary && worktreeCount !== 1 ? 'Host 已有多棵工作树，不能满足项目唯一主工作树要求；先核对现有工作树，不自动删除' : mode === 'blocked' ? primary && linkedRequired ? '项目存在互相冲突的工作树要求，需要人工澄清' : '项目工作区约束需要衡鉴判读，缺少可靠判断时先澄清' : mode === 'primary' ? '项目明确要求唯一主工作树，禁止创建第二工作树' : linkedRequired ? '项目明确要求隔离工作树' : worktreeCount > 1 ? `Host 已有 ${worktreeCount} 棵工作树，保留隔离工作树策略` : '项目没有主树硬限制，保留原隔离工作树默认策略',
    repositoryRoot: input.repositoryRoot, branch: input.branch, head: input.head, sources: input.sources.map(({ path, digest }) => ({ path, digest })), evidence,
    worktreeCountAtPlanning: worktreeCount,
    allowedModes: (primary && (linkedRequired || worktreeCount !== 1) ? [] : primary ? ['primary'] : linkedRequired || worktreeCount > 1 ? ['linked'] : ['primary', 'linked']) as Array<'primary' | 'linked'>,
    decisionSource: (evidence.length > 0 ? 'rules' : 'legacy-default') as WorkspacePlan['decisionSource'] }
  return { ...value, mode, digest: planDigest({ ...value, mode }) }
}

/** Jev 只解释规则；低置信、矛盾或超出硬约束的判断一律不能激活写入。 */
export const applyWorkspaceJudgment = (plan: WorkspacePlan, judgment?: WorkspacePlan['judgment']): WorkspacePlan => {
  if (judgment === undefined) return plan
  const confident = Number.isFinite(judgment.confidence) && judgment.confidence >= 0.9 && judgment.confidence <= 1
  const mode = confident && judgment.choice !== 'blocked' && plan.allowedModes.includes(judgment.choice) ? judgment.choice : 'blocked'
  const next = { ...plan, mode, judgment, decisionSource: 'rules+jev' as const,
    reason: mode === 'blocked' ? '衡鉴判断不确定或与项目硬限制冲突，需要澄清' : plan.mode === 'blocked' ? `衡鉴根据已核验项目规则判断为 ${mode}，仍须当前任务与 Host 写入授权` : `${plan.reason}；衡鉴判断为 ${mode}` }
  return { ...next, mode, digest: planDigest({ ...next, mode }) }
}

/** 当前合同与保留记录必须属于同一逻辑项目；linked 的分支允许区别于主仓库分支。 */
export const assertWorkspacePlanBinding = (plan: WorkspacePlan | undefined, record: { kind?: 'primary' | 'linked'; repositoryRoot: string; branch: string; baseCommit: string }): void => {
  if (!ValidateWorkspacePlan(plan) || plan.mode === 'blocked' || plan.mode !== (record.kind ?? 'linked')
    || plan.repositoryRoot !== record.repositoryRoot || record.kind === 'primary' && plan.branch !== record.branch) throw new Error('工作区记录不属于当前合同的项目、模式或分支')
  // linked 新分支可有自己的后续提交，但不能把另一基线的源码当成当前合同产物。
  if (record.kind !== 'primary' && record.baseCommit !== plan.head) throw new Error('隔离工作树基线不属于当前合同冻结的 HEAD，请为新基线建立新任务')
}
export const blockWorkspacePlan = (plan: WorkspacePlan, reason: string): WorkspacePlan => {
  const next = { ...plan, mode: 'blocked' as const, reason, judgment: undefined, decisionSource: 'rules' as const }
  return { ...next, digest: planDigest(next) }
}
