// 「设置 → 百工 Agent」页面（浏览器端）。
// 本文件是 client bundle 的模块体：scripts/build-client.mjs 把它包进 window.__ModuleLoader__.load，
// 并把 __SWARM_DATA__ 替换为从 lib/ 读出的角色表、默认路由链与容灾升级默认值，保证与宿主侧同源。
// 页面读写 swarm-core 条目的 volatile 字段 routes：每个角色一条「主模型 + 若干备用层」的链，
// 可升级的角色另有 upgrade（启用开关、升级模型链、触发条件）；
// 以及 agents：专家的会话策略（一次性 / 连续会话，由衡鉴判断）、自动重试、提示风格与断网等待。
// 页面顶部是 Jev API key 卡片：状态来自宿主 RPC（只含是否已配置与来源），写入走宿主凭据服务，密钥不进入配置文件。

const React = require('react')
const h = React.createElement

/**
 * @typedef {{ provider: string, model: string, reasoningEffort?: string, policy?: Record<string, unknown> }} RouteInfo
 * @typedef {{ enabled: boolean, chain: RouteInfo[], triggers: string[] }} UpgradeInfo
 * @type {{
 *   namespace: string,
 *   agents: Array<{ key: string, name: string, title: string, note?: string, defaults: RouteInfo[], upgradeable: boolean, upgradeDefault?: UpgradeInfo, upgradeNote?: string }>,
 *   triggers: Array<{ id: string, label: string }>,
 *   policy?: { defaults: PolicyInfo }
 * }}
 * @typedef {{ session: string, repeatAbove: number, sameCategoryAbove: number, maxRetries: number, retryBackoffMs: number, promptStyle: string, networkWaitMs: number, rootRecoverMs: number, modelCallDisplay: string }} PolicyInfo
 */
const DATA = __SWARM_DATA__
const MATH = DATA.math

const NS = 'settings.swarmAgents'
const EMPTY_SLOT = Object.freeze({ provider: '', model: '', reasoningEffort: '' })
const NO_UPGRADE = Object.freeze({ enabled: false, chain: [], triggers: [] })
/** 与宿主 DEFAULT_AGENTS_CONFIG 一致；构建时由 DATA.policy 注入，缺失时用这份兜底 */
const POLICY_DEFAULTS = Object.freeze({ session: 'auto', repeatAbove: 0.5, sameCategoryAbove: 0.5, maxRetries: 3, retryBackoffMs: 5000, promptStyle: 'auto', networkWaitMs: 600000, rootRecoverMs: 600000, modelCallDisplay: 'every', ...(DATA.policy?.defaults ?? {}) })
const SESSION_POLICIES = ['auto', 'continuable', 'oneshot']
const PROMPT_STYLES = ['auto', 'claude', 'gpt', 'generic']
const MODEL_CALL_DISPLAYS = ['every', 'turn']
const POLICY_KEYS = ['session', 'repeatAbove', 'sameCategoryAbove', 'maxRetries', 'retryBackoffMs', 'promptStyle', 'networkWaitMs', 'rootRecoverMs', 'modelCallDisplay']
/** Jev 密钥的默认凭据引用名（swarm-core 的 jev.apiKeyEnv） */
const DEFAULT_JEV_REF = 'TYPESAFE_API_KEY'
const APPROVAL_MODES = ['inherit', 'ask', 'deny']
const APPROVAL_SCOPES = ['write', 'shell', 'external_mcp', 'jev']
const APPROVAL_DEFAULTS = Object.freeze({ mode: 'inherit', scope: Object.freeze([...APPROVAL_SCOPES]) })

const zh = {
  nav: '百工 Agent',
  title: '百工 Agent',
  description: '为 dsh-agent-swarm 的每个 Agent 配置模型路由：主模型加若干备用层（默认 4 层，可自由增减，以后接入新的供应商时可以继续加层），每层先选供应商再选模型。运行中按「主模型 → 备用 1 → 备用 2 → …」依次回退。部分 Agent 还可以配置「容灾升级」：遇到高风险、高歧义或结论冲突时，先改用更强的升级模型。',
  primary: '主模型',
  backup: '备用',
  upgradeLayer: '升级',
  provider: '供应商',
  model: '模型',
  effort: '推理强度',
  effortDefault: '默认',
  selectProvider: '选择供应商',
  selectModel: '选择模型',
  addLayer: '+ 添加一层',
  addUpgradeLayer: '+ 添加升级模型',
  removeLayer: '删除这一层',
  custom: '已自定义',
  builtin: '内置默认',
  reset: '恢复默认',
  save: '保存',
  saving: '保存中…',
  discard: '放弃修改',
  saved: '已保存，新的委派立即生效。',
  saveFailed: '保存失败：宿主没有接受这些值，已保留供你修改。',
  conflict: '设置已在其他位置更新，请放弃修改后重试。',
  loadingCatalog: '正在加载模型目录…',
  catalogFailed: '无法加载模型目录。',
  catalogPartial: '部分供应商的模型目录暂时无法加载：',
  retry: '重试',
  unavailable: 'dsh-agent-swarm 当前未加载，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
  loading: '正在读取配置…',
  notInCatalog: '当前不可用',
  upgradeTitle: '容灾升级',
  upgradeEnabled: '已启用',
  upgradeHint: '命中下列任一触发条件（或天枢显式要求）时，先依次使用升级模型；升级模型都不可用时回到上面的常规路由。',
  upgradeOff: '未启用：该 Agent 始终使用常规路由。',
  triggers: '触发条件',
  noTriggers: '未勾选任何条件时，只在天枢显式要求时升级。',
  errPrimary: '必须选择主模型',
  errUpgradePrimary: '启用升级时至少选择 1 个升级模型',
  errModel: '已选供应商但未选模型',
  errEmptyLayer: '请选择供应商，或删除这一层',
  errDuplicate: '与前面的模型重复',
  pending: '有未保存的修改',
  policyTitle: '专家会话与重试',
  policyDescription: '每次委派前，由衡鉴（Jev）判断这位专家做一次性调用，还是开连续会话：同一大类任务的后续工作（按审查意见修改、复查、补充验证）会追加到该专家已有的会话，保留上下文。专家未执行、中断、出错或交付不合格时自动重试。专家执行不设时间限制，衡鉴调用不设额度。',
  policySession: '会话策略',
  policyAuto: '由衡鉴判断（推荐）',
  policyContinuable: '全部用连续会话',
  policyOneshot: '全部一次性调用',
  policyRepeat: '开连续会话的阈值',
  policyRepeatHint: '衡鉴判断「同一大类任务还会再调用该专家」的概率达到此值时开连续会话（0–1）',
  policySame: '追加到已有会话的阈值',
  policySameHint: '衡鉴判断「新请求与已有会话属于同一大类」的概率达到此值时追加（0–1）',
  policyRetries: '自动重试次数',
  policyRetriesHint: '不含首次执行；0 表示不重试（0–10）',
  policyBackoff: '出错后首次重试等待（秒）',
  policyBackoffHint: '之后每次加倍；交付不合格时立即在会话内要求修正，不等待（0–600）',
  errRatio: '请输入 0 到 1 之间的数',
  errRetries: '请输入 0 到 10 之间的整数',
  errBackoff: '请输入 0 到 600 之间的数',
  policyStyle: '提示风格',
  policyStyleHint: '按模型家族组织给专家与天枢的提示：Claude 用 XML 分节，GPT 用目标/停止条件/证据，其他模型用编号步骤',
  styleAuto: '按模型自动选择（推荐）',
  styleClaude: '固定 Claude 风格',
  styleGpt: '固定 GPT 风格',
  styleGeneric: '固定通用风格',
  policyNetworkWait: '断网时等待恢复（分钟）',
  policyNetworkWaitHint: '模型请求因断网失败时先等网络恢复，再在原模型上重试；0 表示不等待，直接回退（0–120）',
  policyRootRecover: '天枢回退后恢复原模型（分钟）',
  policyRootRecoverHint: '天枢回退到备用模型后，经过这段时间重新尝试对话框所选的模型；0 表示不自动恢复（0–1440）',
  errNetworkWait: '请输入 0 到 120 之间的数',
  errRootRecover: '请输入 0 到 1440 之间的数',
  policyModelCall: '聊天中显示调用模型',
  policyModelCallHint: '百工会话的聊天窗口用一行显示「模型 · 供应商 · 推理强度」；换模型（回退、升级）时总会显示',
  modelCallEvery: '每次调用都显示',
  modelCallTurn: '每轮首次与换模型时显示',
  jevTitle: 'Jev 模型 API Key',
  jevDescription: '百工内嵌 TypeSafe Jev（System One）：衡鉴分流、专家会话判断、交付复评，以及 7 个 jev_* 判断工具（jev_ask / jev_check / jev_classify / jev_score / jev_match / jev_screen / jev_health）都直接在插件内调用，不需要外部 MCP。密钥保存在 DSH 凭据存储中，不会显示，也不会写入配置文件。',
  jevRef: '凭据引用',
  jevConfigured: '已配置',
  jevMissing: '未配置',
  jevUnknown: '状态未知',
  jevSource: '来源',
  jevReadOnly: '只读',
  jevPlaceholder: '粘贴 TypeSafe API key（tsk_…）',
  jevSave: '保存密钥',
  jevSaving: '保存中…',
  jevClear: '清除',
  jevTest: '测试连接',
  jevTesting: '测试中…',
  jevSaved: '密钥已保存，新的 Jev 调用立即使用。',
  jevCleared: '已清除保存的密钥。',
  jevShadowed: '当前密钥由只读来源（环境变量或服务环境文件）提供，这里无法覆盖；如需在此管理，请先从环境中移除该变量并重启 DSH。',
  jevOk: '连接正常',
  jevModels: '可用模型',
  jevLatency: '往返',
  jevFailed: '连接失败',
  jevDisabled: 'Jev 已在 swarm-core 配置中关闭（jev.enabled = false）。',
  jevLoadFailed: '无法读取 Jev 密钥状态。'
}

