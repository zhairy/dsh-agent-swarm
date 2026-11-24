import type { ExecutionLanguage, ExecutionResult, ExecutionScope } from '../execution/runtime.js';
import type { ToolExecLike } from '../tool-shape.js';
export interface KernelTaskContext {
    agentId: string;
    rootSessionId: string;
    taskId: string;
    attemptId: string;
    version: string;
    contractVersion: string;
    cwd: string;
    canCalculate: boolean;
}
export interface KernelCellInput {
    language: ExecutionLanguage;
    code: string;
}
export interface KernelExecutionInput extends KernelCellInput {
    operationId: string;
}
export interface KernelToolDeps {
    getContext: (exec: ToolExecLike) => Promise<KernelTaskContext>;
    execute?: (scope: ExecutionScope, input: KernelExecutionInput, signal: AbortSignal, authorize: () => Promise<void>) => Promise<ExecutionResult>;
}
/** scope 只从 Host 当前身份生成；新 attempt 不自动接管旧变量或旧执行权。 */
export declare const createKernelToolUseCase: (deps: KernelToolDeps) => (raw: unknown, exec: ToolExecLike) => Promise<ExecutionResult>;
