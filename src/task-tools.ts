import { getCollaborationToolDefinitions } from './collaboration-tools.js'
import { DEFAULT_CONTEXT_PAGE_CHARS } from './context-store.js'
import { getMathToolDefinitions } from './math-tools.js'
import type { SwarmService } from './service.js'
import { getToolDefinition, type ToolDefinitionLike } from './tool-shape.js'

export type BoundTaskToolService = Pick<SwarmService, 'ReadContext' | 'ProjectFiles' | 'Calculate' | 'MessageSend' | 'MessageRead' | 'MessageAck' | 'getConfig'>

/** 注册不代表授权：所有入口原样传递真实 exec，由 service 校验任务绑定、版本和角色权限。 */
export const getBoundTaskToolDefinitions = (service: BoundTaskToolService): ToolDefinitionLike[] => {
  const config = service.getConfig()
  return [
    getToolDefinition({ name: 'swarm_context_read', description: '不传 ref 时列出当前任务授权材料与执行摘要；传 ref 分页读取。始终校验任务/版本，不读取其他任务或盲审禁止的作者过程。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, ref: { type: 'string' },
        cursor: { type: 'string', description: 'UTF-16 字符单元偏移，首次省略或传 "0"；后续原样使用返回的 nextCursor，不按字节数或行号猜测' },
        limit: { type: 'number', description: `正安全整数，单位为 UTF-16 字符单元，默认 ${DEFAULT_CONTEXT_PAGE_CHARS}，有效页上限 ${DEFAULT_CONTEXT_PAGE_CHARS}；更大的整数自动收缩并返回 limitClamped。按 nextCursor 继续读取；为保全 emoji 代理对，实际返回最多额外 1 单元，以 returnedChars 为准` },
        expectedDigest: { type: 'string', description: '材料索引中的 digest；版本或摘要不一致仍拒绝读取' } }, additionalProperties: false },
      execute: service.ReadContext, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
    getToolDefinition({ name: 'swarm_project_files', description: '只列举当前任务工作区实际存在的文件；query为文件名或路径片段。先发现再read/grep；无匹配返回正常空结果和真实候选，不猜测或自动改写路径。',
      parameters: { type: 'object', properties: { task_id: { type: 'string' }, query: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } }, additionalProperties: false },
      execute: service.ProjectFiles, render: (_args, result) => JSON.stringify(result), isConcurrencySafe: () => true }),
    ...getMathToolDefinitions({ calculate: service.Calculate }),
    ...(config.persistence.enabled && config.messageBus.enabled
      ? getCollaborationToolDefinitions({ send: service.MessageSend, read: service.MessageRead, acknowledge: service.MessageAck }) : [])
  ]
}
