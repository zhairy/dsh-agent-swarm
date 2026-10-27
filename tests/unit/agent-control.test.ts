import { describe, expect, it, vi } from 'vitest'
import { createAgentControl, ValidateAgentControlRecords, type AgentControlDeps } from '../../src/agent-control.js'
import { intRouteStateRegistry } from '../../src/route-state.js'

const original = { provider: 'qwen-token-plan-cn', model: 'old', reasoningEffort: 'high' }
const chosen = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' }
const binding = { childId: 'child', parentSessionId: 'root', taskId: 'T-1', delegationId: 'D-1', persistent: true, cardRevision: 1, workflowRevision: 1, requestRevision: 1 }
const fixture = (options: { persist?: () => Promise<void>; resume?: () => Promise<{ accepted: true }>; isDelegationActive?: () => boolean } = {}) => {
  const routes = intRouteStateRegistry()
  routes.AddChild('child', { chain: [original], role: 'tan_wei', persistent: true, logicalRequestId: 'D-1' })
  const interrupt = vi.fn(async () => undefined)
  const resume = vi.fn<AgentControlDeps['resume']>(options.resume ?? (async () => ({ accepted: true as const })))
  const control = createAgentControl({ validateRoute: async (route) => route, interrupt, resume, applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause, persist: options.persist,
    ...(options.isDelegationActive === undefined ? {} : { isDelegationActive: options.isDelegationActive }) })
  control.Register(binding)
  const address = () => ({ parentSessionId: 'root', childId: 'child', expectedRevision: control.get('child')!.revision })
  const agent = { id: 'child', session: { header: { parentSession: 'root' } } }
  const start = () => {
    const route = routes.getRequestOverride(agent, original, undefined)
    control.ObserveRequest('child', route)
    control.MarkAttemptStarted('child', 'attempt-1', routes.getLastRoute('child'))
  }
  return { control, routes, interrupt, resume, address, agent, start }
}

