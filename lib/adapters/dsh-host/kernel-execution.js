import { intMutex } from '../../util/mutex.js';
import { SwarmError } from '../../util/errors.js';
/** Host 的一次 cell 提交只有一个 operationId；未知结果先确认停止，不能借重连重放。 */
export const createKernelExecutionPort = (deps) => {
    const queues = new Map();
    return async (scope, input, signal, authorize) => {
        const key = `${scope.projectId}:${scope.ownerId}:${input.language}`;
        let queue = queues.get(key);
        if (queue === undefined) {
            queue = { mutex: intMutex(), users: 0 };
            queues.set(key, queue);
        }
        queue.users += 1;
        try {
            return await queue.mutex.run(async () => {
                signal.throwIfAborted();
                const client = deps.createClient(scope);
                const kernels = await client.listKernels();
                const reusable = kernels.find(kernel => kernel.language === input.language && kernel.state !== 'broken');
                const lease = await client.acquire({ language: input.language, ...(reusable === undefined ? {} : { reuseKernelId: reusable.kernelId }) });
                let submitted = false;
                let canRelease = true;
                try {
                    await authorize();
                    signal.throwIfAborted();
                    submitted = true;
                    canRelease = false;
                    const result = await client.execute(lease, { code: input.code, timeoutMs: 30_000, operationId: input.operationId, signal });
                    await authorize();
                    signal.throwIfAborted();
                    canRelease = result.timedOut !== true;
                    return result;
                }
                catch (error) {
                    if (submitted) {
                        let stopped = false;
                        let cancellationFailure;
                        try {
                            stopped = (await client.cancel(lease, { operationId: input.operationId })).stopped;
                        }
                        catch (failure) {
                            cancellationFailure = failure;
                        }
                        if (!stopped) {
                            const failure = new SwarmError('RECOVERY_REQUIRED', `内核操作 ${input.operationId} 的停止未确认；执行已隔离，禁止重发代码，需人工核对`);
                            Object.defineProperty(failure, 'cause', { value: cancellationFailure ?? error });
                            throw failure;
                        }
                    }
                    throw error;
                }
                finally {
                    if (canRelease)
                        await client.release(lease);
                }
            });
        }
        finally {
            queue.users -= 1;
            if (queue.users === 0)
                queues.delete(key);
        }
    };
};
//# sourceMappingURL=kernel-execution.js.map