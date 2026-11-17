// 纯展示导航/排序规则，不产生宿主配置或执行权限。
const SETTINGS_TABS = Object.freeze([
  { id: 'overview', label: 'tabOverview', hint: 'tabOverviewHint' },
  { id: 'models', label: 'tabModels', hint: 'tabModelsHint' },
  { id: 'execution', label: 'tabExecution', hint: 'tabExecutionHint' },
  { id: 'guards', label: 'tabGuards', hint: 'tabGuardsHint' },
  { id: 'math', label: 'tabMath', hint: 'tabMathHint' }
])
const ROUTE_DRAG_TYPE = 'application/x-dsh-swarm-route-layer'

const getNextSettingsTab = (current, key) => {
  const index = SETTINGS_TABS.findIndex(tab => tab.id === current)
  if (index < 0) return undefined
  if (key === 'Home') return SETTINGS_TABS[0].id
  if (key === 'End') return SETTINGS_TABS.at(-1).id
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined
  return SETTINGS_TABS[(index + (key === 'ArrowRight' ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length].id
}

/** 常规链首位是主模型；升级链首位可排序，仍须保存后才改变升级首选。 */
const moveRouteLayer = (slots, ids, fromId, toId, target) => {
  if (!['chain', 'upgrade'].includes(target) || !Array.isArray(slots) || !Array.isArray(ids) || slots.length !== ids.length || new Set(ids).size !== ids.length) return undefined
  const from = ids.indexOf(fromId), to = ids.indexOf(toId), minimum = target === 'chain' ? 1 : 0
  if (from < minimum || to < minimum || from === to) return undefined
  const nextSlots = [...slots], nextIds = [...ids]
  nextSlots.splice(to, 0, nextSlots.splice(from, 1)[0])
  nextIds.splice(to, 0, nextIds.splice(from, 1)[0])
  return { slots: nextSlots, ids: nextIds }
}

exports.SETTINGS_TABS = SETTINGS_TABS
exports.ROUTE_DRAG_TYPE = ROUTE_DRAG_TYPE
exports.getNextSettingsTab = getNextSettingsTab
exports.moveRouteLayer = moveRouteLayer
