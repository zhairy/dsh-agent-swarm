import { type ExecutionKernelHandle, type ExecutionResult, type ExecutionRuntime, type RuntimeExecutionRequest, type RuntimeStartRequest } from './runtime.js';
export interface DockerCommandRequest {
    command: string;
    args: string[];
    timeoutMs: number;
    stdin?: string;
}
export interface DockerCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}
export interface DockerCommandRunner {
    run(request: DockerCommandRequest): Promise<DockerCommandResult>;
}
export interface DockerExecutionRuntimeOptions {
    image: string;
    runner?: DockerCommandRunner;
    dockerPath?: string;
    uid?: number;
    gid?: number;
    proxySocketDirectory?: string;
}
export declare class DockerSpawnCommandRunner implements DockerCommandRunner {
    private readonly dockerPath;
    constructor(dockerPath?: string);
    run(request: DockerCommandRequest): Promise<DockerCommandResult>;
}
export declare class DockerExecutionRuntime implements ExecutionRuntime {
    readonly kind = "docker";
    private readonly options;
    constructor(options: DockerExecutionRuntimeOptions);
    start(request: RuntimeStartRequest): Promise<ExecutionKernelHandle>;
    private waitUntilReady;
    execute(handle: ExecutionKernelHandle, request: RuntimeExecutionRequest): Promise<ExecutionResult>;
    inspect(handle: ExecutionKernelHandle): Promise<'running' | 'stopped' | 'missing'>;
    remove(handle: ExecutionKernelHandle): Promise<void>;
}
