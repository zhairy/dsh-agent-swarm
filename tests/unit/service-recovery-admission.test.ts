import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { intSwarmService } from '../../src/service.js'
import { getSwarmConfig } from '../../src/config.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'

describe('settled child model admission', () => {
  it('a settled one-shot cannot enter another model request and points to an available parent action', async () => {
    const home = await mkdtemp(join(tmpdir(), 'swarm-oneshot-admission-'))
    const config = getSwarmConfig({ planningReview: { enabled: false }, jev: { enabled: false }, review: { enabled: false }, agents: { maxRetries: 0 } })
    const root = { id: 'root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
    const child = { id: 'oneshot-child', session: { header: { parentSession: root.id, agentPreset: 'tan-wei', cwd: home } } }
    const service = intSwarmService({ getConfig: () => config, dshHome: home,
      getLlm: () => undefined, getAttachments: () => undefined, getCredentials: () => undefined,
      fetch: async () => { throw new Error('This isolated fixture must not make network requests') },
      getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => [{ name: 'read' }] }),
      getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
        start: async () => ({ id: child.id, result: Promise.resolve({ output: [], structured: VALID_OUTPUTS.tan_wei, stopReason: 'completed' }), dispose: async () => undefined }) }),
      probe: async () => ({ ok: true as const, vision: false }), gitStatus: async () => undefined })
    try {
      const exec = { agent: root, signal: new AbortController().signal }
      const task = await service.AddTaskCard({ title: '只读一次性交付', goal: '交付后不沿用旧身份', acceptance: ['保留合法恢复入口'], scope: [], flags: {} }, exec)
      expect((await service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: '只读检查', session: 'oneshot', backend: 'api' }, exec)).status).toBe('completed')
      await expect(service.WaitAgentReady(child)).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', message: expect.stringContaining('一次性') })
      await expect(service.WaitAgentReady(child)).rejects.toThrow('返回父天枢')
      await expect(service.WaitAgentReady(child)).rejects.not.toThrow('安全继续任务')
    } finally { await service.dispose(); await rm(home, { recursive: true, force: true }) }
  })
})
