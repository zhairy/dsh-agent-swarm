import { ROLE_INFO_LIST, getPresetPersona, getRoleInfo, type RoleId } from './role-registry.js'

/** Cordis 插件行；未识别的字段原样透传 */
export interface PluginRow {
  id?: string
  name: string
  config?: unknown
  disabled?: unknown
  [key: string]: unknown
}

/** 预设声明（@deepseek-ai/dsh-agent-preset 的 config） */
export interface PresetDeclarationInfo {
  id: string
  name: string
  description: string
  order: number
  plugins: PluginRow[]
}

export const PRESET_PACKAGE = '@deepseek-ai/dsh-agent-preset'
/** 模式列表里只露出一个入口：天枢主持的「百工模式」 */
export const BAIGONG_NAME = '百工模式'
export const BAIGONG_DESCRIPTION = '以天枢统御百工：建立含 Mermaid 执行流程的版本化任务卡，由独立专家与 Jev 审核目标和流程，按风险选用谋定、枢机、算衡、探微、博闻、观象、铸剑、行舟、疾风、御史、复核、妙笔 12 位专家；通过短检查点、按需材料、受限 P2P 邮箱及纯函数计算辅助协作。各专家可配置模型链、推理强度与容灾升级；交付由衡鉴复评，最终以当前版本的真实证据与硬门禁验收。'
/**
 * 12 个单角色预设默认停用，不出现在模式列表中（委派子智能体不依赖它们）。
 * 需要把某个专家单独作为主会话使用时，设置环境变量 DSH_SWARM_ROLE_PRESETS=1 后重启 dsh。
 */
export const ROLE_PRESETS_DISABLED = "process.env.DSH_SWARM_ROLE_PRESETS !== '1'"
export const SWARM_TOOLS_ROW: PluginRow = { id: 'swarm-tools', name: 'dsh-agent-swarm/tools' }

/** 委派统一走 swarm_delegate，通用委派组在全部 swarm 预设中移除；swarm 行由构建器自己追加 */
const DROPPED_ROWS = new Set(['delegation', 'swarm-tools', 'swarm-runtime'])
const SHELL_ROWS = new Set(['tool-bash', 'tool-pwsh', 'tool-jobs'])
const TIAN_SHU_ONLY_ROWS = new Set(['tool-plugin-manager'])
const ROLE_ORDER_BASE = 20

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const getRuntimeRow = (role: RoleId): PluginRow => ({ id: 'swarm-runtime', name: 'dsh-agent-swarm/runtime', config: { role } })

/**
 * 从 web-app 的 standard.patch.yml 解析结果中取出 preset-standard 的 plugins
 * @param {unknown} patch - YAML 解析结果
 * @returns {PluginRow[]} standard 预设的插件行
 */
export const getStandardPlugins = (patch: unknown): PluginRow[] => {
  const layers = Array.isArray(patch) ? patch : []
  for (const layer of layers) {
    const rows = isObject(layer) && Array.isArray(layer.insert) ? (layer.insert as unknown[]) : []
    const row = rows.find((item) => isObject(item) && item.id === 'preset-standard')
    const plugins = isObject(row) && isObject(row.config) ? row.config.plugins : undefined
    if (Array.isArray(plugins)) return plugins as PluginRow[]
  }
  throw new Error('standard.patch.yml 中找不到 preset-standard 的 plugins 列表')
}

/**
 * 以 standard 为底生成角色预设的插件行：替换 persona，按权限裁剪 shell/web，追加 swarm 行
 * 未识别的行原样保留，便于跟随 DSH 升级
 * @param {RoleId} role - 角色
 * @param {readonly PluginRow[]} standard - standard 预设插件行
 * @returns {PluginRow[]} 插件行
 */
export const getPresetPlugins = (role: RoleId, standard: readonly PluginRow[]): PluginRow[] => {
  const info = getRoleInfo(role)
  const keep = (row: PluginRow): PluginRow[] => {
    const id = row.id ?? ''
    if (DROPPED_ROWS.has(id)) return []
    if (id === 'persona') return [{ ...row, config: { ...(isObject(row.config) ? row.config : {}), prefix: getPresetPersona(role) } }]
    if (TIAN_SHU_ONLY_ROWS.has(id)) return role === 'tian_shu' ? [row] : []
    if (SHELL_ROWS.has(id)) return info.capabilities.includes('shell') ? [row] : []
    if (id === 'tool-web') return info.web === 'never' ? [] : [row]
    return [row]
  }
  return [...standard.flatMap(keep), ...(role === 'tian_shu' ? [SWARM_TOOLS_ROW] : []), getRuntimeRow(role)]
}

export const getPresetDescription = (role: RoleId): string => {
  const info = getRoleInfo(role)
  if (role === 'tian_shu') return BAIGONG_DESCRIPTION
  const base = `${info.title}：${info.duty}`
  return info.needsVision ? `${base}（需要支持图片输入的模型）` : base
}

export const getPresetDeclaration = (role: RoleId, standard: readonly PluginRow[]): PresetDeclarationInfo => {
  const info = getRoleInfo(role)
  return {
    id: info.presetId,
    name: role === 'tian_shu' ? BAIGONG_NAME : info.name,
    description: getPresetDescription(role),
    order: role === 'tian_shu' ? 0 : ROLE_ORDER_BASE + info.order,
    plugins: getPresetPlugins(role, standard)
  }
}

/**
 * 单个预设的 bundle 补丁内容
 * @param {RoleId} role - 角色
 * @param {readonly PluginRow[]} standard - standard 预设插件行
 * @returns {unknown[]} 补丁（YAML 顶层数组）
 */
export const getPresetPatch = (role: RoleId, standard: readonly PluginRow[]): unknown[] => [
  {
    insert: [{
      id: `preset-${getRoleInfo(role).presetId}`,
      name: PRESET_PACKAGE,
      ...(role === 'tian_shu' ? {} : { disabled: { $js: ROLE_PRESETS_DISABLED } }),
      config: getPresetDeclaration(role, standard)
    }]
  }
]

export const getPresetFileName = (role: RoleId): string => `presets/${getRoleInfo(role).presetId}.patch.yml`

export const getBundlePatchList = (): string[] => ['./cordis.patch.yml', ...ROLE_INFO_LIST.map((role) => `./${getPresetFileName(role.id)}`)]