const en = {
  nav: 'Agent Swarm',
  title: 'Agent Swarm',
  description: 'Configure each dsh-agent-swarm agent\'s model route: a primary plus any number of backup layers (4 by default; add more as you connect new providers). Pick a provider, then a model, for each layer. Agents fall back primary → backup 1 → backup 2 → …. Some agents also offer an escalation upgrade: on high-risk, ambiguous or conflicting work they switch to a stronger model first.',
  primary: 'Primary',
  backup: 'Backup',
  upgradeLayer: 'Upgrade',
  provider: 'Provider',
  model: 'Model',
  effort: 'Reasoning',
  effortDefault: 'Default',
  selectProvider: 'Select provider',
  selectModel: 'Select model',
  addLayer: '+ Add layer',
  addUpgradeLayer: '+ Add upgrade model',
  removeLayer: 'Remove this layer',
  custom: 'Customized',
  builtin: 'Built-in default',
  reset: 'Reset to default',
  save: 'Save',
  saving: 'Saving…',
  discard: 'Discard',
  saved: 'Saved. New delegations use it immediately.',
  saveFailed: 'The host did not accept these values; they were left for you to correct.',
  conflict: 'Settings changed elsewhere. Discard your draft and try again.',
  loadingCatalog: 'Loading model catalog…',
  catalogFailed: 'The model catalog could not be loaded.',
  catalogPartial: 'Some providers could not be loaded: ',
  retry: 'Retry',
  unavailable: 'dsh-agent-swarm is not loaded, so it cannot be configured right now.',
  readOnly: 'This deployment stores settings read-only.',
  loading: 'Reading configuration…',
  notInCatalog: 'currently unavailable',
  upgradeTitle: 'Escalation upgrade',
  upgradeEnabled: 'Enabled',
  upgradeHint: 'When any trigger below matches (or the orchestrator asks explicitly), the upgrade models are tried first; if none is available the regular route above is used.',
  upgradeOff: 'Off: this agent always uses its regular route.',
  triggers: 'Triggers',
  noTriggers: 'With no trigger selected, the upgrade only happens when the orchestrator asks for it.',
  errPrimary: 'A primary model is required',
  errUpgradePrimary: 'Pick at least one upgrade model while the upgrade is enabled',
  errModel: 'Provider selected without a model',
  errEmptyLayer: 'Pick a provider, or remove this layer',
  errDuplicate: 'Duplicates an earlier model',
  pending: 'Unsaved changes',
  policyTitle: 'Agent sessions & retries',
  policyDescription: 'Before each delegation the Jev judge decides whether the agent runs one-shot or in a continuable session: follow-up work of the same kind (fixing review findings, re-checking, extra verification) is appended to that agent\'s existing session so it keeps its context. Agents that did not run, stopped, failed or returned an invalid result are retried automatically. Agent runs have no time limit and Jev calls have no quota.',
  policySession: 'Session policy',
  policyAuto: 'Decided by Jev (recommended)',
  policyContinuable: 'Always continuable',
  policyOneshot: 'Always one-shot',
  policyRepeat: 'Continuable threshold',
  policyRepeatHint: 'Open a continuable session when Jev rates "this agent will be called again for the same kind of task" at least this likely (0–1)',
  policySame: 'Append threshold',
  policySameHint: 'Append to an existing session when Jev rates "the new request belongs to the same kind of task" at least this likely (0–1)',
  policyRetries: 'Automatic retries',
  policyRetriesHint: 'Not counting the first run; 0 disables retries (0–10)',
  policyBackoff: 'First wait after an error (seconds)',
  policyBackoffHint: 'Doubles each time; invalid results are corrected in-session immediately (0–600)',
  errRatio: 'Enter a number between 0 and 1',
  errRetries: 'Enter a whole number between 0 and 10',
  errBackoff: 'Enter a number between 0 and 600',
  policyStyle: 'Prompt style',
  policyStyleHint: 'How prompts for experts and Tian Shu are organized: XML sections for Claude, goal/stop rules/evidence for GPT, numbered steps for other models',
  styleAuto: 'Match the model (recommended)',
  styleClaude: 'Always Claude style',
  styleGpt: 'Always GPT style',
  styleGeneric: 'Always generic style',
  policyNetworkWait: 'Wait for network (minutes)',
  policyNetworkWaitHint: 'When a model request fails because the network is down, wait for it to recover and retry the same model; 0 falls back immediately (0–120)',
  policyRootRecover: 'Restore Tian Shu model (minutes)',
  policyRootRecoverHint: 'After Tian Shu falls back to a backup model, retry the model selected in the composer after this long; 0 never restores (0–1440)',
  errNetworkWait: 'Enter a number between 0 and 120',
  errRootRecover: 'Enter a number between 0 and 1440',
  policyModelCall: 'Show model calls in chat',
  policyModelCallHint: 'Swarm sessions show a "model · provider · effort" line in the chat; a model switch (fallback, upgrade) is always shown',
  modelCallEvery: 'On every call',
  modelCallTurn: 'First call of each turn and on switches',
  jevTitle: 'Jev API key',
  jevDescription: 'The swarm embeds TypeSafe Jev (System One): triage, expert session planning, delivery review and the 7 jev_* judgment tools (jev_ask / jev_check / jev_classify / jev_score / jev_match / jev_screen / jev_health) call it directly from the plugin, with no external MCP. The key is kept in the DSH credential store; it is never displayed or written to configuration.',
  jevRef: 'Credential reference',
  jevConfigured: 'Configured',
  jevMissing: 'Not configured',
  jevUnknown: 'Unknown',
  jevSource: 'source',
  jevReadOnly: 'read-only',
  jevPlaceholder: 'Paste a TypeSafe API key (tsk_…)',
  jevSave: 'Save key',
  jevSaving: 'Saving…',
  jevClear: 'Clear',
  jevTest: 'Test connection',
  jevTesting: 'Testing…',
  jevSaved: 'Key saved. New Jev calls use it immediately.',
  jevCleared: 'Stored key removed.',
  jevShadowed: 'The current key comes from a read-only source (an environment variable or service environment file) and cannot be overridden here. Remove it from the environment and restart DSH to manage it here.',
  jevOk: 'Connected',
  jevModels: 'models',
  jevLatency: 'round trip',
  jevFailed: 'Connection failed',
  jevDisabled: 'Jev is disabled in the swarm-core configuration (jev.enabled = false).',
  jevLoadFailed: 'Could not read the Jev key status.'
}

Object.assign(zh, { errRoutePolicy: '路由额度域配置不合法或超限，请在配置中修正后保存', resource_subscription: '订阅', resource_metered_api: '按量 API', resource_judgment_api: '判断 API', resource_unknown: '资源类型未声明' })
Object.assign(en, { errRoutePolicy: 'Route quota policy is invalid or exceeds limits; repair its configuration before saving', resource_subscription: 'Subscription', resource_metered_api: 'Metered API', resource_judgment_api: 'Judgment API', resource_unknown: 'Resource type unspecified' })
Object.assign(zh, {
  mathTitle: '纯函数数学算子', mathEnabled: '启用数学计算', mathDescription: '按算子组、单个算子和数值模式共同授权；关闭后后端立即拒绝新的计算，不只隐藏界面。计算证据用于核对输入结果，不等于算法正确性证明。',
  mathModes: '允许的数值模式', mathExact: 'float64 仅有限数；bigint 为十进制整数字符串；rational 为分子/分母字符串。不作隐式跨类型转换，除零拒绝。',
  mathOptIn: '矩阵与多项式默认关闭，需显式开启。矩阵残差 A,x,b 还要求矩阵组和 matmul 开启。', mathLimits: '高级：单次计算规模与工作量', mathCalls: '每任务数学调用数（0 为不限）', mathWork: '每任务累计数学工作量', mathLimitsHint: '数学工作量是本地确定性计算计费单位，与模型 token、订阅额度和 Jev 调用无关。单次取配置上限与任务剩余额度的较小值。', errMath: '数学授权键或资源限制不合法，请核对配置；各限制须为范围内整数',
  mathGroup_arithmetic: '基础算术与比较', mathGroup_integer: '整数与组合', mathGroup_statistics: '统计', mathGroup_vector: '向量', mathGroup_matrix: '小矩阵（显式开启）', mathGroup_polynomial: '多项式（显式开启）', mathGroup_verification: '验证辅助',
  mathHint_arithmetic: 'add/sub/mul/div 支持三种模式；compare 为精确整数/有理数比较；compare_close 需显式 abs、rel 容差。', mathHint_integer: 'gcd/lcm 使用 bigint 字符串；binomial 的 n、k 为安全整数且 0 ≤ k ≤ n。gcd(0,0)=0，lcm 含零为零。', mathHint_statistics: 'Neumaier 补偿求和、缩放均值、移位缩放方差；ddof 为 0/1，默认 0；空数组仅 sum 返回 0。', mathHint_vector: 'dot 同长有限数组，O(n)；norm2 使用缩放法避免不必要的溢出。', mathHint_matrix: 'matmul 要求矩形和维度匹配，O(mnk)；全部乘加工作量在计算前扣除。', mathHint_polynomial: 'poly_eval 系数从常数项到最高次，Horner O(n)；空系数为零多项式。', mathHint_verification: 'residual_norm 对显式残差向量求范数；A,x,b 组合受矩阵授权约束，只输出计算残差。',
  mathLimit_maxInputBytes: '输入字节数', mathLimit_maxArrayElements: '单数组元素数', mathLimit_maxTotalElements: '总标量数', mathLimit_maxIntegerInputBits: '整数输入位数', mathLimit_maxIntegerOutputBits: '整数输出位数', mathLimit_maxIntermediateBits: '整数中间结果位数', mathLimit_maxBinomialN: '二项式最大 n', mathLimit_maxMatrixDimension: '矩阵单维大小', mathLimit_maxMultiplyAdds: '乘加数', mathLimit_maxPolynomialDegree: '多项式次数', mathLimit_maxWorkUnits: '单次数学工作量'
})
Object.assign(en, {
  mathTitle: 'Pure mathematical operators', mathEnabled: 'Enable mathematical computation', mathDescription: 'Group, individual operator and numeric mode permissions apply together. Disabled operations are rejected by the backend. Computed evidence checks supplied inputs, not general algorithm correctness.',
  mathModes: 'Allowed numeric modes', mathExact: 'float64 accepts finite numbers; bigint accepts decimal strings; rational accepts numerator/denominator strings. No implicit conversion. Division by zero is rejected.',
  mathOptIn: 'Matrix and polynomial groups require explicit opt-in. Matrix residual A,x,b also requires the matrix group and matmul.', mathLimits: 'Advanced: per-call size and work limits', mathCalls: 'Math calls per task (0 = unlimited)', mathWork: 'Cumulative math work per task', mathLimitsHint: 'Math work measures local deterministic computation, independently of model tokens, subscription quotas and Jev. Each call uses the smaller of its configured work limit and the task allowance remaining.', errMath: 'Invalid mathematical permission keys or resource limits; use integers within the displayed ranges',
  mathGroup_arithmetic: 'Arithmetic and comparison', mathGroup_integer: 'Integer and combinatorics', mathGroup_statistics: 'Statistics', mathGroup_vector: 'Vectors', mathGroup_matrix: 'Small matrices (opt-in)', mathGroup_polynomial: 'Polynomials (opt-in)', mathGroup_verification: 'Verification helpers',
  mathHint_arithmetic: 'add/sub/mul/div support all three modes; compare is exact bigint/rational comparison; compare_close needs explicit abs and rel tolerances.', mathHint_integer: 'gcd/lcm use bigint strings; binomial takes safe integer n,k with 0 ≤ k ≤ n. gcd(0,0)=0; lcm with zero is zero.', mathHint_statistics: 'Neumaier sum, scaled mean and shifted/scaled variance; ddof is 0/1, default 0. Only sum accepts an empty array.', mathHint_vector: 'dot requires equal-length finite arrays, O(n); norm2 scales inputs to avoid unnecessary overflow.', mathHint_matrix: 'matmul requires rectangular, compatible matrices, O(mnk); all multiply-add work is charged before computation.', mathHint_polynomial: 'poly_eval uses coefficients from constant to highest degree, Horner O(n); an empty list is the zero polynomial.', mathHint_verification: 'residual_norm computes an explicit residual vector norm. A,x,b additionally requires matrix permission; it reports a residual, not a proof.',
  mathLimit_maxInputBytes: 'Input bytes', mathLimit_maxArrayElements: 'Elements per array', mathLimit_maxTotalElements: 'Total scalars', mathLimit_maxIntegerInputBits: 'Integer input bits', mathLimit_maxIntegerOutputBits: 'Integer output bits', mathLimit_maxIntermediateBits: 'Intermediate integer bits', mathLimit_maxBinomialN: 'Maximum binomial n', mathLimit_maxMatrixDimension: 'Matrix dimension', mathLimit_maxMultiplyAdds: 'Multiply-add count', mathLimit_maxPolynomialDegree: 'Polynomial degree', mathLimit_maxWorkUnits: 'Work per call'
})
Object.assign(zh, {
  approvalsTitle: '百工工具审批', approvalsDescription: '为百工会话中所选类别的工具调用增加审批要求。继承沿用宿主策略；请求审批需要宿主提供审批能力；拒绝会阻止这些调用。插件不能覆盖宿主的 never 策略，也不能开启被宿主禁用的 MCP。',
  approvalsBoundary: '作用域只覆盖工具调用。shell 包含 run_code；jev 指显式 jev_* 工具。衡鉴分流、会话判断、交付复评与规划审核的内部 Jev HTTP 调用不受此开关控制。',
  approvalsMode: '审批策略', approvalsInherit: '继承宿主', approvalsAsk: '请求审批', approvalsDeny: '拒绝调用', approvalsScope: '作用域', approvalsWrite: '文件写入', approvalsShell: 'Shell / run_code', approvalsMcp: '外部 MCP', approvalsJev: '显式 Jev 工具', approvalsEmpty: '未选择作用域：此设置不会增加工具审批限制。', errApprovals: '请选择有效的审批策略和作用域',
  jevPermissionDenied: '宿主或服务拒绝访问。请检查对应权限；插件设置不能覆盖宿主审批策略。', jevInvalidResponse: '服务返回了不完整或非法数据，未作为有效判断接受。', jevCancelled: '连接测试已取消。'
})
Object.assign(en, {
  approvalsTitle: 'Swarm tool approvals', approvalsDescription: 'Add approval requirements for selected tool categories in swarm sessions. Inherit uses the host policy; Ask requires host approval support; Deny blocks selected calls. This plugin cannot override a host never policy or enable MCPs disabled by the host.',
  approvalsBoundary: 'These settings apply to tool calls only. Shell includes run_code; Jev means explicit jev_* tools. Internal Jev HTTP calls for triage, session planning, delivery review and planning review are unaffected.',
  approvalsMode: 'Approval policy', approvalsInherit: 'Inherit host', approvalsAsk: 'Ask for approval', approvalsDeny: 'Deny calls', approvalsScope: 'Scope', approvalsWrite: 'File writes', approvalsShell: 'Shell / run_code', approvalsMcp: 'External MCP', approvalsJev: 'Explicit Jev tools', approvalsEmpty: 'No scope selected: this setting adds no tool approval restrictions.', errApprovals: 'Select a valid approval policy and scope',
  jevPermissionDenied: 'The host or service denied access. Check its permissions; plugin settings cannot override host approval policy.', jevInvalidResponse: 'The service returned incomplete or invalid data; it was not accepted as a valid judgment.', jevCancelled: 'Connection test cancelled.'
})

