import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSwarmEventJournal, EVENT_JOURNAL_MAX_LINE_BYTES } from '../../src/event-journal.js'
import { createDurableStateStore } from '../../src/state-store.js'
import { appendStateCommitToJournal, initializeStateJournal, recoverStateFromJournal } from '../../src/state-journal.js'
import { getSwarmConfig } from '../../src/config.js'
import { createFeatureSession } from '../../src/feature-session.js'
import { intTaskStore } from '../../src/evidence.js'
import { intThreadRegistry } from '../../src/threads.js'
import type { RouteHealthEntry } from '../../src/domain/routing/health.js'
import { ChunkedState } from '../../src/state-chunks.js'

interface FixtureState { schemaVersion: 1; count: number; body: string; removed?: boolean }
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const directory = (): string => { const value = mkdtempSync(join(tmpdir(), 'swarm-state-journal-')); directories.push(value); return value }
const validate = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (value as FixtureState).schemaVersion === 1 && Number.isSafeInteger((value as FixtureState).count)

describe('journal-only state recovery', () => {
  it('reconstructs a chunked snapshot and later mutations without reading the disposable StateStore', async () => {
    const root = directory(), journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-state' })
    const initial: FixtureState = { schemaVersion: 1, count: 0, body: 'x'.repeat(70 * 1024) }
    initializeStateJournal(journal, initial, 0, {})
    const store = await createDurableStateStore<FixtureState>({ directory: join(root, 'materialized'), initialState: initial,
      journalOnly: true, initialSequence: 0, beforeCommit: (fact) => appendStateCommitToJournal(journal, fact) })
    await store.update('fixture/update', { patch: { whole: { count: 1, body: 'y'.repeat(70 * 1024) } } })
    await store.dispose()

    const recovered = recoverStateFromJournal<FixtureState>(journal, { specs: {}, validate })
    expect(recovered).toMatchObject({ sequence: 1, commits: 2, incomplete: 0, issues: [], state: { schemaVersion: 1, count: 1 } })
    expect(recovered.state?.body).toHaveLength(70 * 1024)
    expect(Math.max(...journal.read().events.map((event) => Buffer.byteLength(`${JSON.stringify(event)}\n`)))).toBeLessThan(EVENT_JOURNAL_MAX_LINE_BYTES)
  })

  it.each([1024, 2048])('adapts state chunks to a %i-byte EventJournal line ceiling', (maxLineBytes) => {
    const root = directory(), journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: `root-small-lines-${maxLineBytes}`, maxLineBytes })
    const initial: FixtureState = { schemaVersion: 1, count: 1, body: 'z'.repeat(20 * 1024) }
    initializeStateJournal(journal, initial, 0, {})
    expect(recoverStateFromJournal<FixtureState>(journal, { specs: {}, validate }).state).toEqual(initial)
    expect(Math.max(...journal.read().events.map((event) => Buffer.byteLength(`${JSON.stringify(event)}\n`)))).toBeLessThanOrEqual(maxLineBytes)
  })

  it('ignores an unfinished chunk group instead of exposing a half-applied state', () => {
    const root = directory(), journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-incomplete' })
    const initial: FixtureState = { schemaVersion: 1, count: 2, body: 'ok' }
    initializeStateJournal(journal, initial, 0, {})
    journal.append({ eventId: 'begin', idempotencyKey: 'begin', type: 'state/journal-begin', actor: { kind: 'host', id: 'test' }, payload: {
      protocol: 1, commitId: 'a'.repeat(64), kind: 'snapshot', representation: 'state', type: 'state/test', sequence: 1,
      previousChecksum: 'b'.repeat(64), checksum: 'c'.repeat(64), contentHash: 'd'.repeat(64), contentBytes: 1, chunks: 1
    } })
    const recovered = recoverStateFromJournal<FixtureState>(journal, { specs: {}, validate })
    expect(recovered.state).toEqual(initial)
    expect(recovered).toMatchObject({ sequence: 0, commits: 1, incomplete: 1, issues: [] })
  })

  it('rejects a state chain whose base checksum does not match the recovered state', () => {
    const root = directory(), journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-gap' })
    const initial: FixtureState = { schemaVersion: 1, count: 0, body: 'ok' }
    initializeStateJournal(journal, initial, 0, {})
    appendStateCommitToJournal(journal, { kind: 'patch', type: 'fixture/gap', sequence: 2,
      previousChecksum: '0'.repeat(64), checksum: '1'.repeat(64), patch: { whole: { count: 2, body: 'bad' } } })
    const recovered = recoverStateFromJournal<FixtureState>(journal, { specs: {}, validate })
    expect(recovered.state).toEqual(initial)
    expect(recovered.issues.some((issue) => issue.reason === 'state-journal-broken-chain')).toBe(true)
  })

  it('rejects a later full snapshot that forks the checksum or sequence chain', () => {
    const root = directory(), journal = createSwarmEventJournal({ directory: join(root, 'events'), rootSessionId: 'root-fork' })
    const initial: FixtureState = { schemaVersion: 1, count: 0, body: 'ok' }
    const next: FixtureState = { schemaVersion: 1, count: 9, body: 'fork' }
    initializeStateJournal(journal, initial, 0, {})
    appendStateCommitToJournal(journal, { kind: 'snapshot', type: 'fixture/fork', sequence: 1,
      previousChecksum: 'f'.repeat(64), checksum: ChunkedState.fromState(next, {}, { verified: true }).rootChecksum(), state: next })
    const recovered = recoverStateFromJournal<FixtureState>(journal, { specs: {}, validate })
    expect(recovered.state).toEqual(initial)
    expect(recovered.issues.some((issue) => issue.reason === 'state-journal-broken-chain')).toBe(true)
  })

  it('reopens a real FeatureSession after deleting its legacy StateStore directory', async () => {
    const home = directory()
    const journal = createSwarmEventJournal({ directory: join(home, 'events'), rootSessionId: 'root-feature' })
    const config = getSwarmConfig({ persistence: { enabled: true } })
    const input = { rootSessionId: 'root-feature', cwd: home, dshHome: home, config, journal,
      tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 1000 }
    const first = await createFeatureSession(input)
    const stateDirectory = first.store.directory
    await first.store.update('fixture/runtime', { patch: { whole: { runtime: { rootEditAt: 17, taskSequence: 3,
      counters: { native: 1, jev: 2, review: 3, session: 4 }, rootUpgradeExplicit: ['T-1'] } } } })
    await first.persistRouteHealth([{ key: 'domain:subscription', kind: 'quota_exhausted', failedAt: 10, resetAt: 20,
      aliases: ['domain:subscription'], route: { provider: 'provider-a', model: 'model-a' } }] satisfies RouteHealthEntry[])
    const sequence = first.store.getSequence()
    await first.dispose()
    rmSync(stateDirectory, { recursive: true, force: true })

    const reopened = await createFeatureSession({ ...input, tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 2000 })
    try {
      expect(reopened.store.journalOnly).toBe(true)
      expect(reopened.store.getSequence()).toBe(sequence)
      expect(reopened.getRestoredRuntime()).toMatchObject({ rootEditAt: 17, taskSequence: 3, rootUpgradeExplicit: ['T-1'] })
      expect(await reopened.readRouteHealth()).toEqual([expect.objectContaining({ key: 'domain:subscription', kind: 'quota_exhausted' })])
    } finally { await reopened.dispose() }
  })

  it('keeps journal state authoritative when persistence.enabled is false', async () => {
    const home = directory()
    const journal = createSwarmEventJournal({ directory: join(home, 'events'), rootSessionId: 'root-journal-config' })
    const config = getSwarmConfig({ persistence: { enabled: false } })
    const input = { rootSessionId: 'root-journal-config', cwd: home, dshHome: home, config, journal,
      tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 1000 }
    const first = await createFeatureSession(input)
    expect(first.store).toMatchObject({ durable: false, recoveryDurable: true })
    await first.store.update('fixture/runtime', { patch: { whole: { runtime: { rootEditAt: 33, taskSequence: 0,
      counters: { native: 0, jev: 0, review: 0, session: 0 }, rootUpgradeExplicit: [] } } } })
    await first.dispose()

    const reopened = await createFeatureSession({ ...input, tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 2000 })
    try {
      expect(reopened.store).toMatchObject({ durable: false, recoveryDurable: true, journalOnly: true })
      expect(reopened.getRestoredRuntime()).toMatchObject({ rootEditAt: 33 })
    } finally { await reopened.dispose() }
  })

  it('fails FeatureSession boot when an immutable journal segment is corrupt', async () => {
    const home = directory()
    const journal = createSwarmEventJournal({ directory: join(home, 'events'), rootSessionId: 'root-fatal', maxLineBytes: 2048, sealAfterBytes: 4096 })
    initializeStateJournal(journal, { schemaVersion: 1, count: 1, body: 'x'.repeat(20 * 1024) } satisfies FixtureState, 0, {})
    const sealed = journal.segments().find((segment) => segment !== journal.path)
    expect(sealed).toBeDefined()
    writeFileSync(sealed!, `${readFileSync(sealed!, 'utf8')}null\n`)
    const reopened = createSwarmEventJournal({ directory: join(home, 'events'), rootSessionId: 'root-fatal', maxLineBytes: 2048, sealAfterBytes: 4096 })
    await expect(createFeatureSession({ rootSessionId: 'root-fatal', cwd: home, dshHome: home,
      config: getSwarmConfig({ persistence: { enabled: false } }), journal: reopened, tasks: intTaskStore(), threads: intThreadRegistry(), now: () => 1000 }))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' })
  })
})
