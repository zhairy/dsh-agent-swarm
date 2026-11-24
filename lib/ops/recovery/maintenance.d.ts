export interface RecoveryMaintenanceOptions {
    directory: string;
    enabled: () => boolean;
    log: (message: string) => void;
    intervalMs?: number;
    now?: () => number;
}
export interface RecoveryMaintenance {
    start: () => void;
    dispose: () => void;
}
/**
 * 只维护既有恢复作用域数据库的 claim 超时状态。
 * 该模块不申请新 claim、不执行 repair，也不触发任何模型调用。
 */
export declare const createRecoveryMaintenance: (options: RecoveryMaintenanceOptions) => RecoveryMaintenance;
