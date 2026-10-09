import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteStateRegistry, type FallbackEventInfo } from '../../src/route-state.js'
import type { PreferredRecoveryEventInfo } from '../../src/route-state.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'
import { nativeRecoveryCoverage, getNativeRecoverySupport } from '../../src/provider-policy.js'
import { intRouteHealth } from '../../src/route-health.js'
import type { RouteInfo } from '../../src/routes.js'
import { apply as applyRuntime } from '../../src/runtime.js'
import type { PluginContextLike } from '../../src/host-contract.js'

const config = getSwarmConfig({})
const child = { id: 'c1', session: { header: { parentSession: 'root' } } }
const root = { id: 'root', session: { header: {} } }
const chain = [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2', reasoningEffort: 'high' }, { provider: 'a', model: 'm3' }]

describe('automatic source quota routing', () => {
  const primary = { provider: 'codex', model: 'gpt-6-sol', reasoningEffort: 'high' }
  const qwen = { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash', reasoningEffort: 'medium' }
  const claude = { provider: 'claude', model: 'claude-sonnet-5' }
  const api = { provider: 'deepseek-official', model: 'deepseek-flash' }
  const declared = [primary, qwen, claude, api]
  const effective = [qwen, claude, primary, api]
  const cfg = getSwarmConfig({ agents: { rootRecoverMs: 1 }, routes: { tian_shu: { chain: declared } } })
  const order = (routes: readonly RouteInfo[]) => effective.map((item) => routes.find((route) => route.provider === item.provider)!)
  const fail = (registry: ReturnType<typeof intRouteStateRegistry>, selected: RouteInfo, agent = root, role: 'tian_shu' | undefined = 'tian_shu') => registry.recover({ agent, provider: selected.provider, failure: { status: 400 } }, async () => undefined, role, cfg)

  it('the runtime automatically selects quota preference on the first request and tries deferred subscriptions before API', async () => {
    const orderQuotaRoutes = vi.fn(async (routes: readonly RouteInfo[]) => order(routes))
    const onRouteSuccess = vi.fn()
    const probe = vi.fn(async () => ({ ok: true as const, vision: true }))
    const registry = intRouteStateRegistry(undefined, probe, { orderQuotaRoutes, onRouteSuccess })
    const listeners = new Map<string, (...args: any[]) => any>()
    applyRuntime({
      get: (name: string) => name === 'agentSwarm' ? { routeState: registry, getConfig: () => cfg, WaitAgentReady: async () => undefined } : name === 'sessionProjections' ? { stateOf: () => ({ pending: false }) } : undefined,
      on: (event: string, listener: (...args: any[]) => any) => { listeners.set(event, listener) }
    } as unknown as PluginContextLike, { role: 'tian_shu' })
    const request = () => listeners.get('agent/request')!({ agent: root, turn: 0, step: 0, signal: new AbortController().signal }, async () => primary)
    expect(await request()).toMatchObject(qwen)
    expect(registry.getRootPreference(root.id)).toMatchObject(primary)
    expect(registry.getHealth()).toEqual([])
    for (const [from, to] of [[qwen, claude], [claude, primary], [primary, api]] as const) {
      expect(await fail(registry, from)).toEqual({ kind: 'retry' })
      expect(await request()).toMatchObject(to)
    }
    expect(orderQuotaRoutes).toHaveBeenCalledTimes(1)
    expect(registry.getRecovery(root.id)?.attemptedRoutes).toEqual(effective.map((route) => `${route.provider}/${route.model}`))
    expect(registry.getRecovery(root.id)?.attempts).toBe(4)
    listeners.get('agent/assistant-stream')!({ agent: root, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/attempt' } } })
    expect(onRouteSuccess).not.toHaveBeenCalled()
    listeners.get('agent/assistant-stream')!({ agent: root, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } } })
    expect(onRouteSuccess).toHaveBeenCalledExactlyOnceWith(api)
  })

  it('a child keeps its declared preference while fallback enumerates the complete effective order', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: true }), { orderQuotaRoutes: async (routes) => order(routes) })
    registry.AddChild(child.id, { chain: declared, initialRoute: qwen, initialQuotaOrder: effective, role: 'tan_wei', logicalRequestId: 'D-quota-child' })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, qwen, undefined, cfg)
    await registry.PrepareQuotaRouting(child, qwen, undefined, cfg)
    expect(registry.getRequestOverride(child, qwen, undefined, cfg, true)).toMatchObject(qwen)
    for (const [from, to] of [[qwen, claude], [claude, primary], [primary, api]] as const) {
      expect(await fail(registry, from, child, undefined)).toEqual({ kind: 'retry' })
      expect(registry.getRequestOverride(child, qwen, undefined, cfg, true)).toMatchObject(to)
    }
    registry.FinishLogicalRequest('D-quota-child')
    registry.DelAgent(child.id)
    expect(registry.getRecoveryDiagnostics().logicalRequests).toBe(0)
  })

  it('a trusted spawned child keeps the model actually started after an earlier quota-preferred start failed', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: true }), { orderQuotaRoutes: async (routes) => order(routes) })
    // Quota preferred Qwen, but startSpawn failed there and actually created Codex.
    registry.AddChild(child.id, { chain: declared, initialRoute: primary, initialQuotaOrder: effective, role: 'tan_wei' })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, primary, undefined, cfg)
    await registry.PrepareQuotaRouting(child, primary, undefined, cfg)
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(primary)
    expect(registry.getRecovery(child.id)?.attemptedRoutes).toEqual(['codex/gpt-6-sol'])
    expect(await fail(registry, primary, child, undefined)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(qwen)
  })

  it('an actual preferred recovery trial is protected once from old source quota reports', async () => {
    let clock = 0
    const orderQuotaRoutes = vi.fn(async (routes: readonly RouteInfo[], _signal?: AbortSignal, protectedRoutes?: readonly RouteInfo[]) => protectedRoutes?.some((route) => route.provider === primary.provider) ? [...routes] : order(routes))
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: true }), { now: () => clock, orderQuotaRoutes })
    registry.AddChild(child.id, { chain: declared, initialRoute: qwen, initialQuotaOrder: effective, role: 'tan_wei', persistent: true })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, qwen, undefined, cfg)
    await registry.PrepareQuotaRouting(child, qwen, undefined, cfg)
    registry.getRequestOverride(child, qwen, undefined, cfg, true)
    registry.MarkRequestSucceeded(child.id)
    clock = 6000
    registry.BeginRequestStep(child.id, 0, 1)
    await registry.PreparePreferredRecovery(child, qwen, undefined, cfg)
    await registry.PrepareQuotaRouting(child, qwen, undefined, cfg)
    expect(orderQuotaRoutes.mock.calls.at(-1)?.[2]).toEqual([primary])
    expect(registry.getRequestOverride(child, qwen, undefined, cfg, true)).toMatchObject(primary)
    expect(registry.getRecovery(child.id)?.attempts).toBe(1)
  })

  it.each(['field-order', 'value-change'] as const)('an in-flight fallback survives semantic policy identity and rejects changed values: %s', async (change) => {
    let release!: () => void
    const probe = vi.fn(async (route: RouteInfo) => {
      if (route.provider === claude.provider) await new Promise<void>((resolve) => { release = resolve })
      return { ok: true as const, vision: true }
    })
    const registry = intRouteStateRegistry(undefined, probe)
    const upgradeChain = [primary, qwen, claude].map((route, index) => ({ ...route, policy: { accessMode: 'subscription' as const, quotaDomainId: `upgrade-domain-${index}` } }))
    registry.SetRootUpgrade(root.id, upgradeChain, primary)
    registry.BeginRequestStep(root.id, 0, 0)
    registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)
    expect(await fail(registry, primary)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(qwen)
    const pending = fail(registry, qwen)
    await vi.waitFor(() => expect(probe).toHaveBeenLastCalledWith(upgradeChain[2]))
    const refreshed = upgradeChain.map((route, index) => ({ ...route, policy: { quotaDomainId: change === 'value-change' && index === 1 ? 'changed-domain' : route.policy.quotaDomainId, accessMode: 'subscription' as const } }))
    registry.SetRootUpgrade(root.id, refreshed, primary)
    release()
    if (change === 'field-order') {
      expect(await pending).toEqual({ kind: 'retry' })
      expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(claude)
      expect(registry.getRecovery(root.id)?.attempts).toBe(3)
    } else {
      expect(await pending).toBeUndefined()
      expect(registry.getLastRoute(root.id)).toMatchObject(qwen)
      expect(registry.getRootUpgrade(root.id)?.[1]?.policy?.quotaDomainId).toBe('changed-domain')
      expect(registry.getRecovery(root.id)?.attempts).toBe(2)
    }
  })

  it('a disposed root or a manual selection cannot be overwritten by a late fallback probe', async () => {
    for (const transition of ['dispose', 'select'] as const) {
      let release!: () => void
      const registry = intRouteStateRegistry(undefined, async () => {
        await new Promise<void>((resolve) => { release = resolve })
        return { ok: true, vision: true }
      })
      registry.BeginRequestStep(root.id, 0, 0)
      registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)
      const pending = fail(registry, primary)
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      if (transition === 'dispose') registry.DelAgent(root.id)
      else registry.RecordUserSelection(root.id, api)
      release()
      expect(await pending).toBeUndefined()
      if (transition === 'dispose') expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
      else expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(api)
    }
  })

  it('manual child/root selection and rootFallback=false bypass automatic quota sorting', async () => {
    const orderQuotaRoutes = vi.fn(async (routes: readonly RouteInfo[]) => order(routes))
    const registry = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes })
    registry.AddChild(child.id, { chain: declared, role: 'tan_wei' })
    registry.SetChildOverride(child.id, primary)
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PrepareQuotaRouting(child, primary, undefined, cfg)
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(primary)
    registry.RecordUserSelection(root.id, primary)
    registry.BeginRequestStep(root.id, 0, 0)
    await registry.PrepareQuotaRouting(root, primary, 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(primary)
    const disabled = getSwarmConfig({ rootFallback: false, routes: { tian_shu: { chain: declared } } })
    await registry.PrepareQuotaRouting({ id: 'disabled' }, primary, 'tian_shu', disabled)
    expect(registry.getRequestOverride({ id: 'disabled' }, primary, 'tian_shu', disabled)).toMatchObject(primary)
    expect(orderQuotaRoutes).not.toHaveBeenCalled()
  })

  it('a legacy root picker change invalidates already prepared automatic quota order', async () => {
    const orderQuotaRoutes = vi.fn(async (routes: readonly RouteInfo[]) => order(routes))
    const registry = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes })
    registry.BeginRequestStep(root.id, 0, 0)
    await registry.PrepareQuotaRouting(root, primary, 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg)).toMatchObject(qwen)
    // No explicit model/selection projection exists in this Host generation.
    // A new model that differs from both resolved and actual last routes is human intent.
    expect(registry.getRequestOverride(root, claude, 'tian_shu', cfg)).toMatchObject(claude)
    expect(await fail(registry, claude)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, claude, 'tian_shu', cfg)).toMatchObject(primary)
    expect(orderQuotaRoutes).toHaveBeenCalledTimes(1)
  })

  it('health and capability checks remain authoritative on a new quota-preferred root route', async () => {
    const probe = vi.fn(async (route: RouteInfo) => route.provider === qwen.provider ? { ok: false as const, reason: 'provider-not-configured' } : { ok: true as const, vision: true })
    const registry = intRouteStateRegistry(undefined, probe, { orderQuotaRoutes: async (routes) => order(routes) })
    registry.BeginRequestStep(root.id, 0, 0)
    await registry.PrepareQuotaRouting(root, primary, 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(claude)
    const isolated = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes: async (routes) => order(routes) })
    await isolated.ObserveRouteFailure(qwen, { code: 'QUOTA' }, cfg)
    isolated.BeginRequestStep(root.id, 0, 0)
    await isolated.PrepareQuotaRouting(root, primary, 'tian_shu', cfg)
    expect(isolated.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(claude)
    expect(isolated.getHealth().length).toBe(1)
  })

  it('cancellation or disposal while quota is pending never admits a model or resurrects request state', async () => {
    let release!: (routes: readonly RouteInfo[]) => void
    const orderQuotaRoutes = vi.fn(() => new Promise<readonly RouteInfo[]>((resolve) => { release = resolve }))
    const registry = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes })
    registry.AddChild(child.id, { chain: declared, role: 'tan_wei' })
    registry.BeginRequestStep(child.id, 0, 0)
    const controller = new AbortController()
    const pending = registry.PrepareQuotaRouting(child, primary, undefined, cfg, controller.signal)
    controller.abort()
    registry.DelAgent(child.id)
    release(effective)
    await expect(pending).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(registry.getRecovery(child.id)).toBeUndefined()
    expect(registry.getLastRoute(child.id)).toBeUndefined()
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
    const cancelled = new AbortController(); cancelled.abort()
    await expect(registry.PrepareQuotaRouting(root, primary, 'tian_shu', cfg, cancelled.signal)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(orderQuotaRoutes).toHaveBeenCalledTimes(1)
  })

  it('a late cancelled quota read cannot erase the newer step effective fallback chain', async () => {
    const releases: Array<(routes: readonly RouteInfo[]) => void> = []
    const registry = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes: () => new Promise<readonly RouteInfo[]>((resolve) => { releases.push(resolve) }) })
    registry.AddChild(child.id, { chain: declared, role: 'tan_wei' })
    const old = new AbortController()
    registry.BeginLogicalRequest(child.id, 'old-step')
    const pendingOld = registry.PrepareQuotaRouting(child, primary, undefined, cfg, old.signal)
    registry.BeginLogicalRequest(child.id, 'new-step')
    const pendingNew = registry.PrepareQuotaRouting(child, primary, undefined, cfg)
    releases[1]!(effective)
    await pendingNew
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(qwen)
    old.abort()
    releases[0]!(effective)
    await expect(pendingOld).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await fail(registry, qwen, child, undefined)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(claude)
    expect(await fail(registry, claude, child, undefined)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(primary)
    expect(registry.getRecovery(child.id)?.logicalRequestId).toBe('new-step')
    expect(releases).toHaveLength(2)
  })

  it('new quota preference cannot rewind the established root fallback before its recovery timer', async () => {
    const registry = intRouteStateRegistry(undefined, undefined, { now: () => 0, orderQuotaRoutes: async (routes) => order(routes) })
    registry.BeginRequestStep(root.id, 0, 0)
    await registry.PrepareQuotaRouting(root, primary, 'tian_shu', cfg)
    registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)
    expect(await fail(registry, qwen)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(claude)
    registry.MarkRequestSucceeded(root.id)
    registry.BeginRequestStep(root.id, 0, 1)
    await registry.PreparePreferredRecovery(root, claude, 'tian_shu', cfg)
    await registry.PrepareQuotaRouting(root, claude, 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, claude, 'tian_shu', cfg, true)).toMatchObject(claude)
    expect(registry.getRecovery(root.id)?.attempts).toBe(1)
  })

  it('bad adapter output cannot add/drop routes, replace policy, or collapse different reasoning efforts', async () => {
    const declaredPrimary = { ...primary, policy: { quotaDomainId: 'declared-domain' } }
    const otherEffort = { ...primary, reasoningEffort: 'low' }
    const declaredChain = [declaredPrimary, otherEffort, api]
    const selected = getSwarmConfig({ routes: { tian_shu: { chain: declaredChain } } })
    const registry = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes: async () => [{ ...primary, policy: { quotaDomainId: 'forged' } }, api, api] })
    registry.BeginRequestStep(root.id, 0, 0)
    await registry.PrepareQuotaRouting(root, primary, 'tian_shu', selected)
    expect(registry.getRequestOverride(root, primary, 'tian_shu', selected, true)).toMatchObject(primary)
    expect(registry.getLastRoute(root.id)?.policy?.quotaDomainId).toBe('declared-domain')
    expect(registry.getRecovery(root.id)?.attempts).toBe(1)
  })

  it('quota sorting neither resets the eight-attempt ceiling nor lets a restarted delegation admit a ninth model', async () => {
    const routes = Array.from({ length: 9 }, (_, index) => ({ provider: `subscription-${index}`, model: `model-${index}` }))
    const orderQuotaRoutes = vi.fn(async (chain: readonly RouteInfo[]) => [...chain.slice(1), chain[0]!])
    const registry = intRouteStateRegistry(undefined, undefined, { orderQuotaRoutes })
    registry.AddChild(child.id, { chain: routes, role: 'tan_wei', logicalRequestId: 'D-eight' })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PrepareQuotaRouting(child, routes[0]!, undefined, cfg)
    for (let index = 0; index < 8; index++) {
      expect(registry.getRequestOverride(child, routes[0]!, undefined, cfg, true)).toMatchObject(routes[index + 1]!)
      const result = await fail(registry, routes[index + 1]!, child, undefined)
      expect(result).toEqual(index === 7 ? undefined : { kind: 'retry' })
    }
    expect(registry.getRecovery(child.id)?.attempts).toBe(8)
    expect(registry.getTerminal(child.id)).toBe('recovery_attempts_exhausted')
    registry.DelAgent(child.id)
    registry.AddChild('restarted-quota', { chain: routes, role: 'tan_wei', logicalRequestId: 'D-eight' })
    registry.BeginRequestStep('restarted-quota', 0, 0)
    await registry.PrepareQuotaRouting({ id: 'restarted-quota' }, routes[0]!, undefined, cfg)
    expect(() => registry.getRequestOverride({ id: 'restarted-quota' }, routes[0]!, undefined, cfg, true)).toThrow('recovery_attempts_exhausted')
    expect(orderQuotaRoutes).toHaveBeenCalledTimes(1)
    registry.DelAgent('restarted-quota')
    registry.FinishLogicalRequest('D-eight')
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
  })
})

