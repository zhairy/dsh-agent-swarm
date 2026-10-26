import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFeatureSession, inspectFeatureState } from '../../src/feature-session.js'
import { createDurableStateStore, canonicalStateJson } from '../../src/state-store.js'
import { ChunkedState, LEGACY_SEGMENT_SPECS, PRE_GUARD_SEGMENT_SPECS, type SegmentSpecs } from '../../src/state-chunks.js'
import { getSwarmConfig } from '../../src/config.js'
import { intTaskStore } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'
import { ValidateTaskCard } from '../../src/policy.js'
import { getWorkspaceId } from '../../src/artifacts.js'
import { createMemoryHandoffEnvelope } from '../../src/memory-handoff.js'
import { digest } from '../../src/task-model.js'

type Features = Awaited<ReturnType<typeof createFeatureSession>>
type State = ReturnType<Features['store']['read']>
const homes: string[] = [], disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const newHome = async () => { const home = await mkdtemp(join(tmpdir(), 'swarm-independent-migration-')); homes.push(home); return home }
const initial = (scope: { rootSessionId: string; workspaceId: string }): State => ({ schemaVersion: 1,
  tasks: [{ taskId: 'T-1', sessionId: scope.rootSessionId, workspaceId: scope.workspaceId,
    card: ValidateTaskCard({ title: '兼容迁移', goal: '保留已确认的旧记录', acceptance: ['不丢失状态'], scope: [], flags: {} }).card!,
    gates: [], triage: { source: 'rules', rulesApplied: [] }, delegationIds: ['D-1', 'D-2'], rounds: 2, createdAt: 1, updatedAt: 1,
    requestRevision: 1, cardRevision: 1, workflowRevision: 1 }],
  delegations: ['D-1', 'D-2'].map(delegationId => ({ delegationId, taskId: 'T-1', role: 'miao_bi', roleName: '妙笔',
    status: 'failed', summary: '独立合成的历史失败记录', evidence: [], attempts: [], hardIsolation: true,
    unresolved: [], independence: 'achieved', startedAt: 1 })), threads: [], contexts: [], budgets: {},
  bindings: {}, bindingHistory: {}, messages: {}, messageAcks: {}, experiences: {} })
const tree = async (directory: string): Promise<Record<string, string>> => {
  const found: Record<string, string> = {}
  const walk = async (path: string, prefix = ''): Promise<void> => {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.name === 'owner.json') continue
      const relative = prefix + item.name
      if (item.isDirectory()) await walk(join(path, item.name), relative + '/')
      else found[relative] = sha(await readFile(join(path, item.name)))
    }
  }
  await walk(directory)
  return found
}

