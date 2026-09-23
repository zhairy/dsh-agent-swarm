import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as host from '../../src/index.js'
import * as runtime from '../../src/runtime.js'
import * as tools from '../../src/tools.js'
import type { PluginContextLike, SubagentStartRequestLike, ToolExecutionLike } from '../../src/host-contract.js'
import { ROLE_TAG_PATTERN, type DelegableRoleId } from '../../src/role-registry.js'
import type { SwarmService } from '../../src/service.js'
import type { ToolDefinitionLike } from '../../src/tool-shape.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const makeContext = (services: Record<string, unknown>) => {
  const provided = new Map<string, unknown>()
  const listeners = new Map<string, (...args: never[]) => unknown>()
  const disposers: Array<() => void> = []
  const warn = vi.fn()
  const ctx: PluginContextLike = {
    get: (name) => provided.get(name) ?? services[name],
    provide: (name, value) => { provided.set(name, value); return () => { provided.delete(name) } },
    effect: (execute) => { disposers.push(execute()) },
    on: (name, listener) => { listeners.set(name, listener); return () => true },
    logger: () => ({ info: vi.fn(), warn })
  }
  return { ctx, provided, listeners, disposers, warn }
}

const makeHost = () => {
  const home = mkdtempSync(join(tmpdir(), 'swarm-plugin-'))
  dirs.push(home)
  const registered: ToolDefinitionLike[] = []
  const guards: Array<(execution: ToolExecutionLike) => string | undefined> = []
  const toolsService = {
    register: (definition: unknown) => { registered.push(definition as ToolDefinitionLike); return () => undefined },
    schemas: () => ['read', 'write', 'edit', 'glob', 'grep', 'pwsh'].map((name) => ({ name })),
    guard: (guard: (execution: ToolExecutionLike) => string | undefined) => { guards.push(guard); return () => undefined }
  }
  const subagents = {
    list: () => ['spawn'],
    getProvider: (name: string) => (name === 'spawn' ? { capabilities: {} } : undefined),
    start: vi.fn(async (_name: string, request: SubagentStartRequestLike) => {
      const role = ROLE_TAG_PATTERN.exec(request.persona ?? '')?.[1] as DelegableRoleId
      return { id: `child-${role}`, result: Promise.resolve({ output: [], structured: VALID_OUTPUTS[role], stopReason: 'completed' }), dispose: async () => undefined }
    })
  }
  const services = {
    llm: { listProviders: () => [{ id: 'qwen-token-plan-cn' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) },
    subagents,
    tools: toolsService,
    profileContext: { home }
  }
  const context = makeContext(services)
  host.apply(context.ctx, { jev: { enabled: false } })
  return { ...context, registered, guards, toolsService, home, services }
}

describe('宿主插件', () => {
  it('provide agentSwarm 服务并注册写操作守卫', () => {
    const { provided, guards, disposers } = makeHost()
    expect(host.name).toBe('dsh-agent-swarm')
    expect(host.inject).toEqual(['llm', 'subagents', 'tools'])
    expect(provided.get('agentSwarm')).toBeDefined()
    expect(guards).toHaveLength(1)
    expect(guards[0]?.({ name: 'write', agent: { id: 'a', session: { header: { agentPreset: 'yu-shi' } } } })).toContain('守卫')
    expect(disposers).toHaveLength(2)
  })

  it('DSH_HOME 解析顺序：profileContext.home → 环境变量 → ~/.dsh', () => {
    expect(host.getDshHome(makeContext({ profileContext: { home: '/h' } }).ctx)).toBe('/h')
    process.env.DSH_HOME = '/env-home'
    expect(host.getDshHome(makeContext({}).ctx)).toBe('/env-home')
    delete process.env.DSH_HOME
    expect(host.getDshHome(makeContext({}).ctx)).toMatch(/\.dsh$/)
  })
})

describe('工具插件', () => {
  it('注册 4 个工具并能走通任务卡 → 委派 → 状态 → 验收', async () => {
    const hostHarness = makeHost()
    const service = hostHarness.provided.get('agentSwarm') as SwarmService
    const registered: ToolDefinitionLike[] = []
    const context = makeContext({ agentSwarm: service, tools: { ...hostHarness.toolsService, register: (d: unknown) => { registered.push(d as ToolDefinitionLike); return () => undefined } } })
    tools.apply(context.ctx)
    expect(registered.map((d) => d.name)).toEqual(['swarm_task_card', 'swarm_delegate', 'swarm_status', 'swarm_accept'])
    const byName = (name: string) => registered.find((d) => d.name === name) as ToolDefinitionLike
    const exec = { agent: { id: 'root', session: { header: { agentPreset: 'tian-shu', cwd: process.cwd() } } }, signal: new AbortController().signal }

    const cardArgs = { title: '小改动', goal: '改一行', acceptance: ['测试通过'], scope: ['a.ts'], flags: { changesCode: true } }
    const card = await byName('swarm_task_card').execute(cardArgs, exec)
    const cardText = byName('swarm_task_card').output.render(cardArgs, card)[0]?.text ?? ''
    expect(cardText).toContain('task_id: T-1')
    expect(cardText).toContain('G_VERIFY')

    const delegateArgs = { task_id: 'T-1', role: 'ji_feng', prompt: '改 a.ts' }
    const edit = await byName('swarm_delegate').execute(delegateArgs, exec)
    const editText = byName('swarm_delegate').output.render(delegateArgs, edit)[0]?.text ?? ''
    expect(editText).toContain('【疾风】completed')
    expect(editText).toContain('```json')
    expect(byName('swarm_delegate').isConcurrencySafe?.({ task_id: 'T-1', role: 'tan_wei', prompt: 'x' })).toBe(true)
    expect(byName('swarm_delegate').isConcurrencySafe?.(delegateArgs)).toBe(false)

    const blocked = await byName('swarm_accept').execute({ task_id: 'T-1', decision: 'accept', summary: 's', stopReason: 's' }, exec)
    expect(byName('swarm_accept').output.render({}, blocked)[0]?.text).toContain('blocked')

    await byName('swarm_delegate').execute({ task_id: 'T-1', role: 'fu_he', prompt: '测试' }, exec)
    const status = await byName('swarm_status').execute({ task_id: 'T-1', verbose: true }, exec)
    const statusText = byName('swarm_status').output.render({}, status)[0]?.text ?? ''
    expect(statusText).toContain('✓ G_VERIFY')
    expect(statusText).toContain('疾风')
    const accepted = await byName('swarm_accept').execute({ task_id: 'T-1', decision: 'accept', summary: 's', stopReason: '门禁满足' }, exec)
    expect(byName('swarm_accept').output.render({}, accepted)[0]?.text).toContain('accepted')
  })

  it('缺少会话上下文或参数非法时报错', async () => {
    const hostHarness = makeHost()
    const definitions = tools.getSwarmToolDefinitions(hostHarness.provided.get('agentSwarm') as SwarmService)
    const status = definitions.find((d) => d.name === 'swarm_status') as ToolDefinitionLike
    await expect(status.execute({}, { signal: new AbortController().signal })).rejects.toThrow('会话上下文')
    const delegate = definitions.find((d) => d.name === 'swarm_delegate') as ToolDefinitionLike
    await expect(delegate.execute({ task_id: 'T-1', role: 'x', prompt: 'p' }, { signal: new AbortController().signal })).rejects.toThrow('参数不合法')
  })

  it('渲染函数覆盖失败、跳过与告警信息', () => {
    const text = tools.getDelegationText({
      delegationId: 'D-9', taskId: 'T-1', role: 'guan_xiang', roleName: '观象', status: 'blocked', summary: 'vision-unsupported', evidence: [],
      attempts: [{ route: 'a/b', backend: 'spawn', outcome: 'skipped', reason: 'vision-unsupported' }, { route: 'c/d', backend: 'spawn', outcome: 'fallback', reason: 'QUOTA → e/f' }],
      independence: 'not-achieved', hardIsolation: false, unresolved: ['缺图'], error: 'vision-unsupported', startedAt: 1, changedFiles: ['x.png']
    })
    expect(text).toContain('跳过 a/b（vision-unsupported）')
    expect(text).toContain('回退 c/d（QUOTA → e/f）')
    expect(text).toContain('硬隔离：否')
    expect(text).toContain('错误：vision-unsupported')
    expect(text).toContain('改动文件：x.png')
  })
})

describe('运行时插件', () => {
  it('在作用域事件中改写路由并处理回退、清理', async () => {
    const hostHarness = makeHost()
    const service = hostHarness.provided.get('agentSwarm') as SwarmService
    const context = makeContext({ agentSwarm: service })
    runtime.apply(context.ctx, { role: { get: () => 'tian_shu' } })
    service.routeState.AddChild('kid', { chain: [{ provider: 'a', model: 'm1' }, { provider: 'b', model: 'm2' }], role: 'fu_he' })
    const onRequest = context.listeners.get('agent/request') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const onError = context.listeners.get('agent/request-error') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    const onDisposed = context.listeners.get('agent/disposed') as unknown as (payload: unknown) => void
    expect(await onRequest({ agent: { id: 'kid' } }, async () => ({ provider: 'x', model: 'y' }))).toEqual({ provider: 'a', model: 'm1' })
    expect(await onError({ agent: { id: 'kid' }, provider: 'a', failure: { code: 'QUOTA' } }, async () => undefined)).toEqual({ kind: 'retry' })
    expect(service.routeState.getChild('kid')?.route?.model).toBe('m2')
    onDisposed({ agent: { id: 'kid' } })
    onDisposed(undefined)
    expect(service.routeState.getChild('kid')).toBeUndefined()
    expect(runtime.inject).toEqual(['agentSwarm'])
  })

  it('非法角色配置时只做子智能体改写，不做根会话回退', async () => {
    const hostHarness = makeHost()
    const service = hostHarness.provided.get('agentSwarm') as SwarmService
    const context = makeContext({ agentSwarm: service })
    runtime.apply(context.ctx, { role: 'nobody' })
    const onError = context.listeners.get('agent/request-error') as unknown as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
    expect(await onError({ agent: { id: 'root', session: { header: {} } }, provider: 'a', failure: { code: 'QUOTA' } }, async () => undefined)).toBeUndefined()
    expect(runtime.Config({ role: 'fu_he' })).toBeDefined()
  })
})
