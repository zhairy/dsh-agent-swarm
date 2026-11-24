import type { AgentLike } from '../host-contract.js';
import { type CreatedWorktreeInfo } from '../worktree-binding.js';
interface LinkedCreationContext {
    agent: AgentLike;
    plan?: {
        mode: string;
        repositoryRoot: string;
        head: string;
        branch: string;
    };
    assertCurrent: () => void;
    canCreate: () => string | undefined;
    inspectSource: () => Promise<{
        repositoryRoot: string;
        head: string;
    }>;
    create: (agent: AgentLike, request: {
        name?: string;
        from: string;
    }, signal: AbortSignal) => Promise<CreatedWorktreeInfo>;
    quarantine: () => Promise<void>;
}
/** 保留百工 create-only 合同；alpha2 的 enter 工具会隐式进入已有树，不能直接开放。 */
export declare const createLinkedWorktree: (context: LinkedCreationContext, raw: unknown, signal: AbortSignal) => Promise<CreatedWorktreeInfo>;
export {};