// ───────────────────────── 纯逻辑（单元测试覆盖） ─────────────────────────

const asRecord = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

const getApprovals = (raw) => {
  const value = asRecord(raw)
  return { mode: APPROVAL_MODES.includes(value.mode) ? value.mode : APPROVAL_DEFAULTS.mode, scope: Array.isArray(value.scope) ? APPROVAL_SCOPES.filter((scope) => value.scope.includes(scope)) : [...APPROVAL_DEFAULTS.scope] }
}
const getApprovalErrors = (draft) => !APPROVAL_MODES.includes(draft.mode) || !Array.isArray(draft.scope) || draft.scope.some((scope) => !APPROVAL_SCOPES.includes(scope)) ? 'errApprovals' : undefined
const sameApprovals = (a, b) => a.mode === b.mode && a.scope.length === b.scope.length && a.scope.every((scope) => b.scope.includes(scope))
const buildApprovals = (draft, saved) => getApprovalErrors(draft) === undefined ? { ...asRecord(saved), mode: draft.mode, scope: APPROVAL_SCOPES.filter((scope) => draft.scope.includes(scope)) } : undefined

const getMath = (raw) => {
  const source = asRecord(raw)
  const defaults = MATH.defaults
  const invalid = raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))
  const invalidSection = ['groups', 'operators', 'numericModes', 'limits'].some((key) => source[key] !== undefined && (source[key] === null || typeof source[key] !== 'object' || Array.isArray(source[key])))
  return { ...defaults, ...source, ...(invalid || invalidSection ? { configurationError: 'Invalid math configuration' } : {}),
    groups: { ...defaults.groups, ...(source.enableExtended === true ? { matrix: true, polynomial: true } : {}), ...asRecord(source.groups) },
    operators: { ...defaults.operators, ...asRecord(source.operators) }, numericModes: { ...defaults.numericModes, ...asRecord(source.numericModes) }, limits: { ...defaults.limits, ...asRecord(source.limits) } }
}
const mathInteger = (value, minimum, maximum) => (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum
const getMathErrors = (value) => {
  const errors = {}
  if (typeof value.enabled !== 'boolean' || typeof value.enableExtended !== 'boolean' || value.configurationError !== undefined) errors.enabled = 'errMath'
  for (const section of ['groups', 'operators', 'numericModes']) {
    const known = MATH.defaults[section]
    if (Object.keys(asRecord(value[section])).some((key) => !Object.hasOwn(known, key) || typeof value[section][key] !== 'boolean') || Object.keys(known).some((key) => typeof value[section]?.[key] !== 'boolean')) errors[section] = 'errMath'
  }
  if (!mathInteger(value.maxCallsPerTask, 0, MATH.maxCallsPerTask)) errors.maxCallsPerTask = 'errMath'
  if (!mathInteger(value.maxWorkUnitsPerTask, 1, MATH.maxWorkPerTask)) errors.maxWorkUnitsPerTask = 'errMath'
  if (Object.keys(asRecord(value.limits)).some((key) => !Object.hasOwn(MATH.defaults.limits, key))) errors.limits = 'errMath'
  for (const key of Object.keys(MATH.defaults.limits)) if (!mathInteger(value.limits?.[key], 1, MATH.limitMaxima[key])) errors[key] = 'errMath'
  return errors
}
const buildMath = (draft, saved) => {
  if (Object.keys(getMathErrors(draft)).length > 0) return undefined
  const { configurationError: _error, ...old } = asRecord(saved)
  return { ...old, enabled: draft.enabled, enableExtended: false, maxCallsPerTask: Number(draft.maxCallsPerTask), maxWorkUnitsPerTask: Number(draft.maxWorkUnitsPerTask),
    ...Object.fromEntries(['groups', 'operators', 'numericModes'].map((section) => [section, { ...draft[section] }])),
    limits: Object.fromEntries(Object.keys(MATH.defaults.limits).map((key) => [key, Number(draft.limits[key])])) }
}

/** 保留页面不编辑的额度域等 JSON 元数据；容量或形状异常时阻止保存，不静默清掉隔离配置。 */
const cloneResourcePolicy = (raw) => {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    let remaining = 1024
    const copy = (value, depth) => {
      if (depth > 5 || --remaining < 0) throw new Error('policy complexity limit')
      if (value === null || typeof value === 'boolean') return value
      if (typeof value === 'string' && value.length <= 1024) return value
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (Array.isArray(value) && value.length <= 32) return value.map((item) => copy(item, depth + 1))
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const keys = Object.keys(value)
        if (keys.length > 32 || keys.some((key) => key.length > 128 || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('policy key limit')
        return Object.fromEntries(keys.map((key) => [key, copy(value[key], depth + 1)]))
      }
      throw new Error('policy must be bounded JSON')
    }
    const result = copy(raw, 0)
    return JSON.stringify(result).length <= 8192 ? result : undefined
  } catch { return undefined }
}

const policyDigest = (policy) => {
  const sort = (value) => Array.isArray(value) ? value.map(sort) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])])) : value
  return JSON.stringify(sort(policy))
}

const getResourceAccessMode = (slot) => {
  const configured = slot.policy?.accessMode
  const mode = configured ?? DATA.resourceTypes?.[slot.provider] ?? 'unknown'
  return !slot.policyInvalid && ['subscription', 'metered_api', 'judgment_api', 'unknown'].includes(mode) ? mode : 'unknown'
}

const toSlot = (route) => {
  const record = asRecord(route)
  const policy = record.policy === undefined ? undefined : cloneResourcePolicy(record.policy)
  return {
    provider: typeof record.provider === 'string' ? record.provider : '',
    model: typeof record.model === 'string' ? record.model : '',
    reasoningEffort: typeof record.reasoningEffort === 'string' ? record.reasoningEffort : '',
    ...(record.policy === undefined ? {} : policy === undefined ? { policyInvalid: true } : { policy })
  }
}

/**
 * 链 → 槽位；空链至少给出一个空槽位（主模型 / 第一个升级模型）
 * @param {unknown} chain - 路由链
 * @returns {Array<{provider: string, model: string, reasoningEffort: string}>} 槽位
 */
const getSlots = (chain) => {
  const slots = (Array.isArray(chain) ? chain : []).map(toSlot)
  return slots.length > 0 ? slots : [{ ...EMPTY_SLOT }]
}

/**
 * 某角色已保存的覆盖：常规链非空或配置了升级才算覆盖（与宿主 getRoleRoute 一致）
 * @param {unknown} routes - swarm-core 的 routes 值
 * @param {string} key - 路由键
 * @returns {{chain?: unknown[], escalation?: string, upgrade?: unknown} | undefined} 覆盖
 */
const getOverride = (routes, key) => {
  const entry = asRecord(asRecord(routes)[key])
  const hasChain = Array.isArray(entry.chain) && entry.chain.length > 0
  return hasChain || entry.upgrade !== undefined ? entry : undefined
}

const getSavedChain = (agent, override) =>
  override !== undefined && Array.isArray(override.chain) && override.chain.length > 0 ? override.chain : agent.defaults

/** 升级配置的视图（槽位形式）；不可升级的角色返回 undefined */
const getUpgradeView = (agent, override) => {
  if (!agent.upgradeable) return undefined
  const raw = override?.upgrade !== undefined ? asRecord(override.upgrade) : (agent.upgradeDefault ?? NO_UPGRADE)
  return {
    enabled: raw.enabled !== false && raw !== NO_UPGRADE,
    slots: getSlots(raw.chain),
    triggers: Array.isArray(raw.triggers) ? raw.triggers.filter((id) => DATA.triggers.some((t) => t.id === id)) : []
  }
}

const slotLabel = (slot) => `${slot.provider}/${slot.model}`

/**
 * 校验一组槽位：第一层必填；选了供应商必须选模型；空的非首层要么选上要么删掉；不得重复
 * @param {Array<{provider: string, model: string}>} slots - 槽位
 * @param {string} [firstError='errPrimary'] - 第一层为空时的错误键
 * @returns {Array<string | undefined>} 每个槽位的错误键（undefined 表示通过）
 */
const getSlotErrors = (slots, firstError = 'errPrimary') => {
  const seen = new Set()
  return slots.map((slot, index) => {
    if (slot.policyInvalid || (slot.policy !== undefined && cloneResourcePolicy(slot.policy) === undefined)) return 'errRoutePolicy'
    if (slot.provider === '') return index === 0 ? firstError : 'errEmptyLayer'
    if (slot.model === '') return 'errModel'
    const label = slotLabel(slot)
    if (seen.has(label)) return 'errDuplicate'
    seen.add(label)
    return undefined
  })
}

/** 槽位 → 宿主 RouteSchema 形状的链（未填完整的槽位不写入） */
const getChain = (slots) => slots
  .filter((slot) => slot.provider !== '' && slot.model !== '')
  .map((slot) => ({ provider: slot.provider, model: slot.model, ...(slot.reasoningEffort === '' ? {} : { reasoningEffort: slot.reasoningEffort }), ...(slot.policy === undefined ? {} : { policy: cloneResourcePolicy(slot.policy) }) }))

