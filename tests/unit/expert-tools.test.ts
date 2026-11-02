import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { apply as applyExpert } from '../../src/expert-tools.js'
import { SWARM_SERVICE, type PluginContextLike } from '../../src/host-contract.js'
import { intSwarmService } from '../../src/service.js'
import { getBoundTaskToolDefinitions, type BoundTaskToolService } from '../../src/task-tools.js'
import { apply as applyRoot } from '../../src/tools.js'
import type { ToolDefinitionLike } from '../../src/tool-shape.js'

const createContext = (service: unknown) => {
  const registered: ToolDefinitionLike[] = [], disposals: Array<() => void> = []
  const unregister = vi.fn()
  const ctx: PluginContextLike = {
    get: name => name === SWARM_SERVICE ? service : name === 'tools' ? { register: (definition: ToolDefinitionLike) => { registered.push(definition); return unregister } } : undefined,
    provide: () => () => undefined,
    effect: callback => { disposals.push(callback()) },
    on: () => undefined
  }
  return { ctx, registered, dispose: () => disposals.forEach(dispose => dispose()), unregister }
}
const createService = (persistence: boolean, messageBus: boolean): BoundTaskToolService => ({
  getConfig: () => getSwarmConfig({ persistence: { enabled: persistence }, messageBus: { enabled: messageBus } }),
  ReadContext: vi.fn(async () => ({ materials: [] })), ProjectFiles: vi.fn(async () => ({ files: [] })), Calculate: vi.fn(async () => ({ ok: true })),
  MessageSend: vi.fn(async () => ({ sent: true })), MessageRead: vi.fn(async () => ({ messages: [] })), MessageAck: vi.fn(async () => ({ acknowledged: true }))
})
const SAFE_NAMES = ['swarm_context_read', 'swarm_project_files', 'swarm_calculate']
const MESSAGE_NAMES = ['swarm_message_send', 'swarm_message_read', 'swarm_message_ack']

describe('独立专家安全工具入口', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('持久化 %s / 邮箱 %s 决定消息工具注册，始终不暴露编排和全局 Jev', (persistence, messageBus) => {
    const context = createContext(createService(persistence!, messageBus!))
    applyExpert(context.ctx)
    const names = context.registered.map(tool => tool.name)
    expect(names).toEqual([...SAFE_NAMES, ...(persistence && messageBus ? MESSAGE_NAMES : [])])
    expect(names.some(name => ['swarm_task_card', 'swarm_delegate', 'swarm_accept', 'swarm_review_plan', 'swarm_status', 'swarm_experience'].includes(name) || name.startsWith('jev_'))).toBe(false)
    context.dispose()
    expect(context.unregister).toHaveBeenCalledTimes(names.length)
  })

  it('根与专家复用相同 schema 且不重复注册，根仍有原编排工具', () => {
    const service = createService(true, true)
    const root = createContext(service), expert = createContext(service)
    applyRoot(root.ctx)
    applyExpert(expert.ctx)
    expect(root.registered.filter(tool => tool.name === 'swarm_task_card')).toHaveLength(1)
    for (const tool of expert.registered) {
      const rootTools = root.registered.filter(rootTool => rootTool.name === tool.name)
      expect(rootTools).toHaveLength(1)
      expect(rootTools[0]!.parameters).toEqual(tool.parameters)
    }
  })

  it('原样传递宿主身份与输入，不伪造任务绑定；服务拒绝保持拒绝', async () => {
    const service = createService(false, false)
    const tools = getBoundTaskToolDefinitions(service)
    const read = tools.find(tool => tool.name === 'swarm_context_read')!
    const exec = { agent: { id: 'bound-child' }, signal: new AbortController().signal, callId: 'context-call' }
    const args = { task_id: 'T-1', ref: 'authorized-ref', expectedDigest: 'current' }
    await read.execute(args, exec)
    expect(service.ReadContext).toHaveBeenCalledWith(args, exec)
    vi.mocked(service.ReadContext).mockRejectedValueOnce(new Error('旧任务版本禁止访问'))
    await expect(read.execute(args, exec)).rejects.toThrow('旧任务版本禁止访问')
    await expect(read.execute({ ...args, rootSessionId: 'forged-root' }, exec)).rejects.toThrow('不是允许的字段')
    expect(service.ReadContext).toHaveBeenCalledTimes(2)
  })

  it('工具存在仍不能让未绑定独立专家读取根任务或计算', async () => {
    const home = mkdtempSync(join(tmpdir(), 'expert-tool-binding-'))
    const service = intSwarmService({ getConfig: () => getSwarmConfig({ jev: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'off' } }),
      getLlm: () => undefined, getSubagents: () => undefined, getTools: () => undefined, getAttachments: () => undefined,
      getCredentials: () => undefined, dshHome: home, gitStatus: async () => undefined,
      fetch: async () => { throw new Error('本测试禁止网络') } })
    try {
      const root = { agent: { id: 'expert-test-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }, signal: new AbortController().signal }
      const card = await service.AddTaskCard({ title: '私有合同', goal: '仅允许任务成员读取', acceptance: ['绑定有效'], flags: {} }, root)
      const expert = { agent: { id: 'unbound-expert', session: { header: { agentPreset: 'yu-shi', cwd: home } } }, signal: new AbortController().signal }
      const tools = getBoundTaskToolDefinitions(service)
      for (const name of ['swarm_context_read', 'swarm_project_files', 'swarm_calculate']) {
        const input = name === 'swarm_calculate' ? { task_id: card.task_id, op: 'add', mode: 'float64', args: { a: 1, b: 2 } } : { task_id: card.task_id }
        await expect(tools.find(tool => tool.name === name)!.execute(input, expert)).rejects.toThrow(/任务|身份|绑定/)
      }
      await expect(tools.find(tool => tool.name === 'swarm_context_read')!.execute({ task_id: card.task_id }, { signal: root.signal })).rejects.toThrow('身份')
    } finally { await service.dispose(); rmSync(home, { recursive: true, force: true }) }
  })
})
