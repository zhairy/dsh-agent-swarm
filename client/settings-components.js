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
  section: { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, overflowWrap: 'anywhere' },
  heading: { margin: 0, fontSize: 18, fontWeight: 600, color: color.primary },
  description: { margin: 0, fontSize: 13, lineHeight: 1.6, color: color.secondary },
  banner: { fontSize: 13, color: color.secondary, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  card: { border: `1px solid ${color.border}`, borderRadius: 12, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  name: { fontSize: 14, fontWeight: 600, color: color.primary },
  title: { fontSize: 12, color: color.tertiary },
  tag: { fontSize: 11, padding: '1px 8px', borderRadius: 999, cornerShape: 'round', border: `1px solid ${color.border}`, color: color.secondary },
  note: { fontSize: 12, color: color.tertiary, margin: 0, lineHeight: 1.5 },
  routeList: { display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 },
  routeRow: { border: `1px solid ${color.border}`, borderRadius: 8, padding: 8, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 },
  routeFields: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,140px),1fr))', gap: 8, minWidth: 0 },
  routeActions: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: '100%', gap: 4, marginLeft: 'auto' },
  tabs: { display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: `1px solid ${color.border}`, paddingBottom: 8 },
  slotLabel: { fontSize: 12, color: color.secondary },
  select: { height: 30, minWidth: 0, width: '100%', padding: '0 8px', font: 'inherit', fontSize: 12, borderRadius: 8, border: `1px solid ${color.border}`, background: color.layer, color: color.primary },
  spacer: { flex: 1 },
  footer: { position: 'sticky', bottom: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', padding: '10px 0', borderTop: `1px solid ${color.border}`, background: 'var(--dsw-alias-bg-layer-2, #f7f8fb)' },
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
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', boxSizing: 'border-box', fontSize: 12, padding: '2px 10px', borderRadius: 999, cornerShape: 'round', border: `1px solid ${color.border}`, color: color.secondary, cursor: 'pointer', userSelect: 'none' },
  policyGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,220px),1fr))', gap: '10px 14px' },
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

function RouteLayerRow ({ t, rowKey, rowName, target, slot, slotId, index, length, error, groups, editable, controller }) {
  const label = layerLabel(t, target, index)
  const accessibleLabel = `${rowName ?? rowKey} ${label}`
  const minimum = target === 'chain' ? 1 : 0
  const movable = index >= minimum && length - minimum > 1
  const onChange = patch => controller.setSlotById(rowKey, slotId, patch, target)
  const common = { t, slot, label: accessibleLabel, groups, disabled: !editable, onChange }
  const move = direction => controller.moveLayerByStep(rowKey, slotId, direction, target)
  return h('div', {
    role: 'listitem', style: style.routeRow, 'data-swarm-route-layer': slotId, 'data-swarm-route-index': index,
    onDragOver: event => {
      if (!editable || !controller.canDropLayer(rowKey, slotId, target)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    },
    onDrop: event => {
      event.preventDefault(); event.stopPropagation()
      if (editable) controller.dropLayer(rowKey, slotId, target, event.dataTransfer?.getData?.(ROUTE_DRAG_TYPE))
    }
  },
  h('div', { style: style.cardHead },
    h('strong', { style: style.slotLabel }, label),
    h('small', { style: style.title, 'data-route-access-mode': getResourceAccessMode(slot) }, t(`resource_${getResourceAccessMode(slot)}`)),
    h('div', { style: style.routeActions },
      index < minimum ? null : h('button', {
        type: 'button', style: { ...style.btnRemove, cursor: editable && movable ? 'grab' : 'default' }, disabled: !editable || !movable, draggable: editable && movable,
        title: `${t('dragLayer')}：${accessibleLabel}`, 'aria-label': `${t('dragLayer')}：${accessibleLabel}`, 'data-swarm-route-drag': slotId,
        onDragStart: event => {
          const token = controller.startLayerDrag(rowKey, slotId, target)
          if (token === undefined || !event.dataTransfer) { event.preventDefault(); return }
          try { event.dataTransfer.setData(ROUTE_DRAG_TYPE, token); event.dataTransfer.effectAllowed = 'move' }
          catch { controller.cancelLayerDrag(); event.preventDefault() }
        },
        onDragEnd: () => controller.cancelLayerDrag(),
        onKeyDown: event => {
          if (event.key === 'Escape') controller.cancelLayerDrag()
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1)
        }
      }, '⠿'),
      index < minimum ? null : h('button', { type: 'button', style: style.btnRemove, disabled: !editable || index <= minimum, title: t('moveLayerUp'), 'aria-label': `${t('moveLayerUp')}：${accessibleLabel}`, 'data-swarm-route-move': 'up', onClick: () => move(-1) }, '↑'),
      index < minimum ? null : h('button', { type: 'button', style: style.btnRemove, disabled: !editable || index >= length - 1, title: t('moveLayerDown'), 'aria-label': `${t('moveLayerDown')}：${accessibleLabel}`, 'data-swarm-route-move': 'down', onClick: () => move(1) }, '↓'),
      index === 0 ? null : h('button', { type: 'button', style: style.btnRemove, disabled: !editable, title: t('removeLayer'), 'aria-label': `${t('removeLayer')}：${accessibleLabel}`, onClick: () => controller.removeLayerById(rowKey, slotId, target) }, '×'))),
  h('div', { style: style.routeFields }, h(ProviderSelect, common), h(ModelSelect, common), h(EffortSelect, common)),
  error === undefined ? null : h('p', { style: { fontSize: 11, color: color.danger, margin: 0 }, role: 'alert' }, t(error)))
}

