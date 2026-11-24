interface Identity {
    path: string;
    identity: string;
}
interface LaunchProof {
    anchor: Identity;
    roots: Identity[];
    protectedRoots?: Identity[];
    hardlinkPolicy?: 'protected-only' | 'reject-all';
    cwd: string;
    argv: string[];
}
/** Runs after the kernel has pinned the read-only tree and exact writable mounts. */
export declare const executeFenced: (proof: LaunchProof) => Promise<number>;
export {};