describe('request recovery lifetime', () => {
  const route = { provider: 'fixture', model: 'fixture' }
  const cfg = getSwarmConfig({ routes: { tian_shu: { chain: [route] } } })

  it('failed and cancelled one-shot delegations release all scoped state after terminal consumption', () => {
    const registry = intRouteStateRegistry()
    for (let index = 0; index < 2500; index++) {
      const id = `disposed-${index}`
      const requestId = `D-finished-${index}`
      registry.AddChild(id, { chain: [route], role: 'tan_wei', logicalRequestId: requestId })
      registry.BeginRequestStep(id, 0, 0)
      registry.getRequestOverride({ id }, route, undefined)
      if (index % 2 === 0) registry.getErrorAction({ agent: { id }, provider: route.provider, failure: { status: 400 } }, undefined, undefined, cfg)
      // Real host end/dispose events precede the outer delegate result check.
      registry.ReleaseAgent(id)
      registry.DelAgent(id)
      expect(registry.getTerminal(id)).toBe(index % 2 === 0 ? 'route_chain_exhausted' : undefined)
      registry.FinishLogicalRequest(requestId)
      expect(registry.getRecovery(id)).toBeUndefined()
      expect(registry.getTerminal(id)).toBeUndefined()
    }
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
  })

  it('disposing and restarting a child within the same delegation does not reset the eight-admission ceiling', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('first', { chain: [route], role: 'tan_wei', logicalRequestId: 'D-restart' })
    registry.BeginRequestStep('first', 0, 0)
    for (let index = 0; index < 8; index++) registry.getRequestOverride({ id: 'first' }, route, undefined)
    registry.ReleaseAgent('first')
    registry.DelAgent('first')
    registry.AddChild('second', { chain: [route], role: 'tan_wei', logicalRequestId: 'D-restart' })
    registry.BeginRequestStep('second', 0, 0)
    registry.BeginRequestStep('second', 0, 0)
    expect(() => registry.getRequestOverride({ id: 'second' }, route, undefined)).toThrow('recovery_attempts_exhausted')
    registry.DelAgent('second')
    expect(registry.getTerminal('second')).toBe('recovery_attempts_exhausted')
    registry.FinishLogicalRequest('D-restart')
    registry.FinishLogicalRequest('D-restart')
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
  })

  it('finishing a persistent delegation preserves its current recovery, selected model and pause fence', () => {
    const registry = intRouteStateRegistry()
    const chosen = { provider: 'manual', model: 'chosen' }
    registry.AddChild(child.id, { chain: [route, chosen], role: 'tan_wei', persistent: true, logicalRequestId: 'D-persistent-1' })
    registry.RecordUserSelection(child.id, chosen, 1)
    registry.BeginRequestStep(child.id, 0, 0)
    expect(registry.getRequestOverride(child, route, undefined)).toMatchObject(chosen)
    registry.MarkRequestSucceeded(child.id)
    registry.SetManualPause(child.id, true)
    registry.ReleaseAgent(child.id)
    registry.FinishLogicalRequest('D-persistent-1')
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 1, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
    expect(registry.getRecovery(child.id)?.completed).toBe(true)
    expect(registry.getChildOverride(child.id)).toEqual(chosen)
    expect(registry.isManualPaused(child.id)).toBe(true)
    registry.AddChild(child.id, { chain: [route, chosen], role: 'tan_wei', persistent: true, logicalRequestId: 'D-persistent-2' })
    registry.BeginRequestStep(child.id, 1, 0)
    expect(() => registry.getRequestOverride(child, route, undefined)).toThrow('子会话已人工暂停')
    registry.SetManualPause(child.id, false)
    expect(registry.getRequestOverride(child, route, undefined)).toMatchObject(chosen)
    registry.FinishLogicalRequest('D-persistent-2')
    registry.DelAgent(child.id)
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
  })

  it('new root steps discard old failed state while repeated current step ids retain the counter', () => {
    const registry = intRouteStateRegistry()
    for (let step = 0; step < 2500; step++) {
      registry.BeginRequestStep(root.id, 0, step)
      registry.getRequestOverride(root, route, 'tian_shu', cfg, true)
      registry.BeginRequestStep(root.id, 0, step)
      expect(registry.getRecovery(root.id)?.attempts).toBe(1)
      registry.getErrorAction({ agent: root, provider: route.provider, failure: { status: 400 } }, undefined, 'tian_shu', cfg)
    }
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 1, logicalRequests: 1, logicalStates: 1, disposedTerminals: 0 })
    registry.ReleaseAgent(root.id)
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
  })

  it('a late duplicate persistent-child step after owner cleanup retains its exhausted admission counter', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild(child.id, { chain: [route], role: 'tan_wei', persistent: true, logicalRequestId: 'D-late' })
    registry.BeginRequestStep(child.id, 0, 0)
    for (let index = 0; index < 8; index++) registry.getRequestOverride(child, route, undefined)
    registry.FinishLogicalRequest('D-late')
    registry.BeginRequestStep(child.id, 0, 0)
    expect(() => registry.getRequestOverride(child, route, undefined)).toThrow('recovery_attempts_exhausted')
    registry.FinishLogicalRequest('D-late')
    expect(registry.getRecoveryDiagnostics()).toMatchObject({ agents: 1, logicalRequests: 0, logicalStates: 0 })
  })

  it('legacy unscoped dispose retains only a bounded terminal receipt, never full request histories', () => {
    const registry = intRouteStateRegistry()
    for (let index = 0; index < 2500; index++) {
      const id = `legacy-${index}`
      registry.AddChild(id, { chain: [route], role: 'tan_wei' })
      registry.getRequestOverride({ id }, route, undefined)
      registry.getErrorAction({ agent: { id }, provider: route.provider, failure: { status: 400 } }, undefined, undefined, cfg)
      registry.DelAgent(id)
    }
    expect(registry.getTerminal('legacy-2499')).toBe('route_chain_exhausted')
    expect(registry.getRecovery('legacy-2499')).toBeUndefined()
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 1024 })
  })
})

