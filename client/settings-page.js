const getSettingsTabState = (state, id) => {
  if (id === 'overview') return { dirty: state.jevRouting.dirty, invalid: Object.keys(state.jevRouting.errors).length > 0 }
  if (id === 'models') return { dirty: state.rows.some(row => row.dirty), invalid: state.rows.some(row => row.dirty && hasErrors(row.errors)) }
  if (id === 'execution') return { dirty: state.policy.dirty, invalid: Object.values(state.policy.errors).some(error => error !== undefined) }
  if (id === 'guards') return { dirty: state.approvals.dirty || state.planning.dirty, invalid: state.approvals.error !== undefined || Object.keys(state.planning.errors).length > 0 }
  if (id === 'math') return { dirty: state.math.dirty, invalid: Object.keys(state.math.errors).length > 0 }
  return { dirty: false, invalid: false }
}

function SettingsCategoryTabs ({ state, t, controller }) {
  return h('div', { role: 'tablist', 'aria-label': t('settingsCategories'), style: style.tabs },
    ...SETTINGS_TABS.map(tab => {
      const flag = getSettingsTabState(state, tab.id)
      const selected = state.activeTab === tab.id
      return h('button', {
        key: tab.id, id: `swarm-settings-tab-${tab.id}`, type: 'button', role: 'tab', tabIndex: selected ? 0 : -1,
        'aria-selected': selected, 'aria-controls': `swarm-settings-panel-${tab.id}`, 'data-swarm-settings-tab': tab.id,
        style: { ...style.btn, ...(selected ? { color: color.primary, borderColor: color.primary, fontWeight: 600 } : {}) },
        onClick: () => controller.setSettingsTab(tab.id),
        onKeyDown: event => {
          const next = getNextSettingsTab(tab.id, event.key)
          if (next === undefined) return
          event.preventDefault(); controller.setSettingsTab(next)
          event.currentTarget.parentElement?.querySelector(`[data-swarm-settings-tab="${next}"]`)?.focus()
        }
      }, t(tab.label), flag.invalid ? h('small', { style: { marginLeft: 6, color: color.danger } }, t('categoryInvalid')) : flag.dirty ? h('small', { style: { marginLeft: 6 } }, t('categoryDirty')) : null)
    }))
}

function SettingsOverview ({ state, t, jev, controller, editable }) {
  return h(React.Fragment, null,
    jev === undefined ? null : h(JevKeyCard, { key: 'jev', t, jev, controller, editable }),
    h('div', { style: style.card },
      h('h3', { style: { ...style.name, margin: 0 } }, t('routeOverview')),
      h('p', { style: style.description }, `${t('configuredAgents')}：${state.rows.length} · ${t('customizedAgents')}：${state.rows.filter(row => row.custom).length}`),
      h('p', { style: style.note }, t('routeConfigurationNote'))))
}

const getSettingsPanel = (id, { state, t, jev, editable, controller }) => {
  if (id === 'overview') return h(SettingsOverview, { state, t, jev, controller, editable })
  if (id === 'models') return state.rows.map(row => h(AgentCard, { key: row.key, t, row, groups: state.catalog.groups, editable, controller }))
  if (id === 'execution') return h(PolicyCard, { t, policy: state.policy, groups: state.catalog.groups, editable, controller })
  if (id === 'guards') return h(React.Fragment, null, h(PlanningCard, { t, planning: state.planning, editable, controller }), h(ApprovalsCard, { t, approvals: state.approvals, editable, controller }))
  return h(MathCard, { t, math: state.math, editable, controller })
}

function SwarmAgentsSection ({ controller, jev }) {
  const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const t = controller.t
  React.useEffect(() => {
    if (state.activeTab === 'models' && state.catalog.status === 'idle') controller.loadCatalog()
  }, [controller, state.activeTab, state.catalog.status])
  const editable = state.status === 'ready' && state.writable && !state.saving
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
        : state.notice === 'reorderSaved' ? h('span', { style: { fontSize: 12, color: color.secondary } }, t('reorderSaved')) : null
  return h('section', { style: style.section, 'data-swarm-settings': 'agents' },
    h('h2', { style: style.heading }, t('title')),
    h('p', { style: style.description }, t(SETTINGS_TABS.find(tab => tab.id === state.activeTab)?.hint ?? 'tabOverviewHint')),
    ...banner.map((text, index) => h('div', { key: `b${index}`, style: style.banner }, text)),
    h(SettingsCategoryTabs, { state, t, controller }),
    ...SETTINGS_TABS.map(tab => h('div', {
      key: tab.id, id: `swarm-settings-panel-${tab.id}`, role: 'tabpanel', 'aria-labelledby': `swarm-settings-tab-${tab.id}`,
      hidden: state.activeTab !== tab.id, tabIndex: 0, style: { ...style.section, display: state.activeTab === tab.id ? 'flex' : 'none' }, 'data-swarm-settings-panel': tab.id
    }, state.activeTab === tab.id ? h(React.Fragment, null, tab.id === 'models' ? catalogLine : null, getSettingsPanel(tab.id, { state, t, jev, editable, controller })) : null)),
    h('div', { style: style.footer },
      h('span', { role: 'status', 'aria-live': 'polite' }, notice),
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
  ctx.effect(() => ctx.remote.$on('settings/document-updated', () => { controller.refreshCatalog(); jev.load() }), 'swarm-settings: settings invalidations')
  ctx.effect(() => ctx.on('connection/reset', () => { controller.resetConnection(); jev.resetConnection(); jev.load() }), 'swarm-settings: connection generation')
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
exports.__test__ = { getSlots, getOverride, getSlotErrors, getChain, getUpgradeView, buildRoutes, getPolicy, getPolicyErrors, buildPolicy, toPolicyDraft, cloneResourcePolicy, getResourceAccessMode, getApprovals, buildApprovals, getApprovalErrors, getMath, getMathErrors, buildMath, getPlanning, getPlanningErrors, buildPlanning, getJevRouting, getJevRoutingErrors, buildJevRouting, PlanningCard, PolicyCard, MathCard, ApprovalsCard, JevKeyCard, JevTestLine, LayerGrid, RouteLayerRow, AgentCard, SettingsCategoryTabs, SwarmAgentsSection, getSettingsTabState, SwarmAgentsController, JevKeyController, DATA }
