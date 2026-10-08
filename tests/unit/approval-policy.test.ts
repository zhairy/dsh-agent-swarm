import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { APPROVAL_SCOPES, getApprovalPolicyDiagnostics, getHostApprovalPolicy, getToolApprovalDecision, getToolApprovalDenial, getToolApprovalScope, type ApprovalsConfigInfo } from '../../src/approval-policy.js'
import { apply as applySwarm } from '../../src/index.js'
import type { AgentLike, PluginContextLike, PreToolDecisionLike, ToolExecutionLike } from '../../src/host-contract.js'
import { getToolDefinition } from '../../src/tool-shape.js'

const config = (mode: ApprovalsConfigInfo['mode'], scope: ApprovalsConfigInfo['scope'] = APPROVAL_SCOPES): ApprovalsConfigInfo => ({ mode, scope })

describe('百工工具审批边界', () => {
  it.each([
    ['write', 'write'], ['edit', 'write'], ['bash', 'shell'], ['pwsh', 'shell'], ['run_code', 'shell'],
    ['mcp__filesystem__read_file', 'external_mcp'], ['mcp__jev__jev_health', 'external_mcp'], ['jev_health', 'jev'], ['jev_check', 'jev'],
    ['jev_unknown', undefined], ['read', undefined], ['swarm_review_plan', undefined]
  ])('按精确的宿主公共工具名分类 %s', (name, scope) => { expect(getToolApprovalScope(name)).toBe(scope) })

  it('inherit及未选择scope保留同一个宿主决定对象', () => {
    const host: PreToolDecisionLike = { kind: 'ask', reason: 'original host reason', displayReason: { en: 'host', zh: '宿主' } }
    expect(getToolApprovalDecision({ name: 'write' }, host, config('inherit'))).toBe(host)
    expect(getToolApprovalDecision({ name: 'write' }, host, config('deny', ['jev']))).toBe(host)
    expect(getToolApprovalDecision({ name: 'write' }, { kind: 'allow' }, config('ask', []))).toEqual({ kind: 'allow' })
  })

  it.each(['ask', 'deny'] as const)('%s永不覆盖宿主deny/cancel', (mode) => {
    for (const host of [{ kind: 'deny', reason: 'host hard deny' }, { kind: 'cancel' }] as const) {
      expect(getToolApprovalDecision({ name: 'bash' }, host, config(mode))).toBe(host)
    }
  })

  it('ask不重复或替换已有的审批，deny可以额外收紧已有ask', () => {
    const host: PreToolDecisionLike = { kind: 'ask', reason: 'precise existing reason' }
    expect(getToolApprovalDecision({ name: 'bash' }, host, config('ask'))).toBe(host)
    expect(getToolApprovalDecision({ name: 'bash' }, host, config('deny'))).toMatchObject({ kind: 'deny', reason: expect.stringContaining('Shell/代码执行') })
    expect(getToolApprovalDecision({ name: 'bash' }, { kind: 'allow' }, config('ask'), { hostPolicy: 'never' })).toMatchObject({ kind: 'ask', reason: expect.stringContaining('never') })
    expect(getToolApprovalDenial({ name: 'run_code' }, config('deny', ['shell']))).toBeDefined()
    expect(getToolApprovalDenial({ name: 'write' }, config('ask'))).toBeUndefined()
  })

  it('只读观测宿主政策；旧策略、不可用、未知互不冒充', () => {
    const request = vi.fn(async () => 'unavailable' as const)
    const setPolicy = vi.fn()
    const host = { config: { policy: 'ask' as const }, overrideOf: () => 'never' as const, request, setPolicy }
    expect(getHostApprovalPolicy(host, { id: 'child', session: {} })).toBe('never')
    expect(getHostApprovalPolicy({ request })).toBe('unknown')
    expect(getHostApprovalPolicy(undefined)).toBe('unavailable')
    expect(getHostApprovalPolicy({ ...host, overrideOf: () => { throw new Error('unavailable fold') } }, { id: 'child', session: {} })).toBe('unknown')
    expect(request).not.toHaveBeenCalled()
    expect(setPolicy).not.toHaveBeenCalled()
    expect(getApprovalPolicyDiagnostics(config('ask'), 'never').join('\n')).toContain('不会自动更改')
    expect(getApprovalPolicyDiagnostics(config('inherit'), 'never')).toEqual([])
  })

  it('index仅包裹百工所属会话并以prepend保留所有下游政策', async () => {
    const values = new Map<string, unknown>()
    const listeners = new Map<string, { listener: (...args: any[]) => any; options?: { prepend?: boolean } }>()
    const disposers: Array<() => unknown> = []
    values.set('tools', { guard: () => () => {}, schemas: () => [], register: () => () => {} })
    const ctx = {
      get: (name: string) => values.get(name),
      provide: (name: string, value: unknown) => { values.set(name, value); return () => values.delete(name) },
      effect: (effect: () => () => unknown) => { disposers.push(effect()) },
      on: (name: string, listener: (...args: any[]) => any, options?: { prepend?: boolean }) => { listeners.set(name, { listener, options }) }
    }
    applySwarm(ctx as PluginContextLike, { approvals: config('ask', ['external_mcp']) })
    try {
      const hook = listeners.get('tools/pre-execute')!
      expect(hook.options).toEqual({ prepend: true })
      const next = vi.fn(async () => ({ kind: 'allow' as const }))
      const managed = { id: 'root', session: { header: { agentPreset: 'tian-shu' } } }
      expect(await hook.listener({ name: 'mcp__jev__jev_health', agent: managed }, next)).toMatchObject({ kind: 'ask' })
      expect(next).toHaveBeenCalledTimes(1)
      const denied = { kind: 'deny' as const, reason: 'downstream host policy' }
      expect(await hook.listener({ name: 'mcp__jev__jev_health', agent: managed }, async () => denied)).toBe(denied)
      for (const agent of [undefined, { id: 'outside', session: { header: { agentPreset: 'standard' } } }, { id: 'foreign-child', session: { header: { agentPreset: 'tian-shu', parentSession: 'root' } } }]) {
        expect(await hook.listener({ name: 'mcp__jev__jev_health', agent }, async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })
      }
    } finally { for (const dispose of disposers.reverse()) await dispose() }
  })
})

