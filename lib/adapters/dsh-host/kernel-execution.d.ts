import type { KernelToolDeps } from '../../application/kernel-tools.js';
import type { ExecutionKernelLease } from '../../execution/client.js';
import type { ExecutionLanguage, ExecutionResult, ExecutionScope } from '../../execution/runtime.js';
interface KernelExecutionClient {
    listKernels(): Promise<Array<{
        kernelId: string;
        language: ExecutionLanguage;
        state: string;
    }>>;
    acquire(input: {
        language: ExecutionLanguage;
        reuseKernelId?: string;
    }): Promise<ExecutionKernelLease>;
    execute(lease: ExecutionKernelLease, input: {
        code: string;
        timeoutMs: number;
        operationId: string;
        signal: AbortSignal;
    }): Promise<ExecutionResult>;
    cancel(lease: ExecutionKernelLease, input: {
        operationId: string;
    }): Promise<{
        stopped: boolean;
    }>;
    release(lease: ExecutionKernelLease): Promise<unknown>;
}
/** Host 的一次 cell 提交只有一个 operationId；未知结果先确认停止，不能借重连重放。 */
export declare const createKernelExecutionPort: (deps: {
    createClient: (scope: ExecutionScope) => KernelExecutionClient;
}) => NonNullable<KernelToolDeps['execute']>;
export {};
