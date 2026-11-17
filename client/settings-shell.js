// 「设置 → 百工 Agent」页面（浏览器端）。
// 本文件是 client bundle 的模块体：scripts/build-client.mjs 把它包进 window.__ModuleLoader__.load，
// 并把 __SWARM_DATA__ 替换为从 lib/ 读出的角色表、默认路由链与容灾升级默认值，保证与宿主侧同源。
// 页面读写 swarm-core 条目的 volatile 字段 routes：每个角色一条「主模型 + 若干备用层」的链，
// 可升级的角色另有 upgrade（启用开关、升级模型链、触发条件）；
// 以及 agents：专家的会话策略（一次性 / 连续会话，由衡鉴判断）、自动重试、提示风格与断网等待。
// 页面顶部是 Jev API key 卡片：状态来自宿主 RPC（只含是否已配置与来源），写入走宿主凭据服务，密钥不进入配置文件。

const React = require('react')
const h = React.createElement
const { SETTINGS_TABS, ROUTE_DRAG_TYPE, getNextSettingsTab, moveRouteLayer } = require('@swarm/settings-navigation')

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string, policy?: Record<string, unknown> }} RouteInfo
 * @typedef {{ enabled: boolean, chain: RouteInfo[], triggers: string[] }} UpgradeInfo
 * @type {{
 *   namespace: string,
 *   agents: Array<{ key: string, name: string, title: string, note?: string, defaults: RouteInfo[], upgradeable: boolean, upgradeDefault?: UpgradeInfo, upgradeNote?: string }>,
 *   triggers: Array<{ id: string, label: string }>,
 *   policy?: { defaults: PolicyInfo }
 * }}
 * @typedef {{ session: string, repeatAbove: number, sameCategoryAbove: number, maxRetries: number, retryBackoffMs: number, promptStyle: string, networkWaitMs: number, rootRecoverMs: number, modelCallDisplay: string, nativeTeamProjection: boolean }} PolicyInfo
 */
const DATA = __SWARM_DATA__
const MATH = DATA.math

const NS = 'settings.swarmAgents'
const EMPTY_SLOT = Object.freeze({ provider: '', model: '', reasoningEffort: '' })
const NO_UPGRADE = Object.freeze({ enabled: false, chain: [], triggers: [] })
let settingsControllerSequence = 0
/** 与宿主 DEFAULT_AGENTS_CONFIG 一致；构建时由 DATA.policy 注入，缺失时用这份兜底 */
const POLICY_DEFAULTS = Object.freeze({ language: 'zh-CN', languageExclusions: [], session: 'auto', repeatAbove: 0.5, sameCategoryAbove: 0.5, maxRetries: 3, retryBackoffMs: 5000, promptStyle: 'auto', networkWaitMs: 600000, rootRecoverMs: 600000, modelCallDisplay: 'every', nativeTeamProjection: false, ...(DATA.policy?.defaults ?? {}) })
const SESSION_POLICIES = ['auto', 'continuable', 'oneshot']
const CATALOG_TIMEOUT_MS = 15000
const PROMPT_STYLES = ['auto', 'claude', 'gpt', 'generic']
const MODEL_CALL_DISPLAYS = ['every', 'turn']
const LANGUAGES = ['zh-CN', 'en', 'zh-TW', 'ja', 'ko']
const LANGUAGE_NAMES = { 'zh-CN': '简体中文', en: 'English', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어' }
const POLICY_KEYS = ['language', 'languageExclusions', 'session', 'repeatAbove', 'sameCategoryAbove', 'maxRetries', 'retryBackoffMs', 'promptStyle', 'networkWaitMs', 'rootRecoverMs', 'modelCallDisplay', 'nativeTeamProjection']
const getLanguageExclusions = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\x00-\x1f\x7f]/.test(id)))].slice(0, 128).sort() : []
/** Jev 密钥的默认凭据引用名（swarm-core 的 jev.apiKeyEnv） */
const DEFAULT_JEV_REF = 'TYPESAFE_API_KEY'
const WORKFLOW_MODES = ['off', 'advisory', 'enforced']
/** 流程与规划审核默认值：构建时由 DATA.planning 注入（与宿主 DEFAULT_WORKFLOW_CONFIG / DEFAULT_PLANNING_REVIEW 一致） */
const PLANNING_DEFAULTS = Object.freeze({ workflowMode: 'advisory', enabled: true, requireJev: false, maxFixRounds: 2, reviewAbove: 0.8, timeoutMs: 0, ...(DATA.planning?.defaults ?? {}) })
const PLANNING_TIMEOUT_MAX = 2147483647
/** workflow 其余字段的 schema 默认值：宿主不提供配置分层时，保存不把这些默认值固化进用户配置 */
const WORKFLOW_DEFAULTS = Object.freeze({ maxNodes: 32, maxEdges: 64, ...(DATA.planning?.workflow ?? {}) })
const APPROVAL_MODES = ['inherit', 'ask', 'deny']
const APPROVAL_SCOPES = ['write', 'shell', 'external_mcp', 'jev']
const APPROVAL_DEFAULTS = Object.freeze({ mode: 'inherit', scope: Object.freeze([...APPROVAL_SCOPES]) })