describe('durable successful route recovery', () => {
  const route = { provider: 'synthetic', model: 'success' }
  const prepare = (onHealthChange: NonNullable<Parameters<typeof intRouteStateRegistry>[2]>['onHealthChange'], extra: Parameters<typeof intRouteStateRegistry>[2] = {}) => {
    let clock = 0
    const health = intRouteHealth(() => clock)
    health.record(route, { provider: route.provider, model: route.model, kind: 'quota_exhausted', message: 'synthetic fixture' })
    clock = 5000
    const registry = intRouteStateRegistry(undefined, undefined, { health, now: () => clock, onHealthChange, ...extra })
    registry.AddChild(child.id, { chain: [route], role: 'tan_wei', persistent: true, logicalRequestId: 'D-success' })
    registry.BeginRequestStep(child.id, 0, 0)
    expect(registry.RequestRouteRetry(route, child.id, { force: true }).ok).toBe(true)
    expect(registry.getRequestOverride(child, route, undefined)).toMatchObject(route)
    return registry
  }

  it('observes committed success immediately but gates the next model request until its tombstone is durable', async () => {
    let commit!: () => void
    const hook = vi.fn(() => new Promise<void>((resolve) => { commit = resolve }))
    const registry = prepare(hook)
    registry.MarkRequestSucceeded(child.id)
    registry.MarkRequestSucceeded(child.id)
    expect(registry.getRecovery(child.id)?.completed).toBe(true)
    expect(registry.getHealth()).toEqual([])
    expect(registry.getHealthSnapshot().cleared.length).toBeGreaterThan(0)
    expect(hook).toHaveBeenCalledTimes(1)
    expect(hook.mock.calls[0]).toMatchObject([{ schemaVersion: 1, entries: [], cleared: expect.any(Array) }, { agentId: child.id, reason: 'success' }])
    expect(() => registry.getRequestOverride(child, route, undefined)).toThrow('健康状态持久提交仍未完成')
    let ready = false
    const waiting = registry.WaitHealthReady(child.id).then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)
    commit()
    await waiting
    registry.BeginRequestStep(child.id, 0, 1)
    expect(registry.getRequestOverride(child, route, undefined)).toMatchObject(route)
  })

  it('reports a failed success commit, dispatches no model, and recovers only after a fresh health commit succeeds', async () => {
    let fail = true
    const hook = vi.fn(async () => { if (fail) throw new Error('synthetic-disk-error') })
    const notify = vi.fn()
    const registry = prepare(hook, { onHealthPersistenceFailure: notify })
    registry.MarkRequestSucceeded(child.id)
    await expect(registry.WaitHealthReady(child.id)).rejects.toThrow('route_health_persist_failed')
    expect(notify).toHaveBeenCalledWith({ agentId: child.id, reason: 'route_health_persist_failed' })
    registry.BeginRequestStep(child.id, 0, 1)
    expect(() => registry.getRequestOverride(child, route, undefined)).toThrow('route_health_persist_failed')
    fail = false
    await registry.WaitHealthReady(child.id)
    expect(hook).toHaveBeenCalledTimes(2)
    expect(registry.getRequestOverride(child, route, undefined)).toMatchObject(route)
  })

  it('bounds persistence waiting and allows cancellation without claiming the underlying write was cancelled', async () => {
    let commit!: () => void
    const registry = prepare(() => new Promise<void>((resolve) => { commit = resolve }), { healthCommitWaitMs: 5 })
    registry.MarkRequestSucceeded(child.id)
    await expect(registry.WaitHealthReady(child.id)).rejects.toThrow('底层写入状态仍待确认')
    const controller = new AbortController()
    const waiting = registry.WaitHealthReady(child.id, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow('等待已取消')
    expect(() => registry.getRequestOverride(child, route, undefined)).toThrow('健康状态持久提交仍未完成')
    commit()
    await registry.WaitHealthReady(child.id)
  })

  it('a late rejected write reports failure without recreating a finished one-shot request', async () => {
    let reject!: (error: Error) => void
    const notify = vi.fn()
    const hook = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const registry = prepare(hook, { onHealthPersistenceFailure: notify })
    registry.MarkRequestSucceeded(child.id)
    registry.DelAgent(child.id)
    registry.FinishLogicalRequest('D-success')
    reject(new Error('late-disk-error'))
    await Promise.resolve()
    await Promise.resolve()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(registry.getRecovery(child.id)).toBeUndefined()
    expect(registry.getTerminal(child.id)).toBeUndefined()
    expect(registry.getRecoveryDiagnostics()).toEqual({ agents: 0, logicalRequests: 0, logicalStates: 0, disposedTerminals: 0 })
    expect(() => registry.getRequestOverride(root, route, 'tian_shu', config)).toThrow('route_health_persist_failed')
    hook.mockResolvedValueOnce(undefined)
    await registry.WaitHealthReady(root.id)
    expect(registry.getRequestOverride(root, route, 'tian_shu', config)).toMatchObject(route)
    expect(registry.getRecovery(child.id)).toBeUndefined()
  })

  it('a successful child retains the shared durability barrier for other agents after Finish', async () => {
    let commit!: () => void
    const registry = prepare(() => new Promise<void>((resolve) => { commit = resolve }))
    registry.MarkRequestSucceeded(child.id)
    registry.DelAgent(child.id)
    registry.FinishLogicalRequest('D-success')
    expect(() => registry.getRequestOverride(root, route, 'tian_shu', config)).toThrow('健康状态持久提交仍未完成')
    let ready = false
    const waiting = registry.WaitHealthReady(root.id).then(() => { ready = true })
    await Promise.resolve()
    expect(ready).toBe(false)
    commit()
    await waiting
    expect(registry.getRequestOverride(root, route, 'tian_shu', config)).toMatchObject(route)
    expect(registry.getRecovery(child.id)).toBeUndefined()
  })

  const prepareConcurrentSuccesses = (waitMs = 10000) => {
    let clock = 0
    const health = intRouteHealth(() => clock)
    const other = { provider: 'synthetic', model: 'other-success' }
    for (const selected of [route, other]) health.record(selected, { provider: selected.provider, model: selected.model, kind: 'quota_exhausted', message: 'synthetic fixture' })
    clock = 5000
    const commits: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    const hook = vi.fn(() => new Promise<void>((resolve, reject) => { commits.push({ resolve, reject }) }))
    const registry = intRouteStateRegistry(undefined, undefined, { health, now: () => clock, onHealthChange: hook, healthCommitWaitMs: waitMs })
    for (const [id, selected] of [['first', route], ['second', other]] as const) {
      registry.AddChild(id, { chain: [selected], role: 'tan_wei', persistent: true, logicalRequestId: `D-${id}` })
      registry.RequestRouteRetry(selected, id, { force: true })
      registry.getRequestOverride({ id }, selected, undefined)
    }
    return { registry, commits }
  }

  it('a newer complete shared snapshot covers an older failed commit without reopening the model gate early', async () => {
    const { registry, commits } = prepareConcurrentSuccesses()
    registry.MarkRequestSucceeded('first')
    const waiting = registry.WaitHealthReady(root.id)
    registry.MarkRequestSucceeded('second')
    commits[0]!.reject(new Error('old-snapshot-write-failed'))
    await Promise.resolve()
    await Promise.resolve()
    expect(() => registry.getRequestOverride(root, route, 'tian_shu', config)).toThrow('健康状态持久提交仍未完成')
    commits[1]!.resolve()
    await waiting
    expect(registry.getRequestOverride(root, route, 'tian_shu', config)).toMatchObject(route)
  })

  it('newer shared commits do not reset an existing waiter deadline', async () => {
    vi.useFakeTimers()
    try {
      const { registry, commits } = prepareConcurrentSuccesses(20)
      registry.MarkRequestSucceeded('first')
      const waiting = expect(registry.WaitHealthReady(root.id)).rejects.toThrow('底层写入状态仍待确认')
      await vi.advanceTimersByTimeAsync(15)
      registry.MarkRequestSucceeded('second')
      commits[0]!.resolve()
      await vi.advanceTimersByTimeAsync(5)
      await waiting
      expect(() => registry.getRequestOverride(root, route, 'tian_shu', config)).toThrow('健康状态持久提交仍未完成')
      commits[1]!.resolve()
      await registry.WaitHealthReady(root.id)
    } finally { vi.useRealTimers() }
  })
})

