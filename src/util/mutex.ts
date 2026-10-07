/** 串行锁：同一时刻只执行一个任务 */
export interface MutexInfo {
  run: <T>(task: () => Promise<T>) => Promise<T>
}

/**
 * 创建串行锁；前一个任务失败不会阻塞后续任务
 * @returns {MutexInfo} 锁
 */
export const intMutex = (): MutexInfo => {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    run: <T>(task: () => Promise<T>): Promise<T> => {
      const result = tail.then(task, task)
      tail = result.catch(() => undefined)
      return result
    }
  }
}
