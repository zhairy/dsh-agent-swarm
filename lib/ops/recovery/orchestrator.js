import { validateFailureEvent } from './schema.js';
/** 只把 listener 交给可信 Host 订阅器；返回对象没有可手动触发修复的方法。 */
export const createFailureRecovery = (options) => {
    let closed = false;
    const pending = new Set();
    const unsubscribe = options.subscribe(async (raw) => {
        if (closed)
            throw new Error('RECOVERY_CLOSED');
        const event = validateFailureEvent(raw);
        if (event.repairDepth !== 0)
            throw new Error('NESTED_REPAIR');
        options.assertCurrent(event);
        const run = options.process(event);
        pending.add(run);
        try {
            return await run;
        }
        finally {
            pending.delete(run);
        }
    });
    return { dispose: async () => { closed = true; unsubscribe(); await Promise.allSettled(pending); }, whenIdle: async () => { await Promise.allSettled(pending); } };
};
//# sourceMappingURL=orchestrator.js.map