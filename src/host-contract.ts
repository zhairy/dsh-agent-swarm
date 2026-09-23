/**
 * 宿主契约：dsh-agent-swarm 对 DSH 宿主的全部假设集中在此文件
 * 升级 DSH 时优先核对本文件与集成测试（tests/integration）
 */

/** 已验证兼容的最低 DSH 版本 */
export const DSH_MIN_VERSION = '0.1.7-alpha.2'

/** 宿主行提供给预设行的服务名 */
export const SWARM_SERVICE = 'agentSwarm'

/** dsh-base 注册的进程内子智能体后端 */
export const SPAWN_PROVIDER = 'spawn'

/** spawn 在请求 outputSchema 时注入给子智能体的结构化提交工具 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** 能力 → 宿主工具候选名（0.1.7-alpha.2 实测） */
export const CAPABILITY_TOOL_CANDIDATES = {
  read: ['read', 'read_image'],
  search: ['glob', 'grep'],
  edit: ['write', 'edit'],
  shell: ['pwsh', 'bash'],
  web: ['web_search', 'web_fetch']
} as const satisfies Record<string, readonly string[]>

/** 角色能力名 */
export type Capability = keyof typeof CAPABILITY_TOOL_CANDIDATES

/** 视为写文件的工具名，守卫据此拒绝只读类角色 */
export const WRITE_TOOL_NAMES: readonly string[] = CAPABILITY_TOOL_CANDIDATES.edit

/** 会话头中本插件读取的字段 */
export interface SessionHeaderLike {
  parentSession?: string
  agentPreset?: string
  cwd?: string
}

/** Agent 的最小形状 */
export interface AgentLike {
  id: string
  session?: { header?: SessionHeaderLike }
}

/** LLM 失败信息 */
export interface LlmFailureLike {
  code?: string
  status?: number
  message?: string
}

/** 一次模型调用的路由配置 */
export interface CallConfigLike {
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
  [key: string]: unknown
}

/** 消息内容块 */
export interface ContentBlockLike {
  type: string
  text?: string
  [key: string]: unknown
}

/** 子智能体结果 */
export interface SubagentResultLike {
  output: ContentBlockLike[]
  structured?: unknown
  diagnostic?: string
  stopReason: string
}

/** 子智能体运行句柄 */
export interface SubagentRunLike {
  id: string
  result: Promise<SubagentResultLike>
  dispose: () => Promise<void>
}

/** 一次性子智能体启动请求 */
export interface SubagentStartRequestLike {
  label?: string
  prompt: ContentBlockLike[]
  parent: AgentLike
  signal: AbortSignal
  agentOptions?: { provider: string; model: string; reasoningEffort?: string }
  outputSchema?: object
  maxDepth?: number
  toolFilter?: { allow?: string[]; deny?: string[] }
  persona?: string
}

/** ctx.subagents 的最小形状 */
export interface SubagentsLike {
  start: (name: string, request: SubagentStartRequestLike) => Promise<SubagentRunLike>
  getProvider: (name: string) => { capabilities?: Record<string, boolean> } | undefined
  list: () => string[]
}

/** ctx.llm 的最小形状 */
export interface LlmLike {
  listProviders: () => Array<{ id: string }>
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[] }>
}

/** 工具守卫看到的执行信息 */
export interface ToolExecutionLike {
  name: string
  arguments?: unknown
  agent?: AgentLike
}

/** ctx.tools 的最小形状 */
export interface ToolsLike {
  register: (definition: unknown) => () => void
  schemas: (scope?: unknown) => Array<{ name: string }>
  guard: (guard: (execution: ToolExecutionLike) => string | undefined) => () => void
}

/** ctx.attachments 的最小形状 */
export interface AttachmentsLike {
  saveImages: (inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>) => Promise<readonly unknown[]>
}

/** ctx.credentials 的最小形状 */
export interface CredentialsLike {
  resolve: (ref: string) => Promise<{ value: string } | undefined>
}

/** agent/request-error 的载荷 */
export interface RequestErrorPayloadLike {
  agent: AgentLike
  provider: string
  failure: LlmFailureLike
}

/** agent/request-error 的动作；undefined 表示失败终止 */
export type RequestErrorActionLike = { kind: string } | undefined

/** Cordis 插件上下文中本插件用到的部分 */
export interface PluginContextLike {
  get: (name: string) => unknown
  provide: (name: string, value?: unknown) => () => void
  effect: (execute: () => () => void) => unknown
  on: (name: string, listener: (...args: never[]) => unknown) => unknown
  logger?: (name: string) => { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/**
 * 读取 agent 会话头
 * @param {AgentLike | undefined} agent - 宿主 agent
 * @returns {SessionHeaderLike} 会话头，缺失时为空对象
 */
export const getAgentHeader = (agent: AgentLike | undefined): SessionHeaderLike => agent?.session?.header ?? {}
