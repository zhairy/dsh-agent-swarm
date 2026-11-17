import { readFile } from 'node:fs/promises'
import type { PluginContextLike } from './host-contract.js'
import { getErrorText } from './util/errors.js'

/** 预设声明（@deepseek-ai/dsh-agent-preset 的 config 形状；插件行原样透传） */
interface PresetDeclarationLike {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: unknown[]
}

interface AgentPresetsLike {
  list: () => Promise<Array<{ id: string }>>
  register: (definition: PresetDeclarationLike) => Promise<() => void | Promise<void>>
}

interface LoggerLike { info?: (message: string) => void; warn: (message: string) => void }

/** JSON 里的 {$js} 还原成宿主 loader 的 __jsExpr 节点（loader 以鸭子类型识别并按作用域求值）。 */
export const revivePresetExpressions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(revivePresetExpressions)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === '$js' && typeof record.$js === 'string') return { __jsExpr: record.$js }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, revivePresetExpressions(item)]))
}

/** 从包内 presets/declarations.json 读取 13 个角色预设声明；文件缺失或损坏时抛出，由调用方记录诊断。 */
export const loadPresetDeclarations = async (moduleUrl: string | URL = import.meta.url): Promise<PresetDeclarationLike[]> => {
  const raw = await readFile(new URL('../presets/declarations.json', moduleUrl), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('preset declarations must be an object')
  const declarations = (parsed as { declarations?: unknown }).declarations
  if (!Array.isArray(declarations) || declarations.length === 0) throw new Error('preset declarations are empty')
  return revivePresetExpressions(declarations) as PresetDeclarationLike[]
}

/**
 * 0.2.1-alpha 起子智能体由 agentPreset 选择的预设承载 persona 与工具组合；
 * 角色预设默认不在模式列表里，这里按需注册缺失声明并绑定到插件生命周期。
 * 旧宿主（0.2.0-rc.2 及更早）不注册，保持原有的 persona/toolFilter 委派路径与干净的预设列表。
 */
export const registerMissingRolePresets = async (scoped: PluginContextLike, logger: LoggerLike): Promise<number> => {
  const presets = scoped.get('agentPresets') as AgentPresetsLike | undefined
  if (presets === undefined || typeof presets.list !== 'function' || typeof presets.register !== 'function') return 0
  const existing = new Set((await presets.list()).map((preset) => preset.id))
  const declarations = await loadPresetDeclarations()
  const missing = declarations.filter((declaration) => !existing.has(declaration.id))
  if (missing.length === 0) return 0
  for (const declaration of missing) {
    const dispose = await presets.register(declaration)
    scoped.effect(() => () => { void dispose() })
  }
  logger.info?.(`已注册 ${missing.length} 个百工角色预设（供子智能体与独立角色会话使用）`)
  return missing.length
}

/** 仅在宿主提供 0.2.1-alpha 激活协议（startActivation）时注册；失败只记录诊断，不阻断宿主行。 */
export const ensureRolePresetsForActivationHost = (ctx: PluginContextLike, logger: LoggerLike): void => {
  const subagents = ctx.get('subagents') as { startActivation?: unknown } | undefined
  if (subagents === undefined || typeof subagents.startActivation !== 'function') return
  ctx.inject?.(['agentPresets'], (scoped) => {
    void registerMissingRolePresets(scoped, logger).catch((error: unknown) => {
      logger.warn(`百工角色预设注册失败：${getErrorText(error)}`)
    })
  })
}
