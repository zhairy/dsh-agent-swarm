import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NOTEBOOK_SNAPSHOT_RUNTIME_KEY,
  NotebookSnapshotError,
  createNotebookSnapshotStore,
  getNotebookSnapshotRuntime,
  installNotebookSnapshotRuntime,
  rethrowNotebookSnapshotFailure,
  type AddNotebookSnapshotInput
} from '../../src/notebook-snapshot.ts'

const roots: string[] = []

const createRoots = (): { dshHome: string; workspace: string; savedPath: string } => {
  const root = mkdtempSync(join(tmpdir(), 'notebook-snapshot-test-'))
  roots.push(root)
  const dshHome = join(root, 'dsh-home')
  const workspace = join(root, 'workspace')
  const notebooks = join(workspace, 'notebooks')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  mkdirSync(notebooks, { recursive: true })
  const savedPath = join(notebooks, 'analysis.ipynb')
  writeFileSync(savedPath, '{"nbformat":4,"nbformat_minor":5,"cells":[],"metadata":{}}', { mode: 0o600 })
  return { dshHome, workspace, savedPath }
}

const getDirectoryIdentity = (path: string): string => {
  const stat = lstatSync(path, { bigint: true })
  return [stat.dev, stat.ino, stat.birthtimeNs].join(':')
}

const createInput = (
  roots: ReturnType<typeof createRoots>,
  source = 'print(42)'
): AddNotebookSnapshotInput => ({
  sessionId: 'session-42',
  savedAt: '2026-11-17T08:30:00.000Z',
  savedPath: roots.savedPath,
  notebook: {
    cells: [
      {
        id: 'cell-code',
        cell_type: 'code',
        source,
        execution_count: 1,
        outputs: [{ type: 'stream', name: 'stdout', text: '42\n' }],
        metadata: {},
        status: 'ok'
      },
      {
        id: 'cell-markdown',
        cell_type: 'markdown',
        source: '# Saved result',
        outputs: [],
        execution_count: null,
        metadata: {},
        status: 'idle'
      }
    ],
    metadata: {
      kernelspec: { name: 'swarm-private-python', language: 'python', display_name: 'swarm-private-python' },
      dsh: { title: 'analysis', cwd: roots.workspace }
    },
    nbformat: 4,
    nbformat_minor: 5
  },
  cellExtras: {
    'cell-markdown': { attachments: { diagram: { 'image/png': 'AA==' } } }
  },
  task: {
    id: 'T-42',
    agentId: 'agent-math',
    attemptId: 'attempt-1',
    managed: true
  },
  project: {
    cwd: roots.workspace,
    repositoryRoot: roots.workspace,
    directoryIdentity: getDirectoryIdentity(roots.workspace)
  },
  boundary: {
    mode: 'write',
    operation: 'file',
    writeScopes: [join(roots.workspace, 'notebooks')]
  }
})

