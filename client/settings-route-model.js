const asRecord = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})

const getApprovals = (raw) => {
  const value = asRecord(raw)
  return { mode: APPROVAL_MODES.includes(value.mode) ? value.mode : APPROVAL_DEFAULTS.mode, scope: Array.isArray(value.scope) ? APPROVAL_SCOPES.filter((scope) => value.scope.includes(scope)) : [...APPROVAL_DEFAULTS.scope] }
}
const getApprovalErrors = (draft) => !APPROVAL_MODES.includes(draft.mode) || !Array.isArray(draft.scope) || draft.scope.some((scope) => !APPROVAL_SCOPES.includes(scope)) ? 'errApprovals' : undefined
const sameApprovals = (a, b) => a.mode === b.mode && a.scope.length === b.scope.length && a.scope.every((scope) => b.scope.includes(scope))
const buildApprovals = (draft, saved) => getApprovalErrors(draft) === undefined ? { ...asRecord(saved), mode: draft.mode, scope: APPROVAL_SCOPES.filter((scope) => draft.scope.includes(scope)) } : undefined

/** 已保存的流程模式与规划审核配置（workflow.mode + planningReview.*），按默认值的类型逐字段取值 */
const getPlanning = (workflow, review) => {
  const value = asRecord(review)
  const pick = (key) => (typeof value[key] === typeof PLANNING_DEFAULTS[key] ? value[key] : PLANNING_DEFAULTS[key])
  const mode = asRecord(workflow).mode
  return { workflowMode: WORKFLOW_MODES.includes(mode) ? mode : PLANNING_DEFAULTS.workflowMode, enabled: pick('enabled'), requireJev: pick('requireJev'), maxFixRounds: pick('maxFixRounds'), reviewAbove: pick('reviewAbove'), timeoutMs: pick('timeoutMs') }
}
const getPlanningErrors = (draft) => {
  const integer = (value, maximum) => { const n = toNumber(value); return Number.isSafeInteger(n) && n >= 0 && n <= maximum }
  const ratio = toNumber(draft.reviewAbove)
  return {
    ...(WORKFLOW_MODES.includes(draft.workflowMode) ? {} : { workflowMode: 'errPlanning' }),
    // 与配置 schema 一致：非负整数，不另设上限
    ...(integer(draft.maxFixRounds, Number.MAX_SAFE_INTEGER) ? {} : { maxFixRounds: 'errPlanningRounds' }),
    ...(Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? {} : { reviewAbove: 'errRatio' }),
    ...(integer(draft.timeoutMs, PLANNING_TIMEOUT_MAX) ? {} : { timeoutMs: 'errPlanningTimeout' })
  }
}
/** 草稿 → workflow 与 planningReview 两个值：只写与默认不同的字段，保留页面不管理的已保存字段（例如 maxNodes）；有错时返回 undefined */
const buildPlanning = (draft, layers) => {
  if (Object.keys(getPlanningErrors(draft)).length > 0) return undefined
  const review = { enabled: draft.enabled === true, requireJev: draft.requireJev === true, maxFixRounds: toNumber(draft.maxFixRounds), reviewAbove: toNumber(draft.reviewAbove), timeoutMs: toNumber(draft.timeoutMs) }
  const kept = (raw, managed, defaults) => Object.fromEntries(Object.entries(asRecord(raw)).filter(([key, item]) => !managed.includes(key) && item !== defaults[key]))
  return {
    workflow: { ...kept(layers.workflow, ['mode'], WORKFLOW_DEFAULTS), ...(draft.workflowMode === PLANNING_DEFAULTS.workflowMode ? {} : { mode: draft.workflowMode }) },
    planningReview: { ...kept(layers.planningReview, Object.keys(review), PLANNING_DEFAULTS), ...Object.fromEntries(Object.entries(review).filter(([key, item]) => item !== PLANNING_DEFAULTS[key])) }
  }
}
const samePlanning = (a, b) => Object.keys(PLANNING_DEFAULTS).every((key) => String(a[key]) === String(b[key]))

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

/** Ignore schema-generated empty shells; they are not user policy. */
const meaningfulResourcePolicy = (policy) => {
  if (policy === undefined || policy === null || typeof policy !== 'object' || Array.isArray(policy)) return undefined
  const fields = Object.fromEntries(Object.entries(policy).filter(([key, value]) => key === 'capabilities'
    ? value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).some((item) => typeof item === 'boolean')
    : value !== undefined && value !== ''))
  return Object.keys(fields).length === 0 ? undefined : fields
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
  const copied = record.policy === undefined ? undefined : cloneResourcePolicy(record.policy)
  const policy = copied === undefined ? undefined : meaningfulResourcePolicy(copied)
  return {
    provider: typeof record.provider === 'string' ? record.provider : '',
    model: typeof record.model === 'string' ? record.model : '',
    reasoningEffort: typeof record.reasoningEffort === 'string' ? record.reasoningEffort : '',
    ...(record.policy === undefined || copied !== undefined ? (policy === undefined ? {} : { policy }) : { policyInvalid: true })
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
    language: LANGUAGES.includes(merged.language) ? merged.language : 'zh-CN',
    languageExclusions: getLanguageExclusions(record.languageExclusions),
    session: SESSION_POLICIES.includes(merged.session) ? merged.session : 'auto',
    promptStyle: PROMPT_STYLES.includes(merged.promptStyle) ? merged.promptStyle : 'auto',
    modelCallDisplay: MODEL_CALL_DISPLAYS.includes(merged.modelCallDisplay) ? merged.modelCallDisplay : 'every',
    nativeTeamProjection: merged.nativeTeamProjection === true
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
    language: LANGUAGES.includes(policy.language ?? 'zh-CN') ? undefined : 'errLanguage',
    languageExclusions: policy.languageExclusions === undefined || (Array.isArray(policy.languageExclusions) && policy.languageExclusions.length <= 128 && getLanguageExclusions(policy.languageExclusions).length === policy.languageExclusions.length) ? undefined : 'errLanguageExclusions',
    repeatAbove: policy.session === 'auto' ? ratio(policy.repeatAbove) : undefined,
    sameCategoryAbove: policy.session === 'oneshot' ? undefined : ratio(policy.sameCategoryAbove),
    maxRetries: Number.isInteger(retries) && retries >= 0 && retries <= 10 ? undefined : 'errRetries',
    retryBackoffSec: range(policy.retryBackoffSec, 600, 'errBackoff'),
    networkWaitMin: range(policy.networkWaitMin, 120, 'errNetworkWait'),
    rootRecoverMin: range(policy.rootRecoverMin, 1440, 'errRootRecover')
  }
}

