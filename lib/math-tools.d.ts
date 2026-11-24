import { type ToolDefinitionLike, type ToolExecLike } from './tool-shape.js';
/** Registration is intentionally owned by the service, which checks identity and task budgets. */
export declare const getMathToolDefinitions: (deps: {
    calculate: (raw: unknown, exec: ToolExecLike) => Promise<unknown>;
}) => ToolDefinitionLike[];
