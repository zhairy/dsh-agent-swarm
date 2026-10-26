import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSwarmConfig } from '../../src/config.js'
import { intSwarmService, ValidateAcceptInput, type SwarmService } from '../../src/service.js'
import type { AgentLike } from '../../src/host-contract.js'
import * as FeatureSessions from '../../src/feature-session.js'
import { StateStoreError } from '../../src/state-store.js'
import { VALID_OUTPUTS } from '../fixtures/valid-outputs.js'
import { IsVerificationReceiptCurrent, ValidateVerificationReceipt } from '../../src/verification-receipt.js'
import type { TaskStore } from '../../src/evidence.js'

const homes: string[] = [], services: SwarmService[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  vi.restoreAllMocks()
})
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const fixture = async (scope: string[] = []) => {
  const home = await mkdtemp(join(tmpdir(), 'swarm-receipt-')); homes.push(home)
  const config = getSwarmConfig({ jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, agents: { session: 'oneshot', maxRetries: 0 } })
  let captured!: FeatureSessions.FeatureSession
  let tasks!: TaskStore
  const original = FeatureSessions.createFeatureSession
  vi.spyOn(FeatureSessions, 'createFeatureSession').mockImplementation(async args => { tasks = args.tasks; captured = await original(args); return captured })
  const root: AgentLike = { id: 'receipt-root', session: { header: { agentPreset: 'tian-shu', cwd: home } } }
  const exec = () => ({ agent: root, signal: new AbortController().signal })
  let child = 0
  const subagents = { list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
    start: vi.fn(async () => ({ id: `receipt-child-${++child}`, result: Promise.resolve({ structured: VALID_OUTPUTS.miao_bi, output: [], stopReason: 'completed' }), dispose: async () => undefined })) }
  const service = intSwarmService({ getConfig: () => config, getLlm: () => ({ listProviders: () => [{ id: 'qwen-token-plan-cn' }], resolveModelInfo: async () => ({ inputModalities: ['text'] }) }),
    getSubagents: () => subagents, getTools: () => ({ register: () => () => undefined, guard: () => () => undefined, schemas: () => [{ name: 'read' }] }), getCredentials: () => undefined,
    getAttachments: () => undefined, dshHome: home, fetch: vi.fn() as typeof fetch, probe: async () => ({ ok: true, vision: true }), gitStatus: async () => undefined })
  services.push(service)
  const card = { title: 'receipt', goal: '独立交付', acceptance: ['有独立交付'], scope, flags: { uiCopy: true } }
  const made = await service.AddTaskCard(card, exec())
  const accept = (extra: Record<string, unknown> = {}) => service.AcceptTask({ task_id: made.task_id, decision: 'accept', summary: '根的总结不是证据', stopReason: '检查完成', ...extra }, exec())
  const produce = () => service.delegate({ task_id: made.task_id, role: 'miao_bi', prompt: '提交真实独立交付', session: 'oneshot' }, exec())
  const view = () => service.getStatus({ task_id: made.task_id }, exec()).tasks[0]!
  return { home, config, service, root, exec, card, made, accept, produce, view, features: () => captured, tasks: () => tasks }
}