// Use the actual published 0.2 SDK, without adding host packages to the plugin's runtime closure.
const candidates = [process.env.SWARM_DSH_MODULES, resolve('.sandbox/dsh-0.2.0-rc.2/node_modules'), '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules'].filter((value): value is string => Boolean(value))
const hostModules = candidates.find((root) => {
  const base = join(root, '@deepseek-ai')
  return ['cordis', 'dsh-scope', 'dsh-tools', 'dsh-user-approval'].every((name) => existsSync(join(base, name, 'lib/index.js')))
    && JSON.parse(readFileSync(join(base, 'dsh-tools/package.json'), 'utf8')).version === '0.2.0-rc.2'
})

const sdkHarness = async (policy: 'ask' | 'never' = 'ask', mountApproval = true) => {
  const load = async (name: string) => import(pathToFileURL(join(hostModules!, '@deepseek-ai', name, 'lib/index.js')).href)
  const [{ Context }, { createScope }, { ToolRuntime }, { ApprovalService }] = await Promise.all([load('cordis'), load('dsh-scope'), load('dsh-tools'), load('dsh-user-approval')])
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, context: () => () => {}, getContextOrder: () => 0 })
  const tools = new ToolRuntime(ctx)
  const approval = mountApproval ? new ApprovalService(ctx, { policy }) : undefined
  const events: Array<{ type: string; data?: unknown }> = [{ type: 'turn/start' }]
  const session = { header: {}, get seq() { return events.length }, eventAt: (index: number) => events[index], append: (type: string, data: unknown) => { events.push({ type, data }) } }
  const agent = { id: 'sdk-approval-root', session } as AgentLike
  const scope = createScope(ctx, agent)
  const body = vi.fn(async () => ({ ran: true }))
  tools.register(getToolDefinition({ name: 'write', description: 'isolated SDK fixture', parameters: { type: 'object', additionalProperties: false }, execute: body, render: (_args, result) => JSON.stringify(result) }))
  let settings = config('ask', ['write'])
  ctx.on('tools/pre-execute', async (exec: ToolExecutionLike, next: () => Promise<PreToolDecisionLike>) => getToolApprovalDecision(exec, await next(), settings, { hostPolicy: getHostApprovalPolicy(approval, agent) }), { prepend: true })
  tools.guard((exec: ToolExecutionLike) => getToolApprovalDenial(exec, settings))
  let call = 0
  return { ctx, tools, approval, events, body, agent,
    setMode: (mode: ApprovalsConfigInfo['mode']) => { settings = config(mode, ['write']) },
    execute: (signal = new AbortController().signal) => tools.execute({ name: 'write', arguments: {}, agent, callId: `sdk-call-${++call}`, signal }),
    dispose: async () => { await scope.dispose(); await ctx.fiber.dispose() }
  }
}

