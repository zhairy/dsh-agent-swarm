import { SwarmError } from './util/errors.js'

/** 宿主实现可能忽略 signal；调用方等待仍必须能结束，并观察迟到的拒绝。 */
export const waitForPlanning = <T>(pending: Promise<T>, signal: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
  const abort = () => { cleanup(); reject(signal.reason ?? new SwarmError('RECOVERY_REQUIRED', '规划审核已取消')) }
  const cleanup = () => signal.removeEventListener('abort', abort)
  signal.addEventListener('abort', abort, { once: true })
  pending.then((value) => { cleanup(); signal.aborted ? abort() : resolve(value) }, (error: unknown) => { cleanup(); reject(error) })
  if (signal.aborted) abort()
})