const createReadContext = (roots: ReturnType<typeof createRoots>) => ({
  sessionId: 'session-42',
  managed: true,
  agentId: 'agent-math',
  taskId: 'T-42',
  attemptId: 'attempt-1',
  rootSessionId: 'root-session',
  cwd: roots.workspace,
  directoryIdentity: getDirectoryIdentity(roots.workspace)
})

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[NOTEBOOK_SNAPSHOT_RUNTIME_KEY]
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('Notebook 持久数据快照', () => {
  it('显式保存后可由新 store 恢复 cell/源码/输出，并固定为只读数据视图', async () => {
    const roots = createRoots()
    const store = createNotebookSnapshotStore({
      dshHome: roots.dshHome,
      now: () => Date.parse('2026-11-17T08:31:00.000Z')
    })

    const receipt = await store.save(createInput(roots))

    expect(receipt).toMatchObject({
      saved: true,
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      bytes: expect.any(Number),
      savedAt: '2026-11-17T08:30:00.000Z',
      recordedAt: '2026-11-17T08:31:00.000Z'
    })

    const reopened = createNotebookSnapshotStore({ dshHome: roots.dshHome })
    const restored = await reopened.load('session-42', createReadContext(roots))
    expect(restored).toMatchObject({
      schemaVersion: 1,
      sessionId: 'session-42',
      savedAt: '2026-11-17T08:30:00.000Z',
      savedPath: roots.savedPath,
      task: {
        id: 'T-42',
        agentId: 'agent-math',
        attemptId: 'attempt-1',
        managed: true
      },
      project: {
        cwd: roots.workspace,
        repositoryRoot: roots.workspace,
        directoryIdentity: getDirectoryIdentity(roots.workspace)
      },
      boundary: {
        mode: 'write',
        operation: 'file',
        writeScopes: [join(roots.workspace, 'notebooks')]
      },
      view: {
        mode: 'read-only',
        kernelAlive: false,
        autoRun: false
      }
    })
    expect(restored?.notebook.cells[0]).toMatchObject({
      id: 'cell-code',
      source: 'print(42)',
      outputs: [{ type: 'stream', name: 'stdout', text: '42\n' }]
    })
    expect(restored?.cellExtras).toEqual({
      'cell-markdown': { attachments: { diagram: { 'image/png': 'AA==' } } }
    })

    const snapshotDir = join(roots.dshHome, 'share', 'dsh-agent-swarm', 'notebook-snapshots', 'v1')
    const files = readdirSync(snapshotDir)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/)
    expect(statSync(join(snapshotDir, files[0]!)).mode & 0o777).toBe(0o600)
  })

  it('拒绝路径逃逸、活 Promise 标记、非纯 JSON 数据和超限快照', async () => {
    const roots = createRoots()
    const store = createNotebookSnapshotStore({ dshHome: roots.dshHome, maxBytes: 1024 })

    const outside = join(roots.workspace, '..', 'outside.ipynb')
    writeFileSync(outside, '{}', { mode: 0o600 })
    await expect(store.save({ ...createInput(roots), savedPath: outside }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_PATH_OUTSIDE' })

    const live = createInput(roots)
    ;(live.notebook.cells[0] as Record<string, unknown>)._runJob = Promise.resolve()
    await expect(store.save(live)).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_NOT_DATA' })

    const huge = createInput(roots, 'x'.repeat(2048))
    await expect(store.save(huge)).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_TOO_LARGE' })

    const target = join(roots.workspace, 'notebooks', 'inside-link.ipynb')
    symlinkSync(outside, target)
    await expect(store.save({ ...createInput(roots), savedPath: target }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_INVALID' })
  })

  it('跨 session、项目、任务和托管模式读取保持隔离', async () => {
    const roots = createRoots()
    const otherWorkspace = join(roots.workspace, '..', 'other-project')
    mkdirSync(otherWorkspace, { recursive: true })
    const store = createNotebookSnapshotStore({ dshHome: roots.dshHome })
    await store.save(createInput(roots))

    expect(await store.load('another-session')).toBeUndefined()
    await expect(store.load('session-42'))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })
    await expect(store.load('session-42', {
      ...createReadContext(roots),
      cwd: otherWorkspace,
      directoryIdentity: getDirectoryIdentity(otherWorkspace)
    }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })
    await expect(store.load('session-42', { ...createReadContext(roots), taskId: 'T-other' }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })
    await expect(store.load('session-42', { ...createReadContext(roots), agentId: 'agent-other' }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })
    await expect(store.load('session-42', { ...createReadContext(roots), managed: false }))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })
    await expect(store.load('session-42', {
      ...createReadContext(roots),
      projectPaths: []
    })).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })
  })

  it('托管恢复严格匹配 session/task/agent/cwd，并允许同 task 新 attempt 读取历史数据', async () => {
    const roots = createRoots()
    const repositoryRoot = join(roots.workspace, '..', 'shared-repository')
    const linkedWorktree = join(repositoryRoot, 'worktree-b')
    mkdirSync(linkedWorktree, { recursive: true })
    const store = createNotebookSnapshotStore({ dshHome: roots.dshHome })
    await store.save({
      ...createInput(roots),
      project: {
        cwd: roots.workspace,
        repositoryRoot,
        directoryIdentity: getDirectoryIdentity(roots.workspace)
      }
    })

    await expect(store.load('session-42', {
      ...createReadContext(roots),
      cwd: linkedWorktree,
      directoryIdentity: getDirectoryIdentity(linkedWorktree)
    })).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })

    await expect(store.load('session-42', {
      ...createReadContext(roots),
      directoryIdentity: '0:0:0'
    })).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })

    await expect(store.load('session-42', {
      ...createReadContext(roots),
      sessionId: 'session-other'
    })).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_SCOPE_MISMATCH' })

    const nextAttempt = await store.load('session-42', {
      ...createReadContext(roots),
      attemptId: 'attempt-2'
    })
    expect(nextAttempt?.task).toMatchObject({
      id: 'T-42',
      agentId: 'agent-math',
      attemptId: 'attempt-1',
      managed: true
    })
  })

  it('托管保存缺少目录身份时拒绝登记', async () => {
    const roots = createRoots()
    const store = createNotebookSnapshotStore({ dshHome: roots.dshHome })

    await expect(store.save({
      ...createInput(roots),
      project: {
        ...createInput(roots).project,
        directoryIdentity: null
      }
    })).rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_INVALID' })
  })

  it('并发覆盖保持完整 JSON，损坏或摘要不符的持久快照拒绝恢复', async () => {
    const roots = createRoots()
    const store = createNotebookSnapshotStore({ dshHome: roots.dshHome })
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.save(createInput(roots, `print(${index})`))))

    const snapshotDir = join(roots.dshHome, 'share', 'dsh-agent-swarm', 'notebook-snapshots', 'v1')
    const files = readdirSync(snapshotDir)
    expect(files).toHaveLength(1)
    const file = join(snapshotDir, files[0]!)
    const restored = await store.load('session-42', createReadContext(roots))
    expect(restored?.notebook.cells[0]?.source).toMatch(/^print\([0-7]\)$/)

    const document = JSON.parse(readFileSync(file, 'utf8')) as { digest: string }
    document.digest = '0'.repeat(64)
    writeFileSync(file, JSON.stringify(document), { mode: 0o600 })
    await expect(store.load('session-42', createReadContext(roots)))
      .rejects.toMatchObject({ code: 'NOTEBOOK_SNAPSHOT_CORRUPT' })
  })

  it('全局端口安装 save/load/resolveReadContext，并由安装者安全卸载', async () => {
    const roots = createRoots()
    const store = createNotebookSnapshotStore({ dshHome: roots.dshHome })
    const resolveReadContext = async () => undefined
    const runtime = { ...store, resolveReadContext }
    const dispose = installNotebookSnapshotRuntime(runtime)
    try {
      expect(getNotebookSnapshotRuntime()).toBe(runtime)
      expect(getNotebookSnapshotRuntime()?.resolveReadContext).toBe(resolveReadContext)
      expect(() => installNotebookSnapshotRuntime(runtime)).toThrow(/占用/)
      await store.save(createInput(roots))
      expect((await getNotebookSnapshotRuntime()?.load('session-42', createReadContext(roots)))?.task.id).toBe('T-42')
    } finally {
      dispose()
    }
    expect(getNotebookSnapshotRuntime()).toBeUndefined()
  })

  it('写入失败清理只忽略 ENOENT 和已关闭句柄，其余 I/O 错误保留原 cause', async () => {
    const original = new NotebookSnapshotError('NOTEBOOK_SNAPSHOT_IO', '原始写入失败')
    const same = await rethrowNotebookSnapshotFailure(original, {
      close: async () => { throw Object.assign(new Error('closed'), { code: 'EBADF' }) },
      unlink: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
    }).catch(error => error)
    expect(same).toBe(original)

    const ioError = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    const wrappedWithoutCleanupFailure = await rethrowNotebookSnapshotFailure(ioError, {
      close: async () => { throw Object.assign(new Error('closed'), { code: 'ERR_FILE_HANDLE_CLOSED' }) },
      unlink: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }) }
    }).catch(error => error)
    expect(wrappedWithoutCleanupFailure).toMatchObject({
      code: 'NOTEBOOK_SNAPSHOT_IO',
      message: 'Notebook 快照写入失败: ENOSPC'
    })
    expect(wrappedWithoutCleanupFailure.cause).toBe(ioError)

    const closeError = Object.assign(new Error('close failed'), { code: 'EIO' })
    const unlinkError = Object.assign(new Error('unlink denied'), { code: 'EACCES' })
    const wrapped = await rethrowNotebookSnapshotFailure(original, {
      close: async () => { throw closeError },
      unlink: async () => { throw unlinkError }
    }).catch(error => error)
    expect(wrapped).toMatchObject({
      name: 'NotebookSnapshotError',
      code: 'NOTEBOOK_SNAPSHOT_IO',
      message: 'Notebook 快照写入失败且临时文件清理未确认'
    })
    expect(wrapped.cause).toBeInstanceOf(AggregateError)
    expect(wrapped.cause.errors).toEqual([original, closeError, unlinkError])
  })
})