describe('atomic server verification receipts', () => {
  it('旧参数可用，但根summary或伪造JSON没有独立来源不能签发receipt；unresolved不能完整通过', async () => {
    const f = await fixture()
    expect((await f.accept({ receipt: { issuer: 'independent-evidence-verifier' } })).status).toBe('blocked')
    expect(f.view().acceptance?.verificationReceipt).toBeUndefined()
    await f.produce()
    expect((await f.accept({ unresolved: ['仍有未解决目标'] })).status).toBe('blocked')
    expect(f.view().acceptance?.verificationReceipt).toBeUndefined()
  })

  it('receipt与accepted同一持久事务，重复合法快照复用ID，错误token不走兼容', async () => {
    const f = await fixture(); await f.produce()
    const first = await f.accept()
    expect(first.status).toBe('accepted')
    const receipt = f.view().acceptance!.verificationReceipt!
    expect(ValidateVerificationReceipt(receipt)).toBe(true)
    const saved = f.features().store.read().tasks.find(task => task.taskId === f.made.task_id)!
    expect(saved.acceptance?.verificationReceipt?.id).toBe(first.verification_token)
    expect(saved.acceptance?.status).toBe('accepted')
    expect((await f.accept({ summary: '重复说明不产生新验收' })).verification_token).toBe(receipt.id)
    expect((await f.accept({ verification_token: receipt.id })).verification_token).toBe(receipt.id)
    await expect(f.accept({ verification_token: 'vr-00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    expect(ValidateAcceptInput({ task_id: 'T-1', decision: 'accept', summary: '', stopReason: 'done', verification_token: { id: receipt.id } }).input).toBeUndefined()
  })

  it('锁外Jev复评前不发布accepted；同快照并发只复评一次', async () => {
    const f = await fixture(); await f.produce()
    f.config.jev.enabled = true; f.config.review.enabled = true
    const entered = deferred(), release = deferred()
    const ask = vi.spyOn(f.service.jev.getClient(), 'ask').mockImplementation(async () => { entered.resolve(); await release.promise; return { ok: false, reason: 'network', attempts: 1 } })
    const first = f.accept(); await entered.promise
    const second = f.accept(); await new Promise(resolve => setTimeout(resolve, 15))
    expect(f.view().acceptance?.status).not.toBe('accepted')
    expect(ask).toHaveBeenCalledTimes(1)
    release.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe('accepted'); expect(b.verification_token).toBe(a.verification_token)
    expect(a.assessment).toMatchObject({ status: 'unavailable' })
    await f.accept(); expect(ask).toHaveBeenCalledTimes(1)
  })

  it('持久化失败不发布live假accepted或消费receipt', async () => {
    const f = await fixture(); await f.produce()
    const store = f.features().store, original = store.update
    vi.spyOn(store, 'update').mockImplementation(async (type, write) => {
      if (type === 'accept/decision') throw new StateStoreError('STATE_TOO_LARGE', 'injected capacity failure')
      return original(type, write)
    })
    await expect(f.accept()).rejects.toThrow('injected capacity failure')
    expect(f.view().acceptance?.status).not.toBe('accepted')
    expect(store.read().tasks[0]!.acceptance?.verificationReceipt).toBeUndefined()
  })

  it.each(['artifact', 'policy', 'authorization', 'revision'] as const)('复评期间%s变化使CAS拒绝，不提交accepted', async kind => {
    const f = await fixture(kind === 'artifact' ? ['source.txt'] : [])
    if (kind === 'artifact') await writeFile(join(f.home, 'source.txt'), 'first')
    await f.produce(); f.config.jev.enabled = true; f.config.review.enabled = true
    const entered = deferred(), release = deferred()
    vi.spyOn(f.service.jev.getClient(), 'ask').mockImplementation(async () => { entered.resolve(); await release.promise; return { ok: false, reason: 'network', attempts: 1 } })
    const pending = f.accept(); void pending.catch(() => undefined); await entered.promise
    if (kind === 'artifact') await writeFile(join(f.home, 'source.txt'), 'changed')
    if (kind === 'policy') f.config.review.trustedAbove = 0.99
    if (kind === 'authorization') {
      const original = f.features().store.readPath
      vi.spyOn(f.features().store, 'readPath').mockImplementation(path => path[0] === 'authorizationDecisions' ? { changed: { id: 'changed', questionBinding: { taskId: f.made.task_id } } } as never : original!(path))
    }
    if (kind === 'revision') await f.service.AddTaskCard({ ...f.card, task_id: f.made.task_id, goal: '新目标', expected_card_revision: f.made.cardRevision }, f.exec())
    release.resolve()
    await expect(pending).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
    expect(f.view().acceptance?.status).not.toBe('accepted')
  })

  it('当前receipt对授权摘要不同或长期goal不同不能复用', async () => {
    const f = await fixture(); await f.produce(); await f.accept()
    const receipt = f.view().acceptance!.verificationReceipt!
    expect(IsVerificationReceiptCurrent(receipt, { ...receipt.binding, decisionDigest: 'f'.repeat(64) })).toBe(false)
    expect(IsVerificationReceiptCurrent(receipt, { ...receipt.binding, goalBinding: 'f'.repeat(64) })).toBe(false)
  })

  it('旧accepted无receipt仅为历史，不能凭旧独立输出直接铸新凭据', async () => {
    const f = await fixture(); await f.produce(); await f.accept()
    const { verificationReceipt: _old, ...historical } = f.view().acceptance!
    f.tasks().UpdateTask(f.made.task_id, { acceptance: historical })
    await f.features().persist('fixture/legacy-accepted', f.tasks(), { list: () => [] } as never)
    const result = await f.accept()
    expect(result.status).toBe('blocked')
    expect(result.missing.join('')).toContain('旧版accepted仅为历史')
    expect(result.verification_token).toBeUndefined()
  })

  it('持久事务锁内的授权变化仍拒绝消费，不能只依赖锁前摘要', async () => {
    const f = await fixture(); await f.produce()
    const store = f.features().store, original = store.update
    vi.spyOn(store, 'update').mockImplementation(async (type, write) => {
      if (type !== 'accept/decision' || !('build' in write)) return original(type, write)
      const saved = store.read()
      const changed = { ...saved, authorizationDecisions: { changed: { id: 'changed', questionBinding: { taskId: f.made.task_id } } } }
      // 只改变事务回调看到的当前授权事实；回调拒绝后没有伪造状态写入存储。
      await write.build(changed as unknown as typeof saved)
      throw new Error('CAS guard must reject before this line')
    })
    await expect(f.accept()).rejects.toMatchObject({ code: 'STALE_EVIDENCE' })
    expect(f.view().acceptance?.status).not.toBe('accepted')
  })
})
