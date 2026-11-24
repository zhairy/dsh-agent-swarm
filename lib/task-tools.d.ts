import type { SwarmService } from './service.js';
import { type ToolDefinitionLike } from './tool-shape.js';
export type BoundTaskToolService = Pick<SwarmService, 'ReadContext' | 'ProjectFiles' | 'Calculate' | 'MessageSend' | 'MessageRead' | 'MessageAck' | 'getConfig' | 'RestoreWorktree' | 'BindPrimaryWorkspace' | 'SaveWorkspaceGit' | 'PrepareVerificationOutputs'> & Partial<Pick<SwarmService, 'ExecuteKernel' | 'CreateWorktree'>>;
/** 注册不代表授权：所有入口原样传递真实 exec，由 service 校验任务绑定、版本和角色权限。 */
export declare const getBoundTaskToolDefinitions: (service: BoundTaskToolService) => ToolDefinitionLike[];
