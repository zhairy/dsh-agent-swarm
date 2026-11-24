/**
 * 创建串行锁；前一个任务失败不会阻塞后续任务
 * @returns {MutexInfo} 锁
 */
export const intMutex = () => {
    let tail = Promise.resolve();
    return {
        run: (task) => {
            const result = tail.then(task, task);
            tail = result.catch(() => undefined);
            return result;
        }
    };
};
//# sourceMappingURL=mutex.js.map