/** 宿主实现可能忽略 signal；调用方等待仍必须能结束，并观察迟到的拒绝。 */
export declare const waitForPlanning: <T>(pending: Promise<T>, signal: AbortSignal) => Promise<T>;
