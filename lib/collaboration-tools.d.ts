import { type ToolDefinitionLike, type ToolExecLike } from './tool-shape.js';
export interface CollaborationToolHandlers {
    send: (raw: unknown, exec: ToolExecLike) => Promise<unknown>;
    read: (raw: unknown, exec: ToolExecLike) => Promise<unknown>;
    acknowledge: (raw: unknown, exec: ToolExecLike) => Promise<unknown>;
}
export declare const getCollaborationToolDefinitions: (handlers: CollaborationToolHandlers) => ToolDefinitionLike[];
