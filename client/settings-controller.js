class SwarmAgentsController {
  constructor (ctx) {
    this.ctx = ctx
    this.form = ctx.configForms.get(DATA.namespace)
    this.drafts = new Map()
    this.activeTab = 'overview'
    this.layerIds = new Map()
    this.layerSequence = 0
    this.dragSequence = 0
    this.drag = undefined
    this.instanceId = globalThis.crypto?.randomUUID?.() ?? `settings-${Date.now()}-${++settingsControllerSequence}`
    this.formRevision = this.form.getSnapshot().revision
    /** 会话与重试策略的草稿；undefined 表示没有修改 */
    this.policyDraft = undefined
    this.approvalsDraft = undefined
    this.mathDraft = undefined
    this.planningDraft = undefined
    this.jevRoutingDraft = undefined
    this.draftRevision = undefined
    this.catalog = { status: 'idle', groups: [], failures: [] }
    this.pendingCatalog = undefined
    this.catalogReloadRequested = false
    this.saving = false
    this.expandedAgents = new Set()
    this.notice = undefined
    this.conflicted = false
    this.disposed = false
    this.catalogGeneration = 0
    this.connectionGeneration = 0
    this.saveGeneration = 0
    this.listeners = new Set()
    this.snapshot = this.project()
    this.subscribe = this.subscribe.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
    this.unsubscribe = this.form.subscribe(() => {
      const revision = this.form.getSnapshot().revision
      this.cancelLayerDrag()
      if (!this.saving && !this.hasDrafts() && revision !== this.formRevision) this.layerIds.clear()
      this.formRevision = revision
      if (!this.saving && this.hasDrafts() && this.draftRevision !== undefined && revision !== this.draftRevision) this.conflicted = true
      this.publish()
    })
  }

  subscribe (listener) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot () { return this.snapshot }

  setSettingsTab (id) {
    if (!SETTINGS_TABS.some(tab => tab.id === id) || this.disposed) return
    this.cancelLayerDrag()
    this.activeTab = id
    this.publish()
  }

  isAgentExpanded (agentKey) {
    return this.expandedAgents.has(agentKey)
  }

  toggleAgentExpanded (agentKey) {
    if (!DATA.agents.some((agent) => agent.key === agentKey)) return false
    if (this.expandedAgents.has(agentKey)) this.expandedAgents.delete(agentKey)
    else this.expandedAgents.add(agentKey)
    this.publish()
    return this.expandedAgents.has(agentKey)
  }

  setAllAgentsExpanded (expanded) {
    this.expandedAgents = expanded ? new Set(DATA.agents.map((agent) => agent.key)) : new Set()
    this.publish()
  }

  getLayerIds (agentKey, target, count) {
    if (!['chain', 'upgrade'].includes(target) || !Number.isSafeInteger(count) || count < 0) return []
    const key = `${agentKey}:${target}`
    let ids = this.layerIds.get(key)
    if (ids === undefined) { ids = []; this.layerIds.set(key, ids) }
    while (ids.length < count) ids.push(`${this.instanceId}:${++this.layerSequence}`)
    if (ids.length > count) ids.length = count
    return ids
  }

  canReorder () {
    return this.canEdit() && !this.conflicted && (this.draftRevision === undefined || this.draftRevision === this.form.getSnapshot().revision)
  }

  cancelLayerDrag () { this.drag = undefined }

  startLayerDrag (agentKey, slotId, target = 'chain') {
    this.cancelLayerDrag()
    if (!this.canReorder()) return undefined
    const agent = DATA.agents.find(row => row.key === agentKey)
    if (agent === undefined) return undefined
    const slots = this.slotsOf(this.view(agent), target)
    if (slots === undefined || slots.length < 2) return undefined
    const ids = this.getLayerIds(agentKey, target, slots.length)
    if (ids.indexOf(slotId) < (target === 'chain' ? 1 : 0)) return undefined
    const token = `${this.instanceId}:drag:${++this.dragSequence}`
    this.drag = { agentKey, target, slotId, token, order: ids.join('|'), revision: this.form.getSnapshot().revision }
    return token
  }

  canDropLayer (agentKey, toId, target = 'chain') {
    const drag = this.drag
    if (!this.canReorder() || drag === undefined || drag.agentKey !== agentKey || drag.target !== target || drag.revision !== this.form.getSnapshot().revision) return false
    const agent = DATA.agents.find(row => row.key === agentKey)
    if (agent === undefined) return false
    const slots = this.slotsOf(this.view(agent), target)
    if (slots === undefined) return false
    const ids = this.getLayerIds(agentKey, target, slots.length)
    return drag.order === ids.join('|') && moveRouteLayer(slots, ids, drag.slotId, toId, target) !== undefined
  }

  dropLayer (agentKey, toId, target, token) {
    const drag = this.drag
    const valid = typeof token === 'string' && token === drag?.token && this.canDropLayer(agentKey, toId, target)
    this.cancelLayerDrag()
    return valid ? this.moveLayerById(agentKey, drag.slotId, toId, target) : false
  }

  moveLayerById (agentKey, fromId, toId, target = 'chain') {
    if (!this.canReorder()) return false
    const agent = DATA.agents.find(row => row.key === agentKey)
    if (agent === undefined) return false
    const slots = this.slotsOf(this.view(agent), target)
    if (slots === undefined) return false
    const ids = this.getLayerIds(agentKey, target, slots.length)
    const next = moveRouteLayer(slots, ids, fromId, toId, target)
    if (next === undefined) return false
    this.edit(agentKey, draft => {
      if (target === 'chain') draft.slots = next.slots
      else draft.upgrade.slots = next.slots
      this.layerIds.set(`${agentKey}:${target}`, next.ids)
    }, 'reorderSaved')
    return true
  }

  moveLayerByStep (agentKey, slotId, direction, target = 'chain') {
    if (direction !== -1 && direction !== 1) return false
    const ids = this.layerIds.get(`${agentKey}:${target}`) ?? []
    const index = ids.indexOf(slotId)
    return index < 0 ? false : this.moveLayerById(agentKey, slotId, ids[index + direction], target)
  }

  setSlotById (agentKey, slotId, patch, target = 'chain') {
    const index = this.layerIds.get(`${agentKey}:${target}`)?.indexOf(slotId) ?? -1
    if (index >= 0) this.setSlot(agentKey, index, patch, target)
  }

  removeLayerById (agentKey, slotId, target = 'chain') {
    const index = this.layerIds.get(`${agentKey}:${target}`)?.indexOf(slotId) ?? -1
    if (index >= 0) this.removeLayer(agentKey, index, target)
  }

  dispose () {
    this.disposed = true
    this.catalogGeneration += 1
    this.pendingCatalog = undefined
    this.catalogReloadRequested = false
    this.unsubscribe()
    this.listeners.clear()
    this.cancelLayerDrag()
    this.layerIds.clear()
  }

  routes () { return asRecord(this.form.getSnapshot().value).routes }

  /**
   * 页面不管理、但用户或 profile 显式写过的 agents 字段：取组合层与用户层，不取 schema 默认值，
   * 避免一次保存把默认值（例如探测地址列表）固化成用户配置；宿主不提供分层时退回解析后的值
   */
  savedLayers (key) {
    const snapshot = this.form.getSnapshot()
    if (snapshot.base === undefined && snapshot.user === undefined) return asRecord(snapshot.value)[key]
    return { ...asRecord(asRecord(snapshot.base)[key]), ...asRecord(asRecord(snapshot.user)[key]) }
  }

  savedAgentsLayers () { return this.savedLayers('agents') }

  savedPlanning () {
    const value = asRecord(this.form.getSnapshot().value)
    return getPlanning(value.workflow, value.planningReview)
  }

  setPlanning (patch) {
    if (!this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    this.planningDraft = { ...(this.planningDraft ?? this.savedPlanning()), ...patch }
    if (samePlanning(this.planningDraft, this.savedPlanning())) this.planningDraft = undefined
    if (!this.hasDrafts()) this.draftRevision = undefined
    this.notice = undefined
    this.publish()
  }

  resetPlanning () { this.setPlanning({ ...PLANNING_DEFAULTS }) }

  savedPolicy () { return getPolicy(asRecord(this.form.getSnapshot().value).agents) }

  savedApprovals () { return getApprovals(asRecord(this.form.getSnapshot().value).approvals) }

  savedMath () { return getMath(asRecord(this.form.getSnapshot().value).math) }

  hasDrafts () { return this.drafts.size > 0 || this.policyDraft !== undefined || this.approvalsDraft !== undefined || this.mathDraft !== undefined || this.planningDraft !== undefined || this.jevRoutingDraft !== undefined }

  savedJevRouting () { return getJevRouting(asRecord(this.form.getSnapshot().value).jev) }

  setJevRouting (patch) {
    if (!this.canEdit()) return
    if (!this.hasDrafts()) this.draftRevision = this.form.getSnapshot().revision
    const base = this.jevRoutingDraft ?? this.savedJevRouting()
    const thirdPartyPatch = asRecord(patch.thirdParty)
    const providerChanged = typeof thirdPartyPatch.provider === 'string' && thirdPartyPatch.provider !== base.thirdParty.provider
    const modelChanged = typeof thirdPartyPatch.model === 'string' && thirdPartyPatch.model !== base.thirdParty.model
    const thirdParty = providerChanged
      ? { ...base.thirdParty, provider: thirdPartyPatch.provider,
          model: typeof thirdPartyPatch.model === 'string' ? thirdPartyPatch.model : '',
          reasoningEffort: typeof thirdPartyPatch.reasoningEffort === 'string' ? thirdPartyPatch.reasoningEffort : '' }
      : { ...base.thirdParty, ...thirdPartyPatch,
          ...(modelChanged && typeof thirdPartyPatch.reasoningEffort !== 'string' ? { reasoningEffort: '' } : {}) }
    this.jevRoutingDraft = { ...base, ...patch, thirdParty }
    if (sameJevRouting(this.jevRoutingDraft, this.savedJevRouting())) this.jevRoutingDraft = undefined
    if (!this.hasDrafts()) this.draftRevision = undefined
    this.notice = undefined
    this.publish()
  }

  resetJevRouting () { this.setJevRouting(getJevRouting(undefined)) }

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
  edit (agentKey, change, notice) {
    const agent = DATA.agents.find((row) => row.key === agentKey)
    if (agent === undefined || !this.canEdit()) return
    this.cancelLayerDrag()
    const draft = this.beginDraft(agent)
    change(draft, agent)
    this.dropIfClean(agent)
    this.notice = this.hasDrafts() ? notice : undefined
    this.publish()
  }

  /** target 为 'chain'（常规路由）或 'upgrade'（容灾升级） */
  slotsOf (draft, target) {
    return target === 'upgrade' ? draft.upgrade?.slots : target === 'chain' ? draft.slots : undefined
  }

  setSlot (agentKey, index, patch, target = 'chain') {
    this.edit(agentKey, (draft) => {
      const slots = this.slotsOf(draft, target)
      if (slots === undefined || slots[index] === undefined) return
      const slot = { ...slots[index], ...patch }
      // 换供应商：若新供应商下没有同名模型则清空模型；推理强度随模型重选
      if (patch.provider !== undefined) {
        if (patch.provider !== slots[index].provider) {
          delete slot.policy
          delete slot.policyInvalid
        }
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
      if (slots !== undefined) {
        this.getLayerIds(agentKey, target, slots.length).push(`${this.instanceId}:${++this.layerSequence}`)
        slots.push({ ...EMPTY_SLOT })
      }
    })
  }

  removeLayer (agentKey, index, target = 'chain') {
    this.edit(agentKey, (draft) => {
      const slots = this.slotsOf(draft, target)
      // 常规链保留主模型；升级链至少保留一层（可停用整个升级）
      if (slots === undefined || index <= 0 || index >= slots.length) return
      this.getLayerIds(agentKey, target, slots.length).splice(index, 1)
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
    this.cancelLayerDrag()
    this.layerIds.delete(`${agentKey}:chain`)
    this.layerIds.delete(`${agentKey}:upgrade`)
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
    this.cancelLayerDrag()
    this.layerIds.clear()
    this.drafts.clear()
    this.policyDraft = undefined
    this.approvalsDraft = undefined
    this.mathDraft = undefined
    this.planningDraft = undefined
    this.jevRoutingDraft = undefined
    this.draftRevision = undefined
    this.conflicted = false
    this.notice = undefined
    this.publish()
  }

  async save () {
    this.cancelLayerDrag()
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
        for (const key of result.keys) this.expandedAgents.add(key)
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
    if (this.planningDraft !== undefined) {
      const planning = buildPlanning(this.planningDraft, { workflow: this.savedLayers('workflow'), planningReview: this.savedLayers('planningReview') })
      if (planning === undefined) { this.publish(); return }
      ops.push({ op: 'set', path: ['workflow'], value: planning.workflow }, { op: 'set', path: ['planningReview'], value: planning.planningReview })
    }
    if (this.jevRoutingDraft !== undefined) {
      const jev = buildJevRouting(asRecord(snapshot.value).jev, this.jevRoutingDraft)
      if (jev === undefined) { this.publish(); return }
      ops.push({ op: 'set', path: ['jev'], value: jev })
    }
    const connectionGeneration = this.connectionGeneration
    const saveGeneration = ++this.saveGeneration
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
    if (connectionGeneration !== this.connectionGeneration || saveGeneration !== this.saveGeneration) return
    this.saving = false
    if (accepted) {
      this.drafts.clear()
      this.policyDraft = undefined
      this.approvalsDraft = undefined
      this.mathDraft = undefined
      this.planningDraft = undefined
      this.jevRoutingDraft = undefined
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
    if (this.disposed) return
    if (this.pendingCatalog !== undefined) {
      this.catalogReloadRequested = true
      return this.pendingCatalog
    }
    const generation = ++this.catalogGeneration
    this.catalog = { ...this.catalog, status: 'loading' }
    this.publish()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('模型目录读取超时')), CATALOG_TIMEOUT_MS)
    })
    const pending = Promise.resolve().then(async () => {
      try {
        const response = await Promise.race([this.ctx.remote.session.modelCatalog(), timeout])
        if (generation !== this.catalogGeneration) return
        if (response?.ok === true && Array.isArray(response.value?.groups)) {
          this.catalog = { status: 'ready', groups: response.value.groups, failures: Array.isArray(response.value.failures) ? response.value.failures : [] }
        } else this.catalog = { status: 'error', groups: this.catalog.groups, failures: [] }
      } catch {
        if (generation === this.catalogGeneration) this.catalog = { status: 'error', groups: this.catalog.groups, failures: [] }
      }
    }).finally(() => {
      clearTimeout(timer)
      if (generation === this.catalogGeneration) {
        this.pendingCatalog = undefined
        this.publish()
      }
      if (!this.disposed && this.catalogReloadRequested) {
        this.catalogReloadRequested = false
        void this.loadCatalog()
      }
    })
    this.pendingCatalog = pending
    await pending
  }

  refreshCatalog () {
    if (this.disposed) return
    if (this.pendingCatalog !== undefined) {
      this.catalogReloadRequested = true
      return
    }
    this.catalogGeneration += 1
    this.catalog = { ...this.catalog, status: 'idle' }
    void this.loadCatalog()
  }

  resetConnection () {
    if (this.disposed) return
    this.connectionGeneration += 1
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.pendingCatalog = undefined
    this.catalogReloadRequested = false
    this.cancelLayerDrag()
    this.layerIds.clear()
    this.saving = false
    this.drafts.clear()
    this.policyDraft = undefined
    this.approvalsDraft = undefined
    this.mathDraft = undefined
    this.planningDraft = undefined
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
      custom: POLICY_KEYS.some((key) => JSON.stringify(savedPolicy[key]) !== JSON.stringify(POLICY_DEFAULTS[key])),
      dirty: this.policyDraft !== undefined,
      errors: policyErrors
    }
    const approvals = { value: this.approvalsDraft ?? this.savedApprovals(), dirty: this.approvalsDraft !== undefined, error: this.approvalsDraft === undefined ? undefined : getApprovalErrors(this.approvalsDraft) }
    const mathValue = this.mathDraft ?? this.savedMath()
    const math = { value: mathValue, dirty: this.mathDraft !== undefined, errors: getMathErrors(mathValue) }
    const savedPlanning = this.savedPlanning()
    const planning = { value: this.planningDraft ?? savedPlanning, dirty: this.planningDraft !== undefined, custom: !samePlanning(savedPlanning, PLANNING_DEFAULTS),
      errors: this.planningDraft === undefined ? {} : getPlanningErrors(this.planningDraft) }
    const savedJevRouting = this.savedJevRouting()
    const jevRoutingValue = this.jevRoutingDraft ?? savedJevRouting
    const jevRouting = { value: jevRoutingValue, dirty: this.jevRoutingDraft !== undefined, errors: this.jevRoutingDraft === undefined ? {} : getJevRoutingErrors(jevRoutingValue) }
    return {
      status: snapshot.status,
      activeTab: this.activeTab,
      writable: snapshot.writable,
      rows,
      policy,
      approvals,
      math,
      planning,
      jevRouting,
      catalog: this.catalog,
      saving: this.saving,
      dirty: this.hasDrafts(),
      invalid: rows.some((row) => row.dirty && hasErrors(row.errors)) || Object.values(policyErrors).some((error) => error !== undefined) || approvals.error !== undefined || (math.dirty && Object.keys(math.errors).length > 0) || Object.keys(planning.errors).length > 0 || Object.keys(jevRouting.errors).length > 0,
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

// ───────────────────────── Jev source and API key ─────────────────────────
