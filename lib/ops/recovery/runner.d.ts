import type { ExecutionBoundaryPolicy } from '../../adapters/dsh-host/execution-boundary.js';
import type { RepairBudget } from './budget.js';
import { type RepairAction } from './schema.js';
export interface RecoveryAuthority {
    projectRoot: string;
    tools: readonly string[];
    writeScopes: readonly string[];
    allowProcess: boolean;
    assertCurrent: () => void;
    confirmRollback?: (action: RepairAction) => {
        writeBytes: number;
    } | undefined;
}
export interface RecoveryActionResult {
    ok: boolean;
    value?: unknown;
    sideEffectState?: 'none' | 'confirmed' | 'unknown';
}
export interface RecoveryHostPort {
    available: () => boolean;
    /** Host 没有实际进程配额时不能仅凭 action 中的声明放行 Shell。 */
    processBudgetEnforced?: boolean;
    prepare: (action: RepairAction, signal: AbortSignal) => Promise<ExecutionBoundaryPolicy>;
    run: <T>(policy: ExecutionBoundaryPolicy, next: () => Promise<T>) => Promise<T>;
    invoke: (action: RepairAction, signal: AbortSignal) => Promise<RecoveryActionResult>;
}
/** 所有真实执行经过现有 Host 物理边界；不能用模型自报的 path/字节数代替授权。 */
export declare const createRecoveryRunner: (options: {
    authority: RecoveryAuthority;
    host: RecoveryHostPort;
    budget: RepairBudget;
    checkpoint: () => void;
}) => {
    run: (raw: RepairAction, signal: AbortSignal, depth?: number) => Promise<RecoveryActionResult>;
};
export type RecoveryRunner = ReturnType<typeof createRecoveryRunner>;
