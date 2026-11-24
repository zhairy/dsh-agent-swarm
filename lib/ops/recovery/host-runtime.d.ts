import { type SwarmConfigInfo } from '../../config.js';
import type { AgentLike, PluginContextLike } from '../../host-contract.js';
import type { ExecutionBoundaryPolicy } from '../../adapters/dsh-host/execution-boundary.js';
import { type FailureEvent, type RepairAction } from './schema.js';
import type { RouteInfo } from '../../domain/routing/routes.js';
export interface HostFailureNotice {
    event: FailureEvent;
    agent: AgentLike;
    rootAgent: AgentLike;
    assertCurrent: () => void;
    signal?: AbortSignal;
    originalTool?: {
        name: string;
        arguments: unknown;
    };
    previousModel?: RouteInfo;
    writePolicy?: (action: RepairAction, signal: AbortSignal) => Promise<ExecutionBoundaryPolicy | undefined>;
}
/** 接入真实 Host seam；新库惰性创建，空模型链完全不产生后台任务或模型调用。 */
export declare const createHostFailureRuntime: (options: {
    ctx: Pick<PluginContextLike, 'get'>;
    dshHome: string;
    getConfig: () => SwarmConfigInfo;
    subscribe: (listener: (notice: HostFailureNotice) => Promise<void>) => () => void;
    log: (message: string) => void;
    boundary: {
        available: () => boolean;
        begin: (agentId: string, attemptId: string) => void;
        run: <T>(policy: ExecutionBoundaryPolicy, next: () => Promise<T>) => Promise<T>;
        quiescent: (agentId: string, attemptId: string) => boolean;
        seal?: (agentId: string, attemptId: string) => boolean;
    };
}) => {
    isInternalCall: (id: string | undefined) => boolean;
    dispose: () => Promise<void>;
};