describe('long-running preferred route recovery', () => {
  const primary = { provider: 'preferred', model: 'primary' }
  const backup = { provider: 'backup', model: 'fallback', reasoningEffort: 'high' }
  const cfg = getSwarmConfig({ agents: { rootRecoverMs: 1 }, routes: { tian_shu: { chain: [primary, backup] } } })

  it('automatic SDK header drift never becomes a persistent user override; an eligible preferred route recovers at a new step', async () => {
    let clock = 0
    const events: PreferredRecoveryEventInfo[] = []
    const probe = vi.fn(async () => ({ ok: true as const, vision: false }))
    const registry = intRouteStateRegistry(undefined, probe, { now: () => clock, onPreferredRecovery: (event) => events.push(event) })
    registry.AddChild(child.id, { chain: [primary, backup], role: 'tan_wei', persistent: true, logicalRequestId: 'D-long' })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, primary, undefined, cfg)
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(primary)
    expect(await registry.recover({ agent: child, provider: primary.provider, failure: { code: 'QUOTA', resetAt: new Date(1000).toISOString() } }, vi.fn(), undefined, cfg)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(backup)
    registry.MarkRequestSucceeded(child.id)
    clock = 6000
    registry.BeginRequestStep(child.id, 0, 1)
    // The real Host seeds the following tool step from the last fallback header.
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(primary)
    expect(registry.getChildOverride(child.id)).toBeUndefined()
    expect(probe.mock.calls).toEqual([[backup], [primary]])
    expect(events).toMatchObject([{ from: backup, to: primary, confirmed: false }])
    expect(registry.getHealth()[0]?.halfOpenAgent).toBe(child.id)
    registry.MarkRequestSucceeded(child.id)
    expect(registry.getHealth()).toEqual([])
    expect(events.at(-1)).toMatchObject({ to: primary, confirmed: true, logicalRequestId: 'D-long:0:1' })
  })

  it('same logical retries cannot rewind to the preferred route and a failed probe backs off across new steps', async () => {
    let clock = 0
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: false }), { now: () => clock, sleep: async () => undefined })
    registry.AddChild(child.id, { chain: [primary, backup], role: 'tan_wei', persistent: true, logicalRequestId: 'D-no-flap' })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, primary, undefined, cfg)
    registry.getRequestOverride(child, primary, undefined, cfg, true)
    await registry.recover({ agent: child, provider: primary.provider, failure: { status: 400 } }, vi.fn(), undefined, cfg)
    clock = 10000
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(backup)
    registry.MarkRequestSucceeded(child.id)
    registry.BeginRequestStep(child.id, 0, 1)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(primary)
    await registry.recover({ agent: child, provider: primary.provider, failure: { status: 400 } }, vi.fn(), undefined, cfg)
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(backup)
    registry.MarkRequestSucceeded(child.id)
    clock += 1000
    registry.BeginRequestStep(child.id, 0, 2)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(backup)
    expect(registry.getRecovery(child.id)?.attemptedRoutes).toEqual(['backup/fallback'])
  })

  it('only an explicit selection event pins the fallback, including selection of the same current model', async () => {
    let clock = 0
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: false }), { now: () => clock })
    registry.AddChild(child.id, { chain: [primary, backup], role: 'tan_wei', persistent: true, initialRoute: backup })
    registry.BeginRequestStep(child.id, 0, 0)
    registry.getRequestOverride(child, primary, undefined, cfg, true)
    registry.RecordUserSelection(child.id, backup, 10)
    registry.RecordUserSelection(child.id, primary, 9) // stale replay cannot replace the human choice.
    registry.MarkRequestSucceeded(child.id)
    clock = 1000000
    registry.BeginRequestStep(child.id, 0, 1)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(backup)
    expect(registry.getChildOverride(child.id)).toEqual(backup)
  })

  it('fresh capability checks preserve vision requirements and unavailable metadata is retried only at later safe boundaries', async () => {
    let clock = 10000
    let vision = false
    const probe = vi.fn(async () => ({ ok: true as const, vision }))
    const registry = intRouteStateRegistry(undefined, probe, { now: () => clock })
    registry.AddChild(child.id, { chain: [primary, backup], initialRoute: backup, role: 'guan_xiang', persistent: true, requireVision: true })
    registry.BeginRequestStep(child.id, 0, 0)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(backup)
    registry.MarkRequestSucceeded(child.id)
    vision = true
    registry.BeginRequestStep(child.id, 0, 1)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(backup)
    expect(probe).toHaveBeenCalledTimes(1)
    registry.MarkRequestSucceeded(child.id)
    clock += 5000
    registry.BeginRequestStep(child.id, 0, 2)
    await registry.PreparePreferredRecovery(child, backup, undefined, cfg)
    expect(registry.getRequestOverride(child, backup, undefined, cfg, true)).toMatchObject(primary)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('full candidate chains never blindly dispatch an unconfigured or text-only fallback', async () => {
    const missing = { provider: 'missing', model: 'not-configured' }
    const textOnly = { provider: 'text', model: 'text-only' }
    const probe = vi.fn(async (route: RouteInfo) => route.provider === missing.provider ? { ok: false as const, reason: 'provider-not-configured' } : { ok: true as const, vision: route.provider === backup.provider })
    const registry = intRouteStateRegistry(undefined, probe)
    registry.AddChild(child.id, { chain: [primary, missing, textOnly, backup], role: 'guan_xiang', requireVision: true })
    registry.getRequestOverride(child, primary, undefined, cfg, true)
    expect(await registry.recover({ agent: child, provider: primary.provider, failure: { status: 400 } }, vi.fn(), undefined, cfg)).toEqual({ kind: 'retry' })
    expect(probe.mock.calls).toEqual([[missing], [textOnly], [backup]])
    expect(registry.getRequestOverride(child, primary, undefined, cfg, true)).toMatchObject(backup)
    expect(registry.getRecovery(child.id)?.attemptedRoutes).toEqual(['preferred/primary', 'backup/fallback'])
  })

  it('an upgrade preserves unavailable preferred candidates, starts at the preflight choice and later restores the user picker', async () => {
    let clock = 0
    let configured = false
    const upgraded = { provider: 'strong', model: 'expert' }
    const probe = vi.fn(async (route: RouteInfo) => route.model === upgraded.model && !configured ? { ok: false as const, reason: 'provider-unavailable' } : { ok: true as const, vision: false })
    const registry = intRouteStateRegistry(undefined, probe, { now: () => clock })
    registry.RestoreRootPreference(root.id, primary)
    registry.SetRootUpgrade(root.id, [upgraded, backup], backup)
    registry.BeginRequestStep(root.id, 0, 0)
    await registry.PreparePreferredRecovery(root, backup, 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', cfg, true)).toMatchObject(backup)
    expect(registry.getRootUpgrade(root.id)).toEqual([upgraded, backup])
    registry.MarkRequestSucceeded(root.id)
    configured = true; clock = 6000
    registry.BeginRequestStep(root.id, 0, 1)
    await registry.PreparePreferredRecovery(root, backup, 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', cfg, true)).toMatchObject(upgraded)
    registry.MarkRequestSucceeded(root.id)
    registry.SetRootUpgrade(root.id, undefined)
    registry.BeginRequestStep(root.id, 0, 2)
    expect(registry.getRequestOverride(root, upgraded, 'tian_shu', cfg, true)).toMatchObject(primary)
    registry.RestoreRootPreference(root.id, backup)
    expect(registry.getRootPreference(root.id)).toEqual(primary)
  })

  it('ending an upgrade clears its automatic fallback even outside the old upgrade chain; explicit user choices survive', async () => {
    const upgraded = { provider: 'strong', model: 'expert' }
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: false }))
    registry.RestoreRootPreference(root.id, primary)
    registry.SetRootUpgrade(root.id, [upgraded])
    registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)
    await registry.recover({ agent: root, provider: upgraded.provider, failure: { code: 'QUOTA' } }, vi.fn(), 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, upgraded, 'tian_shu', cfg, true)).toMatchObject(primary)
    await registry.recover({ agent: root, provider: primary.provider, failure: { status: 400 } }, vi.fn(), 'tian_shu', cfg)
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(backup)
    registry.SetRootUpgrade(root.id, undefined)
    registry.BeginRequestStep(root.id, 0, 1)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', cfg, true)).toMatchObject(primary)
    registry.RecordUserSelection(root.id, backup, 20)
    expect(registry.getRootUpgrade(root.id)).toBeUndefined()
    registry.SetRootUpgrade(root.id, undefined)
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(backup)
  })

  it('root recovery honors the configured interval and zero disables automatic restoration even during an upgrade', async () => {
    for (const upgraded of [false, true]) for (const recoverMs of [180000, 0]) {
      let clock = 0
      const selected = getSwarmConfig({ agents: { rootRecoverMs: recoverMs }, routes: { tian_shu: { chain: [primary, backup] } } })
      const probe = vi.fn(async () => ({ ok: true as const, vision: false }))
      const registry = intRouteStateRegistry(undefined, probe, { now: () => clock })
      registry.RestoreRootPreference(root.id, primary)
      if (upgraded) registry.SetRootUpgrade(root.id, [primary, backup], primary)
      registry.BeginRequestStep(root.id, 0, 0)
      registry.getRequestOverride(root, primary, 'tian_shu', selected, true)
      await registry.recover({ agent: root, provider: primary.provider, failure: { status: 400 } }, vi.fn(), 'tian_shu', selected)
      registry.getRequestOverride(root, primary, 'tian_shu', selected, true)
      registry.MarkRequestSucceeded(root.id)
      clock = 6000
      registry.BeginRequestStep(root.id, 0, 1)
      await registry.PreparePreferredRecovery(root, backup, 'tian_shu', selected)
      expect(registry.getRequestOverride(root, backup, 'tian_shu', selected, true)).toMatchObject(backup)
      registry.MarkRequestSucceeded(root.id)
      clock = 180000
      registry.BeginRequestStep(root.id, 0, 2)
      await registry.PreparePreferredRecovery(root, backup, 'tian_shu', selected)
      expect(registry.getRequestOverride(root, backup, 'tian_shu', selected, true)).toMatchObject(recoverMs === 0 ? backup : primary)
    }
  })

  it('legacy hosts also distinguish the last actual fallback header from a new user choice', async () => {
    const registry = intRouteStateRegistry()
    registry.AddChild(child.id, { chain: [primary, backup], role: 'tan_wei', persistent: true })
    registry.getRequestOverride(child, primary, undefined, cfg)
    await registry.recover({ agent: child, provider: primary.provider, failure: { status: 400 } }, vi.fn(), undefined, cfg)
    registry.getRequestOverride(child, primary, undefined, cfg)
    registry.MarkRequestStarted(child.id, 'actual-with-default', { ...backup, reasoningEffort: 'high' })
    registry.MarkRequestSucceeded(child.id)
    expect(registry.getRequestOverride(child, { provider: backup.provider, model: backup.model }, undefined, cfg)).toMatchObject(backup)
    expect(registry.getChildOverride(child.id)).toBeUndefined()
  })

  it('a root timer expiring inside the same logical retry never replays the failed preferred route', async () => {
    let clock = 0
    const registry = intRouteStateRegistry(undefined, undefined, { now: () => clock })
    registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)
    await registry.recover({ agent: root, provider: primary.provider, failure: { status: 400 } }, vi.fn(), 'tian_shu', cfg)
    clock = 10000
    expect(registry.getRequestOverride(root, primary, 'tian_shu', cfg, true)).toMatchObject(backup)
    registry.BeginLogicalRequest(root.id, 'safe-new-request')
    expect(registry.getRequestOverride(root, backup, 'tian_shu', cfg, true)).toMatchObject(primary)
  })

  it('root restoration rebinds the selected provider quota domain, never the SDK fallback header domain', async () => {
    const preferred = { ...primary, policy: { quotaDomainId: 'preferred-account', quotaScope: 'account' as const } }
    const fallback = { ...backup, policy: { quotaDomainId: 'fallback-account', quotaScope: 'account' as const } }
    const selected = getSwarmConfig({ routes: { tian_shu: { chain: [preferred, fallback] } } })
    const registry = intRouteStateRegistry()
    registry.RestoreRootPreference(root.id, primary)
    expect(registry.getRequestOverride(root, backup, 'tian_shu', selected, true)).toMatchObject(primary)
    await registry.recover({ agent: root, provider: primary.provider, failure: { code: 'QUOTA' } }, vi.fn(), 'tian_shu', selected)
    expect(registry.getHealth().map((entry) => entry.key)).toEqual(['domain:preferred-account'])
    expect(registry.isRouteAvailable(fallback)).toBe(true)
  })

  it('idempotent upgrade refresh preserves the active fallback and root recovery clock; removed routes alone require reselection', async () => {
    for (const interval of [0, 180000]) {
      let clock = 0
      const selected = getSwarmConfig({ agents: { rootRecoverMs: interval }, routes: { tian_shu: { chain: [primary, backup] } } })
      const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: false }), { now: () => clock })
      registry.RestoreRootPreference(root.id, primary)
      registry.SetRootUpgrade(root.id, [primary, backup], primary)
      registry.BeginRequestStep(root.id, 0, 0)
      registry.getRequestOverride(root, primary, 'tian_shu', selected, true)
      await registry.recover({ agent: root, provider: primary.provider, failure: { status: 400 } }, vi.fn(), 'tian_shu', selected)
      registry.getRequestOverride(root, primary, 'tian_shu', selected, true)
      registry.MarkRequestSucceeded(root.id)
      clock = 6000
      registry.SetRootUpgrade(root.id, [{ ...primary }, { ...backup }], primary)
      registry.BeginRequestStep(root.id, 0, 1)
      await registry.PreparePreferredRecovery(root, backup, 'tian_shu', selected)
      expect(registry.getRequestOverride(root, backup, 'tian_shu', selected, true)).toMatchObject(backup)
      registry.MarkRequestSucceeded(root.id)
      // A changed declaration still containing the actual current route cannot
      // reset its original recovery clock or silently choose another model.
      const added = { provider: 'added', model: 'higher' }
      registry.SetRootUpgrade(root.id, [added, primary, backup], added)
      clock = 180000
      registry.BeginRequestStep(root.id, 0, 2)
      await registry.PreparePreferredRecovery(root, backup, 'tian_shu', selected)
      expect(registry.getRequestOverride(root, backup, 'tian_shu', selected, true)).toMatchObject(interval === 0 ? backup : added)
      registry.MarkRequestSucceeded(root.id)
      const only = { provider: 'remaining', model: 'only-compatible' }
      registry.SetRootUpgrade(root.id, [only], only)
      registry.BeginRequestStep(root.id, 0, 3)
      expect(registry.getRequestOverride(root, backup, 'tian_shu', selected, true)).toMatchObject(only)
    }
  })
})

