/** 仅修复 AsyncLocalStorage 范围使用 inode 句柄，原 FS 的 UTF-8/字节上限语义原样保留。 */
export declare const createRecoveryReadFence: (filesystem: object) => {
    run: <T>(root: string, assertCurrent: () => void, next: () => Promise<T>, deniedRoots?: readonly string[]) => Promise<T>;
    dispose: () => void;
};
export type RecoveryReadFence = ReturnType<typeof createRecoveryReadFence>;
