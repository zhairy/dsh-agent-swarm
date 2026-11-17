import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_NOTEBOOK_MARKER_SCAN_EVENTS,
  createNotebookContextPort,
  withNotebookRouterDraft,
  type NotebookContextHost,
  type NotebookContextSession
} from '../../src/adapters/dsh-host/notebook-context.ts'
import { createNotebookSnapshotStore } from '../../src/notebook-snapshot.ts'

const roots: string[] = []
const realSessionSdkRoot = resolve(
  'third_party/dsh-notebook/node_modules/@deepseek-ai/dsh-session'
)

const createRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-context-test-'))
  roots.push(root)
  return root
}

const directoryIdentity = (path: string): string => {
  const stat = lstatSync(path, { bigint: true })
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
}

const withHostEntry = async <T>(entry: string | undefined, action: () => Promise<T>): Promise<T> => {
  const previous = process.argv[1]
  if (entry === undefined) delete process.argv[1]
  else process.argv[1] = entry
  try {
    return await action()
  } finally {
    if (previous === undefined) delete process.argv[1]
    else process.argv[1] = previous
  }
}

const createHostedSdkLayout = (): { root: string; hostEntry: string; sessionPkg: string } => {
  const root = createRoot()
  const hostRoot = join(root, 'host', 'node_modules')
  const hostEntry = join(hostRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const sessionPkg = join(hostRoot, '@deepseek-ai', 'dsh-session')
  mkdirSync(join(hostRoot, '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(hostEntry, '', { mode: 0o600 })
  symlinkSync(realSessionSdkRoot, sessionPkg, 'dir')
  return { root, hostEntry, sessionPkg }
}

const createSession = (input: {
  id: string
  parentSession?: string
  cwd?: string
  seq?: number
  firstLiveSeq?: number
}): NotebookContextSession => {
  const seq = input.seq ?? 0
  return {
    id: input.id,
    header: {
      id: input.id,
      ...(input.parentSession === undefined ? {} : { parentSession: input.parentSession }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd })
    },
    seq,
    firstLiveSeq: input.firstLiveSeq ?? seq,
    append: vi.fn()
  }
}

const createHost = (input: {
  session: NotebookContextSession
  events: readonly unknown[]
  cwd: string
  inheritedEventCount?: number
  cursor?: number
  inspectCursor?: number
  live?: boolean
  inspectLive?: boolean
  flushResult?: boolean
  hostPath?: string | undefined
  appendPluginRecord?: (session: NotebookContextSession, type: string, data: unknown) => number
}): {
  host: NotebookContextHost
  disposed: () => number
  flush: ReturnType<typeof vi.fn>
} => {
  let disposeCount = 0
  const cursor = input.cursor ?? Math.max(-1, input.events.length - 1)
  const inspectCursor = input.inspectCursor ?? cursor
  const observationSource = input.live === true ? 'live' as const : 'prepared' as const
  const inspectLive = input.inspectLive ?? input.live === true
  const inspectedSession = inspectLive
    ? {
        ...input.session,
        seq: inspectCursor + 1
      }
    : {
        ...input.session,
        firstLiveSeq: inspectCursor + 1,
        seq: inspectCursor + 2
      }
  const observation = {
    source: observationSource,
    header: input.session.header,
    inheritedEventCount: input.inheritedEventCount ?? 0,
    events: input.events,
    cursor,
    retain: () => observation,
    [Symbol.dispose]: () => { disposeCount += 1 }
  }
  const flush = vi.fn(async () => input.flushResult ?? true)
  const hostPath = input.hostPath === undefined ? input.cwd : input.hostPath
  const fs = {
    lstat: vi.fn(async () => ({ type: 'directory' as const, version: 'v1' })),
    resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
    stat: vi.fn(async () => ({ type: 'directory' as const, version: 'v1' })),
    processPath: vi.fn((target: { targetKey: string }) => target.targetKey),
    processPathFromHostPath: vi.fn(() => hostPath)
  }
  const host: NotebookContextHost = {
    get: (name: string) => ({
      sessionQuery: {
        observeSession: vi.fn(async (sessionId: string) => {
          if (sessionId !== input.session.id) {
            throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
          }
          return observation
        }),
        inspectSession: vi.fn(async (_sessionId, read) => read(inspectedSession))
      },
      sessions: {
        get: vi.fn((sessionId: string) => inspectLive && sessionId === input.session.id ? inspectedSession : undefined),
        flush
      },
      workingDirectory: { get: () => input.cwd },
      fs
    })[name],
    appendPluginRecord: input.appendPluginRecord
  }
  return { host, disposed: () => disposeCount, flush }
}

const createSequencedHost = (input: {
  sessionId: string
  rootSessionId: string
  cwd: string
  cuts: readonly {
    events: readonly unknown[]
    cursor: number
    inspectCursor: number
    inspectLive?: boolean
  }[]
}): {
  host: NotebookContextHost
  observations: () => number
  inspections: () => number
  disposed: () => number
} => {
  let observationIndex = 0
  let inspectionIndex = 0
  let disposeCount = 0
  const sessionsGet = vi.fn()
  const host: NotebookContextHost = {
    get: (name: string) => ({
      sessionQuery: {
        observeSession: vi.fn(async (sessionId: string) => {
          if (sessionId !== input.sessionId) {
            throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
          }
          const cut = input.cuts[observationIndex]
          if (cut === undefined) throw new Error('unexpected extra observation')
          observationIndex += 1
          const observation = {
            source: cut.inspectLive === true ? 'live' as const : 'prepared' as const,
            header: { id: input.sessionId, cwd: input.cwd, parentSession: input.rootSessionId },
            inheritedEventCount: 0,
            events: cut.events,
            cursor: cut.cursor,
            retain: () => observation,
            [Symbol.dispose]: () => { disposeCount += 1 }
          }
          return observation
        }),
        inspectSession: vi.fn(async (_sessionId, read) => {
          const cut = input.cuts[inspectionIndex]
          if (cut === undefined) throw new Error('unexpected extra inspection')
          inspectionIndex += 1
          const live = cut.inspectLive === true
          const session = live
            ? {
                id: input.sessionId,
                header: { id: input.sessionId, cwd: input.cwd, parentSession: input.rootSessionId },
                seq: cut.inspectCursor + 1,
                firstLiveSeq: cut.inspectCursor + 1,
                append: vi.fn()
              }
            : {
                id: input.sessionId,
                header: { id: input.sessionId, cwd: input.cwd, parentSession: input.rootSessionId },
                firstLiveSeq: cut.inspectCursor + 1,
                seq: cut.inspectCursor + 2,
                append: vi.fn()
              }
          sessionsGet.mockReturnValue(live ? session : undefined)
          return read(session)
        })
      },
      sessions: {
        get: sessionsGet,
        flush: vi.fn(async () => true)
      },
      workingDirectory: { get: () => input.cwd },
      fs: {
        lstat: vi.fn(async () => ({ type: 'directory' as const })),
        resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
        stat: vi.fn(async () => ({ type: 'directory' as const })),
        processPath: vi.fn((target: { targetKey: string }) => target.targetKey),
        processPathFromHostPath: vi.fn((hostPath: string) => hostPath)
      }
    })[name]
  }
  return {
    host,
    observations: () => observationIndex,
    inspections: () => inspectionIndex,
    disposed: () => disposeCount
  }
}

const liveMarker = (input: {
  sessionId: string
  rootSessionId: string
  taskId: string
  attemptId: string
  seq: number
}): unknown => ({
  type: 'plugin:swarm/notebook-task-binding',
  seq: input.seq,
  time: input.seq + 1,
  ignorable: true,
  data: {
    schemaVersion: 1,
    sessionId: input.sessionId,
    rootSessionId: input.rootSessionId,
    taskId: input.taskId,
    attemptId: input.attemptId
  }
})

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Notebook Host context', () => {
  it('只依赖 rc3 sessionQuery 公开异步接口，不调用已废弃的事件读取', () => {
    const source = readFileSync(new URL('../../src/adapters/dsh-host/notebook-context.ts', import.meta.url), 'utf8')
    expect(source).toContain('observeSession')
    expect(source).toContain('inspectSession')
    expect(source).toContain('createRequire(hostEntry)')
    expect(source).not.toContain('import(SESSION_SDK_SPECIFIER)')
    expect(source).not.toContain('snapshotEvents(')
    expect(source).not.toContain('ownEvents(')
  })

  it('无 peer 依赖时从真实 Host 原生入口解析同一个 rc3 Session SDK', async () => {
    const fixture = createHostedSdkLayout()
    const sdk = await import(pathToFileURL(join(realSessionSdkRoot, 'lib', 'index.js')).href)
    const session = sdk.Session.create(
      sdk.SessionId('host-child'),
      [],
      {
        version: sdk.SESSION_FORMAT_VERSION,
        id: sdk.SessionId('host-child'),
        createdAt: Date.now(),
        cwd: fixture.root,
        parentSession: sdk.SessionId('host-root'),
        isSeeded: false
      },
      sdk.SessionLogOffset(0)
    )
    const { host, flush } = createHost({
      session: session as unknown as NotebookContextSession,
      events: [],
      cwd: fixture.root
    })
    const port = createNotebookContextPort({ host })

    const receipt = await withHostEntry(fixture.hostEntry, () => port.record({
      id: 'host-child',
      session: session as unknown as NotebookContextSession
    }, {
      taskId: 'T-host',
      rootSessionId: 'host-root',
      attemptId: 'attempt-host'
    }))

    const record = sdk.pluginRecordOf(session.eventAt(sdk.SessionSeq(receipt.seq)))
    expect(record).toMatchObject({
      type: 'plugin:swarm/notebook-task-binding',
      data: {
        schemaVersion: 1,
        sessionId: 'host-child',
        rootSessionId: 'host-root',
        taskId: 'T-host',
        attemptId: 'attempt-host'
      }
    })
    expect(flush).toHaveBeenCalledWith(session)
  })

  it('未知 Host 入口与缺少 appendPluginRecord 时明确不可用', async () => {
    const root = createRoot()
    const session = createSession({ id: 'child-session', parentSession: 'root-session', cwd: root })
    const { host } = createHost({ session, events: [], cwd: root })
    const port = createNotebookContextPort({ host })

    await expect(withHostEntry(undefined, () => port.record({
      id: session.id,
      session
    }, {
      taskId: 'T-1',
      rootSessionId: 'root-session',
      attemptId: 'attempt-1'
    }))).rejects.toMatchObject({
      code: 'NOTEBOOK_CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('Host process.argv[1]')
    })

    const fixture = createHostedSdkLayout()
    rmSync(fixture.sessionPkg)
    mkdirSync(fixture.sessionPkg, { recursive: true })
    writeFileSync(join(fixture.sessionPkg, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-session',
      version: '0.0.0-test',
      type: 'module',
      exports: './index.js'
    }))
    writeFileSync(join(fixture.sessionPkg, 'index.js'), 'export const noAppendPluginRecord = true\n')

    await expect(withHostEntry(fixture.hostEntry, () => port.record({
      id: session.id,
      session
    }, {
      taskId: 'T-1',
      rootSessionId: 'root-session',
      attemptId: 'attempt-1'
    }))).rejects.toMatchObject({
      code: 'NOTEBOOK_CONTEXT_UNAVAILABLE',
      message: expect.stringContaining('appendPluginRecord')
    })
  })

  it('在真实 child session 上写入 SDK 公共 plugin record，并等待 durable flush', async () => {
    const root = createRoot()
    const session = createSession({
      id: 'child-session',
      parentSession: 'root-session',
      cwd: root
    })
    const records: Array<{ session: NotebookContextSession; type: string; data: unknown }> = []
    const appendPluginRecord = vi.fn((target: NotebookContextSession, type: string, data: unknown) => {
      records.push({ session: target, type, data })
      return 17
    })
    const { host, flush } = createHost({
      session,
      events: [],
      cwd: root,
      appendPluginRecord
    })
    const port = createNotebookContextPort({ host })

    await expect(withHostEntry(undefined, () => port.record({ id: session.id, session }, {
      taskId: 'T-1',
      rootSessionId: 'root-session',
      attemptId: 'attempt-1'
    }))).resolves.toEqual({
      sessionId: 'child-session',
      eventType: 'plugin:swarm/notebook-task-binding',
      seq: 17,
      flushed: true
    })

    expect(records).toEqual([{
      session,
      type: 'plugin:swarm/notebook-task-binding',
      data: {
        schemaVersion: 1,
        sessionId: 'child-session',
        rootSessionId: 'root-session',
        taskId: 'T-1',
        attemptId: 'attempt-1'
      }
    }])
    expect(flush).toHaveBeenCalledWith(session)
  })

  it('flush 未确认持久化时拒绝记录成功', async () => {
    const root = createRoot()
    const session = createSession({ id: 'child-session', parentSession: 'root-session', cwd: root })
    const { host } = createHost({
      session,
      events: [],
      cwd: root,
      flushResult: false,
      appendPluginRecord: () => 1
    })
    const port = createNotebookContextPort({ host })

    await expect(port.record({ id: session.id, session }, {
      taskId: 'T-1',
      rootSessionId: 'root-session',
      attemptId: 'attempt-1'
    })).rejects.toMatchObject({ code: 'NOTEBOOK_CONTEXT_NOT_DURABLE' })
  })

  it('冷读最新子会话 marker，并用同 cursor 的 inspectSession 取 trusted cwd', async () => {
    const root = createRoot()
    const session = createSession({ id: 'child-session', parentSession: 'root-session', cwd: root })
    const events = [
      {
        type: 'plugin:swarm/notebook-task-binding',
        seq: 0,
        time: 1,
        ignorable: true,
        data: { schemaVersion: 1, sessionId: 'child-session', rootSessionId: 'root-session', taskId: 'T-old', attemptId: 'attempt-old' }
      },
      {
        type: 'plugin:swarm/notebook-task-binding',
        seq: 1,
        time: 2,
        ignorable: true,
        data: { schemaVersion: 1, sessionId: 'child-session', rootSessionId: 'root-session', taskId: 'T-new', attemptId: 'attempt-new' }
      },
      { type: 'tool/call', seq: 2, time: 3, data: {} }
    ]
    const { host, disposed } = createHost({
      session,
      events,
      cwd: root,
      inheritedEventCount: 0,
      cursor: 2
    })
    const port = createNotebookContextPort({ host })

    await expect(port.read('child-session')).resolves.toEqual({
      schemaVersion: 1,
      sessionId: 'child-session',
      managed: true,
      taskId: 'T-new',
      agentId: 'child-session',
      attemptId: 'attempt-new',
      rootSessionId: 'root-session',
      cwd: root,
      directoryIdentity: directoryIdentity(root),
      source: 'swarm-marker'
    })
    expect(disposed()).toBe(1)
  })

  it('真实 prepared Session 的 synthetic resume marker 使用 firstLiveSeq，不误判 cursor 变化', async () => {
    const root = createRoot()
    const sdk = await import(pathToFileURL(join(realSessionSdkRoot, 'lib', 'index.js')).href)
    const sessionId = 'prepared-child'
    const rootSessionId = 'prepared-root'
    const marker = {
      type: 'plugin:swarm/notebook-task-binding',
      seq: 0,
      time: 1,
      ignorable: true,
      data: {
        schemaVersion: 1,
        sessionId,
        rootSessionId,
        taskId: 'T-prepared',
        attemptId: 'attempt-prepared'
      }
    }
    const session = sdk.Session.create(
      sdk.SessionId(sessionId),
      [marker],
      {
        version: sdk.SESSION_FORMAT_VERSION,
        id: sdk.SessionId(sessionId),
        createdAt: Date.now(),
        cwd: root,
        parentSession: sdk.SessionId(rootSessionId),
        isSeeded: false
      },
      sdk.SessionLogOffset(0)
    )
    expect(session.firstLiveSeq).toBe(1)
    expect(session.seq).toBe(2)
    expect(session.eventAt(1).type).toBe('session/end-seed')

    const { host } = createHost({
      session: session as unknown as NotebookContextSession,
      events: [marker],
      cwd: root,
      cursor: 0
    })
    const expected = {
      schemaVersion: 1,
      sessionId,
      managed: true,
      taskId: 'T-prepared',
      agentId: sessionId,
      attemptId: 'attempt-prepared',
      rootSessionId,
      cwd: root,
      directoryIdentity: directoryIdentity(root),
      source: 'swarm-marker'
    }

    await expect(createNotebookContextPort({ host }).read(sessionId)).resolves.toEqual(expected)

    const fallback = await import(pathToFileURL(resolve(
      'third_party/dsh-notebook/lib/notebook-host-context.js'
    )).href) as {
      createNotebookHostContextResolver: (ctx: { get: (name: string) => unknown }) =>
        (sessionId: string, signal?: AbortSignal) => Promise<unknown>
    }
    const resolveFallback = fallback.createNotebookHostContextResolver({
      get: name => host.get(name)
    })
    await expect(resolveFallback(sessionId)).resolves.toEqual(expected)
  })

  it('live Session 仍用 seq-1，并拒绝 observe prepared 到 inspect live 的 source 切换', async () => {
    const root = createRoot()
    const liveSession = createSession({
      id: 'live-session',
      parentSession: 'live-root',
      cwd: root,
      seq: 4,
      firstLiveSeq: 1
    })
    const events = [{
      type: 'plugin:swarm/notebook-task-binding',
      seq: 3,
      time: 4,
      ignorable: true,
      data: {
        schemaVersion: 1,
        sessionId: 'live-session',
        rootSessionId: 'live-root',
        taskId: 'T-live',
        attemptId: 'attempt-live'
      }
    }]
    const live = createHost({
      session: liveSession,
      events,
      cwd: root,
      cursor: 3,
      live: true
    })
    await expect(createNotebookContextPort({ host: live.host }).read('live-session')).resolves.toMatchObject({
      managed: true,
      taskId: 'T-live',
      attemptId: 'attempt-live',
      source: 'swarm-marker'
    })

    const switched = createHost({
      session: createSession({
        id: 'switched-session',
        parentSession: 'switched-root',
        cwd: root,
        seq: 4,
        firstLiveSeq: 1
      }),
      events: [{
        ...events[0]!,
        data: {
          ...events[0]!.data,
          sessionId: 'switched-session',
          rootSessionId: 'switched-root'
        }
      }],
      cwd: root,
      cursor: 3,
      inspectLive: true
    })
    await expect(createNotebookContextPort({ host: switched.host }).read('switched-session')).rejects.toMatchObject({
      code: 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH'
    })
  })

  it('工具或任务事件造成一次 cursor 增长后，用 fresh cut 重观测并稳定读取', async () => {
    const root = createRoot()
    const sessionId = 'retry-stable-session'
    const rootSessionId = 'retry-stable-root'
    const marker = liveMarker({ sessionId, rootSessionId, taskId: 'T-stable', attemptId: 'attempt-stable', seq: 0 })
    const sequenced = createSequencedHost({
      sessionId,
      rootSessionId,
      cwd: root,
      cuts: [
        { events: [marker], cursor: 0, inspectCursor: 1, inspectLive: true },
        {
          events: [marker, { type: 'tool/call', seq: 1, time: 2, data: { name: 'read' } }],
          cursor: 1,
          inspectCursor: 1,
          inspectLive: true
        }
      ]
    })
    const port = createNotebookContextPort({ host: sequenced.host })

    await expect(port.read(sessionId)).resolves.toMatchObject({
      managed: true,
      taskId: 'T-stable',
      attemptId: 'attempt-stable',
      source: 'swarm-marker'
    })
    expect(sequenced.observations()).toBe(2)
    expect(sequenced.inspections()).toBe(2)
    expect(sequenced.disposed()).toBe(2)
  })

  it('连续 cursor 变化到重观测上限后明确 stale，不复用旧 marker', async () => {
    const root = createRoot()
    const sessionId = 'retry-unstable-session'
    const rootSessionId = 'retry-unstable-root'
    const marker = liveMarker({ sessionId, rootSessionId, taskId: 'T-old', attemptId: 'attempt-old', seq: 0 })
    const sequenced = createSequencedHost({
      sessionId,
      rootSessionId,
      cwd: root,
      cuts: [
        { events: [marker], cursor: 0, inspectCursor: 1, inspectLive: true },
        {
          events: [marker, { type: 'tool/call', seq: 1, time: 2, data: { name: 'read' } }],
          cursor: 1,
          inspectCursor: 2,
          inspectLive: true
        },
        {
          events: [
            marker,
            { type: 'tool/call', seq: 1, time: 2, data: { name: 'read' } },
            { type: 'job/settled', seq: 2, time: 3, data: { jobId: 'job-1' } }
          ],
          cursor: 2,
          inspectCursor: 3,
          inspectLive: true
        }
      ]
    })
    const port = createNotebookContextPort({ host: sequenced.host })

    await expect(port.read(sessionId)).rejects.toMatchObject({
      code: 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH',
      message: expect.stringMatching(/连续|上限|稳定/)
    })
    expect(sequenced.observations()).toBe(3)
    expect(sequenced.inspections()).toBe(3)
    expect(sequenced.disposed()).toBe(3)
  })

  it('重观测切换到 T2 后不会复用 T1 持久快照', async () => {
    const root = createRoot()
    const dshHome = join(root, 'dsh')
    const workspace = join(root, 'workspace')
    const notebooks = join(workspace, 'notebooks')
    mkdirSync(notebooks, { recursive: true })
    const savedPath = join(notebooks, 'task-a.ipynb')
    writeFileSync(savedPath, '{}', { mode: 0o600 })
    const sessionId = 'retry-task-switch-session'
    const rootSessionId = 'retry-task-switch-root'
    const store = createNotebookSnapshotStore({ dshHome })
    await store.save({
      sessionId,
      savedAt: '2026-11-17T10:00:00.000Z',
      savedPath,
      notebook: {
        cells: [{ id: 'cell-1', cell_type: 'code', source: '41 + 1', outputs: [], metadata: {} }],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5
      },
      task: { id: 'T-1', agentId: sessionId, attemptId: 'attempt-a', managed: true },
      project: {
        cwd: workspace,
        repositoryRoot: workspace,
        directoryIdentity: directoryIdentity(workspace)
      },
      boundary: { mode: 'write', operation: 'file', writeScopes: [notebooks] }
    })

    const taskA = liveMarker({
      sessionId,
      rootSessionId,
      taskId: 'T-1',
      attemptId: 'attempt-a',
      seq: 0
    })
    const taskB = liveMarker({
      sessionId,
      rootSessionId,
      taskId: 'T-2',
      attemptId: 'attempt-b',
      seq: 1
    })
    const sequenced = createSequencedHost({
      sessionId,
      rootSessionId,
      cwd: workspace,
      cuts: [
        { events: [taskA], cursor: 0, inspectCursor: 1, inspectLive: true },
        { events: [taskA, taskB], cursor: 1, inspectCursor: 1, inspectLive: true }
      ]
    })
    const resolved = await createNotebookContextPort({ host: sequenced.host }).read(sessionId)
    if (resolved === undefined) throw new Error('expected T2 Notebook context')
    expect(resolved).toMatchObject({ managed: true, taskId: 'T-2', attemptId: 'attempt-b' })
    await expect(store.load(sessionId, resolved)).rejects.toMatchObject({
      code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH'
    })
  })

  it('没有 Swarm marker 的普通 Host session 仍返回当前 cwd context', async () => {
    const root = createRoot()
    const session = createSession({ id: 'standard-session', cwd: root })
    const { host } = createHost({
      session,
      events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
      cwd: root
    })
    const port = createNotebookContextPort({ host })

    await expect(port.read('standard-session')).resolves.toEqual({
      schemaVersion: 1,
      sessionId: 'standard-session',
      managed: false,
      taskId: null,
      agentId: 'standard-session',
      attemptId: null,
      rootSessionId: null,
      cwd: root,
      directoryIdentity: directoryIdentity(root),
      source: 'host-session'
    })
  })

  it('只有无 task 的普通 Host root session 可增补可信 routerDraft', () => {
    const standard = {
      schemaVersion: 1 as const,
      sessionId: 'root-session',
      managed: false,
      taskId: null,
      agentId: 'root-session',
      attemptId: null,
      rootSessionId: null,
      cwd: '/workspace',
      directoryIdentity: '1:2:3',
      source: 'host-session' as const
    }
    expect(withNotebookRouterDraft(standard)).toEqual({ ...standard, routerDraft: true })
    expect(() => withNotebookRouterDraft({
      ...standard,
      managed: true,
      taskId: 'T-1',
      attemptId: 'attempt-1',
      rootSessionId: 'parent-session',
      source: 'swarm-marker'
    })).toThrow(/routerDraft/)
  })

  it('observe 与 inspect 的 cursor 不一致时拒绝竞态读取', async () => {
    const root = createRoot()
    const session = createSession({ id: 'child-session', parentSession: 'root-session', cwd: root })
    const { host } = createHost({
      session,
      events: [],
      cwd: root,
      cursor: 1,
      inspectCursor: 0
    })
    const port = createNotebookContextPort({ host })

    await expect(port.read('child-session')).rejects.toMatchObject({
      code: 'NOTEBOOK_CONTEXT_CURSOR_MISMATCH'
    })
  })

  it('Host fs 不能把 project cwd 映射回本机同一物理目录时拒绝身份计算', async () => {
    const root = createRoot()
    const session = createSession({ id: 'standard-session', cwd: root })
    const { host } = createHost({
      session,
      events: [],
      cwd: root,
      hostPath: join(root, 'remote-copy')
    })
    const port = createNotebookContextPort({ host })

    await expect(port.read('standard-session')).rejects.toMatchObject({
      code: 'NOTEBOOK_CONTEXT_NOT_HOST_FS'
    })
  })

  it('marker 扫描只覆盖尾部有界窗口，不会无限读取历史', async () => {
    const root = createRoot()
    const session = createSession({ id: 'child-session', parentSession: 'root-session', cwd: root })
    const oldMarker = {
      type: 'plugin:swarm/notebook-task-binding',
      seq: 0,
      time: 1,
      ignorable: true,
      data: { schemaVersion: 1, sessionId: 'child-session', rootSessionId: 'root-session', taskId: 'T-old', attemptId: 'attempt-old' }
    }
    const filler = Array.from({ length: MAX_NOTEBOOK_MARKER_SCAN_EVENTS }, (_, index) => ({
      type: 'turn/start',
      seq: index + 1,
      time: index + 2,
      data: { turn: index + 1 }
    }))
    const { host } = createHost({
      session,
      events: [oldMarker, ...filler],
      cwd: root,
      inheritedEventCount: 0,
      cursor: filler.length
    })
    const port = createNotebookContextPort({ host })

    await expect(port.read('child-session')).resolves.toMatchObject({
      managed: false,
      taskId: null,
      source: 'host-session'
    })
  })

  it('缺失 session、错误 root 或无效 marker 不会降级为当前任务', async () => {
    const root = createRoot()
    const session = createSession({ id: 'child-session', parentSession: 'root-session', cwd: root })
    const { host } = createHost({
      session,
      events: [{
        type: 'plugin:swarm/notebook-task-binding',
        seq: 0,
        time: 1,
        ignorable: true,
        data: { schemaVersion: 1, sessionId: 'child-session', rootSessionId: 'other-root', taskId: 'T-other', attemptId: 'attempt-other' }
      }],
      cwd: root
    })
    const port = createNotebookContextPort({ host })

    await expect(port.read('child-session')).resolves.toMatchObject({
      managed: false,
      taskId: null,
      source: 'host-session'
    })
    await expect(port.read('unknown-session')).resolves.toBeUndefined()
  })
})
