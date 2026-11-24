import type { DelegableRoleId, SuanHengMode } from './role-registry.js';
import { type JsonSchemaObject } from './util/json-schema.js';
/** 复核命令类别 */
export declare const COMMAND_KINDS: readonly ['unit', 'integration', 'typecheck', 'lint', 'build', 'benchmark', 'differential', 'property', 'e2e', 'other'];
/** 御史发现的严重度 */
export declare const SEVERITIES: readonly ['critical', 'high', 'medium', 'low'];
/**
 * 角色的 outputSchema（传给 spawn，并用于宿主侧校验）
 * @param {DelegableRoleId} role - 角色 ID
 * @returns {JsonSchemaObject} schema
 */
export declare const getOutputSchema: (role: DelegableRoleId) => JsonSchemaObject;
/**
 * 在 schema 校验之上做角色级语义检查
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 子智能体提交的结构化结果
 * @param {SuanHengMode} [mode] - 算衡本次委派的模式
 * @returns {string[]} 违规描述
 */
export declare const ValidateStructuredOutput: (role: DelegableRoleId, value: unknown, mode?: SuanHengMode) => string[];
/** 可核对的证据条目 */
export interface EvidenceItem {
    kind: 'command' | 'step' | 'finding' | 'source' | 'observation' | 'claim' | 'file-change';
    ref: string;
    detail?: string;
    exitCode?: number;
    commandKind?: string;
    severity?: string;
}
/**
 * 从结构化结果中抽取证据条目
 * @param {DelegableRoleId} role - 角色 ID
 * @param {unknown} value - 结构化结果
 * @returns {EvidenceItem[]} 证据
 */
export declare const getEvidenceFromOutput: (role: DelegableRoleId, value: unknown) => EvidenceItem[];
