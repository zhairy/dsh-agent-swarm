import type { AgentLike, ContentBlockLike, SubagentActivationLike, SubagentRunLike, SubagentStartRequestLike, SubagentsLike } from './host-contract.js'
import { SwarmError } from './util/errors.js'

/** 版本无关的子智能体启动参数：旧宿主用 persona/toolFilter，0.2.1-alpha 起由 agentPreset 指定的预设负责 composition。 */
export interface ChildStartInput {
  provider: string
  label: string
  childId?: string
  prompt: ContentBlockLike[]
  parent: AgentLike
  signal: AbortSignal
  agentOptions?: SubagentStartRequestLike['agentOptions']
  outputSchema?: object
  maxDepth?: number
  /** 新宿主：角色预设 id（persona + 工具组合都来自预设） */
  agentPreset?: string
  /** 旧宿主：persona 文本与工具过滤 */
  persona?: string
  toolFilter?: SubagentStartRequestLike['toolFilter']
}

/** 0.2.1-alpha 起的激活协议：本地子会话固定为连续会话，结算后自动关闭；一次性由调用方在结果后 dispose。 */
export const hasActivationApi = (subagents: SubagentsLike): boolean => typeof subagents.startActivation === 'function'

/** 连续会话：旧宿主 startContinuable，新宿主 startActivation（同一 childId 可被 sendMessage 冷恢复）。 */
export const supportsContinuableSessions = (subagents: SubagentsLike): boolean =>
  subagents.sendMessage !== undefined && (subagents.startContinuable !== undefined || hasActivationApi(subagents))

/**
 * 统一启动一个子智能体，返回旧协议的 {id,result,dispose} 形状。
 * 新宿主缺 start 时改走 startActivation；delivery 固定 caller，结束通知由本插件自己管理，避免重复进入天枢上下文。
 */
export const startChild = async (subagents: SubagentsLike, input: ChildStartInput): Promise<SubagentRunLike> => {
  const request: Omit<SubagentStartRequestLike, 'label' | 'signal'> = {
    prompt: input.prompt,
    parent: input.parent,
    ...(input.agentOptions === undefined ? {} : { agentOptions: input.agentOptions }),
    ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth })
  }
  if (typeof subagents.start === 'function') {
    return subagents.start(input.provider, {
      label: input.label, ...request, signal: input.signal,
      ...(input.persona === undefined ? {} : { persona: input.persona }),
      ...(input.toolFilter === undefined ? {} : { toolFilter: input.toolFilter })
    })
  }
  if (typeof subagents.startActivation === 'function') {
    const activation: SubagentActivationLike = await subagents.startActivation({
      provider: input.provider, label: input.label,
      ...(input.childId === undefined ? {} : { childId: input.childId }),
      request: { ...request, ...(input.agentPreset === undefined ? {} : { agentPreset: input.agentPreset }) },
      signal: input.signal, delivery: 'caller'
    })
    return { id: activation.childId, result: activation.result, dispose: activation.dispose }
  }
  throw new SwarmError('SERVICE_UNAVAILABLE', '宿主没有可用的子智能体启动接口（start/startActivation 均缺失）')
}
