import { type FailureEvent, type RepairOutcome } from './schema.js';
/** 只把 listener 交给可信 Host 订阅器；返回对象没有可手动触发修复的方法。 */
export declare const createFailureRecovery: (options: {
    subscribe: (listener: (event: unknown) => Promise<RepairOutcome>) => () => void;
    assertCurrent: (event: FailureEvent) => void;
    process: (event: FailureEvent) => Promise<RepairOutcome>;
}) => {
    dispose: () => Promise<void>;
    whenIdle: () => Promise<void>;
};
