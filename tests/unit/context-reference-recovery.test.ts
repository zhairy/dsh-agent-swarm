import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, type SwarmService } from '../../src/service.js'
import type { AgentLike } from '../../src/host-contract.js'

const homes: string[] = []
const services: SwarmService[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

const createRuntime = async (existingHome?: string) => {
  const home = existingHome ?? await mkdtemp(join(tmpdir(), 'swarm-context-ref-'))
  if (existingHome === undefined) homes.push(home)
  const root: AgentLike = { id: 'context-reference-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const config = getSwarmConfig({ persistence: { enabled: true }, jev: { enabled: false },
    review: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'off' } })
  const service = intSwarmService({ getConfig: () => config, dshHome: home,
    getLlm: () => undefined, getSubagents: () => undefined, getTools: () => undefined,
    getAttachments: () => undefined, getCredentials: () => undefined,
    gitStatus: async () => undefined, fetch: async () => { throw new Error('Context regression forbids network') } })
  services.push(service)
  return { home, root, service, exec: (agent = root) => ({ agent, signal: new AbortController().signal }) }
}
const card = { title: '上下文恢复', goal: '核对当前合同材料', acceptance: ['引用有当前身份与版本绑定'], flags: {} }
type Index = { materials: Array<{ ref: string; digest: string; kind: string }> }

describe('recovering obsolete context references without reviving authorization', () => {
  it('returns a current authorized index for replaced refs, resets cursors and still rejects wrong digests', async () => {
    const runtime = await createRuntime()
    const task = await runtime.service.AddTaskCard(card, runtime.exec())
    const old = await runtime.service.ReadContext({ task_id: task.task_id }, runtime.exec()) as Index
    const replaced = await runtime.service.AddTaskCard({ ...card, task_id: task.task_id,
      goal: '核对修订后的合同材料，旧引用不能升级' }, runtime.exec())
    const recovery = await runtime.service.ReadContext({ task_id: task.task_id, ref: old.materials[0]!.ref,
      expectedDigest: old.materials[0]!.digest, cursor: '999999', limit: 8000 }, runtime.exec()) as Index & Record<string, unknown>
    expect(recovery).toMatchObject({ ok: false, code: 'CONTEXT_REFERENCE_UNAVAILABLE',
      recovery: 'relist_current_materials', mayUseForImplementation: false, stateRefreshRequired: false,
      publishedRevisions: { cardRevision: replaced.cardRevision } })
    expect(recovery).not.toHaveProperty('text')
    expect(recovery).not.toHaveProperty('nextCursor')
    expect(recovery.materials.map((material) => material.ref)).not.toContain(old.materials[0]!.ref)
    const material = recovery.materials[0]!
    const page = await runtime.service.ReadContext({ task_id: task.task_id, ref: material.ref,
      expectedDigest: material.digest }, runtime.exec())
    expect(page).toMatchObject({ cursor: '0', cardRevision: replaced.cardRevision })
    await expect(runtime.service.ReadContext({ task_id: task.task_id, ref: material.ref,
      expectedDigest: old.materials[0]!.digest }, runtime.exec())).rejects.toThrow('摘要')
  })

  it('restores valid persistent refs across host restart and keeps missing-reference recovery read-only', async () => {
    const first = await createRuntime()
    const task = await first.service.AddTaskCard(card, first.exec())
    const index = await first.service.ReadContext({ task_id: task.task_id }, first.exec()) as Index
    const material = index.materials[0]!
    const before = await first.service.ReadContext({ task_id: task.task_id, ref: material.ref,
      expectedDigest: material.digest }, first.exec())
    await first.service.dispose(); services.splice(services.indexOf(first.service), 1)
    const restored = await createRuntime(first.home)
    expect(await restored.service.ReadContext({ task_id: task.task_id, ref: material.ref,
      expectedDigest: material.digest }, restored.exec())).toEqual(before)
    const recovery = await restored.service.ReadContext({ task_id: task.task_id,
      ref: 'ctx-11207567-742d-476c-9932-e8d6911840d3', limit: 8000 }, restored.exec())
    expect(recovery).toMatchObject({ ok: false, code: 'CONTEXT_REFERENCE_UNAVAILABLE', materials: index.materials })
    expect(await restored.service.ReadContext({ task_id: task.task_id }, restored.exec())).toMatchObject(index)
  })

  it('does not turn cross-task, unauthenticated or unbound expert reads into recoverable authorization', async () => {
    const runtime = await createRuntime()
    const first = await runtime.service.AddTaskCard(card, runtime.exec())
    const second = await runtime.service.AddTaskCard({ ...card, title: '其他任务' }, runtime.exec())
    const index = await runtime.service.ReadContext({ task_id: first.task_id }, runtime.exec()) as Index
    await expect(runtime.service.ReadContext({ task_id: second.task_id, ref: index.materials[0]!.ref }, runtime.exec()))
      .rejects.toThrow('其他会话、工作区或任务')
    await expect(runtime.service.ReadContext({ task_id: first.task_id, ref: 'absent' }, { signal: runtime.exec().signal }))
      .rejects.toThrow('身份')
    const expert: AgentLike = { id: 'unbound-expert', session: { header: { agentPreset: 'yu-shi', cwd: runtime.home } } }
    await expect(runtime.service.ReadContext({ task_id: first.task_id, ref: 'absent' }, runtime.exec(expert)))
      .rejects.toThrow(/任务|身份|绑定/)
  })
})
