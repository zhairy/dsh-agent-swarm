import { describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteStateRegistry, type FallbackEventInfo } from '../../src/route-state.js'
import { normalizeRouteFailure } from '../../src/provider-policy.js'

const primary = { provider: 'claude', model: 'claude-opus-5-5' }
const backup = { provider: 'codex', model: 'fixture-backup' }
const chosen = { provider: 'other-provider', model: 'manual-choice' }
const root = { id: 'request-owner-root', session: { header: { agentPreset: 'tian-shu' } } }
const config = getSwarmConfig({ agents: { networkWaitMs: 0 }, routes: { tian_shu: { chain: [primary, backup], upgrade: { enabled: false } } } })
const poolFailure = { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 51_840_000,
  message: 'pool "claude-opus-5-5" exhausted: every member is cooling down; earliest member recovers in 14h24m' }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

describe('actual request ownership across model changes', () => {
  it('a picker change during fallback metadata I/O retries admission instead of ending the Host turn', async () => {
    const entered = deferred(), probe = deferred()
    const sleep = vi.fn(async () => undefined)
    const registry = intRouteStateRegistry(undefined, async route => {
      if (route.provider === backup.provider) { entered.resolve(); await probe.promise }
      return { ok: true as const, vision: false }
    }, { sleep })
    registry.BeginRequestStep(root.id, 1, 0)
    registry.getRequestOverride(root, primary, 'tian_shu', config, true)
    const action = registry.getErrorAction({ agent: root, provider: primary.provider, failure: poolFailure }, undefined, 'tian_shu', config)
    await entered.promise
    registry.RecordUserSelection(root.id, backup, 1)
    probe.resolve()
    expect(await action).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, primary, 'tian_shu', config, true)).toMatchObject(backup)
    expect(sleep).not.toHaveBeenCalled()
    expect(registry.getHealth().map(entry => entry.route.provider)).toEqual(['claude'])
  })

  it('an explicit model outside the configured fallback chain remains the next admitted choice', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true as const, vision: false }))
    registry.BeginRequestStep(root.id, 1, 0)
    registry.getRequestOverride(root, primary, 'tian_shu', config, true)
    registry.RecordUserSelection(root.id, chosen, 1)
    expect(await registry.getErrorAction({ agent: root, provider: primary.provider, failure: poolFailure }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, primary, 'tian_shu', config, true)).toMatchObject(chosen)
  })

  it('health persistence cannot change the failure route to a later actual header', async () => {
    const committed = deferred(), events: FallbackEventInfo[] = []
    const registry = intRouteStateRegistry(event => events.push(event), async () => ({ ok: true as const, vision: false }), { onHealthChange: () => committed.promise })
    registry.BeginRequestStep(root.id, 1, 0)
    registry.getRequestOverride(root, primary, 'tian_shu', config, true)
    const action = registry.getErrorAction({ agent: root, provider: primary.provider, failure: poolFailure }, undefined, 'tian_shu', config)
    registry.RecordUserSelection(root.id, backup, 1)
    registry.MarkRequestStarted(root.id, 'new-header', backup)
    committed.resolve()
    expect(await action).toEqual({ kind: 'retry' })
    expect(events[0]?.from).toMatchObject(primary)
    expect(events[0]?.to).toMatchObject(backup)
    expect(registry.getHealth().map(entry => entry.route.provider)).toEqual(['claude'])
  })

  it('a late failure from an earlier turn signal cannot quarantine or terminate its replacement turn', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true as const, vision: false }))
    const oldTurn = new AbortController(), newTurn = new AbortController()
    registry.BeginRequestStep(root.id, 1, 0)
    await registry.AdmitRequest(root, primary, 'tian_shu', config, true, oldTurn.signal)
    registry.RecordUserSelection(root.id, backup, 1)
    registry.BeginRequestStep(root.id, 2, 0)
    await registry.AdmitRequest(root, backup, 'tian_shu', config, true, newTurn.signal)
    expect(await registry.getErrorAction({ agent: root, provider: primary.provider, failure: poolFailure, signal: oldTurn.signal }, undefined, 'tian_shu', config)).toBeUndefined()
    expect(registry.getTerminal(root.id)).toBeUndefined()
    expect(registry.getHealth()).toEqual([])
    expect(registry.getRootPreference(root.id)).toMatchObject(backup)
    expect(registry.getRecovery(root.id)?.lastFailure).toBeUndefined()
  })

  it('a turn signal reused for another tool step still rejects an old step failure', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true as const, vision: false }))
    const turn = new AbortController()
    registry.BeginRequestStep(root.id, 1, 0)
    await registry.AdmitRequest(root, primary, 'tian_shu', config, true, turn.signal)
    registry.RecordUserSelection(root.id, backup, 1)
    registry.BeginRequestStep(root.id, 1, 1)
    await registry.AdmitRequest(root, backup, 'tian_shu', config, true, turn.signal)
    expect(await registry.getErrorAction({ agent: root, turn: 1, step: 0, provider: primary.provider, failure: poolFailure, signal: turn.signal }, undefined, 'tian_shu', config)).toBeUndefined()
    expect(registry.getTerminal(root.id)).toBeUndefined()
    expect(registry.getHealth()).toEqual([])
    expect(registry.getRecovery(root.id)?.lastFailure).toBeUndefined()
  })

  it('a duplicate old-provider failure at the same step cannot poison an admitted backup', async () => {
    const registry = intRouteStateRegistry(undefined, async () => ({ ok: true as const, vision: false }))
    const turn = new AbortController()
    registry.BeginRequestStep(root.id, 1, 0)
    await registry.AdmitRequest(root, primary, 'tian_shu', config, true, turn.signal)
    const payload = { agent: root, turn: 1, step: 0, provider: primary.provider, failure: poolFailure, signal: turn.signal }
    expect(await registry.getErrorAction(payload, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(await registry.AdmitRequest(root, primary, 'tian_shu', config, true, turn.signal)).toMatchObject(backup)
    expect(await registry.getErrorAction(payload, undefined, 'tian_shu', config)).toBeUndefined()
    expect(registry.getTerminal(root.id)).toBeUndefined()
    expect(registry.getHealth().map(entry => entry.route.provider)).toEqual(['claude'])
  })

  it('a disposed request signal cannot compact a replacement context or recreate recovery state', async () => {
    const registry = intRouteStateRegistry()
    const turn = new AbortController()
    registry.BeginRequestStep(root.id, 1, 0)
    await registry.AdmitRequest(root, primary, 'tian_shu', config, true, turn.signal)
    registry.DelAgent(root.id)
    const compactIfNeeded = vi.fn(async () => null)
    expect(await registry.recover({ agent: root, turn: 1, step: 0, provider: primary.provider, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal: turn.signal }, async () => undefined, 'tian_shu', config, { compactIfNeeded })).toBeUndefined()
    expect(compactIfNeeded).not.toHaveBeenCalled()
    expect(registry.getRecovery(root.id)).toBeUndefined()
  })

  for (const failure of [poolFailure, { code: 'QUOTA', status: 429, message: 'Your subscription usage limit reached' },
    { code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 51_840_000, message: 'requests per minute exceeded' }]) {
    it(`immediately falls back for ${failure.code} without sleeping on an exhausted resource`, async () => {
      const sleep = vi.fn(async () => undefined)
      const registry = intRouteStateRegistry(undefined, undefined, { sleep, now: () => 1000 })
      registry.BeginRequestStep(root.id, 1, 0)
      registry.getRequestOverride(root, primary, 'tian_shu', config, true)
      expect(await registry.getErrorAction({ agent: root, provider: primary.provider, failure }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
      expect(registry.getRequestOverride(root, primary, 'tian_shu', config, true)).toMatchObject(backup)
      expect(sleep).not.toHaveBeenCalled()
      expect(registry.getHealth()[0]?.kind).toBe(normalizeRouteFailure(failure, primary).kind)
      if (failure === poolFailure) expect(registry.getHealth()[0]!.retryAt! - 1000).toBeLessThanOrEqual(30 * 60_000)
    })
  }

  it('retains one short retry for a genuine transient 429 without marking quota exhaustion', async () => {
    const sleep = vi.fn(async () => undefined)
    const registry = intRouteStateRegistry(undefined, undefined, { sleep })
    registry.BeginRequestStep(root.id, 1, 0)
    registry.getRequestOverride(root, primary, 'tian_shu', config, true)
    expect(await registry.getErrorAction({ agent: root, provider: primary.provider, failure: { code: 'RATE_LIMIT', status: 429, message: 'requests per minute exceeded' } }, undefined, 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(registry.getRequestOverride(root, primary, 'tian_shu', config, true)).toMatchObject(primary)
    expect(sleep).toHaveBeenCalledWith(500, undefined)
    expect(registry.getHealth()).toEqual([])
  })
})