describe('manual child routing and bounded context recovery', () => {
  it('manual public selections retain trusted declared quota domains and cannot bypass shared quarantine', () => {
    const domain = { accessMode: 'subscription' as const, quotaDomainId: 'trusted-account', quotaScope: 'account' as const }
    const first = { provider: 'codex', model: 'first', policy: domain }
    const alias = { provider: 'codex', model: 'alias', policy: domain }
    const independent = { provider: 'qwen-token-plan-cn', model: 'backup' }
    const registry = intRouteStateRegistry(undefined, undefined, { now: () => 1000 })
    registry.AddChild(child.id, { chain: [first, alias, independent], role: 'tan_wei', persistent: true })
    registry.getRequestOverride(child, first, undefined)
    registry.getErrorAction({ agent: child, provider: 'codex', failure: { kind: 'quota_exhausted', quotaDomainId: 'trusted-account', quotaScope: 'account' } }, undefined, undefined, config)
    registry.BeginLogicalRequest(child.id, 'new-logical')
    registry.SetChildOverride(child.id, { provider: 'codex', model: 'alias', reasoningEffort: 'max' })
    expect(registry.getRequestOverride(child, first, undefined)).toMatchObject(independent)
    registry.BeginLogicalRequest(child.id, 'manual-probe')
    expect(registry.RequestRouteRetry({ provider: 'codex', model: 'alias' }, child.id, { force: true })).toMatchObject({ ok: true, keys: ['domain:trusted-account'] })
    expect(registry.getHealth()[0]?.halfOpenAgent).toBeUndefined()
    expect(registry.isRouteAvailableFor(alias, child.id)).toBe(true)
    expect(registry.isRouteAvailableFor(alias, 'different-child')).toBe(false)
    // Cancellation/idle releases an actual trial, while the explicit next-request
    // intent remains queued until this same persistent child really dispatches it.
    registry.ReleaseAgent(child.id)
    expect(registry.getHealth()[0]?.halfOpenAgent).toBeUndefined()
    registry.SetChildOverride(child.id, { provider: 'codex', model: 'alias', reasoningEffort: 'max' })
    expect(registry.getRequestOverride(child, first, undefined)).toMatchObject({ provider: 'codex', model: 'alias', reasoningEffort: 'max' })
  })
  it('persistent overrides survive new logical rounds; real host-resolved changes including effort take priority', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild(child.id, { chain, role: 'tan_wei', persistent: true, logicalRequestId: 'D-1' })
    registry.getRequestOverride(child, chain[0]!, undefined)
    const chosen = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'max' }
    registry.SetChildOverride(child.id, chosen)
    expect(registry.getRequestOverride(child, chain[0]!, undefined)).toEqual(chosen)
    registry.ReleaseAgent(child.id)
    registry.AddChild(child.id, { chain, role: 'tan_wei', persistent: true, logicalRequestId: 'D-2' })
    expect(registry.getRequestOverride(child, chain[0]!, undefined)).toEqual(chosen)
    const nativeChoice = { ...chain[0]!, reasoningEffort: 'high' }
    expect(registry.getRequestOverride(child, nativeChoice, undefined)).toEqual(nativeChoice)
    expect(registry.getChildOverride(child.id)).toEqual(nativeChoice)
    registry.SetManualPause(child.id, true)
    expect(() => registry.getRequestOverride(child, nativeChoice, undefined)).toThrow('人工暂停')
    expect(registry.getErrorAction({ agent: child, provider: nativeChoice.provider, failure: { code: 'SERVER_ERROR' } }, undefined, undefined, config)).toBeUndefined()
  })

  it('context overflow calls the real compaction seam once; only measured surface replacement authorizes a retry', async () => {
    const registry = intRouteStateRegistry()
    const agent = { id: 'context-child', session: { header: { parentSession: 'root' }, surface: { replaceGeneration: 4 } } }
    registry.AddChild(agent.id, { chain, role: 'tan_wei', persistent: true, logicalRequestId: 'context-request' })
    registry.getRequestOverride(agent, chain[0]!, undefined)
    const next = vi.fn(async () => ({ kind: 'retry' }))
    const compactIfNeeded = vi.fn(async () => { agent.session.surface.replaceGeneration += 1; return { summarySeq: 100 } })
    const payload = { agent, provider: 'a', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context limit exceeded' }, signal: new AbortController().signal }
    expect(await registry.recover(payload, next, undefined, config, { compactIfNeeded })).toEqual({ kind: 'retry' })
    expect(compactIfNeeded).toHaveBeenCalledWith(agent, 'context-overflow', payload.signal)
    expect(next).not.toHaveBeenCalled()
    registry.getRequestOverride(agent, chain[0]!, undefined)
    expect(await registry.recover(payload, next, undefined, config, { compactIfNeeded })).toBeUndefined()
    expect(compactIfNeeded).toHaveBeenCalledTimes(1)
    expect(registry.getTerminal(agent.id)).toBe('context_recovery_required')
    expect(registry.getHealth()).toEqual([])
    expect(registry.getRecovery(agent.id)?.attemptedRoutes).toEqual(['a/m1', 'a/m1'])
  })

  it('a compact callback returning success without actual shrink cannot retry or poison the route', async () => {
    const registry = intRouteStateRegistry()
    const agent = { id: 'context-no-shrink', session: { header: { parentSession: 'root' }, surface: { replaceGeneration: 4 } } }
    registry.AddChild(agent.id, { chain, role: 'tan_wei' })
    const next = vi.fn(async () => ({ kind: 'retry' }))
    expect(await registry.recover({ agent, provider: 'a', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: new AbortController().signal }, next, undefined, config, { compactIfNeeded: async () => ({ summarySeq: 1 }) })).toBeUndefined()
    expect(registry.getTerminal(agent.id)).toBe('context_recovery_required')
    expect(registry.getHealth()).toEqual([])
    expect(next).not.toHaveBeenCalled()
  })
})

describe('子智能体路由', () => {
  it('请求时套用当前路由并去掉继承的推理强度', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he' })
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y', reasoningEffort: 'max', maxTokens: 10 }, undefined))
      .toEqual({ provider: 'a', model: 'm1', maxTokens: 10 })
    expect(registry.getChildRole('c1')).toBe('fu_he')
  })

  it('致命失败切到下一条并回调；链尽后交回宿主动作', () => {
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he', onFallback: (event) => events.push(event) })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)
    const action = registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)
    expect(action).toEqual({ kind: 'retry' })
    expect(events[0]).toMatchObject({ scope: 'child', from: { model: 'm1' }, to: { model: 'm2' } })
    expect(registry.getRequestOverride(child, { provider: 'a', model: 'm1' }, undefined)).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'high' })
    expect(registry.getErrorAction({ agent: child, provider: 'b', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    registry.getRequestOverride(child, { provider: 'b', model: 'm2' }, undefined)
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toBeUndefined()
    expect(registry.getChild('c1')).toMatchObject({ route: { model: 'm3' }, role: 'fu_he', switches: 3 })
  })

  it('认证失败跳过未知账号同 provider；瞬时失败由有界策略管理', async () => {
    const registry = intRouteStateRegistry(undefined, undefined, { sleep: async () => undefined })
    registry.AddChild('c1', { chain: [chain[0], chain[2], chain[1]], role: 'fu_he' })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)
    const hostRetry = { kind: 'retry' }
    await expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'RATE_LIMIT', status: 429 } }, hostRetry, undefined, config)).resolves.toEqual(hostRetry)
    expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { status: 401 } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild('c1')?.route).toEqual({ provider: 'b', model: 'm2', reasoningEffort: 'high' })
  })

  it('DelAgent 清理状态', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain, role: 'fu_he' })
    registry.DelAgent('c1')
    expect(registry.getChild('c1')).toBeUndefined()
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)).toEqual({ provider: 'x', model: 'y' })
  })
})

