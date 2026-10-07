import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intRouteStateRegistry, type FallbackEventInfo } from '../../src/route-state.js'
import { DEFAULT_ROUTE_CHAINS } from '../../src/routes.js'
import { nativeRecoveryCoverage, getNativeRecoverySupport } from '../../src/provider-policy.js'
import type { RouteInfo } from '../../src/routes.js'
import { apply as applyRuntime } from '../../src/runtime.js'
import type { PluginContextLike } from '../../src/host-contract.js'

const config = getSwarmConfig({})
const child = { id: 'c1', session: { header: { parentSession: 'root' } } }
const root = { id: 'root', session: { header: {} } }
const chain = [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2', reasoningEffort: 'high' }, { provider: 'a', model: 'm3' }]

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

  it('NO_ADAPTER仅说No eligible account时保留断网刷新恢复；明确pool/quota仍走零等待', async () => {
    const offline = makeNetwork([false])
    const registry = intRouteStateRegistry(undefined, undefined, { network: offline.network })
    const picked = { provider: 'codex', model: 'gpt-6-sol' }
    registry.getRequestOverride(root, picked, 'tian_shu', config)
    expect(await registry.recover({ agent: root, provider: 'codex', failure: { code: 'NO_ADAPTER', message: 'No eligible account for codex/gpt-6-sol' } }, vi.fn(), 'tian_shu', config)).toEqual({ kind: 'retry' })
    expect(offline.calls.waitOnline).toBe(1)
    expect(registry.getRequestOverride(root, picked, 'tian_shu', config)).toEqual(picked)
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
      expect(hook.mock.calls[0]).toMatchObject([expect.any(Array), { agentId: child.id, reason: 'failure' }])
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
