import { describe, expect, it, vi } from 'vitest'
import { createAgentControl, validateAgentControlRecords, type AgentControlDeps } from '../../src/agent-control.js'
import { intRouteStateRegistry } from '../../src/route-state.js'

const original = { provider: 'qwen-token-plan-cn', model: 'old', reasoningEffort: 'high' }
const chosen = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' }
const binding = { childId: 'child', parentSessionId: 'root', taskId: 'T-1', delegationId: 'D-1', persistent: true, cardRevision: 1, workflowRevision: 1, requestRevision: 1 }
const fixture = (options: { persist?: () => Promise<void>; resume?: () => Promise<{ accepted: true }> } = {}) => {
  const routes = intRouteStateRegistry()
  routes.AddChild('child', { chain: [original], role: 'tan_wei', persistent: true, logicalRequestId: 'D-1' })
  const interrupt = vi.fn(async () => undefined)
  const resume = vi.fn<AgentControlDeps['resume']>(options.resume ?? (async () => ({ accepted: true as const })))
  const control = createAgentControl({ validateRoute: async (route) => route, interrupt, resume, applyOverride: routes.SetChildOverride, setPaused: routes.SetManualPause, persist: options.persist })
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
  it('real failed run ends pause persistent tasks for direct recovery; duplicate end signals are idempotent', async () => {
    const f = fixture()
    f.start()
    f.control.MarkRunSettled('child', 'error')
    expect(f.control.get('child')).toMatchObject({ phase: 'paused', paused: true, actual: { state: 'settled' }, reason: 'host-run-failed:error' })
    const revision = f.control.get('child')!.revision
    f.control.MarkRunSettled('child', 'error')
    expect(f.control.get('child')!.revision).toBe(revision)
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
    expect(validateAgentControlRecords([{ ...snapshot[0], selectedNext: { ...chosen, policy: { quotaDomainId: 'forged' } } }])).toBe(false)
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
    expect(validateAgentControlRecords(raw)).toBe(true)
    const restored = fixture()
    const next = createAgentControl({ validateRoute: async (route) => route, interrupt: restored.interrupt, resume: restored.resume, applyOverride: restored.routes.SetChildOverride, setPaused: restored.routes.SetManualPause })
    next.Restore(raw, 'root')
    expect(next.get('child')).toMatchObject({ phase: 'recovery-required', paused: true, actual: { state: 'unknown' } })
    await expect(next.Continue({ parentSessionId: 'root', childId: 'child', expectedRevision: next.get('child')!.revision })).rejects.toThrow('宿主已确认沉寂')
    expect(restored.resume).not.toHaveBeenCalled()
    expect(() => createAgentControl({ validateRoute: async (route) => route, interrupt: restored.interrupt, resume: restored.resume, applyOverride: restored.routes.SetChildOverride, setPaused: restored.routes.SetManualPause }).Restore(raw, 'other')).toThrow('根会话边界')
    expect(validateAgentControlRecords([{ ...raw[0], revision: -1 }])).toBe(false)
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