const sameSlots = (a, b) => a.length === b.length && a.every((slot, index) =>
  slot.provider === b[index].provider && slot.model === b[index].model && slot.reasoningEffort === b[index].reasoningEffort && slot.policyInvalid === b[index].policyInvalid && policyDigest(slot.policy) === policyDigest(b[index].policy))

const sameUpgrade = (a, b) => (a === undefined || b === undefined)
  ? a === b
  : a.enabled === b.enabled && sameSlots(getSlots(getChain(a.slots)), getSlots(getChain(b.slots))) && [...a.triggers].sort().join() === [...b.triggers].sort().join()

/** 草稿的错误：常规链；已启用的升级链 */
const getDraftErrors = (draft) => ({
  chain: getSlotErrors(draft.slots),
  upgrade: draft.upgrade !== undefined && draft.upgrade.enabled ? getSlotErrors(draft.upgrade.slots, 'errUpgradePrimary') : (draft.upgrade?.slots ?? []).map(() => undefined)
})

const hasErrors = (errors) => [...errors.chain, ...errors.upgrade].some((error) => error !== undefined)

/**
 * 按草稿生成新的 routes 值。每个草稿都是该角色的完整状态：与内置默认相同的部分不写入，
 * 这样默认值以后调整时仍能生效；两部分都等于默认时删除覆盖。原有的原生升级通道（escalation）保留。
 * @param {unknown} routes - 当前 routes
 * @param {Map<string, {reset: boolean, slots: Array, upgrade?: {enabled: boolean, slots: Array, triggers: string[]}}>} drafts - 草稿
 * @returns {{ ok: true, routes: Record<string, unknown> } | { ok: false, keys: string[] }} 结果
 */
const buildRoutes = (routes, drafts) => {
  const next = { ...asRecord(routes) }
  const invalid = []
  for (const [key, draft] of drafts) {
    const agent = DATA.agents.find((row) => row.key === key)
    if (agent === undefined) continue
    const escalation = asRecord(next[key]).escalation
    if (draft.reset) {
      if (typeof escalation === 'string') next[key] = { chain: [], escalation }
      else delete next[key]
      continue
    }
    if (hasErrors(getDraftErrors(draft))) {
      invalid.push(key)
      continue
    }
    const chain = getChain(draft.slots)
    const defaultUpgrade = getUpgradeView(agent, undefined)
    const entry = {
      chain: sameSlots(getSlots(chain), getSlots(agent.defaults)) ? [] : chain,
      ...(typeof escalation === 'string' ? { escalation } : {}),
      ...(draft.upgrade === undefined || sameUpgrade(draft.upgrade, defaultUpgrade)
        ? {}
        : { upgrade: { enabled: draft.upgrade.enabled, chain: getChain(draft.upgrade.slots), triggers: [...draft.upgrade.triggers] } })
    }
    if (entry.chain.length === 0 && entry.upgrade === undefined && entry.escalation === undefined) delete next[key]
    else next[key] = entry
  }
  return invalid.length > 0 ? { ok: false, keys: invalid } : { ok: true, routes: next }
}

// ───────────────────────── 会话与重试策略（纯逻辑） ─────────────────────────

/**
 * 读取已保存的 agents 策略：按默认值的类型逐字段取值，与宿主 getSwarmConfig 一致
 * @param {unknown} value - swarm-core 的 agents 值
 * @returns {PolicyInfo} 策略
 */
const getPolicy = (value) => {
  const record = asRecord(value)
  const merged = Object.fromEntries(POLICY_KEYS.map((key) => [key, typeof record[key] === typeof POLICY_DEFAULTS[key] ? record[key] : POLICY_DEFAULTS[key]]))
  return {
    ...merged,
    session: SESSION_POLICIES.includes(merged.session) ? merged.session : 'auto',
    promptStyle: PROMPT_STYLES.includes(merged.promptStyle) ? merged.promptStyle : 'auto',
    modelCallDisplay: MODEL_CALL_DISPLAYS.includes(merged.modelCallDisplay) ? merged.modelCallDisplay : 'every'
  }
}

/** 草稿里的数值字段可能是正在输入的字符串 */
const toNumber = (value) => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN)

/**
 * 校验策略草稿
 * @param {Record<string, unknown>} policy - 草稿（重试等待以秒为单位的 retryBackoffSec）
 * @returns {Record<string, string | undefined>} 各字段错误的文案键
 */
const getPolicyErrors = (policy) => {
  const ratio = (value) => { const n = toNumber(value); return Number.isFinite(n) && n >= 0 && n <= 1 ? undefined : 'errRatio' }
  const range = (value, max, error) => { const n = toNumber(value); return Number.isFinite(n) && n >= 0 && n <= max ? undefined : error }
  const retries = toNumber(policy.maxRetries)
  return {
    repeatAbove: ratio(policy.repeatAbove),
    sameCategoryAbove: ratio(policy.sameCategoryAbove),
    maxRetries: Number.isInteger(retries) && retries >= 0 && retries <= 10 ? undefined : 'errRetries',
    retryBackoffSec: range(policy.retryBackoffSec, 600, 'errBackoff'),
    networkWaitMin: range(policy.networkWaitMin, 120, 'errNetworkWait'),
    rootRecoverMin: range(policy.rootRecoverMin, 1440, 'errRootRecover')
  }
}

/** 草稿里的时长字段：重试等待用秒，断网等待与恢复用分钟 */
const DRAFT_KEYS = ['session', 'repeatAbove', 'sameCategoryAbove', 'maxRetries', 'retryBackoffSec', 'promptStyle', 'networkWaitMin', 'rootRecoverMin', 'modelCallDisplay']

/** 已保存策略 → 编辑草稿（时长换成秒或分钟） */
const toPolicyDraft = (policy) => ({
  session: policy.session,
  repeatAbove: policy.repeatAbove,
  sameCategoryAbove: policy.sameCategoryAbove,
  maxRetries: policy.maxRetries,
  retryBackoffSec: policy.retryBackoffMs / 1000,
  promptStyle: policy.promptStyle,
  networkWaitMin: policy.networkWaitMs / 60000,
  rootRecoverMin: policy.rootRecoverMs / 60000,
  modelCallDisplay: policy.modelCallDisplay
})

/**
 * 草稿 → 写入的 agents 值：只写与默认不同的字段，并保留页面不管理的已保存字段（例如 networkProbeUrls）；草稿有错时返回 undefined
 * @param {Record<string, unknown>} draft - 草稿
 * @param {unknown} [saved] - 已保存的 agents 值
 * @returns {Record<string, unknown> | undefined} agents 值
 */
const buildPolicy = (draft, saved) => {
  if (Object.values(getPolicyErrors(draft)).some((error) => error !== undefined)) return undefined
  const value = {
    session: SESSION_POLICIES.includes(draft.session) ? draft.session : 'auto',
    repeatAbove: toNumber(draft.repeatAbove),
    sameCategoryAbove: toNumber(draft.sameCategoryAbove),
    maxRetries: toNumber(draft.maxRetries),
    retryBackoffMs: Math.round(toNumber(draft.retryBackoffSec) * 1000),
    promptStyle: PROMPT_STYLES.includes(draft.promptStyle) ? draft.promptStyle : 'auto',
    networkWaitMs: Math.round(toNumber(draft.networkWaitMin) * 60000),
    rootRecoverMs: Math.round(toNumber(draft.rootRecoverMin) * 60000),
    modelCallDisplay: MODEL_CALL_DISPLAYS.includes(draft.modelCallDisplay) ? draft.modelCallDisplay : 'every'
  }
  const kept = Object.fromEntries(Object.entries(asRecord(saved)).filter(([key]) => !POLICY_KEYS.includes(key)))
  return { ...kept, ...Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== POLICY_DEFAULTS[key])) }
}

const samePolicy = (a, b) => DRAFT_KEYS.every((key) => String(a[key]) === String(b[key]))

// ───────────────────────── 控制器 ─────────────────────────

const copyUpgrade = (upgrade) => (upgrade === undefined ? undefined : { enabled: upgrade.enabled, slots: upgrade.slots.map((slot) => ({ ...slot })), triggers: [...upgrade.triggers] })

/** 持有 swarm-core 配置表单、模型目录与每个角色的草稿，向视图发布不可变快照 */
class SwarmAgentsController {
  constructor (ctx) {
    this.ctx = ctx
    this.form = ctx.configForms.get(DATA.namespace)
    this.drafts = new Map()
    /** 会话与重试策略的草稿；undefined 表示没有修改 */
    this.policyDraft = undefined
    this.approvalsDraft = undefined
    this.mathDraft = undefined
    this.draftRevision = undefined
    this.catalog = { status: 'idle', groups: [], failures: [] }
    this.saving = false
    this.notice = undefined
    this.conflicted = false
    this.disposed = false
    this.catalogGeneration = 0
    this.listeners = new Set()
    this.snapshot = this.project()
    this.subscribe = this.subscribe.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
    this.unsubscribe = this.form.subscribe(() => {
      const revision = this.form.getSnapshot().revision
      if (!this.saving && this.hasDrafts() && this.draftRevision !== undefined && revision !== this.draftRevision) this.conflicted = true
      this.publish()
    })
  }