describe('根会话回退', () => {
  it('选择器路由致命失败时按角色链回退，跳过已失败路由', () => {
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry((event) => events.push(event))
    const first = DEFAULT_ROUTE_CHAINS.tian_shu[0]
    registry.getRequestOverride(root, { provider: first.provider, model: first.model }, 'tian_shu')
    expect(registry.getErrorAction({ agent: root, provider: first.provider, failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(events[0]?.to).toEqual(DEFAULT_ROUTE_CHAINS.tian_shu[1])
    expect(registry.getRequestOverride(root, { provider: first.provider, model: first.model }, 'tian_shu'))
      .toMatchObject({ provider: DEFAULT_ROUTE_CHAINS.tian_shu[1].provider, model: DEFAULT_ROUTE_CHAINS.tian_shu[1].model })
  })

  it('回退后用户在选择器里换了模型：清除覆盖与已试记录，尊重新选择', () => {
    const registry = intRouteStateRegistry()
    const picked = { provider: 'p', model: 'picked' }
    registry.getRequestOverride(root, picked, 'tian_shu')
    registry.getErrorAction({ agent: root, provider: 'p', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)
    expect(registry.getRequestOverride(root, picked, 'tian_shu').model).toBe(DEFAULT_ROUTE_CHAINS.tian_shu[0].model)
    const changed = { provider: 'q', model: 'new-choice' }
    expect(registry.getRequestOverride(root, changed, 'tian_shu')).toEqual(changed)
    expect(registry.getErrorAction({ agent: root, provider: 'q', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, changed, 'tian_shu').model).toBe(DEFAULT_ROUTE_CHAINS.tian_shu[0].model)
  })

  it('有预检时跳过不可解析的路由，全部不可用则终止而非保留宿主动作', async () => {
    const custom = getSwarmConfig({ routes: { tian_shu: { chain: [{ provider: 'q', model: 'gone' }, { provider: 'g', model: 'ok' }, { provider: 'd', model: 'also-gone' }] } } })
    const probed: string[] = []
    const probe = async (route: { provider: string; model: string }) => {
      probed.push(`${route.provider}/${route.model}`)
      return route.model === 'ok' ? { ok: true as const, vision: false } : { ok: false as const, reason: 'model-unavailable' }
    }
    const events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry((event) => events.push(event), probe)
    registry.getRequestOverride(root, { provider: 'codex', model: 'picked' }, 'tian_shu')
    await expect(registry.getErrorAction({ agent: root, provider: 'codex', failure: { status: 400 } }, undefined, 'tian_shu', custom)).resolves.toEqual({ kind: 'retry' })
    expect(probed).toEqual(['q/gone', 'g/ok'])
    expect(events.map((event) => event.to)).toEqual([{ provider: 'g', model: 'ok' }])
    expect(registry.getRequestOverride(root, { provider: 'codex', model: 'picked' }, 'tian_shu')).toMatchObject({ provider: 'g', model: 'ok' })
    // 接替路由也失败：剩下的 d/also-gone 不可解析，交还宿主给出的动作
    const hostAction = { kind: 'fail' } as never
    await expect(registry.getErrorAction({ agent: root, provider: 'g', failure: { code: 'QUOTA' } }, hostAction, 'tian_shu', custom)).resolves.toBeUndefined()
    expect(registry.getTerminal(root.id)).toBe('route_chain_exhausted')
    expect(probed).toEqual(['q/gone', 'g/ok', 'd/also-gone'])
  })

  it('容灾升级：根会话改走升级链；升级模型失败先在升级链内回退；用户换模型则撤销升级', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true, vision: false }))
    const picked = { provider: 'codex', model: 'gpt-6-sol' }
    const astra = { provider: 'codex', model: 'gpt-6-astra' }
    const opus = { provider: 'claude', model: 'claude-opus-5-5' }
    registry.SetRootUpgrade(root.id, [astra, opus])
    expect(registry.getRootUpgrade(root.id)).toEqual([astra, opus])
    expect(registry.getRequestOverride(root, picked, 'tian_shu')).toMatchObject(astra)
    await expect(registry.getErrorAction({ agent: root, provider: 'codex', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)).resolves.toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, picked, 'tian_shu')).toMatchObject(opus)
    // 撤销：指向升级链的回退覆盖一并作废，回到对话框所选模型
    registry.SetRootUpgrade(root.id, undefined)
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config)).toEqual(picked)
    // 再次升级后用户换了模型：以用户选择为准
    registry.SetRootUpgrade(root.id, [astra])
    // 重建升级链不清除刚才失败 astra 的额度隔离。
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config)).not.toMatchObject(astra)
    const changed = { provider: 'qwen-token-plan-cn', model: 'qwen3.8-max' }
    expect(registry.getRequestOverride(root, changed, 'tian_shu')).toEqual(changed)
    expect(registry.getRootUpgrade(root.id)).toBeUndefined()
  })

  it('关闭 rootFallback、非 swarm 预设、未跟踪的子会话都不干预', () => {
    const registry = intRouteStateRegistry()
    const off = getSwarmConfig({ rootFallback: false })
    const failure = { agent: root, provider: 'x', failure: { code: 'QUOTA' } }
    expect(registry.getErrorAction(failure, undefined, 'tian_shu', off)).toBeUndefined()
    expect(registry.getErrorAction(failure, undefined, undefined, config)).toBeUndefined()
    expect(registry.getErrorAction({ ...failure, agent: { id: 'fork', session: { header: { parentSession: 'root' } } } }, undefined, 'tian_shu', config)).toBeUndefined()
  })
})

