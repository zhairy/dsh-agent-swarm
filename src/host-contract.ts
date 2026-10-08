/**
 * 宿主契约：dsh-agent-swarm 对 DSH 宿主的全部假设集中在此文件
 * 升级 DSH 时优先核对本文件与集成测试（tests/integration）
 */

/** 已验证兼容的最低 DSH 版本 */
export const DSH_MIN_VERSION = '0.1.7-alpha.2'

/** 宿主行提供给预设行的服务名 */
export const SWARM_SERVICE = 'agentSwarm'

/**
 * 跨插件约定：百工模式管理的会话登记在 globalThis 的这个键上。
 * 其他会改写路由的插件（例如 dsh-llm-fallbacks 的全局回退）读到后应跳过这些会话，
 * 由百工自己的路由链负责回退。值的形状见 ManagedAgentsInfo。
 */
export const MANAGED_AGENTS_KEY = Symbol.for('dsh-agent-swarm/managed-agents')

/** globalThis[MANAGED_AGENTS_KEY] 的形状 */
export interface ManagedAgentsInfo {
  version: 1
  /** 该会话是否由百工管理：天枢等百工预设的根会话，以及百工委派出的专家子会话 */
  isManaged: (agent: unknown) => boolean
}

/** dsh-base 注册的进程内子智能体后端 */
export const SPAWN_PROVIDER = 'spawn'

/** spawn 在请求 outputSchema 时注入给子智能体的结构化提交工具 */
export const STRUCTURED_OUTPUT_TOOL = 'structured_output'

/** 能力 → 宿主工具候选名（0.1.7-alpha.2 实测）；jev 为本插件在天枢预设内注册的 7 个 Jev 判断工具 */
export const CAPABILITY_TOOL_CANDIDATES = {
  read: ['read', 'read_image'],
  search: ['glob', 'grep', 'swarm_project_files'],
  edit: ['write', 'edit'],
  shell: ['pwsh', 'bash'],
  web: ['web_search', 'web_fetch'],
  jev: ['jev_ask', 'jev_check', 'jev_classify', 'jev_health', 'jev_match', 'jev_score', 'jev_screen'],
  calculate: ['swarm_calculate'],
  context: ['swarm_context_read'],
  message: ['swarm_message_send', 'swarm_message_read', 'swarm_message_ack']
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
  session?: {
    header?: SessionHeaderLike
    deriveMessages?: () => readonly { id?: string; role?: string; source?: { kind?: string }; content?: readonly ContentBlockLike[] }[]
    surface?: { replaceGeneration: number }
    requestHeader?: () => { config: CallConfigLike } | undefined
  }
}

/** Real DSH compaction seam; progress is verified against the durable surface generation. */
export interface ContextCompactionLike {
  compactIfNeeded: (agent: AgentLike, trigger: 'context-overflow', signal: AbortSignal) => Promise<unknown | null>
}

/** LLM 失败信息 */
export interface LlmFailureLike {
  code?: string
  status?: number
  message?: string
  providerRetryAfterMs?: number
  requestId?: string
  kind?: string
  quotaDomainId?: string
  quotaScope?: 'account' | 'plan' | 'model' | 'pool' | 'unknown'
  poolId?: string
  resetAt?: string
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

/** 连续会话（continuable）子智能体的创建请求：不支持 outputSchema，结构化结果由子智能体以 json 代码块回复 */
export interface ContinuableStartSpecLike {
  provider: string
  label: string
  /** 调用方预留的子会话 ID：先登记等待者与路由状态，再创建，避免错过首轮结束事件 */
  childId?: string
  request: Omit<SubagentStartRequestLike, 'label' | 'signal' | 'outputSchema'>
  signal: AbortSignal
}

/** 子智能体一轮结束（subagent/end）；连续会话每次沉寂都会发出一次 */
export interface SubagentEndInfoLike {
  id: string
  stopReason: string
  lastAssistantMessage?: readonly ContentBlockLike[]
}

/** ctx.subagents 的最小形状；连续会话相关方法在 DSH 0.1.7-rc.2 起提供，缺失时退回一次性委派 */
export interface SubagentsLike {
  start: (name: string, request: SubagentStartRequestLike) => Promise<SubagentRunLike>
  getProvider: (name: string) => { capabilities?: Record<string, boolean> } | undefined
  list: () => string[]
  startContinuable?: (spec: ContinuableStartSpecLike) => Promise<{ childId: string; messageId: string }>
  sendMessage?: (sender: AgentLike, targetId: string, content: ContentBlockLike[], options: { signal: AbortSignal }) => Promise<string>
  interrupt?: (targetSessionId: string, authority: { kind: 'ancestor'; agent: AgentLike }) => void
  listChildren?: (parentSessionId: string, signal?: AbortSignal) => Promise<Array<{ id: string; createdAt: number; mode: 'continuable' | 'one-shot' | 'unknown'; label?: string }>>
}

/** 进入一步之前的消息（agent/pre-step）；只读取本插件需要的来源字段 */
export interface InboxMessageLike {
  source?: { kind?: string; senderSessionId?: string }
  [key: string]: unknown
}

/** agent/pre-step 的决定 */
export type PreStepDecisionLike = { kind: 'reject' } | { kind: 'enter'; messages: InboxMessageLike[]; [key: string]: unknown }

/** ctx.llm 的最小形状 */
export interface LlmLike {
  listProviders: () => Array<{ id: string }>
  resolveModelInfo: (provider: string, model: string, signal?: AbortSignal) => Promise<{ inputModalities?: readonly string[]; reasoning?: { efforts: readonly { id: string; name?: string }[]; defaultEffort?: string } }>
  resolveCallConfig?: (config: Pick<CallConfigLike, 'provider' | 'model' | 'reasoningEffort'>, signal?: AbortSignal) => Promise<CallConfigLike>
}

/** 工具守卫看到的执行信息 */
export interface ToolExecutionLike {
  name: string
  arguments?: unknown
  agent?: AgentLike
  callId?: string
  signal?: AbortSignal
}

/** DSH 0.2 ToolRuntime pre-dispatch waterfall; an ask is resolved by ctx.approval. */
export type PreToolDecisionLike =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: { name: string; code: string; reason?: string } }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } }

