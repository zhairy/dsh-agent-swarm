import { getCollaborationToolDefinitions } from './collaboration-tools.js'
import { getMathToolDefinitions } from './math-tools.js'
import type { SwarmService } from './service.js'
import { getToolDefinition, type ToolDefinitionLike } from './tool-shape.js'

export type BoundTaskToolService = Pick<SwarmService, 'ReadContext' | 'ProjectFiles' | 'Calculate' | 'MessageSend' | 'MessageRead' | 'MessageAck' | 'getConfig'>

/** 注册不代表授权：所有入口原样传递真实 exec，由 service 校验任务绑定、版本和角色权限。 */
export const getBoundTaskToolDefinitions = (service: BoundTaskToolService): ToolDefinitionLike[] => {
  const config = service.getConfig()
  return [
    getToolDefinition({ name: 'swarm_context_read', description: '不传 ref 时列出当前任务授权材料与执行摘要；传 ref 分页读取。始终校验任务/版本，不读取其他任务或盲审禁止的作者过程。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, ref: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' }, expectedDigest: { type: 'string' } }, additionalProperties: false },
      execute: service.ReadContext, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
    getToolDefinition({ name: 'swarm_project_files', description: '只列举当前任务工作区实际存在的文件；query为文件名或路径片段。先发现再read/grep；无匹配返回正常空结果和真实候选，不猜测或自动改写路径。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, query: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      execute: service.ProjectFiles, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
    ...getMathToolDefinitions({ calculate: service.Calculate }),
    ...(config.persistence.enabled && config.messageBus.enabled
      ? getCollaborationToolDefinitions({ send: service.MessageSend, read: service.MessageRead, acknowledge: service.MessageAck }) : [])
  ]
}
