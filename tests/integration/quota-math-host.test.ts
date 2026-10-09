import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureDsh, getPluginRoot, getSandboxDshModules, getTestedVersion } from '../../scripts/sandbox.mjs'

// Use the real installed SDK and the private compiled candidate. No production
// profile, CLI, server, credentials, model generation, or live lib/ is modified.
ensureDsh()
const sdkModules = getSandboxDshModules()
const sdk = (name: string) => import(pathToFileURL(join(sdkModules, '@deepseek-ai', name, 'lib/index.js')).href)
const candidate = (file: string) => import(pathToFileURL(join(getPluginRoot(), 'lib', file)).href)
const [{ Context }, { SystemPrompt }, { ToolRuntime }, { HostConnectionService }, swarm, swarmTools, swarmRuntime] = await Promise.all([
  sdk('cordis'), sdk('dsh-system-prompt'), sdk('dsh-tools'), sdk('dsh-client-connection'), candidate('index.js'), candidate('tools.js'), candidate('runtime.js')
])
const sdkVersions = Object.fromEntries(['dsh', 'cordis', 'dsh-tools', 'dsh-client-connection'].map((name) => [name, JSON.parse(readFileSync(join(sdkModules, '@deepseek-ai', name, 'package.json'), 'utf8')).version]))
const providers = ['codex', 'claude', 'grok', 'copilot', 'antigravity']
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

type SourceCall = { method: string; payload: Record<string, unknown> }
const sourceStatus = () => ({ providers: Object.fromEntries(providers.map((provider) => [provider, { busy: false, accounts: provider === 'codex' ? [{ key: 'fixture-a', isDefault: true }, { key: 'fixture-b', isDefault: false }] : [] }])) })
const sourceUsage = (account: unknown) => ({ supported: true, windows: [
  { kind: 'session', usedPercent: account === 'fixture-a' ? 37.125 : 91.5, resetsAt: Date.now() + 60_000 },
  { kind: 'weekly', usedPercent: account === 'fixture-a' ? 12.75 : 85.25 },
  { kind: 'weekly', scope: 'model display lane', usedPercent: 77.25 }
] })