describe('故障恢复', () => {
  const makeNetwork = (online: boolean[], recovered = true) => {
    const calls = { isOnline: 0, waitOnline: 0 }
    return {
      calls,
      network: {
        isOnline: async () => { calls.isOnline += 1; return online.shift() ?? true },
        waitOnline: async () => { calls.waitOnline += 1; return recovered }
      }
    }
  }

  it('额度隔离不会被十分钟根恢复或重新登记清除；显式清除后才能恢复', () => {
    let at = 0
    const registry = intRouteStateRegistry(undefined, undefined, { now: () => at })
    const picked = { provider: 'codex', model: 'gpt-6-sol' }
    registry.getRequestOverride(root, picked, 'tian_shu', config)
    registry.getErrorAction({ agent: root, provider: 'codex', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', config)
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config).model).not.toBe('gpt-6-sol')
    at = config.agents.rootRecoverMs - 1
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config).model).not.toBe('gpt-6-sol')
    at = config.agents.rootRecoverMs
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config).model).not.toBe('gpt-6-sol')
    registry.clearHealth()
    registry.BeginLogicalRequest(root.id, 'explicit-retry')
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config)).toEqual(picked)
    const sticky = getSwarmConfig({ agents: { rootRecoverMs: 0 } })
    registry.getErrorAction({ agent: root, provider: 'codex', failure: { code: 'QUOTA' } }, undefined, 'tian_shu', sticky)
    at += 10 * 60 * 60_000
    expect(registry.getRequestOverride(root, picked, 'tian_shu', sticky).model).not.toBe('gpt-6-sol')
  })

  it('断网：等待网络恢复后在原路由重试，不消耗路由链；联网时按常规回退', async () => {
    const waits: Array<{ recovered?: boolean }> = []
    const offline = makeNetwork([false])
    const registry = intRouteStateRegistry(undefined, undefined, { network: offline.network, onNetworkWait: (event) => waits.push(event) })
    const picked = { provider: 'deepseek-official', model: 'deepseek-flash' }
    registry.getRequestOverride(root, picked, 'tian_shu', config)
    const failure = { code: 'TRANSPORT', message: 'DeepSeek Messages transport failed' }
    await expect(registry.getErrorAction({ agent: root, provider: 'deepseek-official', failure }, undefined, 'tian_shu', config)).resolves.toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config)).toEqual(picked)
    expect(waits.map((event) => event.recovered)).toEqual([undefined, true])
    const online = makeNetwork([true])
    const other = intRouteStateRegistry(undefined, undefined, { network: online.network })
    other.getRequestOverride(root, picked, 'tian_shu', config)
    await expect(other.getErrorAction({ agent: root, provider: 'deepseek-official', failure }, undefined, 'tian_shu', config)).resolves.toEqual({ kind: 'retry' })
    expect(online.calls.waitOnline).toBe(0)
    expect(other.getRequestOverride(root, picked, 'tian_shu', config).model).not.toBe('deepseek-flash')
  })

  it('NO_ADAPTER仅说No eligible account不冒充断网；明确transport失败才走网络恢复', async () => {
    const offline = makeNetwork([false])
    const registry = intRouteStateRegistry(undefined, undefined, { network: offline.network })
    const picked = { provider: 'codex', model: 'gpt-6-sol' }
    registry.getRequestOverride(root, picked, 'tian_shu', config)
    expect(await registry.recover({ agent: root, provider: 'codex', failure: { code: 'NO_ADAPTER', message: 'No eligible account for codex/gpt-6-sol' } }, vi.fn(), 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(offline.calls.waitOnline).toBe(0)
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config)).not.toEqual(picked)
    const transport = makeNetwork([false])
    const networkFailure = intRouteStateRegistry(undefined, undefined, { network: transport.network })
    networkFailure.getRequestOverride(root, picked, 'tian_shu', config)
    expect(await networkFailure.recover({ agent: root, provider: 'codex', failure: { code: 'NO_ADAPTER', message: 'No eligible account: token refresh transport failed' } }, vi.fn(), 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(transport.calls.waitOnline).toBe(1)
    expect(networkFailure.getRequestOverride(root, picked, 'tian_shu', config)).toEqual(picked)
  })

  it('断网等待超时按常规回退；额度类失败不探测网络；networkWaitMs=0 关闭等待', async () => {
    const stuck = makeNetwork([false], false)
    const registry = intRouteStateRegistry(undefined, undefined, { network: stuck.network })
    registry.AddChild('c1', { chain, role: 'fu_he' })
    registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined, config)
    await expect(registry.getErrorAction({ agent: child, provider: 'a', failure: { code: 'TIMEOUT' } }, undefined, undefined, config)).resolves.toEqual({ kind: 'retry' })
    expect(registry.getChild('c1')?.route?.model).toBe('m2')
    const quota = makeNetwork([false])
    const plain = intRouteStateRegistry(undefined, undefined, { network: quota.network })
    plain.AddChild('c1', { chain, role: 'fu_he' })
    expect(plain.getErrorAction({ agent: child, provider: 'a', failure: { code: 'QUOTA' } }, undefined, undefined, config)).toEqual({ kind: 'retry' })
    expect(quota.calls.isOnline).toBe(0)
    const off = getSwarmConfig({ agents: { networkWaitMs: 0 } })
    await expect(plain.getErrorAction({ agent: child, provider: 'b', failure: { code: 'TIMEOUT' } }, undefined, undefined, off)).resolves.toEqual({ kind: 'retry' })
    expect(quota.calls.isOnline).toBe(0)
  })

  it('同一会话 30 分钟内最多等待 3 次网络，取消时交回宿主', async () => {
    const registry = intRouteStateRegistry(undefined, undefined, { network: makeNetwork([false, false, false, false]).network })
    registry.getRequestOverride(root, { provider: 'p', model: 'm' }, 'tian_shu', config)
    const failure = { code: 'NETWORK' }
    for (let index = 0; index < 3; index++) {
      await expect(registry.getErrorAction({ agent: root, provider: 'p', failure }, undefined, 'tian_shu', config)).resolves.toEqual({ kind: 'retry' })
    }
    // 第 4 次不再等待，直接回退到角色链
    await registry.getErrorAction({ agent: root, provider: 'p', failure }, undefined, 'tian_shu', config)
    expect(registry.getRequestOverride(root, { provider: 'p', model: 'm' }, 'tian_shu', config).model).toBe(DEFAULT_ROUTE_CHAINS.tian_shu[0].model)
    const controller = new AbortController()
    controller.abort()
    const aborted = intRouteStateRegistry(undefined, undefined, { network: makeNetwork([false], false).network })
    aborted.getRequestOverride(root, { provider: 'p', model: 'm' }, 'tian_shu', config)
    expect(await aborted.getErrorAction({ agent: root, provider: 'p', failure, signal: controller.signal }, undefined, 'tian_shu', config)).toBeUndefined()
  })

  it('发往 Codex 的 ultra 推理强度映射为 max', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild('c1', { chain: [{ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' }], role: 'suan_heng' })
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'y' }, undefined)).toEqual({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' })
    registry.AddChild('c2', { chain: [{ provider: 'other', model: 'm', reasoningEffort: 'ultra' }], role: 'suan_heng' })
    expect(registry.getRequestOverride({ id: 'c2' }, { provider: 'x', model: 'y' }, undefined)).toEqual({ provider: 'other', model: 'm', reasoningEffort: 'ultra' })
  })
})

describe('共享故障域与有界恢复', () => {
  const accountA: RouteInfo = { provider: 'subscription', model: 'a', policy: { quotaDomainId: 'account-a', quotaScope: 'account' } }
  const sameAccount: RouteInfo = { provider: 'subscription', model: 'b', policy: { quotaDomainId: 'account-a', quotaScope: 'account' } }
  const independent: RouteInfo = { provider: 'subscription', model: 'c', policy: { quotaDomainId: 'account-b', quotaScope: 'account' } }

  it('标准Qwen provider无custom failure字段也跨模型/根/线程共享plan；Go额度仅隔离原model', async () => {
    const registry = intRouteStateRegistry()
    const qwen = { provider: 'qwen-token-plan-cn', model: 'glm-5.3' }
    const other = { provider: 'qwen-token-plan-cn', model: 'qwen3.8-flash' }
    const go = { provider: 'opencode-go', model: 'glm-5.3' }
    registry.AddChild(child.id, { chain: [qwen, other, go], role: 'fu_he' })
    registry.getRequestOverride(child, qwen, undefined)
    await registry.recover({ agent: child, provider: qwen.provider, failure: { code: 'QUOTA' } }, vi.fn(), undefined, config)
    expect(registry.getChild(child.id)?.route).toEqual(go)
    expect(registry.isRouteAvailable(other)).toBe(false)
    registry.AddChild('fresh-root-expert', { chain: [other, go], role: 'tan_wei' })
    expect(registry.getRequestOverride({ id: 'fresh-root-expert' }, other, undefined)).toMatchObject(go)
    await registry.recover({ agent: { id: 'fresh-root-expert' }, provider: go.provider, failure: { code: 'QUOTA' } }, vi.fn(), undefined, config)
    expect(registry.isRouteAvailable({ provider: go.provider, model: 'another-independent-budget' })).toBe(true)
  })

  it('Jev类judgment API和明示无生成能力不会作为主生成或备用', () => {
    const registry = intRouteStateRegistry()
    registry.AddChild(child.id, { chain: [
      { provider: 'jev', model: 'jev-latest', policy: { accessMode: 'judgment_api' } },
      { provider: 'nongenerative', model: 'choice', policy: { capabilities: { generation: false } } }, independent
    ], role: 'fu_he' })
    expect(registry.getRequestOverride(child, { provider: 'x', model: 'x' }, undefined)).toMatchObject({ provider: independent.provider, model: independent.model })
  })

  it('同账号不同模型跨root/thread共享隔离，独立账号仍可用，重登记不清额度', async () => {
    const registry = intRouteStateRegistry()
    registry.AddChild(child.id, { chain: [accountA, sameAccount, independent], role: 'fu_he' })
    registry.getRequestOverride(child, { ...accountA }, undefined)
    expect(await registry.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA' } }, vi.fn(), undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild(child.id)?.route).toEqual(independent)
    expect(registry.isRouteAvailable({ ...accountA, policy: { quotaDomainId: 'another-account', quotaScope: 'account' } })).toBe(true)
    registry.AddChild('second', { chain: [sameAccount, independent], role: 'yu_shi' })
    expect(registry.getRequestOverride({ id: 'second' }, { ...sameAccount }, undefined)).toMatchObject({ provider: independent.provider, model: independent.model })
    registry.DelAgent(child.id)
    registry.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    expect(registry.getRequestOverride(child, { ...accountA }, undefined)).toMatchObject({ provider: independent.provider, model: independent.model })
  })

  it('pool错误及长Retry-After在next/网络/sleep前立即隔离并回退', async () => {
    const sleep = vi.fn(async () => undefined)
    const next = vi.fn(async () => ({ kind: 'retry' }))
    const network = { isOnline: vi.fn(async () => false), waitOnline: vi.fn(async () => false) }
    const registry = intRouteStateRegistry(undefined, undefined, { sleep, network })
    const pooled = { ...accountA, policy: { poolId: 'claude-opus-5-5' } }
    const alias = { provider: 'alias', model: 'opus', policy: { poolId: 'claude-opus-5-5' } }
    registry.AddChild(child.id, { chain: [pooled, alias, independent], role: 'fu_he' })
    registry.getRequestOverride(child, pooled, undefined)
    expect(await registry.recover({ agent: child, provider: pooled.provider, failure: { code: 'SERVER_ERROR', message: 'pool "claude-opus-5-5" exhausted: every member is unavailable or failed; transport failed', providerRetryAfterMs: 9060669 } }, next, undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild(child.id)?.route).toEqual(independent)
    expect(next).not.toHaveBeenCalled()
    expect(network.isOnline).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
    const slow = intRouteStateRegistry(undefined, undefined, { sleep })
    slow.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    slow.getRequestOverride(child, { ...accountA }, undefined)
    expect(await slow.recover({ agent: child, provider: accountA.provider, failure: { code: 'RATE_LIMIT', providerRetryAfterMs: 9060669 } }, next, undefined, config)).toEqual({ kind: 'retry' })
    expect(slow.getRecovery(child.id)?.suppressedRetryAfterMs).toBe(9060669)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('没有备用返回真实宿主undefined终态，即使next提供retry也不执行', async () => {
    const registry = intRouteStateRegistry()
    registry.AddChild(child.id, { chain: [accountA], role: 'fu_he' })
    registry.getRequestOverride(child, { ...accountA }, undefined)
    const next = vi.fn(async () => ({ kind: 'retry' }))
    expect(await registry.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA' } }, next, undefined, config)).toBeUndefined()
    expect(registry.getTerminal(child.id)).toBe('route_chain_exhausted')
    expect(next).not.toHaveBeenCalled()
    registry.DelAgent(child.id)
    expect(registry.getTerminal(child.id)).toBe('route_chain_exhausted')
  })

  it('瞬时失败仅短重试一次；逻辑8次上限不被同逻辑重登记清空', async () => {
    const sleep = vi.fn(async () => undefined)
    const registry = intRouteStateRegistry(undefined, undefined, { sleep })
    registry.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he', logicalRequestId: 'logical-1' })
    registry.BeginRequestStep(child.id, 1, 0)
    registry.getRequestOverride(child, { ...accountA }, undefined)
    expect(await registry.recover({ agent: child, provider: accountA.provider, failure: { status: 429, code: 'RATE_LIMIT' } }, vi.fn(), undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild(child.id)?.route).toEqual(accountA)
    expect(await registry.recover({ agent: child, provider: accountA.provider, failure: { status: 429, code: 'RATE_LIMIT' } }, vi.fn(), undefined, config)).toEqual({ kind: 'retry' })
    expect(registry.getChild(child.id)?.route).toEqual(independent)
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500, undefined)
    for (let index = 1; index < 8; index++) registry.getRequestOverride(child, { ...accountA }, undefined)
    registry.AddChild('restart', { chain: [independent], role: 'fu_he', logicalRequestId: 'logical-1' })
    registry.BeginRequestStep('restart', 1, 0)
    expect(() => registry.getRequestOverride({ id: 'restart' }, { ...independent }, undefined)).toThrow('recovery_attempts_exhausted')
    expect(registry.getTerminal('restart')).toBe('recovery_attempts_exhausted')
    expect(nativeRecoveryCoverage(false)).toEqual({ verified: false, reason: 'native-internal-retries-unobservable' })
    expect(nativeRecoveryCoverage(true).verified).toBe(false)
    expect(getNativeRecoverySupport(undefined)).toMatchObject({ contractVersion: 1, structuredFailure: false, verified: false })
    expect(getNativeRecoverySupport({ routeFailureMetadataV1: true, requestRecoveryControlV1: true, requestAttemptEventsV1: true }).verified).toBe(false)
  })

  it('真实reset到期仅允许一个half-open，解析模型和10分钟不清隔离，成功才清除', async () => {
    let at = 0
    const registry = intRouteStateRegistry(undefined, undefined, { now: () => at })
    registry.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    registry.getRequestOverride(child, { ...accountA }, undefined)
    await registry.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA', resetAt: new Date(3600000).toISOString() } }, vi.fn(), undefined, config)
    at = 600000
    expect(registry.isRouteAvailable(accountA)).toBe(false)
    at = 3600000
    registry.AddChild('half-a', { chain: [accountA, independent], role: 'fu_he' })
    registry.AddChild('half-b', { chain: [sameAccount, independent], role: 'fu_he' })
    expect(registry.getRequestOverride({ id: 'half-a' }, { ...accountA }, undefined)).toMatchObject({ provider: accountA.provider, model: accountA.model })
    expect(registry.getRequestOverride({ id: 'half-b' }, { ...sameAccount }, undefined)).toMatchObject({ provider: independent.provider, model: independent.model })
    registry.MarkRequestSucceeded('half-a')
    expect(registry.isRouteAvailable(sameAccount)).toBe(true)
    expect(registry.isRouteAvailable(accountA)).toBe(true)
  })

  it('half-open失败不会因为旧reset已过而不断重开；任务明示再试另有入口', async () => {
    let at = 0
    const registry = intRouteStateRegistry(undefined, undefined, { now: () => at, sleep: async () => undefined })
    registry.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    registry.getRequestOverride(child, { ...accountA }, undefined)
    await registry.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA', resetAt: new Date(1000).toISOString() } }, vi.fn(), undefined, config)
    at = 1000
    registry.AddChild('half', { chain: [accountA, independent], role: 'fu_he' })
    registry.getRequestOverride({ id: 'half' }, { ...accountA }, undefined)
    await registry.recover({ agent: { id: 'half' }, provider: accountA.provider, failure: { status: 503 } }, vi.fn(), undefined, config)
    expect(registry.isRouteAvailable(accountA)).toBe(false)
    registry.AddChild('half', { chain: [accountA, independent], role: 'fu_he' })
    expect(registry.getRequestOverride({ id: 'half' }, { ...accountA }, undefined)).toMatchObject({ provider: independent.provider, model: independent.model })
  })

  it('完整健康态恢复保留quota域与别名，不因根十分钟窗口清除，拒绝坏状态不部分写入', async () => {
    let at = 0
    const first = intRouteStateRegistry(undefined, undefined, { now: () => at })
    first.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    first.getRequestOverride(child, { ...accountA }, undefined)
    await first.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA' } }, vi.fn(), undefined, config)
    const snapshot = JSON.parse(JSON.stringify(first.getHealth()))
    at = 600001
    const recovered = intRouteStateRegistry(undefined, undefined, { now: () => at })
    recovered.RestoreHealth(snapshot)
    expect(recovered.isRouteAvailable(sameAccount)).toBe(false)
    const cfg = getSwarmConfig({ routes: { tian_shu: { chain: [accountA, sameAccount, independent] } } })
    expect(recovered.getRequestOverride(root, { ...accountA }, 'tian_shu', cfg)).toMatchObject({ provider: independent.provider, model: independent.model })
    at += 600001
    expect(recovered.getRequestOverride(root, { ...accountA }, 'tian_shu', cfg)).toMatchObject({ provider: independent.provider, model: independent.model })
    const before = recovered.getHealth()
    expect(() => recovered.RestoreHealth([...snapshot, { ...snapshot[0], key: 'domain:bad', kind: 'fake-kind' }])).toThrow('invalid-route-health')
    expect(recovered.getHealth()).toEqual(before)
    expect(() => recovered.RestoreHealth([{ ...snapshot[0], resetAt: Infinity }])).toThrow('invalid-route-health')
  })

  it('quota立即内存隔离，但持久提交完成前不返回恢复动作；无备用终态同样先提交', async () => {
    for (const backups of [[independent], []]) {
      let commit!: () => void
      const persisted = new Promise<void>((resolve) => { commit = resolve })
      const hook = vi.fn(() => persisted)
      const next = vi.fn(async () => ({ kind: 'retry' }))
      const registry = intRouteStateRegistry(undefined, undefined, { onHealthChange: hook })
      registry.AddChild(child.id, { chain: [accountA, ...backups], role: 'fu_he' })
      registry.getRequestOverride(child, { ...accountA }, undefined)
      let returned = false
      const action = registry.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA' } }, next, undefined, config).then((value) => { returned = true; return value })
      await Promise.resolve()
      expect(registry.isRouteAvailable(accountA)).toBe(false)
      expect(registry.getChild(child.id)?.route).toEqual(accountA)
      expect(returned).toBe(false)
      expect(hook.mock.calls[0]).toMatchObject([{ schemaVersion: 1, entries: expect.any(Array), cleared: expect.any(Array) }, { agentId: child.id, reason: 'failure' }])
      commit()
      expect(await action).toEqual(backups.length === 0 ? undefined : { kind: 'retry' })
      expect(next).not.toHaveBeenCalled()
    }
  })

  it('健康态持久化失败停止模型与外层重启，而不选择备用或调用宿主next', async () => {
    const registry = intRouteStateRegistry(undefined, undefined, { onHealthChange: async () => { throw new Error('disk-write-failed') } })
    registry.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    registry.getRequestOverride(child, { ...accountA }, undefined)
    const next = vi.fn(async () => ({ kind: 'retry' }))
    await expect(registry.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA' } }, next, undefined, config)).rejects.toThrow('disk-write-failed')
    expect(registry.getTerminal(child.id)).toBe('route_health_persist_failed')
    expect(registry.getChild(child.id)?.route).toEqual(accountA)
    expect(next).not.toHaveBeenCalled()
  })

  it('恢复不继承旧进程half-open所有者，当前进程单trial仍受互斥保护', async () => {
    let at = 0
    const first = intRouteStateRegistry(undefined, undefined, { now: () => at })
    first.AddChild(child.id, { chain: [accountA, independent], role: 'fu_he' })
    first.getRequestOverride(child, { ...accountA }, undefined)
    await first.recover({ agent: child, provider: accountA.provider, failure: { code: 'QUOTA', resetAt: new Date(1000).toISOString() } }, vi.fn(), undefined, config)
    at = 1000
    first.AddChild('old-half', { chain: [accountA, independent], role: 'fu_he' })
    first.getRequestOverride({ id: 'old-half' }, { ...accountA }, undefined)
    expect(first.getHealth()[0]?.halfOpenAgent).toBe('old-half')
    const recovered = intRouteStateRegistry(undefined, undefined, { now: () => at })
    recovered.RestoreHealth(first.getHealth())
    expect(recovered.getHealth()[0]?.halfOpenAgent).toBeUndefined()
    recovered.AddChild('new-half', { chain: [accountA, independent], role: 'fu_he' })
    recovered.getRequestOverride({ id: 'new-half' }, { ...accountA }, undefined)
    recovered.RestoreHealth(first.getHealth()) // 同时加载另一个根的旧快照不破坏当前in-flight claim。
    expect(recovered.getHealth()[0]?.halfOpenAgent).toBe('new-half')
  })
})

for (const hostVersion of ['0.1.7-rc.2', '0.2.0-rc.2']) {
const hostRoot = resolve(`.sandbox/dsh-${hostVersion}/node_modules/@deepseek-ai`)
describe.skipIf(!existsSync(resolve(hostRoot, 'dsh-llm-retry/lib/index.js')))(`真实 ${hostVersion} Cordis + scope + dsh-llm-retry 协作`, () => {
  it.each(['normal', 'always'])('%s下先截断真实宿主长退避，无备用也不生成llm/retry事件', async (mode) => {
    const { Context } = await import(pathToFileURL(resolve(hostRoot, 'cordis/lib/index.js')).href)
    const { createScope, scopeTarget } = await import(pathToFileURL(resolve(hostRoot, 'dsh-scope/lib/index.js')).href)
    const { apply: applyRetry } = await import(pathToFileURL(resolve(hostRoot, 'dsh-llm-retry/lib/index.js')).href)
    const ctx = new Context()
    ctx.provide('sessionProjections', { register: () => undefined, stateOf: () => ({}) })
    applyRetry(ctx)
    const key = {}
    const scoped = createScope(ctx, key)
    const events: string[] = []
    const picked = { provider: 'pool-provider', model: 'pool' }
    const cfg = getSwarmConfig({ routes: { tian_shu: { chain: [picked, { provider: 'independent', model: 'backup' }] } } })
    const registry = intRouteStateRegistry()
    let ready!: () => void
    const readiness = new Promise<void>((resolve) => { ready = resolve })
    ctx.provide('agentSwarm', { routeState: registry, getConfig: () => cfg, WaitAgentReady: () => readiness })
    applyRuntime(scoped.ctx as PluginContextLike, { role: 'tian_shu' })
    const agent = { id: 'real-host', session: { header: {}, append: (type: string) => events.push(type) } }
    const controller = new AbortController()
    const safety = setTimeout(() => controller.abort(), 1000)
    try {
      const request = ctx.waterfall(scopeTarget(agent, key), 'agent/request', { agent, turn: 0, step: 0 }, async () => picked)
      await Promise.resolve()
      expect(registry.getRecovery(agent.id)).toBeUndefined()
      ready()
      expect(await request).toMatchObject(picked)
      const retryPolicy = { mode, retryableCodes: ['QUOTA', 'SERVER_ERROR'], maxRetries: 5, initialDelayMs: 9060669, maxDelayMs: 9060669, jitterRatio: 0 }
      const payload = { agent, turn: 0, step: 0, provider: picked.provider, failure: { code: 'SERVER_ERROR', message: 'pool "claude-opus-5-5" exhausted: every member is unavailable or failed', providerRetryAfterMs: 9060669 }, retryPolicy, signal: controller.signal }
      expect(await ctx.waterfall(scopeTarget(agent, key), 'agent/request-error', payload, async () => undefined)).toEqual({ kind: 'retry' })
      expect(events).toEqual([])
      expect(registry.getRequestOverride(agent, picked, 'tian_shu', cfg)).toMatchObject({ provider: 'independent', model: 'backup' })
      expect(await ctx.waterfall(scopeTarget(agent, key), 'agent/request-error', { ...payload, provider: 'independent', failure: { code: 'QUOTA' } }, async () => undefined)).toBeUndefined()
      expect(registry.getTerminal(agent.id)).toBe('route_chain_exhausted')
      expect(events).toEqual([])
      // 真正成功来自持久化 assistant/message 的 end frame，而不是原始 finish。
      registry.clearHealth()
      registry.BeginLogicalRequest(agent.id, 'reopened')
      registry.getRequestOverride(agent, picked, 'tian_shu', cfg)
      ctx.emit(scopeTarget(agent, key), 'agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'actual-attempt-1' } })
      ctx.emit(scopeTarget(agent, key), 'agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'actual-attempt-1' } })
      expect(registry.getRecovery(agent.id)?.observedModelAttempts).toBe(1)
      expect(registry.getRecovery(agent.id)?.observationCoverage).toBe('agent-loop-stream-attempts')
      ctx.emit(scopeTarget(agent, key), 'agent/assistant-stream', { agent, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/attempt' } } })
      expect(registry.getRecovery(agent.id)?.completed).not.toBe(true)
      ctx.emit(scopeTarget(agent, key), 'agent/assistant-stream', { agent, frame: { type: 'end', outcome: { kind: 'committed', eventType: 'assistant/message' } } })
      expect(registry.getRecovery(agent.id)?.completed).toBe(true)
      const outside = { id: 'other-plugin-child', session: { header: { parentSession: 'outside-swarm' }, append: (type: string) => events.push(type) } }
      const externalRoute = { provider: 'external', model: 'external' }
      expect(await ctx.waterfall(scopeTarget(outside, key), 'agent/request', { agent: outside, turn: 1, step: 0 }, async () => externalRoute)).toEqual(externalRoute)
      ctx.emit(scopeTarget(outside, key), 'agent/assistant-stream', { agent: outside, frame: { type: 'start', attemptId: 'outside-attempt' } })
      expect(registry.getRecovery(outside.id)).toBeUndefined()
      expect(await ctx.waterfall(scopeTarget(outside, key), 'agent/request-error', {
        agent: outside, provider: 'external', turn: 1, step: 0, failure: { code: 'RATE_LIMIT' },
        retryPolicy: { ...retryPolicy, initialDelayMs: 1, maxDelayMs: 1, retryableCodes: ['RATE_LIMIT'] }, signal: controller.signal
      }, async () => undefined)).toEqual({ kind: 'retry' })
      expect(events).toEqual(['llm/retry', 'llm/retry-started'])
    } finally { clearTimeout(safety); await scoped.dispose(); await ctx.fiber.dispose() }
  })
})

}