describe('persistent subagent control uses actual routing and host settlement', () => {
  it('bounds settled one-shot controls without evicting persistent controls', () => {
    const routes = intRouteStateRegistry()
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: vi.fn(), resume: vi.fn(), applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause })
    control.Register(binding)
    for (let index = 0; index < 300; index++) {
      const childId = `one-shot-${index}`
      control.Register({ ...binding, childId, delegationId: `D-${index}`, persistent: false })
      control.MarkRunSettled(childId, 'completed')
    }
    const exported = control.Export()
    expect(exported.filter((record) => record.persistent === false && record.oneShotSettled === true)).toHaveLength(256)
    expect(exported.find((record) => record.childId === 'one-shot-0')).toBeUndefined()
    expect(exported.find((record) => record.childId === 'one-shot-299')).toBeDefined()
    expect(control.get('child')).toMatchObject({ persistent: true })
  })

  it('rejects a persistent control beyond the durable schema cap', () => {
    const routes = intRouteStateRegistry()
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: vi.fn(), resume: vi.fn(), applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause })
    for (let index = 0; index < 4096; index++) {
      control.Register({ ...binding, childId: `persistent-${index}`, delegationId: `D-${index}` })
    }
    expect(() => control.Register({ ...binding, childId: 'overflow', delegationId: 'D-overflow' }))
      .toThrow('安全上限')
  })

  it('keeps settled one-shots that still require side-effect review outside the ordinary cap', () => {
    const routes = intRouteStateRegistry()
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: vi.fn(), resume: vi.fn(), applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause })
    for (let index = 0; index < 301; index++) {
      const childId = `one-shot-${index}`
      control.Register({ ...binding, childId, delegationId: `D-${index}`, persistent: false, needsSideEffectReview: index === 0 })
      control.MarkRunSettled(childId, 'aborted')
    }
    expect(control.get('one-shot-0')).toMatchObject({ oneShotSettled: true, needsSideEffectReview: true })
    expect(control.get('one-shot-1')).toBeUndefined()
    expect(control.Export().filter((record) => record.persistent === false)).toHaveLength(257)
  })

  it('hard-bounds side-effect review records separately', () => {
    const routes = intRouteStateRegistry()
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: vi.fn(), resume: vi.fn(), applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause })
    for (let index = 0; index < 301; index++) {
      const childId = `review-${index}`
      control.Register({ ...binding, childId, delegationId: `D-${index}`, persistent: false })
      control.MarkSideEffectRisk(childId)
      control.MarkRunSettled(childId, 'aborted')
    }
    expect(control.get('review-0')).toBeUndefined()
    expect(control.get('review-299')).toMatchObject({ needsSideEffectReview: true, oneShotSettled: true })
    expect(control.Export().filter((record) => record.persistent === false)).toHaveLength(256)
  })

  it('forgets settled controls for a terminal task but retains running or uncertain records', async () => {
    const f = fixture()
    const cancelRetryRoute = vi.fn()
    const setPaused = vi.fn(f.routes.SetManualPause)
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: f.interrupt, resume: f.resume,
      applyOverride: f.routes.SetChildOverride, setPaused, cancelRetryRoute })
    control.Register({ ...binding, childId: 'idle-a', taskId: 'terminal', delegationId: 'D-a' })
    control.Register({ ...binding, childId: 'review-a', taskId: 'terminal', delegationId: 'D-review', needsSideEffectReview: true })
    control.Register({ ...binding, childId: 'running-a', taskId: 'terminal', delegationId: 'D-b' })
    control.ObserveRequest('running-a', original)
    control.MarkAttemptStarted('running-a', 'attempt-running', original)
    control.Register({ ...binding, childId: 'other-task', taskId: 'active', delegationId: 'D-c' })
    await expect(control.ForgetTask('root', 'terminal')).resolves.toEqual(['idle-a'])
    expect(control.get('idle-a')).toBeUndefined()
    expect(control.get('review-a')).toMatchObject({ needsSideEffectReview: true })
    expect(control.get('running-a')).toMatchObject({ phase: 'running' })
    expect(control.get('other-task')).toBeDefined()
    expect(cancelRetryRoute).toHaveBeenCalledWith('idle-a')
    expect(setPaused).toHaveBeenCalledWith('idle-a', false)
    expect(f.routes.isManualPaused('idle-a')).toBe(false)
  })

  it('forgets only the owning root and persists an empty control snapshot for that root', async () => {
    const persist = vi.fn(async () => undefined)
    const routes = intRouteStateRegistry()
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: vi.fn(), resume: vi.fn(),
      applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause, persist })
    control.Register({ ...binding, childId: 'root-a-child', taskId: 'T-1', delegationId: 'D-a' })
    control.Register({ ...binding, childId: 'root-b-child', parentSessionId: 'root-b', taskId: 'T-1', delegationId: 'D-b' })
    await expect(control.ForgetTask('root', 'T-1')).resolves.toEqual(['root-a-child'])
    expect(control.get('root-a-child')).toBeUndefined()
    expect(control.get('root-b-child')).toBeDefined()
    expect(persist).toHaveBeenLastCalledWith([expect.objectContaining({ childId: 'root-b-child' })], ['root'])
  })

  it('一次性规划审核可以切换下一请求，当前 attempt 不被取消或伪改模型，结束后禁止重放', async () => {
    const routes = intRouteStateRegistry()
    routes.AddChild('reviewer', { chain: [original], role: 'yu_shi', logicalRequestId: 'plan-1' })
    const interrupt = vi.fn(async () => undefined)
    const resume = vi.fn(async () => ({ accepted: true as const }))
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt, resume, applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause })
    control.Register({ ...binding, childId: 'reviewer', delegationId: 'plan-1', persistent: false })
    control.ObserveRequest('reviewer', original)
    control.MarkAttemptStarted('reviewer', 'reviewer:1', original)
    const address = () => ({ parentSessionId: 'root', childId: 'reviewer', expectedRevision: control.get('reviewer')!.revision })
    await control.Select({ ...address(), route: chosen })
    expect(interrupt).not.toHaveBeenCalled()
    expect(routes.isManualPaused('reviewer')).toBe(false)
    expect(control.get('reviewer')).toMatchObject({ phase: 'running', persistent: false, selectedNext: chosen, actual: { route: original } })
    expect(routes.getRequestOverride({ id: 'reviewer', session: { header: { parentSession: 'root' } } }, original, undefined)).toEqual(chosen)
    control.MarkAttemptStarted('reviewer', 'reviewer:2', chosen)
    control.MarkRunSettled('reviewer', 'completed')
    expect(control.get('reviewer')).toMatchObject({ oneShotSettled: true, reason: 'one-shot-settled', actual: { route: chosen, state: 'settled' } })
    const settled = control.get('reviewer')!
    control.ObserveSelection('reviewer', original)
    control.MarkWaiting('reviewer', true)
    control.MarkBlocked('reviewer', 'late-error')
    expect(control.get('reviewer')).toEqual(settled)
    await expect(control.Select({ ...address(), route: original })).rejects.toThrow('已结束')
    await expect(control.Continue(address())).rejects.toThrow('一次性')
    expect(resume).not.toHaveBeenCalled()
  })

  it('late cancellation can relabel a settled one-shot once without reopening execution', () => {
    const f = fixture()
    f.control.Register({ ...binding, childId: 'late-cancel', persistent: false })
    f.control.MarkRunSettled('late-cancel', 'completed')
    const settled = f.control.get('late-cancel')!
    f.control.MarkRunSettled('late-cancel', 'cancelled')
    const cancelled = f.control.get('late-cancel')!
    expect(cancelled).toMatchObject({ oneShotSettled: true, reason: 'one-shot-cancelled' })
    expect(cancelled.revision).toBe(settled.revision + 1)
    f.control.MarkRunSettled('late-cancel', 'cancelled')
    expect(f.control.get('late-cancel')).toEqual(cancelled)
  })

  it('一次性下一请求选择在异步模型校验中结算时拒绝陈旧CAS', async () => {
    let release!: () => void
    const applyOverride = vi.fn()
    const control = createAgentControl({ validateRoute: async (route) => { await new Promise<void>((resolve) => { release = resolve }); return route },
      interrupt: vi.fn(), resume: vi.fn(), applyOverride, setPaused: vi.fn() })
    control.Register({ ...binding, persistent: false })
    const select = control.Select({ parentSessionId: 'root', childId: 'child', expectedRevision: 1, route: chosen })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    control.MarkRunSettled('child', 'completed')
    release()
    await expect(select).rejects.toThrow('状态已改变')
    expect(applyOverride).not.toHaveBeenCalled()
  })
  it('model errors leave persistent tasks runnable for in-session retry; cancelled runs pause for direct recovery; duplicate end signals are idempotent', async () => {
    const errored = fixture()
    errored.start()
    errored.control.MarkRunSettled('child', 'error')
    expect(errored.control.get('child')).toMatchObject({ phase: 'idle', paused: false, actual: { state: 'settled' }, reason: 'host-run-failed:error' })
    await errored.control.Continue(errored.address())
    expect(errored.resume).toHaveBeenCalledTimes(1)
    const f = fixture()
    f.start()
    f.control.MarkRunSettled('child', 'aborted')
    expect(f.control.get('child')).toMatchObject({ phase: 'paused', paused: true, actual: { state: 'settled' }, reason: 'host-run-failed:aborted' })
    const revision = f.control.get('child')!.revision
    f.control.MarkRunSettled('child', 'aborted')
    expect(f.control.get('child')!.revision).toBe(revision)
    await f.control.Continue(f.address())
    expect(f.resume).toHaveBeenCalledTimes(1)
  })
  it('宿主真实结束原因：aborted（取消或打断）与 refusal（回合被拦下）暂停，error 与 max-tokens 不暂停', () => {
    for (const [reason, paused] of [['aborted', true], ['refusal', true], ['error', false], ['max-tokens', false]] as const) {
      const f = fixture()
      f.start()
      f.control.MarkRunSettled('child', reason)
      expect(f.control.get('child')).toMatchObject({ phase: paused ? 'paused' : 'idle', paused, reason: `host-run-failed:${reason}` })
      expect(f.routes.isManualPaused('child')).toBe(paused)
    }
  })
  it('原委派仍在退避等待自动重试时拒绝人工继续，且不改变状态、不暂停自动恢复', async () => {
    let active = true
    const f = fixture({ isDelegationActive: () => active })
    f.start()
    f.control.MarkRunSettled('child', 'error')
    const before = f.control.get('child')!
    await expect(f.control.Continue(f.address())).rejects.toThrow('原委派仍在自动重试')
    expect(f.control.get('child')).toEqual(before)
    expect(f.routes.isManualPaused('child')).toBe(false)
    expect(f.resume).not.toHaveBeenCalled()
    active = false
    await f.control.Continue(f.address())
    expect(f.resume).toHaveBeenCalledTimes(1)
  })
  it('selection changes the next effective request, survives Arm/Release, and is not an actual attempt until observed', async () => {
    const f = fixture()
    const selected = await f.control.Select({ ...f.address(), route: chosen })
    expect(selected.selectedNext).toEqual(chosen)
    expect(selected.actual).toBeUndefined()
    f.routes.ReleaseAgent('child')
    f.routes.AddChild('child', { chain: [original], role: 'tan_wei', persistent: true, logicalRequestId: 'D-2' })
    expect(f.routes.getRequestOverride(f.agent, original, undefined)).toEqual(chosen)
    f.control.ObserveRequest('child', chosen)
    expect(f.control.get('child')!.actual).toBeUndefined()
    f.control.MarkAttemptStarted('child', 'observed-2', f.routes.getLastRoute('child'))
    expect(f.control.get('child')!.actual).toMatchObject({ attemptId: 'observed-2', route: chosen, source: 'agent-loop-attempt', state: 'running' })
  })

  it('running switch cancels and blocks retry, waits for a real end, then explicitly continues the existing pipeline', async () => {
    const f = fixture()
    f.start()
    const selected = await f.control.Select({ ...f.address(), route: chosen, interruptRunning: true })
    expect(selected).toMatchObject({ phase: 'stopping', paused: true, actual: { route: original } })
    expect(f.interrupt).toHaveBeenCalledTimes(1)
    expect(f.resume).not.toHaveBeenCalled()
    expect(() => f.routes.getRequestOverride(f.agent, original, undefined)).toThrow('人工暂停')
    await expect(f.control.Continue(f.address())).rejects.toThrow('宿主已确认沉寂')
    f.control.MarkRunSettled('child')
    expect(f.control.get('child')).toMatchObject({ phase: 'paused', actual: { state: 'settled', route: original }, selectedNext: chosen })
    await f.control.Continue({ ...f.address(), steering: '只继续未完成的只读检查' })
    expect(f.resume).toHaveBeenCalledTimes(1)
    expect(f.resume.mock.calls[0]?.[1]).toEqual({ steering: '只继续未完成的只读检查' })
    expect(f.routes.isManualPaused('child')).toBe(false)
  })

  it('cold continuable attachment may reuse child:1; a new bound delegation still records the new actual model', () => {
    const f = fixture()
    f.control.MarkAttemptStarted('child', 'child:1', original)
    f.control.MarkRunSettled('child')
    const settledRevision = f.control.get('child')!.revision
    f.control.MarkRunSettled('child')
    expect(f.control.get('child')!.revision).toBe(settledRevision)
    f.control.Register({ ...binding, delegationId: 'D-2' })
    f.control.MarkAttemptStarted('child', 'child:1', chosen)
    expect(f.control.get('child')!.actual).toMatchObject({ attemptId: 'child:1', delegationId: 'D-2', route: chosen, state: 'running' })
    const current = f.control.get('child')!.revision
    f.control.MarkAttemptStarted('child', 'child:1', chosen)
    expect(f.control.get('child')!.revision).toBe(current)
  })

  it('control persistence stores only public route identity and rejects imported policy/extra fields', () => {
    const f = fixture()
    f.control.ObserveRequest('child', { ...original, maxTokens: 8192, privateAdapterSetting: 'must-not-persist' } as typeof original)
    f.control.MarkAttemptStarted('child', 'child:1', { ...original, policy: { quotaDomainId: 'private-domain' } })
    const snapshot = f.control.Export()
    expect(snapshot[0]!.requestedRoute).toEqual(original)
    expect(snapshot[0]!.actual?.route).toEqual(original)
    expect(JSON.stringify(snapshot)).not.toMatch(/must-not-persist|private-domain/)
    expect(ValidateAgentControlRecords([{ ...snapshot[0], selectedNext: { ...chosen, policy: { quotaDomainId: 'forged' } } }])).toBe(false)
  })

  it('side-effect confirmation is conditional and cannot bypass the actual workspace/lease recovery callback', async () => {
    const f = fixture({ resume: async () => { throw new Error('workspace mutation outcome remains unknown') } })
    f.control.Register({ ...binding, needsSideEffectReview: true })
    await f.control.Stop(f.address())
    await expect(f.control.Continue(f.address())).rejects.toThrow('副作用')
    await expect(f.control.Continue({ ...f.address(), confirmSafeToContinue: true })).rejects.toThrow('mutation outcome remains unknown')
    expect(f.control.get('child')).toMatchObject({ phase: 'paused', paused: true })
    expect(f.routes.isManualPaused('child')).toBe(true)
    expect(f.resume).toHaveBeenCalledTimes(1)
  })

  it('only a real allowed side-effect boundary marks risk; ending a wait cannot unpause a cancelled run', async () => {
    const f = fixture()
    f.start()
    expect(f.control.get('child')!.needsSideEffectReview).not.toBe(true)
    f.control.MarkWaiting('child', true)
    expect(f.control.get('child')!.phase).toBe('waiting')
    f.control.MarkSideEffectRisk('child')
    expect(f.control.get('child')!.needsSideEffectReview).toBe(true)
    await f.control.Stop(f.address())
    f.control.MarkWaiting('child', false)
    expect(f.control.get('child')!.phase).toBe('stopping')
    f.control.MarkRunSettled('child')
    await expect(f.control.Continue(f.address())).rejects.toThrow('副作用')
  })
  it('a completed run clears its risk flag; an aborted or unknown run keeps it', () => {
    const f = fixture()
    f.start(); f.control.MarkSideEffectRisk('child')
    f.control.MarkRunSettled('child', 'completed')
    expect(f.control.get('child')).toMatchObject({ phase: 'idle', needsSideEffectReview: false })
    f.control.MarkSideEffectRisk('child')
    f.control.MarkRunSettled('child', 'aborted')
    expect(f.control.get('child')).toMatchObject({ phase: 'paused', needsSideEffectReview: true })
  })

  it('retry intent is fenced before exposure and cancelled before a failed persistence restores execution', async () => {
    const f = fixture()
    let queued = false
    const cancelled: string[] = []
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: f.interrupt, resume: f.resume, applyOverride: f.routes.SetChildOverride,
      setPaused: (childId, paused) => { if (!paused) expect(queued).toBe(false); f.routes.SetManualPause(childId, paused) },
      retryRoute: async (_route, childId) => { expect(f.routes.isManualPaused(childId)).toBe(true); queued = true },
      cancelRetryRoute: (childId) => { queued = false; cancelled.push(childId) }, persist: async () => { throw new Error('disk failed') } })
    control.Register(binding)
    await expect(control.Select({ childId: 'child', parentSessionId: 'root', expectedRevision: 1, route: chosen, retryRoute: true, forceRetry: true })).rejects.toThrow('disk failed')
    expect(queued).toBe(false)
    expect(cancelled).toContain('child')
    expect(f.routes.isManualPaused('child')).toBe(false)
    expect(f.routes.getChildOverride('child')).toBeUndefined()
  })

  it('wrong root, stale revision and uninterruptible running selection never apply changes', async () => {
    const f = fixture()
    await expect(f.control.Select({ ...f.address(), parentSessionId: 'other', route: chosen })).rejects.toThrow('直属子会话')
    const stale = f.address()
    f.start()
    await expect(f.control.Select({ ...stale, route: chosen, interruptRunning: true })).rejects.toThrow('状态已改变')
    await expect(f.control.Select({ ...f.address(), route: chosen })).rejects.toThrow('先取消')
    expect(f.routes.getChildOverride('child')).toBeUndefined()
    expect(f.interrupt).not.toHaveBeenCalled()
  })

  it('durable write failure rolls back the latch; restart never claims an old run is idle or auto resumes it', async () => {
    const f = fixture({ persist: async () => { throw new Error('disk failed') } })
    f.start()
    await expect(f.control.Stop(f.address())).rejects.toThrow('disk failed')
    expect(f.control.get('child')).toMatchObject({ phase: 'running', paused: false })
    expect(f.routes.isManualPaused('child')).toBe(false)
    expect(f.interrupt).not.toHaveBeenCalled()
    const raw = f.control.Export('root')
    expect(ValidateAgentControlRecords(raw)).toBe(true)
    const restored = fixture()
    const next = createAgentControl({ validateRoute: async (route) => route, interrupt: restored.interrupt, resume: restored.resume, applyOverride: restored.routes.SetChildOverride, setPaused: restored.routes.SetManualPause })
    next.Restore(raw, 'root')
    expect(next.get('child')).toMatchObject({ phase: 'recovery-required', paused: true, actual: { state: 'unknown' } })
    await expect(next.Continue({ parentSessionId: 'root', childId: 'child', expectedRevision: next.get('child')!.revision })).rejects.toThrow('宿主已确认沉寂')
    expect(restored.resume).not.toHaveBeenCalled()
    expect(() => createAgentControl({ validateRoute: async (route) => route, interrupt: restored.interrupt, resume: restored.resume, applyOverride: restored.routes.SetChildOverride, setPaused: restored.routes.SetManualPause }).Restore(raw, 'other')).toThrow('根会话边界')
    expect(ValidateAgentControlRecords([{ ...raw[0], revision: -1 }])).toBe(false)
  })

  it('durable restore rejects one-shot controls instead of rehydrating an unbounded backlog', () => {
    const f = fixture()
    const record = f.control.Export()[0]!
    expect(() => f.control.Restore([{ ...record, persistent: false, oneShotSettled: true }], 'root')).toThrow('快照无效')
  })
  it('unknown recovery permits saving a new selection or requesting stop without claiming quiescence', async () => {
    const original = fixture()
    original.start()
    const f = fixture()
    const control = createAgentControl({ validateRoute: async (route) => route, interrupt: f.interrupt, resume: f.resume, applyOverride: f.routes.SetChildOverride, setPaused: f.routes.SetManualPause })
    control.Restore(original.control.Export(), 'root')
    const address = () => ({ childId: 'child', parentSessionId: 'root', expectedRevision: control.get('child')!.revision })
    await control.Select({ ...address(), route: chosen })
    expect(control.get('child')).toMatchObject({ phase: 'recovery-required', paused: true, selectedNext: chosen, actual: { state: 'unknown' } })
    expect(f.interrupt).not.toHaveBeenCalled()
    await control.Stop(address())
    expect(f.interrupt).toHaveBeenCalledTimes(1)
    expect(control.get('child')!.phase).toBe('recovery-required')
    await expect(control.Continue(address())).rejects.toThrow('宿主已确认沉寂')
    expect(f.resume).not.toHaveBeenCalled()
  })
})