/** 草稿里的时长字段：重试等待用秒，断网等待与恢复用分钟 */
const DRAFT_KEYS = ['language', 'languageExclusions', 'session', 'repeatAbove', 'sameCategoryAbove', 'maxRetries', 'retryBackoffSec', 'promptStyle', 'networkWaitMin', 'rootRecoverMin', 'modelCallDisplay', 'nativeTeamProjection']

/** 已保存策略 → 编辑草稿（时长换成秒或分钟） */
const toPolicyDraft = (policy) => ({
  language: policy.language,
  languageExclusions: [...policy.languageExclusions],
  session: policy.session,
  repeatAbove: policy.repeatAbove,
  sameCategoryAbove: policy.sameCategoryAbove,
  maxRetries: policy.maxRetries,
  retryBackoffSec: policy.retryBackoffMs / 1000,
  promptStyle: policy.promptStyle,
  networkWaitMin: policy.networkWaitMs / 60000,
  rootRecoverMin: policy.rootRecoverMs / 60000,
  modelCallDisplay: policy.modelCallDisplay,
  nativeTeamProjection: policy.nativeTeamProjection
})

/**
 * 草稿 → 写入的 agents 值：只写与默认不同的字段，并保留页面不管理的已保存字段（例如 networkProbeUrls）；草稿有错时返回 undefined
 * @param {Record<string, unknown>} draft - 草稿
 * @param {unknown} [saved] - 已保存的 agents 值
 * @returns {Record<string, unknown> | undefined} agents 值
 */
const buildPolicy = (draft, saved) => {
  if (Object.values(getPolicyErrors(draft)).some((error) => error !== undefined)) return undefined
  const savedPolicy = getPolicy(saved)
  const value = {
    language: LANGUAGES.includes(draft.language) ? draft.language : 'zh-CN',
    languageExclusions: getLanguageExclusions(draft.languageExclusions),
    session: SESSION_POLICIES.includes(draft.session) ? draft.session : 'auto',
    // Hidden controls must not turn an earlier half-edited value into null/NaN
    // when the selected session policy makes that threshold irrelevant.
    repeatAbove: draft.session === 'auto' ? toNumber(draft.repeatAbove) : savedPolicy.repeatAbove,
    sameCategoryAbove: draft.session === 'oneshot' ? savedPolicy.sameCategoryAbove : toNumber(draft.sameCategoryAbove),
    maxRetries: toNumber(draft.maxRetries),
    retryBackoffMs: Math.round(toNumber(draft.retryBackoffSec) * 1000),
    promptStyle: PROMPT_STYLES.includes(draft.promptStyle) ? draft.promptStyle : 'auto',
    networkWaitMs: Math.round(toNumber(draft.networkWaitMin) * 60000),
    rootRecoverMs: Math.round(toNumber(draft.rootRecoverMin) * 60000),
    modelCallDisplay: MODEL_CALL_DISPLAYS.includes(draft.modelCallDisplay) ? draft.modelCallDisplay : 'every',
    nativeTeamProjection: draft.nativeTeamProjection === true
  }
  const kept = Object.fromEntries(Object.entries(asRecord(saved)).filter(([key]) => !POLICY_KEYS.includes(key)))
  return { ...kept, ...Object.fromEntries(Object.entries(value).filter(([key, item]) => JSON.stringify(item) !== JSON.stringify(POLICY_DEFAULTS[key]))) }
}

const samePolicy = (a, b) => DRAFT_KEYS.every((key) => key === 'languageExclusions' ? JSON.stringify(getLanguageExclusions(a[key])) === JSON.stringify(getLanguageExclusions(b[key])) : String(a[key]) === String(b[key]))

// ───────────────────────── 控制器 ─────────────────────────

const copyUpgrade = (upgrade) => (upgrade === undefined ? undefined : { enabled: upgrade.enabled, slots: upgrade.slots.map((slot) => ({ ...slot })), triggers: [...upgrade.triggers] })

/** 持有 swarm-core 配置表单、模型目录与每个角色的草稿，向视图发布不可变快照 */