export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
/** Public approval capability. Policy mutation is intentionally not part of the plugin contract. */
export interface ApprovalServiceLike {
  config?: { policy?: 'ask' | 'never' }
  overrideOf?: (session: NonNullable<AgentLike['session']>) => 'ask' | 'never' | undefined
  request: (request: { agent: AgentLike; toolName: string; callId?: string; reason?: string; signal?: AbortSignal }) => Promise<ApprovalOutcomeLike>
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

/** ctx.credentials 的最小形状；describe 只返回是否已配置与来源，不返回密钥值 */
export interface CredentialsLike {
  resolve: (ref: string) => Promise<{ value: string; source?: string } | undefined>
  describe?: (ref: string) => Promise<{ configured: boolean; source?: string; writable: boolean }>
}

/** ctx.skills 的最小形状（DSH 0.2.0 起）：在调用方作用域注册运行时技能 */
export interface SkillsLike {
  register: (skill: { name: string; description: string; content: string; source: string; path?: string }) => () => void
}

/** system-prompt/assemble 瀑布的组装结果中本插件读写的部分 */
export interface PromptAssemblyLike {
  sections: Array<{ name: string; text: string; interpolate?: boolean }>
  variables: Record<string, string | undefined>
  [key: string]: unknown
}

/** 宿主 connection.fetch.register 接受的路由（与 dsh-plugin-subscriptions 相同的 RPC 线格式） */
export interface FetchRouteLike {
  path: string
  methods: string[]
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

/** ctx.connection 的最小形状 */
export interface ConnectionLike {
  fetch: { register: (route: FetchRouteLike) => () => void }
}

/** ctx.sessionProjections 的最小形状：会话在空白期切换预设后，当前预设只在 agentPreset 投影里，会话头仍是创建时的值 */
export interface SessionProjectionsLike {
  stateOf: (session: unknown, key: string) => unknown
}

/** agent/request-error 的载荷；signal 为本轮的取消信号（DSH 0.2.0 起提供） */
export interface RequestErrorPayloadLike {
  agent: AgentLike
  provider: string
  failure: LlmFailureLike
  signal?: AbortSignal
}

/** agent/request-error 的动作；undefined 表示失败终止 */
export type RequestErrorActionLike = { kind: string } | undefined

/** Cordis 插件上下文中本插件用到的部分 */
export interface PluginContextLike {
  get: (name: string) => unknown
  provide: (name: string, value?: unknown) => () => void
  effect: (execute: () => () => void) => unknown
  on: (name: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean }) => unknown
  /** 可选依赖：服务就绪后在子上下文中执行（无界面的 profile 没有 connection） */
  inject?: (deps: string[], callback: (ctx: PluginContextLike) => void) => unknown
  logger?: (name: string) => { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void }
}

/**
 * 读取 agent 会话头
 * @param {AgentLike | undefined} agent - 宿主 agent
 * @returns {SessionHeaderLike} 会话头，缺失时为空对象
 */
export const getAgentHeader = (agent: AgentLike | undefined): SessionHeaderLike => agent?.session?.header ?? {}