// This suite deliberately uses an unmodified released reader, never an
// approximation with relaxed validation. CI without that package skips it.
const oldRoot = process.env.SWARM_OLD_READER_DIR
describe.skipIf(oldRoot === undefined)('独立真实3.1.2 reader与schema/layout迁移', () => {
  it.each([{ layout: 1, snapshot: false }, { layout: 1, snapshot: true }, { layout: 2, snapshot: false }, { layout: 2, snapshot: true }])(
    '真实旧writer layout$layout snapshot=$snapshot → 新版保全记录并拒绝旧writer续写', async ({ layout, snapshot }) => {
      const load = (file: string) => import(pathToFileURL(join(oldRoot!, 'lib', file)).href)
      const oldStore = await load('state-store.js') as { createDurableStateStore: typeof createDurableStateStore }
      const oldChunks = await load('state-chunks.js') as { LEGACY_SEGMENT_SPECS: SegmentSpecs; SWARM_SEGMENT_SPECS: SegmentSpecs; ChunkedState: typeof ChunkedState }
      const oldFeatures = await load('feature-session.js') as { inspectFeatureState: typeof inspectFeatureState }
      expect(JSON.parse(await readFile(join(oldRoot!, 'package.json'), 'utf8')).version).toBe('3.1.2')
      const home = await newHome(), scope = { rootSessionId: 'migration-root', workspaceId: await getWorkspaceId(home) }
      const state = initial(scope), directory = join(home, 'state', scope.workspaceId, digest(scope.rootSessionId))
      expect(oldFeatures.inspectFeatureState(state, scope).ok).toBe(true)
      const specs = layout === 1 ? oldChunks.LEGACY_SEGMENT_SPECS : oldChunks.SWARM_SEGMENT_SPECS
      const mapped = layout === 1 ? LEGACY_SEGMENT_SPECS : PRE_GUARD_SEGMENT_SPECS
      expect(ChunkedState.fromState(state, mapped).rootChecksum()).toBe(oldChunks.ChunkedState.fromState(state, specs).rootChecksum())
      const old = await oldStore.createDurableStateStore({ directory, initialState: state, enabled: true, segments: specs,
        legacySegments: oldChunks.LEGACY_SEGMENT_SPECS, layoutVersion: layout, snapshotEvery: snapshot ? 1 : 64,
        validate: raw => oldFeatures.inspectFeatureState(raw, scope) })
      disposers.push(old.dispose)
      await old.commit('released/old-write', draft => { draft.tasks[0]!.updatedAt = 2 })
      const oldState = old.read(), oldRootHash = old.getRootChecksum()
      expect(ChunkedState.fromState(oldState, mapped).rootChecksum()).toBe(oldRootHash)
      if (!snapshot) {
        const rows = (await readFile(join(directory, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        const expectedFingerprint = sha(canonicalStateJson(Object.entries(mapped).sort(([a], [b]) => a < b ? -1 : 1).map(([name, spec]) => [name, spec.kind, spec.bucketOf !== undefined])))
        expect(rows.at(-1)).toMatchObject({ layout, layoutFingerprint: expectedFingerprint })
      }
      await old.dispose()
      const features = await createFeatureSession({ ...scope, cwd: home, dshHome: home,
        config: getSwarmConfig({ persistence: { enabled: true, directory: join(home, 'state') } }),
        tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 1000 })
      disposers.push(features.dispose)
      const migrated = features.store.read()
      expect(migrated.schemaVersion).toBe(2)
      expect(migrated.tasks[0]).toMatchObject({ ...oldState.tasks[0], recovered: true })
      expect(migrated.delegations).toEqual(oldState.delegations)
      expect(migrated.runtimeControls).toEqual({}); expect(migrated.progressHistory).toEqual({}); expect(migrated.authorizationDecisions).toEqual({})
      const lineageId = await features.progress.bindTask(migrated.tasks[0]!, scope.workspaceId)
      await features.progress.observe({ lineageId, taskId: 'T-1', action: 'checkpoint', projection: { actual: 'new-read' } })
      expect(features.progress.forTask('T-1')).toMatchObject({ historyCount: 1, activations: 1, legacyBaseline: true })
      const next = features.store.read()
      expect(inspectFeatureState(next, scope).ok).toBe(true)
      expect(oldFeatures.inspectFeatureState(next, scope).ok).toBe(false)
      await features.dispose()
      const before = await tree(directory)
      await expect(oldStore.createDurableStateStore({ directory, initialState: state, enabled: true,
        segments: oldChunks.SWARM_SEGMENT_SPECS, legacySegments: oldChunks.LEGACY_SEGMENT_SPECS, layoutVersion: 2,
        validate: raw => oldFeatures.inspectFeatureState(raw, scope) })).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
      expect(await tree(directory)).toEqual(before)
    })
})

describe('独立交接schema来源边界', () => {
  it('declared 3.1.3 origin does not silently reset a missing schema2 guard history to empty legacy history', async () => {
    const home = await newHome(), scope = { rootSessionId: 'handoff-root', workspaceId: await getWorkspaceId(home) }
    const directory = join(home, 'share', 'dsh-agent-swarm', 'maintenance', scope.workspaceId, digest(scope.rootSessionId))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const pending = join(directory, 'pending.json')
    await writeFile(pending, canonicalStateJson(createMemoryHandoffEnvelope({ ...scope, state: initial(scope), sourceVersion: '3.1.3' })), { mode: 0o600 })
    const before = await readFile(pending, 'utf8')
    const loading = createFeatureSession({ ...scope, cwd: home, dshHome: home,
      config: getSwarmConfig({ persistence: { enabled: false } }), tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 1000 })
    // Retain cleanup even if a faulty initializer wrongly admits this state.
    void loading.then(features => { disposers.push(features.dispose) }, () => undefined)
    await expect(loading).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
    expect(await readFile(pending, 'utf8')).toBe(before)
  })
})
