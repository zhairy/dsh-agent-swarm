import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike, SubagentResultLike } from '../../src/host-contract.js'
import type { DelegationRecord } from '../../src/evidence.js'

const homes: string[] = [], services: SwarmService[] = [], finish: Array<() => void> = [], pending: Promise<unknown>[] = []
afterEach(async () => {
  for (const release of finish.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
const marker = 'PRIVATE_MEMORY_HANDOFF_BODY_MUST_NEVER_REACH_EXPERT_OR_JEV'
const setup = async () => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-maintenance-privacy-')); homes.push(home)
  const directory = join(home, 'share', 'dsh-agent-swarm', 'maintenance', 'fixture-private-scope')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const privateFiles = [join(directory, 'pending.json'), join(directory, 'consumed-1-fixture.json')]
  for (const path of privateFiles) await writeFile(path, JSON.stringify({ privateBody: marker }), { mode: 0o600 })
  const alias = join(home, 'maintenance-alias.json')
  await symlink(privateFiles[0]!, alias)
  const publicFile = join(home, 'public.ts')
  await writeFile(publicFile, 'export const publicValue = 42\n')
  const root: AgentLike = { id: 'maintenance-privacy-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const child: AgentLike = { id: 'maintenance-privacy-child', session: { header: { parentSession: root.id, cwd: home } } }
  const config = getSwarmConfig({ persistence: { enabled: false }, jev: { enabled: true, baseUrl: 'https://jev.privacy.invalid', maxRetries: 0 },
    review: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' }, agents: { session: 'oneshot', maxRetries: 0 } })
  let release!: () => void
  const childResult = new Promise<SubagentResultLike>((resolve) => { release = () => resolve({ output: [], stopReason: 'completed',
    structured: { summary: '核查私有材料保护，未读取私有正文', unresolved: [], findings: [privateFiles[0]!, alias].map((path) => ({
      path: relative(home, path), symbol: 'privateBody', callChain: [], evidence: '此路径需要私有状态隔离，不得当作项目证据' })) } }) })
  finish.push(release)
  const requests: string[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (!String(url).startsWith('https://jev.privacy.invalid/')) throw new Error('No real network in privacy regression')
    requests.push(String(init?.body))
    const score = { type: 'score', score: 3, confidence: 0.9, probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 } }
    return new Response(JSON.stringify({ model: 'fixture-jev', usage: { input_tokens: 1, output_tokens: 1 }, answers: {
      credibility: score, relevance: score, support: { type: 'choice', choice: 'supports', confidence: 0.9 } } }), { status: 200 })
  })
  const service = intSwarmService({ getConfig: () => config, getLlm: () => undefined,
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
      start: async () => ({ id: child.id, result: childResult, dispose: async () => undefined }) }),
    getTools: () => ({ register: () => () => undefined, guard: () => () => undefined,
      schemas: () => ['read', 'glob', 'grep', 'swarm_context_read'].map((name) => ({ name })) }),
    getAttachments: () => undefined, getCredentials: () => ({ resolve: async () => ({ value: 'fixture-only-key' }) }),
    dshHome: home, fetch, probe: async () => ({ ok: true, vision: true }), gitStatus: async () => undefined })
  services.push(service)
  const exec = (agent = root) => ({ agent, signal: new AbortController().signal })
  const task = await service.AddTaskCard({ title: '保护私有交接', goal: '仅核查公开项目代码', acceptance: ['维护数据不能进入专家上下文'],
    scope: ['public.ts'], flags: {} }, exec())
  const run = service.delegate({ task_id: task.task_id, role: 'tan_wei', prompt: '只核查公开代码', backend: 'api', session: 'oneshot' }, exec())
  pending.push(run.catch(() => undefined))
  await vi.waitFor(() => {
    expect(service.isManagedAgent(child)).toBe(true)
    expect(service.getGuardReason({ name: 'read', agent: child, arguments: { path: publicFile } })).toBeUndefined()
  })
  return { home, service, exec, root, child, task, privateFiles, alias, publicFile, release, run, requests, fetch }
}

describe('maintenance state stays behind the existing private context boundary', () => {
  it('blocks actual bound child read/glob/grep for pending, consumed files and realpath aliases', async () => {
    const runtime = await setup()
    for (const name of ['read', 'glob', 'grep']) for (const path of [...runtime.privateFiles, runtime.alias]) {
      expect(runtime.service.getGuardReason({ name, agent: runtime.child, arguments: { path } })).toMatch(/私有状态/)
    }
    expect(runtime.service.getGuardReason({ name: 'read', agent: runtime.child, arguments: { path: runtime.publicFile } })).toBeUndefined()
  })

  it('excludes the maintenance tree from real service project enumeration', async () => {
    const runtime = await setup()
    const page = await runtime.service.ProjectFiles({ task_id: runtime.task.task_id }, runtime.exec(runtime.child)) as { files: string[] }
    expect(page.files).toContain('public.ts')
    expect(page.files.some((path) => path.includes('/maintenance/'))).toBe(false)
    expect(page.files.some((path) => path.endsWith('pending.json') || path.includes('consumed-'))).toBe(false)
  })

  it('does not capture maintenance bytes or alias bytes into exploration grades or fake Jev requests', async () => {
    const runtime = await setup()
    runtime.release()
    const record: DelegationRecord = await runtime.run
    expect(runtime.fetch).toHaveBeenCalled()
    expect(record.evidenceAssessment?.items).toHaveLength(2)
    for (const item of record.evidenceAssessment!.items) {
      expect(item.source).toMatchObject({ status: 'unknown', reason: 'private-runtime-reference' })
      expect(item.source.supportingText).toBeUndefined()
      expect(item.credibility.status).toBe('unknown')
    }
    expect(JSON.stringify(record.evidenceAssessment)).not.toContain(marker)
    expect(runtime.requests.every((request) => !request.includes(marker))).toBe(true)
  })
})