/** 每行使用控制器持有的稳定身份；排序后事件按ID查找当前位置，不捕获旧数组索引。 */
function LayerGrid ({ t, rowKey, rowName, target, slots, errors, groups, editable, controller }) {
  const ids = controller.getLayerIds(rowKey, target, slots.length)
  return h('div', { style: style.routeList, 'data-swarm-route-chain': `${rowKey}:${target}` },
    h('p', { style: style.note }, t(target === 'upgrade' ? 'upgradeDragHint' : 'chainDragHint')),
    h('div', { role: 'list', style: style.routeList, 'aria-label': `${rowName ?? rowKey} ${target === 'upgrade' ? t('upgradeTitle') : t('tabModels')}` },
      ...slots.map((slot, index) => h(RouteLayerRow, { key: ids[index], t, rowKey, rowName, target, slot, slotId: ids[index], index, length: slots.length, error: errors[index], groups, editable, controller }))),
    h('button', { type: 'button', style: style.btnLink, disabled: !editable, onClick: () => controller.addLayer(rowKey, target) }, target === 'upgrade' ? t('addUpgradeLayer') : t('addLayer')))
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
        h(LayerGrid, { t, rowKey: row.key, rowName: row.name, target: 'upgrade', slots: upgrade.slots, errors: row.errors.upgrade, groups, editable, controller }),
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

/** Jev source and API key card (page header). */
function JevKeyCard ({ t, jev, controller, editable }) {
  const state = React.useSyncExternalStore(jev.subscribe, jev.getSnapshot)
  const configState = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const routing = configState.jevRouting
  React.useEffect(() => {
    if (state.status === 'idle') jev.load()
  }, [jev, state.status])
  React.useEffect(() => {
    if (routing.value.source === 'third-party' && configState.catalog.status === 'idle') controller.loadCatalog()
  }, [controller, configState.catalog.status, routing.value.source])
  const info = state.info
  const shadowed = routing.value.source === 'official' && info !== undefined && info.configured && info.writable === false
  const statusText = info === undefined
    ? (state.status === 'error' ? t('jevLoadFailed') : t('jevUnknown'))
    : info.configured
      ? `${t('jevConfigured')}${info.source === undefined ? '' : ` · ${t('jevSource')} ${info.source}`}${info.writable === false ? `（${t('jevReadOnly')}）` : ''}`
      : t('jevMissing')
  const busy = state.saving || state.status === 'loading' || routing.dirty
  const thirdParty = routing.value.thirdParty
  const common = { t, slot: thirdParty, label: t('jevTitle'), groups: configState.catalog.groups, disabled: !editable || routing.value.source !== 'third-party', onChange: (patch) => controller.setJevRouting({ thirdParty: patch }) }
  return h('div', { style: style.card, 'data-swarm-jev': 'key' },
    h('div', { style: style.cardHead },
      h('span', { style: style.name }, t('jevTitle')),
      h('span', { style: { ...style.tag, ...(info?.configured ? { color: color.success, borderColor: color.success } : {}) } }, statusText),
      h('span', { style: style.spacer }),
      h('button', { type: 'button', style: style.btnSmall, disabled: state.testing || routing.dirty, title: routing.dirty ? t('jevSaveFirst') : '', onClick: () => { jev.test() } }, state.testing ? t('jevTesting') : t('jevTest'))
    ),
    h('p', { style: style.note }, t('jevDescription')),
    h('label', { style: style.switchLabel },
      h('input', { type: 'checkbox', checked: routing.value.source === 'third-party', disabled: !editable,
        onChange: (event) => controller.setJevRouting({ source: event.target.checked ? 'third-party' : 'official' }) }),
      t('jevThirdParty')),
    h('p', { style: style.hint }, t('jevThirdPartyHint')),
    routing.value.source === 'third-party' ? h(React.Fragment, null,
      h('div', { style: style.routeFields }, h(ProviderSelect, common), h(ModelSelect, common), h(EffortSelect, common)),
      routing.errors.provider === undefined ? null : h('span', { style: style.fieldError, role: 'alert' }, t(routing.errors.provider)),
      routing.errors.model === undefined ? null : h('span', { style: style.fieldError, role: 'alert' }, t(routing.errors.model))
    ) : null,
    routing.dirty ? h('p', { style: style.statusBad, role: 'status' }, t('jevSaveFirst')) : null,
    state.loadError === undefined ? null : h('p', { style: style.statusBad, role: 'alert' }, state.loadError),
    h('span', { style: style.hint }, `${t('jevRef')}：${info?.ref ?? jev.getRef()}`),
    routing.value.source === 'official' ? h('div', { style: style.keyRow },
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
    ) : null,
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

/** 任务流程与规划审核（workflow.mode 与 planningReview.*） */
function PlanningCard ({ t, planning, editable, controller }) {
  const value = planning.value
  const number = (name, label, hint, step) => h('label', { style: style.field },
    h('span', { style: style.fieldLabel }, t(label)),
    h('input', { style: style.input, type: 'number', step, min: 0, value: String(value[name]), disabled: !editable, 'aria-label': t(label), onChange: (event) => controller.setPlanning({ [name]: event.target.value }) }),
    planning.errors[name] === undefined ? h('span', { style: style.hint }, t(hint)) : h('span', { style: style.fieldError, role: 'alert' }, t(planning.errors[name])))
  const check = (name, label) => h('label', { style: style.switchLabel },
    h('input', { type: 'checkbox', checked: value[name] === true, disabled: !editable, onChange: (event) => controller.setPlanning({ [name]: event.target.checked }) }), t(label))
  return h('div', { style: style.card, 'data-swarm-planning': 'review' },
    h('div', { style: style.cardHead },
      h('span', { style: style.name }, t('planningTitle')),
      h('span', { style: style.tag }, planning.custom ? t('custom') : t('builtin')),
      planning.dirty ? h('span', { style: { ...style.tag, color: color.primary } }, t('pending')) : null,
      h('span', { style: style.spacer }),
      planning.custom || planning.dirty ? h('button', { type: 'button', style: style.btnSmall, disabled: !editable, onClick: () => controller.resetPlanning() }, t('reset')) : null),
    h('p', { style: style.note }, t('planningDescription')),
    h('div', { style: style.policyGrid },
      h('label', { style: style.field }, h('span', { style: style.fieldLabel }, t('planningMode')),
        h('select', { style: style.select, value: value.workflowMode, disabled: !editable, 'aria-label': t('planningMode'), onChange: (event) => controller.setPlanning({ workflowMode: event.target.value }) },
          h('option', { value: 'off' }, t('planningModeOff')), h('option', { value: 'advisory' }, t('planningModeAdvisory')), h('option', { value: 'enforced' }, t('planningModeEnforced'))),
        planning.errors.workflowMode === undefined ? null : h('span', { style: style.fieldError, role: 'alert' }, t(planning.errors.workflowMode))),
      number('timeoutMs', 'planningTimeout', 'planningTimeoutHint', 1000),
      number('maxFixRounds', 'planningRounds', 'planningRoundsHint', 1),
      number('reviewAbove', 'planningThreshold', 'planningThresholdHint', 0.05)),
    check('enabled', 'planningEnabled'),
    check('requireJev', 'planningRequireJev'))
}

/** 专家会话与重试策略 */
function PolicyCard ({ t, policy, groups, editable, controller }) {
  const value = policy.value
  const auto = value.session === 'auto'
  const providers = [...new Map([...groups.map(group => [group.id, group.name === group.id ? group.id : `${group.name}（${group.id}）`]), ...value.languageExclusions.filter(id => !groups.some(group => group.id === id)).map(id => [id, id])]).entries()]
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
      h('label', { style: style.field }, h('span', { style: style.fieldLabel }, t('policyLanguage')), h('select', { style: style.select, value: value.language, disabled: !editable, 'aria-label': t('policyLanguage'), onChange: event => controller.setPolicy({ language: event.target.value }) }, ...LANGUAGES.map(language => h('option', { key: language, value: language }, LANGUAGE_NAMES[language]))), h('span', { style: style.hint }, t('policyLanguageHint'))),
      h('fieldset', { style: { ...style.field, margin: 0, minWidth: 0, border: 0, padding: 0 }, 'aria-label': t('policyLanguageExclusions') },
        h('legend', { style: style.fieldLabel }, t('policyLanguageExclusions')),
        h('span', { style: style.hint }, t('policyLanguageExclusionsHint')),
        ...providers.map(([id, label]) => h('label', { key: id }, h('input', { type: 'checkbox', checked: value.languageExclusions.includes(id), disabled: !editable, 'aria-label': `${t('policyLanguageExclusions')}：${label}`, onChange: event => controller.setPolicy({ languageExclusions: getLanguageExclusions(event.target.checked ? [...value.languageExclusions, id] : value.languageExclusions.filter(item => item !== id)) }) }), label)),
        providers.length === 0 ? h('span', { style: style.hint }, t('policyLanguageExclusionsEmpty')) : null,
        policy.errors.languageExclusions === undefined ? null : h('span', { role: 'alert', style: style.fieldError }, t(policy.errors.languageExclusions))),
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
      h('label', { style: style.field },
        h('span', { style: style.fieldLabel }, t('policyNativeTeam')),
        h('span', { style: style.switchLabel },
          h('input', {
            type: 'checkbox',
            checked: value.nativeTeamProjection,
            disabled: !editable,
            'aria-label': t('policyNativeTeam'),
            onChange: (event) => controller.setPolicy({ nativeTeamProjection: event.target.checked })
          }),
          value.nativeTeamProjection ? t('policyOn') : t('policyOff')),
        h('span', { style: style.hint }, t('policyNativeTeamHint'))
      ),
      h(PolicyNumber, { t, name: 'networkWaitMin', label: 'policyNetworkWait', hint: 'policyNetworkWaitHint', value: value.networkWaitMin, error: policy.errors.networkWaitMin, step: 1, disabled: !editable, controller }),
      h(PolicyNumber, { t, name: 'rootRecoverMin', label: 'policyRootRecover', hint: 'policyRootRecoverHint', value: value.rootRecoverMin, error: policy.errors.rootRecoverMin, step: 1, disabled: !editable, controller })
    )
  )
}

function AgentCard ({ t, row, groups, editable, controller }) {
  const expanded = controller.isAgentExpanded(row.key)
  const invalid = hasErrors(row.errors)
  const primary = slotLabel(row.slots[0])
  const bodyId = `swarm-agent-body-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`
  return h('div', { style: { ...style.card, ...(row.custom ? {} : { opacity: 0.92 }) }, 'data-swarm-agent': row.key },
    h('div', { style: style.cardHead },
      h('span', { style: style.name }, row.name),
      h('span', { style: style.title }, row.title),
      h('span', { style: style.tag }, row.custom ? t('custom') : t('builtin')),
      row.dirty ? h('span', { style: { ...style.tag, color: color.primary } }, t('pending')) : null,
      invalid ? h('span', { style: { ...style.tag, color: color.danger } }, t('needsCorrection')) : null,
      h('span', { style: style.spacer }),
      h('span', { style: style.title, 'data-swarm-agent-summary': row.key }, `${t('primary')} ${primary} · ${row.slots.length} ${t('layers')}`),
      row.custom
        ? h('button', { type: 'button', style: style.btnSmall, disabled: !editable, onClick: () => controller.resetAgent(row.key) }, t('reset'))
        : null,
      h('button', {
        type: 'button', style: style.btnSmall, 'data-swarm-agent-toggle': row.key,
        'aria-expanded': expanded, 'aria-controls': bodyId,
        'aria-label': `${expanded ? t('collapseAgent') : t('expandAgent')}：${row.name}`,
        title: expanded ? t('collapseAgent') : t('expandAgent'),
        onClick: () => controller.toggleAgentExpanded(row.key)
      }, expanded ? `▲ ${t('collapseAgent')}` : `▼ ${t('expandAgent')}`)
    ),
    expanded ? h('div', { id: bodyId, 'data-swarm-agent-body': row.key },
      row.note === undefined ? null : h('p', { style: style.note }, row.note),
      h(LayerGrid, { t, rowKey: row.key, rowName: row.name, target: 'chain', slots: row.slots, errors: row.errors.chain, groups, editable, controller }),
      row.upgrade === undefined ? null : h(UpgradeBlock, { t, row, groups, editable, controller })
    ) : null
  )
}