describe.skipIf(hostModules === undefined)('真实 DSH 0.2 SDK：ToolRuntime + ApprovalService', () => {
  it('单次allowed-once才执行；每次调用独立询问并保存asked/decided审计', async () => {
    const host = await sdkHarness()
    const answer = vi.fn(async () => 'allowed-once')
    host.ctx.on('approval/request', answer)
    try {
      expect((await host.execute()).isError).toBe(false)
      expect((await host.execute()).isError).toBe(false)
      expect(answer).toHaveBeenCalledTimes(2)
      expect(host.body).toHaveBeenCalledTimes(2)
      expect(host.events.filter(e => e.type === 'approval/asked')).toHaveLength(2)
      expect(host.events.filter(e => e.type === 'approval/decided')).toHaveLength(2)
    } finally { await host.dispose() }
  })

  it.each(['rejected', 'unavailable'] as const)('%s不运行；缺失、失败的应答者均失败关闭', async (outcome) => {
    const host = await sdkHarness()
    if (outcome === 'rejected') host.ctx.on('approval/request', async () => 'rejected')
    try {
      expect((await host.execute()).isError).toBe(true)
      expect(host.body).not.toHaveBeenCalled()
      expect(host.events.filter(e => e.type === 'approval/decided').at(-1)?.data).toMatchObject({ outcome })
    } finally { await host.dispose() }
  })

  it('审批服务缺失、应答抛错或返回词汇外的allow-always都不执行', async () => {
    for (const failure of ['missing-service', 'throwing-answerer', 'invalid-answer'] as const) {
      const host = await sdkHarness('ask', failure !== 'missing-service')
      if (failure === 'throwing-answerer') host.ctx.on('approval/request', async () => { throw new Error('fixture answerer failed') })
      if (failure === 'invalid-answer') host.ctx.on('approval/request', async () => 'allow-always')
      try {
        expect((await host.execute()).isError).toBe(true)
        expect(host.body).not.toHaveBeenCalled()
      } finally { await host.dispose() }
    }
  })

  it('宿主never和delegation固定never在应答者之前拒绝，不能被插件ask提高权限', async () => {
    for (const delegated of [false, true]) {
      const host = await sdkHarness(delegated ? 'ask' : 'never')
      if (delegated) host.events.push({ type: 'approval/policy', data: { policy: 'never', source: 'delegation' } })
      const answer = vi.fn(async () => 'allowed-once')
      host.ctx.on('approval/request', answer)
      try {
        expect((await host.execute()).isError).toBe(true)
        expect(getHostApprovalPolicy(host.approval, host.agent)).toBe('never')
        expect(answer).not.toHaveBeenCalled()
        expect(host.body).not.toHaveBeenCalled()
      } finally { await host.dispose() }
    }
  })

  it('取消审批丢弃迟到许可；pending期间切deny或最终角色guard仍阻断', async () => {
    for (const restriction of ['cancel', 'deny', 'role'] as const) {
      const host = await sdkHarness()
      const controller = new AbortController()
      let permit!: (outcome: string) => void
      let reached!: () => void
      const waiting = new Promise<void>((resolve) => { reached = resolve })
      host.ctx.on('approval/request', () => new Promise<string>((resolve) => { permit = resolve; reached() }))
      try {
        const execution = host.execute(controller.signal)
        await waiting
        if (restriction === 'cancel') controller.abort()
        if (restriction === 'deny') host.setMode('deny')
        if (restriction === 'role') host.tools.guard(() => 'readonly reviewer cannot write')
        permit('allowed-once')
        expect((await execution).isError).toBe(true)
        expect(host.body).not.toHaveBeenCalled()
      } finally { await host.dispose() }
    }
  })
})
