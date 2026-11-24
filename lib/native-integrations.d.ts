import type { AgentLike, GoalsLike, JobsLike, SessionProjectionsLike, ToolsLike } from './host-contract.js';
import type { GoalViewLike } from './host-contract.js';
export interface NativeIntegrationView {
    availability: {
        askUser: boolean;
        todo: boolean;
        timeContext: boolean;
        planMode: boolean;
        goal: boolean;
        jobs: boolean;
        worktree: boolean;
    };
    todos?: {
        total: number;
        scanned: number;
        pending: number;
        inProgress: number;
        completed: number;
        items: Array<{
            content: string;
            status: 'pending' | 'in_progress' | 'completed';
        }>;
    };
    timeContext?: {
        lastMessageTime: number | null;
        lastInjectionTime: number | null;
        lastTurnInjectionTime: number | null;
    };
    planMode?: {
        active: boolean;
        pending: boolean;
    };
    goal?: Pick<GoalViewLike, 'id' | 'revision' | 'phase' | 'activation' | 'roundsStarted' | 'maxGoalRounds'>;
    jobs?: {
        total: number;
        running: number;
        stopping: number;
        completed: number;
        failedOrKilled: number;
    };
}
/** Read native DSH projections without creating a second task, plan or job state store. */
export declare const getNativeIntegrationView: (input: {
    projections?: SessionProjectionsLike;
    goals?: GoalsLike;
    jobs?: JobsLike;
    tools?: ToolsLike;
    session?: unknown;
    agent?: AgentLike;
}) => NativeIntegrationView;
