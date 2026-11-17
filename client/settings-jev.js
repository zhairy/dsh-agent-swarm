const JEV_SOURCES = ['official', 'third-party']
const EMPTY_THIRD_PARTY_JEV = Object.freeze({ provider: '', model: '', reasoningEffort: '' })
const getJevRouting = (raw) => {
  const value = asRecord(raw), thirdParty = asRecord(value.thirdParty)
  return {
    source: JEV_SOURCES.includes(value.source) ? value.source : 'official',
    thirdParty: {
      ...thirdParty,
      provider: typeof thirdParty.provider === 'string' ? thirdParty.provider : '',
      model: typeof thirdParty.model === 'string' ? thirdParty.model : '',
      reasoningEffort: typeof thirdParty.reasoningEffort === 'string' ? thirdParty.reasoningEffort : ''
    }
  }
}
const getJevRoutingErrors = (value) => value.source !== 'third-party' ? {} : {
  ...(value.thirdParty.provider === '' ? { provider: 'errJevProvider' } : {}),
  ...(value.thirdParty.model === '' ? { model: 'errJevModel' } : {})
}
const sameJevRouting = (left, right) => policyDigest(left) === policyDigest(right)
const buildJevRouting = (saved, draft) => {
  if (Object.keys(getJevRoutingErrors(draft)).length > 0) return undefined
  return { ...asRecord(saved), source: draft.source, thirdParty: { ...draft.thirdParty } }
}

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
    this.writeGeneration = 0
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
    this.writeGeneration += 1
    this.listeners.clear()
  }

  resetConnection () {
    if (this.disposed) return
    this.generation += 1
    this.testGeneration += 1
    this.writeGeneration += 1
    this.update({ saving: false, testing: false, test: undefined, notice: undefined, error: undefined })
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
    const writeGeneration = this.writeGeneration
    this.testGeneration += 1
    this.update({ saving: true, notice: undefined, error: undefined, testing: false, test: undefined })
    let error
    try {
      const response = operation === 'set' ? await this.ctx.remote.credentials.set(ref, value) : await this.ctx.remote.credentials.unset(ref)
      if (!response.ok) error = response.error?.message ?? 'refused'
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure)
    }
    if (this.disposed || writeGeneration !== this.writeGeneration) return
    const currentRef = this.state.info?.ref ?? this.getRef()
    if (currentRef !== ref) {
      this.update({ saving: false, test: undefined, draft: this.state.draft, error: '凭据引用已在保存期间改变；本次写入未应用到当前模型配置，请重新保存。' })
      await this.load()
      return
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
