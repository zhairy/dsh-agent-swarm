import type { TaskCard, TaskFlags } from './policy.js';
import { type DelegableRoleId } from './role-registry.js';
/**
 * 编排规划：任务卡通过后、委派开始前，先把「要不要拆、按什么角度拆、哪些能并行」定下来。
 * 规则给出确定性基线，Jev 只做复杂度与拆分倾向的判断；两者都写进任务记录，供状态与图表展示。
 */
/** 中大型任务解耦的常见角度。名称用于展示，id 稳定、可被测试与图表引用。 */
export declare const ORCHESTRATION_DIMENSIONS: readonly ['layer', 'vertical-slice', 'domain-boundary', 'data-ownership', 'stable-base', 'deployment-unit', 'client-side', 'contract-first', 'risk-isolation', 'conway', 'state-machine', 'resource-profile', 'rule-frequency'];
export type OrchestrationDimension = typeof ORCHESTRATION_DIMENSIONS[number];
export declare const DIMENSION_LABELS: Readonly<Record<OrchestrationDimension, string>>;
export declare const COMPLEXITY_LEVELS: readonly ['small', 'medium', 'large'];
export type ComplexityLevel = typeof COMPLEXITY_LEVELS[number];
export declare const COMPLEXITY_LABELS: Readonly<Record<ComplexityLevel, string>>;
export interface OrchestrationSubtask {
    readonly id: string;
    readonly title: string;
    readonly role: DelegableRoleId;
    readonly dependsOn: readonly string[];
    /** 可与本子任务同时开工的兄弟子任务（串行/并行决策的直接依据）。 */
    readonly parallelWith: readonly string[];
    readonly dimension: OrchestrationDimension;
    readonly deliverable: string;
}
export interface OrchestrationPlan {
    readonly complexity: ComplexityLevel;
    readonly source: 'jev' | 'rules' | 'jev-fallback';
    readonly reason: string;
    readonly dimensions: readonly OrchestrationDimension[];
    readonly subtasks: readonly OrchestrationSubtask[];
    /** 无依赖、可同时委派的子任务分组。 */
    readonly parallelGroups: readonly (readonly string[])[];
    /** 必须按顺序执行的依赖链（每条链内部串行）。 */
    readonly serialized: readonly (readonly string[])[];
    readonly risks: readonly string[];
    readonly mermaid: string;
}
/** 复杂度基线：范围、验收条数与风险标记共同决定，不依赖模型。 */
export declare const getRuleComplexity: (card: TaskCard, flags: TaskFlags) => {
    level: ComplexityLevel;
    reason: string;
};
/** 由任务标记推导拆分角度：每条规则都能追溯到卡片里的一个具体事实。 */
export declare const getRuleDimensions: (flags: TaskFlags) => OrchestrationDimension[];
/**
 * 规则编排：把维度、角色与依赖显式化。
 * 第 1 条切片先探明现状，其余切片依赖它，因此彼此之间可并行——这正是「先勘察、后并行」的最小形状。
 */
export declare const getRuleOrchestration: (card: TaskCard, flags: TaskFlags) => OrchestrationPlan;
/** 编排图：子任务、依赖与并行分组；只画编排决策，不冒充执行进度。 */
export declare const getOrchestrationMermaid: (plan: Omit<OrchestrationPlan, 'mermaid'> | OrchestrationPlan) => string;
/** 编排判断题：只让 Jev 判断「复杂度」与「是否值得拆」，具体切法留给规则，保证可复核。 */
export declare const getOrchestrationQuestions: () => Record<string, unknown>;
/** 解析 Jev 答案；任一项缺失或不合法时返回 undefined，由调用方回退规则。 */
export declare const ParseOrchestrationPlan: (answers: Record<string, unknown>, card: TaskCard, flags: TaskFlags) => OrchestrationPlan | undefined;
