import { type AgentLike, type ApprovalServiceLike, type PreToolDecisionLike, type ToolExecutionLike } from './host-contract.js';
import { APPROVAL_SCOPES, type ApprovalsConfigInfo } from './config.js';
export { APPROVAL_SCOPES, type ApprovalsConfigInfo } from './config.js';
export type ApprovalScope = typeof APPROVAL_SCOPES[number];
export type HostApprovalPolicy = 'ask' | 'never' | 'unavailable' | 'unknown';
/** Classifies public tool names; it does not infer the safety of arbitrary code or MCP payloads. */
export declare const getToolApprovalScope: (name: string) => ApprovalScope | undefined;
/** Pure final guard: a live switch to deny also revokes a pending approval before dispatch. */
export declare const getToolApprovalDenial: (execution: ToolExecutionLike, config: ApprovalsConfigInfo) => string | undefined;
/**
 * Adds a restriction to the host waterfall. Never answers approval, weakens a host denial,
 * changes session policy, or approves a native backend's private tools.
 */
export declare const getToolApprovalDecision: (execution: ToolExecutionLike, hostDecision: PreToolDecisionLike, config: ApprovalsConfigInfo, options?: {
    hostPolicy?: HostApprovalPolicy;
}) => PreToolDecisionLike;
/** Read the public host surface only. Missing knowledge is not an approval or permission grant. */
export declare const getHostApprovalPolicy: (approval: ApprovalServiceLike | undefined, agent?: AgentLike) => HostApprovalPolicy;
export declare const getApprovalPolicyDiagnostics: (config: ApprovalsConfigInfo, hostPolicy: HostApprovalPolicy) => string[];