  subscribe (listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot () { return this.snapshot }

  dispose () {
    this.disposed = true
    this.catalogGeneration += 1
    this.unsubscribe()
    this.listeners.clear()
  }

  routes () { return asRecord(this.form.getSnapshot().value).routes }

  /**
   * 页面不管理、但用户或 profile 显式写过的 agents 字段：取组合层与用户层，不取 schema 默认值，
   * 避免一次保存把默认值（例如探测地址列表）固化成用户配置；宿主不提供分层时退回解析后的值
   */
  savedAgentsLayers () {
    const snapshot = this.form.getSnapshot()
    if (snapshot.base === undefined && snapshot.user === undefined) return asRecord(snapshot.value).agents
    return { ...asRecord(asRecord(snapshot.base).agents), ...asRecord(asRecord(snapshot.user).agents) }
  }

  savedPolicy () { return getPolicy(asRecord(this.form.getSnapshot().value).agents) }

  savedApprovals () { return getApprovals(asRecord(this.form.getSnapshot().value).approvals) }

  savedMath () { return getMath(asRecord(this.form.getSnapshot().value).math) }

  hasDrafts () { return this.drafts.size > 0 || this.policyDraft !== undefined || this.approvalsDraft !== undefined || this.mathDraft !== undefined }

  setMath (patch) {
    if (!this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    const base = this.mathDraft ?? this.savedMath()
    this.mathDraft = { ...base, ...patch }
    for (const section of ['groups', 'operators', 'numericModes', 'limits']) this.mathDraft[section] = { ...base[section], ...asRecord(patch[section]) }
    const normalized = buildMath(this.mathDraft, undefined)
    const saved = buildMath(this.savedMath(), undefined)
    if (normalized !== undefined && policyDigest(normalized) === policyDigest(saved)) this.mathDraft = undefined
    if (!this.hasDrafts()) this.draftRevision = undefined
    this.notice = undefined
    this.publish()
  }

  resetMath () {
    if (!this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    this.mathDraft = getMath(undefined)
    if (policyDigest(buildMath(this.mathDraft, undefined)) === policyDigest(buildMath(this.savedMath(), undefined))) this.mathDraft = undefined
    if (!this.hasDrafts()) this.draftRevision = undefined
    this.notice = undefined
    this.publish()
  }

  setApprovals (patch) {
    if (!this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    this.approvalsDraft = { ...(this.approvalsDraft ?? this.savedApprovals()), ...patch }
    if (getApprovalErrors(this.approvalsDraft) === undefined && sameApprovals(this.approvalsDraft, this.savedApprovals())) this.approvalsDraft = undefined
    if (!this.hasDrafts()) this.draftRevision = undefined
    this.notice = undefined
    this.publish()
  }

  toggleApprovalScope (scope) {
    if (!APPROVAL_SCOPES.includes(scope)) return
    const value = this.approvalsDraft ?? this.savedApprovals()
    this.setApprovals({ scope: value.scope.includes(scope) ? value.scope.filter((item) => item !== scope) : [...value.scope, scope] })
  }

  /** 修改会话与重试策略的一个字段 */
  setPolicy (patch) {
    if (!this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    const base = this.policyDraft ?? toPolicyDraft(this.savedPolicy())
    this.policyDraft = { ...base, ...patch }
    if (samePolicy(this.policyDraft, toPolicyDraft(this.savedPolicy()))) this.policyDraft = undefined
    if (!this.hasDrafts()) this.draftRevision = undefined
    this.notice = undefined
    this.publish()
  }

  resetPolicy () {
    if (!this.canEdit()) return
    this.setPolicy(toPolicyDraft(getPolicy(undefined)))
  }

  /** 已保存状态（无草稿时显示的内容） */
  saved (agent) {
    const override = getOverride(this.routes(), agent.key)
    return { slots: getSlots(getSavedChain(agent, override)), upgrade: getUpgradeView(agent, override) }
  }

  /** 视图状态：有草稿用草稿（恢复默认的草稿显示默认值），否则显示已保存状态 */
  view (agent) {
    const draft = this.drafts.get(agent.key)
    if (draft === undefined) return this.saved(agent)
    if (draft.reset) return { slots: getSlots(agent.defaults), upgrade: getUpgradeView(agent, undefined) }
    return draft
  }

  beginDraft (agent) {
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    const existing = this.drafts.get(agent.key)
    if (existing !== undefined && !existing.reset) return existing
    const base = this.view(agent)
    const draft = { reset: false, slots: base.slots.map((slot) => ({ ...slot })), upgrade: copyUpgrade(base.upgrade) }
    this.drafts.set(agent.key, draft)
    return draft
  }

  canEdit () {
    const snapshot = this.form.getSnapshot()
    return !this.disposed && snapshot.status === 'ready' && snapshot.writable && !this.saving
  }

  /** 编辑一个角色：取得草稿后执行 change，再清理与已保存一致的草稿并发布 */
  edit (agentKey, change) {
    const agent = DATA.agents.find((row) => row.key === agentKey)
    if (agent === undefined || !this.canEdit()) return
    const draft = this.beginDraft(agent)
    change(draft, agent)
    this.notice = undefined
    this.dropIfClean(agent)
    this.publish()
  }

  /** target 为 'chain'（常规路由）或 'upgrade'（容灾升级） */
  slotsOf (draft, target) {
    return target === 'upgrade' ? draft.upgrade?.slots : draft.slots
  }

  setSlot (agentKey, index, patch, target = 'chain') {
    this.edit(agentKey, (draft) => {
      const slots = this.slotsOf(draft, target)
      if (slots === undefined || slots[index] === undefined) return
      const slot = { ...slots[index], ...patch }
      // 换供应商：若新供应商下没有同名模型则清空模型；推理强度随模型重选
      if (patch.provider !== undefined) {
        if (slot.provider === '' || !this.hasModel(slot.provider, slot.model)) slot.model = ''
        slot.reasoningEffort = ''
      }
      if (patch.model !== undefined) slot.reasoningEffort = ''
      slots[index] = slot
    })
  }

  addLayer (agentKey, target = 'chain') {
    this.edit(agentKey, (draft) => {
      const slots = this.slotsOf(draft, target)
      if (slots !== undefined) slots.push({ ...EMPTY_SLOT })
    })
  }

  removeLayer (agentKey, index, target = 'chain') {
    this.edit(agentKey, (draft) => {
      const slots = this.slotsOf(draft, target)
      // 常规链保留主模型；升级链至少保留一层（可停用整个升级）
      if (slots === undefined || index <= 0 || index >= slots.length) return
      slots.splice(index, 1)
    })
  }

  setUpgradeEnabled (agentKey, enabled) {
    this.edit(agentKey, (draft) => {
      if (draft.upgrade !== undefined) draft.upgrade.enabled = enabled
    })
  }

  toggleTrigger (agentKey, trigger) {
    this.edit(agentKey, (draft) => {
      if (draft.upgrade === undefined) return
      const has = draft.upgrade.triggers.includes(trigger)
      draft.upgrade.triggers = has ? draft.upgrade.triggers.filter((id) => id !== trigger) : [...draft.upgrade.triggers, trigger]
    })
  }

  resetAgent (agentKey) {
    const agent = DATA.agents.find((row) => row.key === agentKey)
    if (agent === undefined || !this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    this.drafts.set(agent.key, { reset: true, slots: getSlots(agent.defaults), upgrade: getUpgradeView(agent, undefined) })
    this.notice = undefined
    this.dropIfClean(agent)
    this.publish()
  }

  /** 草稿与已保存状态一致时丢弃，避免出现「无改动也显示待保存」 */
  dropIfClean (agent) {
    const draft = this.drafts.get(agent.key)
    if (draft === undefined) return
    const override = getOverride(this.routes(), agent.key)
    const saved = this.saved(agent)
    const clean = draft.reset
      ? override === undefined
      : sameSlots(draft.slots, saved.slots) && sameUpgrade(draft.upgrade, saved.upgrade)
    if (clean) this.drafts.delete(agent.key)
    if (!this.hasDrafts()) this.draftRevision = undefined
  }

  discard () {
    if (this.saving) return
    this.drafts.clear()
    this.policyDraft = undefined
    this.approvalsDraft = undefined
    this.mathDraft = undefined
    this.draftRevision = undefined
    this.conflicted = false
    this.notice = undefined
    this.publish()
  }

  async save () {
    if (!this.canEdit() || !this.hasDrafts()) return
    const snapshot = this.form.getSnapshot()
    if (this.draftRevision !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const ops = []
    if (this.drafts.size > 0) {
      const result = buildRoutes(this.routes(), this.drafts)
      if (!result.ok) {
        this.publish()
        return
      }
      ops.push({ op: 'set', path: ['routes'], value: result.routes })
    }
    if (this.policyDraft !== undefined) {
      const agents = buildPolicy(this.policyDraft, this.savedAgentsLayers())
      if (agents === undefined) {
        this.publish()
        return
      }
      ops.push({ op: 'set', path: ['agents'], value: agents })
    }
    if (this.approvalsDraft !== undefined) {
      const approvals = buildApprovals(this.approvalsDraft, asRecord(snapshot.value).approvals)
      if (approvals === undefined) { this.publish(); return }
      ops.push({ op: 'set', path: ['approvals'], value: approvals })
    }
    if (this.mathDraft !== undefined) {
      const math = buildMath(this.mathDraft, asRecord(snapshot.value).math)
      if (math === undefined) { this.publish(); return }
      ops.push({ op: 'set', path: ['math'], value: math })
    }
    this.saving = true
    this.notice = undefined
    this.publish()
    let accepted = false
    try {
      accepted = await this.form.mutate(ops, this.draftRevision)
    } catch {
      accepted = false
    }
    if (this.disposed) return
    this.saving = false
    if (accepted) {
      this.drafts.clear()
      this.policyDraft = undefined
      this.approvalsDraft = undefined
      this.mathDraft = undefined
      this.draftRevision = undefined
      this.conflicted = false
      this.notice = 'saved'
    } else {
      this.notice = 'saveFailed'
    }
    this.publish()
  }

  hasModel (provider, model) {
    const group = this.catalog.groups.find((row) => row.id === provider)
    return group !== undefined && group.models.some((row) => row.id === model)
  }

  async loadCatalog () {
    if (this.disposed || this.catalog.status === 'loading') return
    const generation = ++this.catalogGeneration
    this.catalog = { ...this.catalog, status: 'loading' }
    this.publish()
    let response
    try {
      response = await this.ctx.remote.session.modelCatalog()
    } catch (error) {
      response = { ok: false, error }
    }
    if (generation !== this.catalogGeneration) return
    this.catalog = response.ok
      ? { status: 'ready', groups: response.value.groups, failures: response.value.failures }
      : { status: 'error', groups: this.catalog.groups, failures: [] }
    this.publish()
  }

  refreshCatalog () {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalog = { ...this.catalog, status: 'idle' }
    this.loadCatalog()
  }

  resetConnection () {
    if (this.disposed) return
    this.saving = false
    this.drafts.clear()
    this.policyDraft = undefined
    this.approvalsDraft = undefined
    this.mathDraft = undefined
    this.draftRevision = undefined
    this.conflicted = false
    this.refreshCatalog()
  }

  project () {
    const snapshot = this.form.getSnapshot()
    const routes = this.routes()
    const rows = DATA.agents.map((agent) => {
      const draft = this.drafts.get(agent.key)
      const view = this.view(agent)
      const custom = draft === undefined ? getOverride(routes, agent.key) !== undefined : !draft.reset
      const errors = draft === undefined || draft.reset
        ? { chain: view.slots.map(() => undefined), upgrade: (view.upgrade?.slots ?? []).map(() => undefined) }
        : getDraftErrors(draft)
      return {
        key: agent.key,
        name: agent.name,
        title: agent.title,
        note: agent.note,
        upgradeNote: agent.upgradeNote,
        custom,
        dirty: draft !== undefined,
        slots: view.slots,
        upgrade: view.upgrade,
        errors
      }
    })
    const savedPolicy = this.savedPolicy()
    const policyValue = this.policyDraft ?? toPolicyDraft(savedPolicy)
    const policyErrors = this.policyDraft === undefined ? {} : getPolicyErrors(this.policyDraft)
    const policy = {
      value: policyValue,
      custom: POLICY_KEYS.some((key) => savedPolicy[key] !== POLICY_DEFAULTS[key]),
      dirty: this.policyDraft !== undefined,
      errors: policyErrors
    }
    const approvals = { value: this.approvalsDraft ?? this.savedApprovals(), dirty: this.approvalsDraft !== undefined, error: this.approvalsDraft === undefined ? undefined : getApprovalErrors(this.approvalsDraft) }
    const mathValue = this.mathDraft ?? this.savedMath()
    const math = { value: mathValue, dirty: this.mathDraft !== undefined, errors: getMathErrors(mathValue) }
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      rows,
      policy,
      approvals,
      math,
      catalog: this.catalog,
      saving: this.saving,
      dirty: this.hasDrafts(),
      invalid: rows.some((row) => row.dirty && hasErrors(row.errors)) || Object.values(policyErrors).some((error) => error !== undefined) || approvals.error !== undefined || (math.dirty && Object.keys(math.errors).length > 0),
      conflicted: this.conflicted,
      notice: this.notice
    }
  }

  publish () {
    if (this.disposed) return
    this.snapshot = this.project()
    for (const listener of [...this.listeners]) listener()
  }
}

// ───────────────────────── Jev API key ─────────────────────────

/**
 * Jev API key 卡片的状态：宿主 RPC 给出密钥是否已配置与来源（从不返回密钥值），
 * 保存与清除走宿主凭据服务（remote.credentials），新的 Jev 调用立即使用，不需要重启。
 */
class JevKeyController {
  constructor (ctx, getRef) {
    this.ctx = ctx
    this.getRef = getRef
    this.state = { status: 'idle', info: undefined, draft: '', saving: false, testing: false, test: undefined, notice: undefined, error: undefined, loadError: undefined }
    this.listeners = new Set()
    this.disposed = false
    this.generation = 0
    this.testGeneration = 0
    this.subscribe = this.subscribe.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
  }

  subscribe (listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot () { return this.state }

  dispose () {
    this.disposed = true
    this.generation += 1
    this.testGeneration += 1
    this.listeners.clear()
  }

  update (patch) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** 调用本插件的宿主 RPC（POST /api/swarm.<method>） */
  async rpc (method) {
    const connection = this.ctx.get('connection')
    if (typeof connection?.rpc?.call !== 'function') throw Object.assign(new Error('rpc method unavailable'), { code: 'gateway/method-not-found' })
    const result = await connection.rpc.call('/api', `swarm.${method}`, {})
    if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? 'rpc failed'), { code: result?.error?.code, details: result?.error?.details })
    return result.value
  }

  async load () {
    const generation = ++this.generation
    this.testGeneration += 1
    this.update({ status: 'loading', test: undefined, testing: false, loadError: undefined })
    let info
    let error
    try {
      info = await this.rpc('jevStatus')
    } catch (failure) {
      // 仅旧宿主明确不存在此方法时兼容；权限拒绝或未知故障不能改走另一操作。
      if (['gateway/method-not-found', 'rpc/method-not-found', 'swarm/method-not-found'].includes(failure?.code)) try {
        const ref = this.getRef()
        const response = await this.ctx.remote.credentials.describe([ref])
        info = response.ok && response.value[ref] !== undefined ? { ref, ...response.value[ref] } : undefined
      } catch (fallbackFailure) {
        info = undefined
        error = fallbackFailure instanceof Error ? fallbackFailure.message : String(fallbackFailure)
      }
      else error = `${failure?.code === undefined ? '' : `${failure.code}: `}${failure instanceof Error ? failure.message : String(failure)}`
    }
    if (generation !== this.generation) return
    this.update(info === undefined ? { status: 'error', info: undefined, loadError: error } : { status: 'ready', info })
  }

  setDraft (draft) {
    this.update({ draft, notice: undefined, error: undefined })
  }

  async write (operation) {
    const ref = this.state.info?.ref ?? this.getRef()
    const value = this.state.draft.trim()
    if (this.state.saving || (operation === 'set' && value === '')) return
    this.testGeneration += 1
    this.update({ saving: true, notice: undefined, error: undefined, testing: false, test: undefined })
    let error
    try {
      const response = operation === 'set' ? await this.ctx.remote.credentials.set(ref, value) : await this.ctx.remote.credentials.unset(ref)
      if (!response.ok) error = response.error?.message ?? 'refused'
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    this.update({ saving: false, test: undefined, ...(error === undefined ? { draft: '', notice: operation === 'set' ? 'jevSaved' : 'jevCleared' } : { error }) })
    await this.load()
  }

  save () { return this.write('set') }

  clear () { return this.write('unset') }

  async test () {
    if (this.state.testing || this.state.saving || this.disposed) return
    const generation = ++this.testGeneration
    const ref = this.getRef()
    this.update({ testing: true, test: undefined })
    let test
    try {
      test = await this.rpc('jevHealth')
    } catch (failure) {
      test = { error: failure instanceof Error ? failure.message : String(failure), ...(failure?.code === undefined ? {} : { code: failure.code }) }
    }
    if (this.disposed || generation !== this.testGeneration) return
    if (ref !== this.getRef()) { this.update({ testing: false, test: undefined }); return }
    this.update({ testing: false, test })
  }
}

// ───────────────────────── 视图 ─────────────────────────

const color = {
  primary: 'var(--dsw-alias-label-primary, #182635)',
  secondary: 'var(--dsw-alias-label-secondary, #596b7d)',
  tertiary: 'var(--dsw-alias-label-tertiary, #6a7e95)',
  border: 'var(--dsw-alias-border-l2, #d9e0e8)',
  layer: 'var(--dsw-alias-bg-layer-3, #fff)',
  danger: 'var(--dsw-alias-label-danger, #d9480f)',
  success: 'var(--dsw-alias-label-success, #2b8a3e)'
}

const style = {
  section: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 },
  heading: { margin: 0, fontSize: 18, fontWeight: 600, color: color.primary },
  description: { margin: 0, fontSize: 13, lineHeight: 1.6, color: color.secondary },
  banner: { fontSize: 13, color: color.secondary, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  card: { border: `1px solid ${color.border}`, borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { fontSize: 14, fontWeight: 600, color: color.primary },
  title: { fontSize: 12, color: color.tertiary },
  tag: { fontSize: 11, padding: '1px 8px', borderRadius: 999, cornerShape: 'round', border: `1px solid ${color.border}`, color: color.secondary },
  note: { fontSize: 12, color: color.tertiary, margin: 0, lineHeight: 1.5 },
  grid: { display: 'grid', gridTemplateColumns: '56px minmax(0,1fr) minmax(0,1.4fr) minmax(0,0.8fr) 26px', gap: '6px 8px', alignItems: 'center' },
  slotLabel: { fontSize: 12, color: color.secondary },
  select: { height: 30, minWidth: 0, width: '100%', padding: '0 8px', font: 'inherit', fontSize: 12, borderRadius: 8, border: `1px solid ${color.border}`, background: color.layer, color: color.primary },
  error: { gridColumn: '2 / -1', fontSize: 11, color: color.danger, marginTop: -2 },
  spacer: { flex: 1 },
  footer: { position: 'sticky', bottom: 0, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', padding: '10px 0', borderTop: `1px solid ${color.border}`, background: 'var(--dsw-alias-bg-layer-2, #f7f8fb)' },
  btn: { font: 'inherit', fontSize: 13, padding: '5px 14px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${color.border}`, background: 'none', color: color.secondary },
  btnSmall: { font: 'inherit', fontSize: 12, padding: '2px 10px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${color.border}`, background: 'none', color: color.secondary },
  btnLink: { font: 'inherit', fontSize: 12, padding: '2px 0', border: 'none', background: 'none', color: color.secondary, cursor: 'pointer', justifySelf: 'start' },
  btnRemove: { font: 'inherit', fontSize: 14, lineHeight: '24px', width: 26, height: 26, padding: 0, borderRadius: 8, border: `1px solid ${color.border}`, background: 'none', color: color.tertiary, cursor: 'pointer' },
  btnPrimary: { font: 'inherit', fontSize: 13, padding: '5px 14px', borderRadius: 8, cursor: 'pointer', border: '1px solid transparent', background: color.primary, color: color.layer },
  upgrade: { borderTop: `1px dashed ${color.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 },
  upgradeHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  upgradeTitle: { fontSize: 13, fontWeight: 600, color: color.primary },
  switchLabel: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: color.secondary, cursor: 'pointer' },
  chips: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '2px 10px', borderRadius: 999, cornerShape: 'round', border: `1px solid ${color.border}`, color: color.secondary, cursor: 'pointer', userSelect: 'none' },
  policyGrid: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '10px 14px' },
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
  fieldLabel: { fontSize: 12, color: color.secondary },
  input: { height: 30, minWidth: 0, width: '100%', boxSizing: 'border-box', padding: '0 8px', font: 'inherit', fontSize: 12, borderRadius: 8, border: `1px solid ${color.border}`, background: color.layer, color: color.primary },
  hint: { fontSize: 11, color: color.tertiary, lineHeight: 1.4 },
  fieldError: { fontSize: 11, color: color.danger },
  keyRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  keyInput: { height: 30, flex: '1 1 260px', minWidth: 0, boxSizing: 'border-box', padding: '0 8px', font: 'inherit', fontSize: 12, borderRadius: 8, border: `1px solid ${color.border}`, background: color.layer, color: color.primary },
  statusOk: { fontSize: 12, color: color.success },
  statusBad: { fontSize: 12, color: color.danger }
}

const layerLabel = (t, target, index) => (target === 'upgrade'
  ? `${t('upgradeLayer')} ${index + 1}`
  : index === 0 ? t('primary') : `${t('backup')} ${index}`)

/** 供应商下拉：目录中的供应商 + 已保存但当前不在目录中的值 */
function ProviderSelect ({ t, slot, label, groups, disabled, onChange }) {
  const options = groups.map((group) => h('option', { key: group.id, value: group.id }, group.name === group.id ? group.id : `${group.name}（${group.id}）`))
  if (slot.provider !== '' && !groups.some((group) => group.id === slot.provider)) {
    options.push(h('option', { key: `missing:${slot.provider}`, value: slot.provider }, `${slot.provider}（${t('notInCatalog')}）`))
  }
  return h('select', {
    style: style.select,
    value: slot.provider,
    disabled,
    'aria-label': `${label} ${t('provider')}`,
    onChange: (event) => onChange({ provider: event.target.value })
  }, h('option', { value: '' }, t('selectProvider')), ...options)
}

/** 模型下拉：只列所选供应商目录中的模型 */
function ModelSelect ({ t, slot, label, groups, disabled, onChange }) {
  const group = groups.find((row) => row.id === slot.provider)
  const models = group?.models ?? []
  const options = models.map((model) => h('option', { key: model.id, value: model.id }, model.name === model.id ? model.id : `${model.name}（${model.id}）`))
  if (slot.model !== '' && !models.some((model) => model.id === slot.model)) {
    options.push(h('option', { key: `missing:${slot.model}`, value: slot.model }, `${slot.model}（${t('notInCatalog')}）`))
  }
  return h('select', {
    style: style.select,
    value: slot.model,
    disabled: disabled || slot.provider === '',
    'aria-label': `${label} ${t('model')}`,
    onChange: (event) => onChange({ model: event.target.value })
  }, h('option', { value: '' }, t('selectModel')), ...options)
}

/** 推理强度下拉：模型声明了 reasoning 时列出其档位，否则只保留已存值 */
function EffortSelect ({ t, slot, label, groups, disabled, onChange }) {
  const model = groups.find((row) => row.id === slot.provider)?.models.find((row) => row.id === slot.model)
  const efforts = model?.reasoning?.efforts ?? []
  const options = efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))
  if (slot.reasoningEffort !== '' && !efforts.some((effort) => effort.id === slot.reasoningEffort)) {
    options.push(h('option', { key: `saved:${slot.reasoningEffort}`, value: slot.reasoningEffort }, slot.reasoningEffort))
  }
  return h('select', {
    style: style.select,
    value: slot.reasoningEffort,
    disabled: disabled || slot.model === '' || options.length === 0,
    'aria-label': `${label} ${t('effort')}`,
    onChange: (event) => onChange({ reasoningEffort: event.target.value })
  }, h('option', { value: '' }, t('effortDefault')), ...options)
}

/** 一组路由层：每层 供应商 / 模型 / 推理强度 / 删除，末尾「添加一层」 */
function LayerGrid ({ t, rowKey, target, slots, errors, groups, editable, controller }) {
  const cells = slots.flatMap((slot, index) => {
    const label = layerLabel(t, target, index)
    const onChange = (patch) => controller.setSlot(rowKey, index, patch, target)
    const common = { t, slot, label, groups, disabled: !editable, onChange }
    const error = errors[index]
    return [
      h('span', { key: `l${index}`, style: style.slotLabel }, label, h('small', { style: { display: 'block', fontWeight: 400 }, 'data-route-access-mode': getResourceAccessMode(slot) }, t(`resource_${getResourceAccessMode(slot)}`))),
      h(ProviderSelect, { key: `p${index}`, ...common }),
      h(ModelSelect, { key: `m${index}`, ...common }),
      h(EffortSelect, { key: `e${index}`, ...common }),
      index === 0
        ? h('span', { key: `r${index}` })
        : h('button', { key: `r${index}`, type: 'button', style: style.btnRemove, disabled: !editable, title: t('removeLayer'), 'aria-label': `${t('removeLayer')}：${label}`, onClick: () => controller.removeLayer(rowKey, index, target) }, '×'),
      error === undefined ? null : h('span', { key: `x${index}`, style: style.error, role: 'alert' }, t(error))
    ]
  })
  return h('div', { style: style.grid },
    ...cells,
    h('span', { key: 'add-pad' }),
    h('button', { key: 'add', type: 'button', style: style.btnLink, disabled: !editable, onClick: () => controller.addLayer(rowKey, target) }, target === 'upgrade' ? t('addUpgradeLayer') : t('addLayer'))
  )
}

/** 容灾升级区块：只在可升级的角色上显示 */
function UpgradeBlock ({ t, row, groups, editable, controller }) {
  const upgrade = row.upgrade
  return h('div', { style: style.upgrade, 'data-swarm-upgrade': row.key },
    h('div', { style: style.upgradeHead },
      h('span', { style: style.upgradeTitle }, t('upgradeTitle')),
      h('label', { style: style.switchLabel },
        h('input', { type: 'checkbox', checked: upgrade.enabled, disabled: !editable, onChange: (event) => controller.setUpgradeEnabled(row.key, event.target.checked) }),
        t('upgradeEnabled'))
    ),
    upgrade.enabled
      ? h(React.Fragment, null,
        h('p', { style: style.note }, t('upgradeHint')),
        row.upgradeNote === undefined ? null : h('p', { style: style.note }, row.upgradeNote),
        h(LayerGrid, { t, rowKey: row.key, target: 'upgrade', slots: upgrade.slots, errors: row.errors.upgrade, groups, editable, controller }),
        h('span', { style: style.slotLabel }, t('triggers')),
        h('div', { style: style.chips },
          ...DATA.triggers.map((trigger) => h('label', {
            key: trigger.id,
            style: { ...style.chip, ...(upgrade.triggers.includes(trigger.id) ? { color: color.primary, borderColor: color.primary } : {}) }
          },
          h('input', { type: 'checkbox', checked: upgrade.triggers.includes(trigger.id), disabled: !editable, onChange: () => controller.toggleTrigger(row.key, trigger.id) }),
          trigger.label))),
        upgrade.triggers.length === 0 ? h('p', { style: style.note }, t('noTriggers')) : null)
      : h('p', { style: style.note }, t('upgradeOff'))
  )
}

/** 一个数值字段：标签、输入框、说明与错误 */
function PolicyNumber ({ t, name, label, hint, value, error, step, disabled, controller }) {
  return h('label', { style: style.field },
    h('span', { style: style.fieldLabel }, t(label)),
    h('input', {
      style: style.input,
      type: 'number',
      step,
      value: value === undefined ? '' : String(value),
      disabled,
      'aria-label': t(label),
      onChange: (event) => controller.setPolicy({ [name]: event.target.value })
    }),
    error === undefined ? h('span', { style: style.hint }, t(hint)) : h('span', { style: style.fieldError, role: 'alert' }, t(error))
  )
}

/** Jev 测试连接的结果行 */
function JevTestLine ({ t, test }) {
  if (test === undefined) return null
  if (test.error !== undefined) return h('span', { style: style.statusBad, role: 'alert' }, `${t('jevFailed')}：${test.code === undefined ? '' : `[${test.code}] `}${test.error}${test.code === 'swarm/permission-denied' ? ` ${t('jevPermissionDenied')}` : ''}`)
  if (test.enabled === false) return h('span', { style: style.statusBad, role: 'alert' }, t('jevDisabled'))
  const result = test.result ?? {}
  if (result.ok !== true) {
    const hint = result.failure_kind === 'permission' ? t('jevPermissionDenied') : result.failure_kind === 'invalid-response' ? t('jevInvalidResponse') : result.failure_kind === 'cancelled' ? t('jevCancelled') : ''
    return h('span', { style: style.statusBad, role: 'alert' }, `${t('jevFailed')}（${result.status ?? '?'}${result.reason === undefined ? '' : ` / ${result.reason}`}）：${result.error ?? ''}${hint === '' ? '' : ` ${hint}`}`)
  }
  const models = Array.isArray(result.answers?.models) ? result.answers.models.map((model) => model.name).filter(Boolean) : []
  const latency = Math.round(result.answers?.round_trip_latency_ms ?? result.latency_ms ?? 0)
  return h('span', { style: style.statusOk, role: 'status' }, `${t('jevOk')}：${test.model}；${t('jevModels')} ${models.join('、') || '—'}；${t('jevLatency')} ${latency} ms`)
}

/** Jev API key 卡片（页面顶部） */
function JevKeyCard ({ t, jev }) {
  const state = React.useSyncExternalStore(jev.subscribe, jev.getSnapshot)
  React.useEffect(() => {
    if (state.status === 'idle') jev.load()
  }, [jev, state.status])
  const info = state.info
  const shadowed = info !== undefined && info.configured && info.writable === false
  const statusText = info === undefined
    ? (state.status === 'error' ? t('jevLoadFailed') : t('jevUnknown'))
    : info.configured
      ? `${t('jevConfigured')}${info.source === undefined ? '' : ` · ${t('jevSource')} ${info.source}`}${info.writable === false ? `（${t('jevReadOnly')}）` : ''}`
      : t('jevMissing')
  const busy = state.saving || state.status === 'loading'
  return h('div', { style: style.card, 'data-swarm-jev': 'key' },
    h('div', { style: style.cardHead },
      h('span', { style: style.name }, t('jevTitle')),
      h('span', { style: { ...style.tag, ...(info?.configured ? { color: color.success, borderColor: color.success } : {}) } }, statusText),
      h('span', { style: style.spacer }),
      h('button', { type: 'button', style: style.btnSmall, disabled: state.testing, onClick: () => { jev.test() } }, state.testing ? t('jevTesting') : t('jevTest'))
    ),
    h('p', { style: style.note }, t('jevDescription')),
    state.loadError === undefined ? null : h('p', { style: style.statusBad, role: 'alert' }, state.loadError),
    h('span', { style: style.hint }, `${t('jevRef')}：${info?.ref ?? jev.getRef()}`),
    h('div', { style: style.keyRow },
      h('input', {
        style: style.keyInput,
        type: 'password',
        autoComplete: 'off',
        spellCheck: false,
        value: state.draft,
        placeholder: t('jevPlaceholder'),
        disabled: busy || shadowed,
        'aria-label': t('jevTitle'),
        onChange: (event) => jev.setDraft(event.target.value),
        onKeyDown: (event) => { if (event.key === 'Enter') jev.save() }
      }),
      h('button', { type: 'button', style: style.btnPrimary, disabled: busy || shadowed || state.draft.trim() === '', onClick: () => { jev.save() } }, state.saving ? t('jevSaving') : t('jevSave')),
      info?.configured && info.writable !== false
        ? h('button', { type: 'button', style: style.btnSmall, disabled: busy, onClick: () => { jev.clear() } }, t('jevClear'))
        : null
    ),
    shadowed ? h('p', { style: style.note }, t('jevShadowed')) : null,
    state.notice === undefined ? null : h('span', { style: style.statusOk, role: 'status' }, t(state.notice)),
    state.error === undefined ? null : h('span', { style: style.statusBad, role: 'alert' }, state.error),
    h(JevTestLine, { t, test: state.test })
  )
}

function ApprovalsCard ({ t, approvals, editable, controller }) {
  const value = approvals.value
  const labels = { write: 'approvalsWrite', shell: 'approvalsShell', external_mcp: 'approvalsMcp', jev: 'approvalsJev' }
  return h('div', { style: style.card, 'data-swarm-approvals': 'tools' },
    h('div', { style: style.cardHead }, h('span', { style: style.name }, t('approvalsTitle')), approvals.dirty ? h('span', { style: style.tag }, t('pending')) : null),
    h('p', { style: style.note }, t('approvalsDescription')),
    h('label', { style: style.field }, h('span', { style: style.fieldLabel }, t('approvalsMode')),
      h('select', { style: style.select, value: value.mode, disabled: !editable, 'aria-label': t('approvalsMode'), onChange: (event) => controller.setApprovals({ mode: event.target.value }) },
        h('option', { value: 'inherit' }, t('approvalsInherit')), h('option', { value: 'ask' }, t('approvalsAsk')), h('option', { value: 'deny' }, t('approvalsDeny')))),
    h('div', { style: style.chips, role: 'group', 'aria-label': t('approvalsScope') }, ...APPROVAL_SCOPES.map((scope) => h('label', { key: scope, style: style.chip },
      h('input', { type: 'checkbox', checked: value.scope.includes(scope), disabled: !editable, onChange: () => controller.toggleApprovalScope(scope) }), t(labels[scope])))),
    value.scope.length === 0 ? h('p', { style: style.note }, t('approvalsEmpty')) : null,
    h('p', { style: style.note }, t('approvalsBoundary')),
    approvals.error === undefined ? null : h('p', { style: style.fieldError, role: 'alert' }, t(approvals.error))
  )
}

function MathNumber ({ t, label, value, maximum, minimum = 1, error, editable, onChange }) {
  return h('label', { style: style.field },
    h('span', { style: style.fieldLabel }, t(label)),
    h('input', { style: style.input, type: 'number', step: 1, min: minimum, max: maximum, value: String(value), disabled: !editable, 'aria-label': t(label), onChange: (event) => onChange(event.target.value) }),
    error === undefined ? h('span', { style: style.hint }, `${minimum} – ${maximum}`) : h('span', { style: style.fieldError, role: 'alert' }, t(error)))
}

function MathCard ({ t, math, editable, controller }) {
  const value = math.value
  return h('div', { style: style.card, 'data-swarm-math': 'operators' },
    h('div', { style: style.cardHead }, h('span', { style: style.name }, t('mathTitle')),
      math.dirty ? h('span', { style: style.tag }, t('pending')) : null,
      h('span', { style: style.spacer }), h('button', { type: 'button', style: style.btnSmall, disabled: !editable, onClick: () => controller.resetMath() }, t('reset'))),
    h('p', { style: style.note }, t('mathDescription')),
    h('label', { style: style.switchLabel }, h('input', { type: 'checkbox', checked: value.enabled, disabled: !editable, onChange: (event) => controller.setMath({ enabled: event.target.checked }) }), t('mathEnabled')),
    h('div', { style: style.chips, role: 'group', 'aria-label': t('mathModes') }, ...Object.keys(MATH.defaults.numericModes).map((mode) => h('label', { key: mode, style: style.chip },
      h('input', { type: 'checkbox', checked: value.numericModes[mode], disabled: !editable, onChange: (event) => controller.setMath({ numericModes: { [mode]: event.target.checked } }) }), mode))),
    h('p', { style: style.note }, t('mathExact')),
    ...Object.entries(MATH.groups).map(([group, operators]) => h('details', { key: group, 'data-swarm-math-group': group },
      h('summary', { style: { ...style.switchLabel, display: 'flex', flexWrap: 'wrap' } },
        h('input', { type: 'checkbox', checked: value.groups[group], disabled: !editable, 'aria-label': t(`mathGroup_${group}`), onClick: (event) => event.stopPropagation(), onChange: (event) => controller.setMath({ groups: { [group]: event.target.checked } }) }),
        t(`mathGroup_${group}`), h('span', { style: { ...style.hint, overflowWrap: 'anywhere' } }, operators.join(' / '))),
      h('p', { style: { ...style.note, margin: '8px 0' } }, t(`mathHint_${group}`)),
      h('div', { style: style.chips }, ...operators.map((op) => h('label', { key: op, style: style.chip },
        h('input', { type: 'checkbox', checked: value.operators[op], disabled: !editable, 'aria-label': op, onChange: (event) => controller.setMath({ operators: { [op]: event.target.checked } }) }), op))))),
    h('p', { style: style.note }, t('mathOptIn')),
    h('div', { style: style.policyGrid },
      h(MathNumber, { t, label: 'mathCalls', value: value.maxCallsPerTask, minimum: 0, maximum: MATH.maxCallsPerTask, error: math.errors.maxCallsPerTask, editable, onChange: (next) => controller.setMath({ maxCallsPerTask: next }) }),
      h(MathNumber, { t, label: 'mathWork', value: value.maxWorkUnitsPerTask, maximum: MATH.maxWorkPerTask, error: math.errors.maxWorkUnitsPerTask, editable, onChange: (next) => controller.setMath({ maxWorkUnitsPerTask: next }) })),
    h('details', null, h('summary', { style: style.fieldLabel }, t('mathLimits')),
      h('p', { style: { ...style.note, margin: '8px 0' } }, t('mathLimitsHint')),
      h('div', { style: style.policyGrid }, ...Object.keys(MATH.defaults.limits).map((key) => h(MathNumber, {
        key, t, label: `mathLimit_${key}`, value: value.limits[key], maximum: MATH.limitMaxima[key], error: math.errors[key], editable, onChange: (next) => controller.setMath({ limits: { [key]: next } }) })))),
    Object.keys(math.errors).length === 0 ? null : h('p', { style: style.fieldError, role: 'alert' }, t('errMath'))
  )
}

/** 专家会话与重试策略 */
function PolicyCard ({ t, policy, editable, controller }) {
  const value = policy.value
  const auto = value.session === 'auto'
  return h('div', { style: style.card, 'data-swarm-policy': 'agents' },
    h('div', { style: style.cardHead },
      h('span', { style: style.name }, t('policyTitle')),
      h('span', { style: style.tag }, policy.custom ? t('custom') : t('builtin')),
      policy.dirty ? h('span', { style: { ...style.tag, color: color.primary } }, t('pending')) : null,
      h('span', { style: style.spacer }),
      policy.custom || policy.dirty
        ? h('button', { type: 'button', style: style.btnSmall, disabled: !editable, onClick: () => controller.resetPolicy() }, t('reset'))
        : null
    ),
    h('p', { style: style.note }, t('policyDescription')),
    h('div', { style: style.policyGrid },
      h('label', { style: style.field },
        h('span', { style: style.fieldLabel }, t('policySession')),
        h('select', {
          style: style.select,
          value: value.session,
          disabled: !editable,
          'aria-label': t('policySession'),
          onChange: (event) => controller.setPolicy({ session: event.target.value })
        },
        h('option', { value: 'auto' }, t('policyAuto')),
        h('option', { value: 'continuable' }, t('policyContinuable')),
        h('option', { value: 'oneshot' }, t('policyOneshot')))
      ),
      h(PolicyNumber, { t, name: 'maxRetries', label: 'policyRetries', hint: 'policyRetriesHint', value: value.maxRetries, error: policy.errors.maxRetries, step: 1, disabled: !editable, controller }),
      h(PolicyNumber, { t, name: 'repeatAbove', label: 'policyRepeat', hint: 'policyRepeatHint', value: value.repeatAbove, error: policy.errors.repeatAbove, step: 0.05, disabled: !editable || !auto, controller }),
      h(PolicyNumber, { t, name: 'sameCategoryAbove', label: 'policySame', hint: 'policySameHint', value: value.sameCategoryAbove, error: policy.errors.sameCategoryAbove, step: 0.05, disabled: !editable || value.session === 'oneshot', controller }),
      h(PolicyNumber, { t, name: 'retryBackoffSec', label: 'policyBackoff', hint: 'policyBackoffHint', value: value.retryBackoffSec, error: policy.errors.retryBackoffSec, step: 1, disabled: !editable, controller }),
      h('label', { style: style.field },
        h('span', { style: style.fieldLabel }, t('policyStyle')),
        h('select', {
          style: style.select,
          value: value.promptStyle,
          disabled: !editable,
          'aria-label': t('policyStyle'),
          onChange: (event) => controller.setPolicy({ promptStyle: event.target.value })
        },
        h('option', { value: 'auto' }, t('styleAuto')),
        h('option', { value: 'claude' }, t('styleClaude')),
        h('option', { value: 'gpt' }, t('styleGpt')),
        h('option', { value: 'generic' }, t('styleGeneric'))),
        h('span', { style: style.hint }, t('policyStyleHint'))
      ),
      h('label', { style: style.field },
        h('span', { style: style.fieldLabel }, t('policyModelCall')),
        h('select', {
          style: style.select,
          value: value.modelCallDisplay,
          disabled: !editable,
          'aria-label': t('policyModelCall'),
          onChange: (event) => controller.setPolicy({ modelCallDisplay: event.target.value })
        },
        h('option', { value: 'every' }, t('modelCallEvery')),
        h('option', { value: 'turn' }, t('modelCallTurn'))),
        h('span', { style: style.hint }, t('policyModelCallHint'))
      ),
      h(PolicyNumber, { t, name: 'networkWaitMin', label: 'policyNetworkWait', hint: 'policyNetworkWaitHint', value: value.networkWaitMin, error: policy.errors.networkWaitMin, step: 1, disabled: !editable, controller }),
      h(PolicyNumber, { t, name: 'rootRecoverMin', label: 'policyRootRecover', hint: 'policyRootRecoverHint', value: value.rootRecoverMin, error: policy.errors.rootRecoverMin, step: 1, disabled: !editable, controller })
    )
  )
}

function AgentCard ({ t, row, groups, editable, controller }) {
  return h('div', { style: { ...style.card, ...(row.custom ? {} : { opacity: 0.92 }) }, 'data-swarm-agent': row.key },
    h('div', { style: style.cardHead },
      h('span', { style: style.name }, row.name),
      h('span', { style: style.title }, row.title),
      h('span', { style: style.tag }, row.custom ? t('custom') : t('builtin')),
      row.dirty ? h('span', { style: { ...style.tag, color: color.primary } }, t('pending')) : null,
      h('span', { style: style.spacer }),
      row.custom
        ? h('button', { type: 'button', style: style.btnSmall, disabled: !editable, onClick: () => controller.resetAgent(row.key) }, t('reset'))
        : null
    ),
    row.note === undefined ? null : h('p', { style: style.note }, row.note),
    h(LayerGrid, { t, rowKey: row.key, target: 'chain', slots: row.slots, errors: row.errors.chain, groups, editable, controller }),
    row.upgrade === undefined ? null : h(UpgradeBlock, { t, row, groups, editable, controller })
  )
}

function SwarmAgentsSection ({ controller, jev }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const t = controller.t
  React.useEffect(() => {
    if (state.catalog.status === 'idle') controller.loadCatalog()
  }, [controller, state.catalog.status])
  const editable = state.status === 'ready' && state.writable && !state.saving
  const groups = state.catalog.groups
  const banner = []
  if (state.status === 'unavailable') banner.push(t('unavailable'))
  else if (state.status === 'loading') banner.push(t('loading'))
  else if (!state.writable) banner.push(t('readOnly'))
  const catalogLine = state.catalog.status === 'loading'
    ? h('div', { style: style.banner }, t('loadingCatalog'))
    : state.catalog.status === 'error'
      ? h('div', { style: style.banner }, t('catalogFailed'), h('button', { type: 'button', style: style.btnSmall, onClick: () => controller.refreshCatalog() }, t('retry')))
      : state.catalog.failures.length > 0
        ? h('div', { style: style.banner }, t('catalogPartial') + state.catalog.failures.map((row) => row.name || row.id).join('、'))
        : null
  const notice = state.conflicted
    ? h('span', { style: { fontSize: 12, color: color.danger } }, t('conflict'))
    : state.notice === 'saved'
      ? h('span', { style: { fontSize: 12, color: color.success } }, t('saved'))
      : state.notice === 'saveFailed'
        ? h('span', { style: { fontSize: 12, color: color.danger } }, t('saveFailed'))
        : null
  return h('section', { style: style.section, 'data-swarm-settings': 'agents' },
    h('h2', { style: style.heading }, t('title')),
    h('p', { style: style.description }, t('description')),
    jev === undefined ? null : h(JevKeyCard, { key: 'jev', t, jev }),
    ...banner.map((text, index) => h('div', { key: `b${index}`, style: style.banner }, text)),
    catalogLine,
    h(ApprovalsCard, { key: 'approvals', t, approvals: state.approvals, editable, controller }),
    h(PolicyCard, { key: 'policy', t, policy: state.policy, editable, controller }),
    h(MathCard, { key: 'math', t, math: state.math, editable, controller }),
    ...state.rows.map((row) => h(AgentCard, { key: row.key, t, row, groups, editable, controller })),
    h('div', { style: style.footer },
      notice,
      h('span', { style: style.spacer }),
      h('button', { type: 'button', style: style.btn, disabled: !state.dirty || state.saving, onClick: () => controller.discard() }, t('discard')),
      h('button', {
        type: 'button',
        style: { ...style.btnPrimary, ...(!state.dirty || state.invalid || !editable ? { opacity: 0.5, cursor: 'default' } : {}) },
        disabled: !state.dirty || state.invalid || !editable || state.conflicted,
        onClick: () => { controller.save() }
      }, state.saving ? t('saving') : t('save'))
    )
  )
}

// ───────────────────────── 插件入口 ─────────────────────────

const inject = ['slots', 'locale', 'connection', 'remote', 'remote.session', 'remote.credentials', 'configForms']

/**
 * 在「设置」对话框注册「百工 Agent」一节；只在宿主提供 swarm-core 命名空间时出现
 * @param ctx - 浏览器端插件上下文
 */
function apply (ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'swarm-settings: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new SwarmAgentsController(ctx)
  controller.t = t
  const jev = new JevKeyController(ctx, () => {
    const ref = asRecord(asRecord(controller.form.getSnapshot().value).jev).apiKeyEnv
    return typeof ref === 'string' && ref !== '' ? ref : DEFAULT_JEV_REF
  })
  ctx.effect(() => () => { controller.dispose() }, 'swarm-settings: controller')
  ctx.effect(() => () => { jev.dispose() }, 'swarm-settings: jev key')
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', () => { jev.load() }), 'swarm-settings: credential invalidations')
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', () => { controller.refreshCatalog() }), 'swarm-settings: adapter invalidations')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { controller.refreshCatalog() }), 'swarm-settings: settings invalidations')
  ctx.effect(() => ctx.on('connection/reset', () => { controller.resetConnection(); jev.load() }), 'swarm-settings: connection generation')
  ctx.effect(() => ctx.configForms.whileServed([DATA.namespace], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'swarm-agents',
    order: 25,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ controller, jev })
  }, SwarmAgentsSection))), 'swarm-settings: section')
}

exports.inject = inject
exports.apply = apply
exports.NS = NS
exports.__test__ = { getSlots, getOverride, getSlotErrors, getChain, getUpgradeView, buildRoutes, getPolicy, getPolicyErrors, buildPolicy, toPolicyDraft, cloneResourcePolicy, getResourceAccessMode, getApprovals, buildApprovals, getApprovalErrors, getMath, getMathErrors, buildMath, MathCard, ApprovalsCard, JevTestLine, LayerGrid, SwarmAgentsController, JevKeyController, DATA }