const fixture = async (options: { partial?: boolean; holdStatus?: Promise<void>; routing?: boolean } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'swarm-quota-math-sdk-'))
  writeFileSync(join(directory, 'README.md'), '# Isolated quota and pure computation host fixture\n')
  const root = new Context()
  const calls: SourceCall[] = []
  let scoped: any
  const config: Record<string, any> = { rootFallback: options.routing === true, jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false },
    workflow: { mode: 'advisory' }, persistence: { enabled: false }, math: { groups: { statistics: false, matrix: false } },
    routes: { tian_shu: { chain: [{ provider: 'codex', model: 'fixture-model' }, ...(options.routing ? [{ provider: 'claude', model: 'fixture-secondary' }, { provider: 'deepseek-official', model: 'fixture-api' }] : [])], upgrade: { enabled: false } } } }
  const fiber = await root.plugin({ name: 'quota-math-sdk-fixture', apply(ctx: any) {
    scoped = ctx
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx, {})
    // The actual admission implementation remains in use; only the private
    // browser-auth store is replaced by an isolated deterministic test owner.
    new HostConnectionService(ctx, [], { isAuthenticated: (request: { headers: Headers }) => request.headers.get('x-fixture-owner') === 'yes' })
    ctx.provide('profileContext', { home: directory })
    ctx.provide('llm', { listProviders: () => [{ id: 'codex', name: 'Subscription fixture' }, ...(options.routing ? [{ id: 'claude', name: 'Secondary subscription fixture' }, { id: 'deepseek-official', name: 'API fixture' }] : [])],
      resolveModelInfo: async () => ({ inputModalities: ['text'], context: { contextWindow: 200_000 } }) })
    ctx.provide('subagents', { list: () => [], getProvider: () => undefined })
    if (options.routing) ctx.provide('configEditor', { entries: () => [{ options: { id: 'llm-subscriptions', name: 'dsh-plugin-subscriptions' }, fiber: { state: 2, runtime: {}, config: { providers: ['codex', 'claude'], pool: { enabled: true, autoAccounts: true, strategy: 'quota_aware' } } } }] })
    for (const endpoint of ['status', 'usage', 'providerSettings']) ctx.connection.fetch.register({ path: `/api/subscriptions-auth.${endpoint}`, methods: ['POST'], requestBody: 'buffered', async fetch(request: Request) {
      const body = await request.json()
      calls.push({ method: body.method, payload: body.payload })
      if (endpoint === 'status') await options.holdStatus
      const status = sourceStatus()
      if (options.routing) status.providers.claude.accounts = [{ key: 'fixture-c', isDefault: true }]
      const value = endpoint === 'status' ? status : endpoint === 'providerSettings' ? { provider: body.payload.provider, settings: {}, accounts: (status.providers[body.payload.provider]?.accounts ?? []).map((account: any) => ({ key: account.key, models: [{ id: body.payload.provider === 'codex' ? 'fixture-model' : 'fixture-secondary', name: 'Fixture wire model' }] })) }
        : options.partial && body.payload.account === 'fixture-b' ? { supported: true, windows: [] }
          : options.routing ? { supported: true, windows: [{ kind: 'weekly', usedPercent: body.payload.provider === 'codex' ? 100 : 20, resetsAt: Date.now() + 60_000 }] } : sourceUsage(body.payload.account)
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
    } })
    swarm.apply(ctx, config)
    ctx.inject(['agentSwarm'], (scope: any) => swarmTools.apply(scope))
    if (options.routing) ctx.inject(['agentSwarm'], (scope: any) => swarmRuntime.apply(scope, { role: 'tian_shu' }))
  } })
  cleanups.push(async () => { await fiber.dispose(); rmSync(directory, { recursive: true, force: true }) })
  // Cordis dependency injection mounts the connection contribution as a child
  // fiber. Allow its real lifecycle queue to settle, without starting a CLI.
  await new Promise<void>((resolve) => setImmediate(resolve))
  const agent = { id: `quota-math-root-${directory.split('/').at(-1)}`, session: { header: { agentPreset: 'tian-shu', cwd: directory } } }
  const tools = scoped.tools
  const service = scoped.get('agentSwarm')
  const exec = () => ({ agent, signal: new AbortController().signal })
  const tool = (name: string, args: unknown, signal = new AbortController().signal) => tools.execute({ callId: `${name}-${crypto.randomUUID()}`, name, arguments: args, agent, signal })
  const rpc = async (payload: unknown = {}, signal = new AbortController().signal, authenticated = true) => {
    const method = 'swarm.quotaView', rpcId = `sdk-${crypto.randomUUID()}`
    const request = new Request(`http://localhost/api/${method}`, { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', ...(authenticated ? { 'x-fixture-owner': 'yes' } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal })
    const admission = scoped.connection.admit(request)
    if ('rejection' in admission) return { status: admission.rejection }
    const response = await scoped.connection.createSharedFetchHandler('/api').fetch(request)
    return { status: response.status, ...(await response.json()) }
  }
  const request = (resolved: { provider: string; model: string }, step = 0) => scoped.waterfall('agent/request', { agent, turn: 0, step, signal: new AbortController().signal }, async () => resolved)
  return { config, calls, service, tool, rpc, exec, request }
}

describe('真实 SDK Connection 与百工候选：准确额度只读链路', () => {
  it('真实注册、认证准入和quotaView返回原百分比，不聚合共享/模型窗口', async () => {
    expect(sdkVersions.dsh).toBe(getTestedVersion())
    const host = await fixture()
    expect(await host.rpc({}, undefined, false)).toEqual({ status: 401 })
    expect(host.calls).toEqual([])
    const response = await host.rpc({ force: true })
    expect(response.status).toBe(200)
    expect(response.result.ok).toBe(true)
    const view = response.result.value
    expect(new Set(view.routes.map((route: any) => route.routeId)).size).toBe(view.routes.length)
    expect(view.sampledAt).toBeNull()
    expect(view.freshness).toBe('upstream-not-disclosed')
    const codex = view.providers.find((provider: any) => provider.provider === 'codex')
    expect(codex.accounts.map((account: any) => account.windows.map((window: any) => window.usedPercent))).toEqual([[37.125, 12.75, 77.25], [91.5, 85.25, 77.25]])
    expect(new Set(codex.accounts.flatMap((account: any) => account.windows.map((window: any) => window.id))).size).toBe(6)
    expect(codex.accounts.every((account: any) => account.windows.every((window: any) => window.unit === 'percent'))).toBe(true)
    expect(host.calls.filter((call) => call.method === 'subscriptions-auth.status')).toHaveLength(1)
    expect(host.calls.filter((call) => call.method === 'subscriptions-auth.usage')).toHaveLength(2)
    expect(JSON.stringify(view)).not.toMatch(/fixture-a|fixture-b|remainingTokens/)
    expect(view.routes.find((route: any) => route.provider === 'codex' && route.model === 'fixture-model')).toMatchObject({ status: 'unknown', mapping: 'provider-accounts', windowIds: [] })
    expect(view.routes.filter((route: any) => ['qwen-token-plan-cn', 'opencode-go', 'deepseek-official'].includes(route.provider)).every((route: any) => route.status === 'unknown')).toBe(true)
  })

  it('账户部分缺失明确unknown，拒绝额外参数与预取消请求而不触发额度源', async () => {
    const host = await fixture({ partial: true })
    const rejected = await host.rpc({ method: 'subscriptions-auth.logout', provider: 'codex' })
    expect(rejected.result).toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    const abort = new AbortController(); abort.abort()
    expect((await host.rpc({}, abort.signal)).result).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(host.calls).toEqual([])
    const response = await host.rpc()
    const codex = response.result.value.providers.find((provider: any) => provider.provider === 'codex')
    expect(codex.accounts.map((account: any) => account.status)).toEqual(['reported', 'unknown'])
    expect(codex.warnings.join(' ')).toContain('不代表完整')
  })

  it('真实RPC中途取消拒绝等待，不取消同轮共享读取或伪造成功', async () => {
    let release!: () => void
    const holdStatus = new Promise<void>((resolve) => { release = resolve })
    const host = await fixture({ holdStatus })
    const abort = new AbortController()
    const cancelled = host.rpc({}, abort.signal)
    const shared = host.rpc({ force: true })
    while (host.calls.length === 0) await new Promise<void>((resolve) => setImmediate(resolve))
    abort.abort()
    expect((await cancelled).result).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    release()
    const response = await shared
    expect(response.result.ok).toBe(true)
    expect(response.result.value.refreshJoinedExisting).toBe(true)
    expect(host.calls.filter((call) => call.method === 'subscriptions-auth.status')).toHaveLength(1)
  })
})

describe('真实 SDK ToolRuntime 与百工任务/预算：纯函数配置', () => {
  const addTask = async (host: Awaited<ReturnType<typeof fixture>>) => {
    const result = await host.tool('swarm_task_card', { title: '隔离纯函数宿主验证', goal: '验证设置开关与实际预算/计算结果', acceptance: ['禁用无计费，启用按输入计算'], scope: ['README.md'], flags: {} })
    expect(result.isError, JSON.stringify(result)).toBe(false)
    return result.value.task_id
  }

  it('真实runtime在模型请求中自动读取公开额度/池来源，首选满额只后移到其他订阅且不写隔离', async () => {
    const host = await fixture({ routing: true }), task_id = await addTask(host)
    const before = host.service.getStatus({ task_id }, host.exec()).executionBudgets
    const primary = { provider: 'codex', model: 'fixture-model' }
    expect(await host.request(primary)).toMatchObject({ provider: 'claude', model: 'fixture-secondary' })
    expect(host.service.routeState.getRootPreference(host.exec().agent.id)).toMatchObject(primary)
    expect(host.service.routeState.getHealth()).toEqual([])
    expect(host.service.getStatus({ task_id }, host.exec()).executionBudgets).toEqual(before)
    expect(host.calls.filter((call) => call.method === 'subscriptions-auth.status')).toHaveLength(1)
    expect(host.calls.some((call) => call.method === 'subscriptions-auth.providerSettings')).toBe(true)
    expect(host.calls.some((call) => call.method === 'subscriptions-auth.usage')).toBe(true)
    // The feature is an automatic Host routing input, not a model-operated
    // quota chooser or a new model-facing tool.
    expect((await host.tool('swarm_quota_read', { task_id })).isError).toBe(true)
  })

  it('统计/矩阵默认禁用前置拒绝不计预算，显式开启矩阵后真正执行并记录计算证据', async () => {
    const host = await fixture(), task_id = await addTask(host)
    const before = host.service.getStatus({ task_id }, host.exec()).executionBudgets
    const disabled = await host.tool('swarm_calculate', { task_id, op: 'mean', mode: 'float64', args: { values: [1, 2, 3] } })
    expect(disabled).toMatchObject({ isError: false, value: { ok: false, code: 'UNSUPPORTED', workUnits: 0 } })
    const matrixArgs = { task_id, op: 'matmul', mode: 'float64', args: { a: [[1, 2], [3, 4]], b: [[5], [6]] } }
    expect(await host.tool('swarm_calculate', matrixArgs)).toMatchObject({ value: { ok: false, code: 'UNSUPPORTED', workUnits: 0 } })
    expect(host.service.getStatus({ task_id }, host.exec()).executionBudgets).toEqual(before)
    host.config.math.groups.matrix = true
    const enabled = await host.tool('swarm_calculate', matrixArgs)
    expect(enabled).toMatchObject({ isError: false, value: { ok: true, value: [[17], [39]], evidenceKind: 'computed', numericMode: 'float64' } })
    expect(enabled.value.artifactRef).toBeTypeOf('string')
    const after = host.service.getStatus({ task_id }, host.exec()).executionBudgets[0]
    expect(after.reservations).toHaveLength(1)
    expect(after.reservations[0]).toMatchObject({ source: 'math', state: 'settled' })
    expect(enabled.value.workUnits).toBeGreaterThan(0)
  })

  it('真实工具无损JSON管道保留有限mean、零variance；溢出和ddof越域明确失败', async () => {
    const host = await fixture(), task_id = await addTask(host)
    host.config.math.groups.statistics = true
    const calc = async (op: string, args: unknown) => {
      const result = await host.tool('swarm_calculate', { task_id, op, mode: 'float64', args })
      expect(result.isError).toBe(false)
      return result.value
    }
    expect(await calc('mean', { values: [Number.MAX_VALUE, Number.MAX_VALUE] })).toMatchObject({ ok: true, value: Number.MAX_VALUE })
    expect(await calc('mean', { values: [1e16, 1, -1e16] })).toMatchObject({ ok: true, value: 1 / 3 })
    expect(await calc('variance', { values: [Number.MAX_VALUE, Number.MAX_VALUE], ddof: 0 })).toMatchObject({ ok: true, value: 0 })
    expect(await calc('variance', { values: [-Number.MAX_VALUE, Number.MAX_VALUE], ddof: 0 })).toMatchObject({ ok: false, code: 'NON_FINITE' })
    expect(await calc('variance', { values: [1], ddof: 1 })).toMatchObject({ ok: false, code: 'DOMAIN' })
    expect(await calc('variance', { values: [1, 2], ddof: 0.5 })).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
    expect(await calc('mean', { values: [] })).toMatchObject({ ok: false, code: 'DOMAIN' })
  })
})
