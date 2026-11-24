import type { AgentBinding } from '../agent-binding.js';
import type { TaskRecord, TaskStore } from '../evidence.js';
import type { FeatureSession } from '../feature-session.js';
import { type AgentLike } from '../host-contract.js';
import type { MutexInfo } from '../util/mutex.js';
import type { SwarmService } from './service-api.js';
import type { ToolExecLike } from '../tool-shape.js';
export interface ExperienceSessionPort {
    taskLock: MutexInfo;
    store: TaskStore;
    rootAgent?: AgentLike;
}
export interface ExperienceTaskContext {
    session: ExperienceSessionPort;
    features: FeatureSession;
    task: TaskRecord;
    agent: AgentLike;
    binding?: AgentBinding;
}
export interface ExperienceToolDeps {
    getConfigEnabled: () => boolean;
    getToolTask: (raw: unknown, exec: ToolExecLike) => Promise<ExperienceTaskContext>;
    isRootTianShu: (agent: AgentLike) => boolean;
    currentTask: (context: ExperienceTaskContext) => TaskRecord;
    isClosing: () => boolean;
    now: () => number;
}
export type ExperienceToolUseCases = Pick<SwarmService, 'Experience'>;
/** Bounded experience lookup and evidence-bound tool-candidate registration. */
export declare const createExperienceToolUseCase: (deps: ExperienceToolDeps) => ExperienceToolUseCases;
