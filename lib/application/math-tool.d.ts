import type { AgentBinding } from '../agent-binding.js';
import type { SwarmConfigInfo } from '../config.js';
import type { Ledger, TaskRecord, TaskStore } from '../evidence.js';
import type { FeatureSession } from '../feature-session.js';
import type { AgentLike } from '../host-contract.js';
import type { ThreadRegistry } from '../threads.js';
import type { MutexInfo } from '../util/mutex.js';
import type { ToolExecLike } from '../tool-shape.js';
import type { SwarmService } from './service-api.js';
export interface MathSessionPort {
    taskLock: MutexInfo;
    rootAgent?: AgentLike;
    store: TaskStore;
    ledger: Ledger;
    threads: ThreadRegistry;
}
export interface MathTaskContext {
    session: MathSessionPort;
    features: FeatureSession;
    task: TaskRecord;
    agent: AgentLike;
    binding?: AgentBinding;
}
export interface MathToolDeps {
    getConfig: () => SwarmConfigInfo;
    getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<MathTaskContext>;
    getTask: (session: MathSessionPort, taskId: string) => TaskRecord;
    refreshTask: (context: MathTaskContext, taskId: string) => TaskRecord;
}
export type MathToolUseCases = Pick<SwarmService, 'Calculate'>;
/**
 * Pure math execution use case. It reserves the hard work ceiling before the
 * synchronous kernel and only publishes context after settlement succeeds.
 */
export declare const createMathToolUseCase: (deps: MathToolDeps) => MathToolUseCases;
