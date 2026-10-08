import { CAPABILITY_TOOL_CANDIDATES, type AgentLike, type ApprovalServiceLike, type PreToolDecisionLike, type ToolExecutionLike } from './host-contract.js'
import { APPROVAL_SCOPES, type ApprovalsConfigInfo } from './config.js'

export { APPROVAL_SCOPES, type ApprovalsConfigInfo } from './config.js'
export type ApprovalScope = typeof APPROVAL_SCOPES[number]
export type ApprovalMode = ApprovalsConfigInfo['mode']
export type HostApprovalPolicy = 'ask' | 'never' | 'unavailable' | 'unknown'

const SCOPE_LABELS: Record<ApprovalScope, string> = {
  write: '文件修改', shell: 'Shell/代码执行', external_mcp: '外部 MCP', jev: '内置 Jev 工具'
}

/** Classifies public tool names; it does not infer the safety of arbitrary code or MCP payloads. */
export const getToolApprovalScope = (name: string): ApprovalScope | undefined => {
  if (CAPABILITY_TOOL_CANDIDATES.edit.includes(name as 'write' | 'edit')) return 'write'
  if (name === 'bash' || name === 'pwsh' || name === 'run_code') return 'shell'
  if (name.startsWith('mcp__')) return 'external_mcp'
  if ((CAPABILITY_TOOL_CANDIDATES.jev as readonly string[]).includes(name)) return 'jev'
  return undefined
}

const selectedScope = (execution: ToolExecutionLike, config: ApprovalsConfigInfo): ApprovalScope | undefined => {
  const scope = getToolApprovalScope(execution.name)
  return scope !== undefined && config.scope.includes(scope) ? scope : undefined
}

/** Pure final guard: a live switch to deny also revokes a pending approval before dispatch. */
export const getToolApprovalDenial = (execution: ToolExecutionLike, config: ApprovalsConfigInfo): string | undefined => {
  if (config.mode !== 'deny') return undefined
  const scope = selectedScope(execution, config)
  return scope === undefined ? undefined : `百工审批策略已拒绝${SCOPE_LABELS[scope]}工具 ${execution.name}`
}

/**
 * Adds a restriction to the host waterfall. Never answers approval, weakens a host denial,
 * changes session policy, or approves a native backend's private tools.
 */
export const getToolApprovalDecision = (
  execution: ToolExecutionLike,
  hostDecision: PreToolDecisionLike,
  config: ApprovalsConfigInfo,
  options: { hostPolicy?: HostApprovalPolicy } = {}
): PreToolDecisionLike => {
  if (config.mode === 'inherit' || hostDecision.kind === 'deny' || hostDecision.kind === 'cancel') return hostDecision
  const scope = selectedScope(execution, config)
  if (scope === undefined) return hostDecision
  if (config.mode === 'deny') return { kind: 'deny', reason: getToolApprovalDenial(execution, config)! }
  if (hostDecision.kind === 'ask') return hostDecision
  const boundary = options.hostPolicy === 'never'
    ? '宿主当前策略为 never，会拒绝审批；百工不会提升权限，请由用户通过宿主支持的入口调整。'
    : options.hostPolicy === 'unavailable'
      ? '宿主未提供审批服务，请求将被拒绝。'
      : '仅宿主的一次性许可允许执行；缺少审批应答渠道时拒绝。'
  return { kind: 'ask', reason: `百工配置要求审批${SCOPE_LABELS[scope]}工具 ${execution.name}。${boundary}` }
}

/** Read the public host surface only. Missing knowledge is not an approval or permission grant. */
export const getHostApprovalPolicy = (approval: ApprovalServiceLike | undefined, agent?: AgentLike): HostApprovalPolicy => {
  if (approval === undefined || typeof approval.request !== 'function') return 'unavailable'
  try {
    if (agent?.session !== undefined && typeof approval.overrideOf === 'function') {
      const policy = approval.overrideOf(agent.session)
      if (policy === 'ask' || policy === 'never') return policy
    }
    const policy = approval.config?.policy
    return policy === 'ask' || policy === 'never' ? policy : 'unknown'
  } catch { return 'unknown' }
}

export const getApprovalPolicyDiagnostics = (config: ApprovalsConfigInfo, hostPolicy: HostApprovalPolicy): string[] => {
  if (config.mode !== 'ask' || config.scope.length === 0) return []
  const diagnostics = ['百工工具审批仅覆盖所选 ToolRuntime 调用；内部规划/复评 Jev HTTP 与原生 Codex/Claude 内部工具由各自接口管理。']
  if (hostPolicy === 'never') diagnostics.push('宿主审批策略为 never：审批请求会自动拒绝，专家子会话也可能由宿主固定为 never；百工不会自动更改该策略。')
  else if (hostPolicy === 'unavailable') diagnostics.push('宿主审批服务不可用：所选 ask 工具将拒绝执行。')
  else diagnostics.push('审批交给宿主的一次性应答渠道；服务存在不代表已配置应答者，拒绝、取消或不可用都不会执行工具。')
  return diagnostics
}
