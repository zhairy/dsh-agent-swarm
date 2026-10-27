import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadTaskViewStoreModule } from './client-module-loader.js'

const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const stores: any[] = []
const fixture = (options: Record<string, unknown> = {}) => {
  const request = vi.fn().mockImplementation((_method, { taskId, sessionId }) => Promise.resolve(taskId === undefined ? { rootSessionId: sessionId, tasks: [] } : { task_id: taskId, rootSessionId: sessionId }))
  const store = loadTaskViewStoreModule().createTaskViewStore({ request, ...options })
  stores.push(store)
  return { store, request: options.request as ReturnType<typeof vi.fn> ?? request }
}
const loadClient = (state: unknown[] = []) => {
  const effects: Array<() => unknown> = []
  const setState = vi.fn()
  let stateIndex = 0
  const react = {
    Fragment: 'Fragment',
    createElement: (type: unknown, props: any, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    useMemo: (read: () => unknown) => read(),
    useRef: (value: unknown) => ({ current: value }),
    useEffect: (effect: () => unknown) => effects.push(effect),
    useState: (initial: unknown) => [stateIndex < state.length ? state[stateIndex++] : typeof initial === 'function' ? (initial as () => unknown)() : initial, setState],
    useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read()
  }
  const load = (file: string, require: (id: string) => unknown): any => {
    const module = { exports: {} }
    new Function('require', 'module', 'exports', readFileSync(join(__dirname, '../../client', file), 'utf8'))(require, module, module.exports)
    return module.exports
  }
  const store = loadTaskViewStoreModule()
  const flow = load('task-flow.js', (id) => id === 'react' ? react : id === '@swarm/task-view-store' ? store : {})
  const progress = load('task-progress.js', (id) => id === 'react' ? react : id === '@swarm/task-view-store' ? store : id === '@swarm/task-flow' ? flow : {})
  return { progress, flow, effects, setState }
}
const flatten = (node: any): any[] => node === null || node === undefined ? [] : Array.isArray(node) ? node.flatMap(flatten) : typeof node === 'object' ? [node, ...node.children.flatMap(flatten)] : []
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('任务进度共享读取层', () => {
  it('inline与主Tab同任务共享单飞读取，任务和目录查询分别绑定根身份', async () => {
    vi.useFakeTimers()
    const { store, request } = fixture()
    const inline = store.task('root', 'T-1'), tab = store.task('root', 'T-1')
    const a = inline.subscribe(vi.fn()), b = tab.subscribe(vi.fn())
    await inline.refresh()
    expect(request).toHaveBeenCalledTimes(1)
    expect(inline.getSnapshot()).toBe(tab.getSnapshot())
    expect(request).toHaveBeenLastCalledWith('taskView', { sessionId: 'root', taskId: 'T-1' }, expect.any(AbortSignal))
    const directory = store.index('root'); const release = directory.subscribe(vi.fn()); await directory.refresh()
    expect(directory.getSnapshot().value.rootSessionId).toBe('root')
    a(); b(); release()
  })

  it('超时真正abort；不合作transport结算前既不补请求，也不发布迟到结果', async () => {
    vi.useFakeTimers()
    const pending = deferred()
    const request = vi.fn().mockReturnValue(pending.promise)
    const { store } = fixture({ request })
    const source = store.task('root', 'T-1'); source.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(15000)
    expect(request.mock.calls[0]![2].aborted).toBe(true)
    expect(source.getSnapshot()).toMatchObject({ value: null, status: 'unavailable' })
    void source.refresh()
    await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(1)
    pending.resolve({ task_id: 'T-1', rootSessionId: 'root' }); await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot().value).toBeNull()
    request.mockResolvedValue({ task_id: 'T-1', rootSessionId: 'root' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(source.getSnapshot().status).toBe('live')
  })

  it('失败保留已验证快照并退避恢复；权限拒绝停止周期重试', async () => {
    vi.useFakeTimers()
    const { store, request } = fixture()
    const source = store.task('root', 'T-1'); source.subscribe(vi.fn()); await source.refresh()
    const first = source.getSnapshot().value
    request.mockRejectedValueOnce(new Error('temporary offline'))
    await vi.advanceTimersByTimeAsync(5000)
    expect(source.getSnapshot()).toMatchObject({ status: 'stale', value: first })
    await vi.advanceTimersByTimeAsync(2000)
    expect(source.getSnapshot().status).toBe('live')
    request.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'PERMISSION_DENIED' }))
    await vi.advanceTimersByTimeAsync(5000)
    const calls = request.mock.calls.length
    await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(calls)
    expect(source.getSnapshot().value).toEqual(first)
  })

  it('页面隐藏与最后订阅卸载停止新增RPC，恢复可见后读取；不取消业务作业', async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, () => void>()
    const document = { visibilityState: 'visible', addEventListener: (event: string, run: () => void) => listeners.set(event, run), removeEventListener: (event: string) => listeners.delete(event) }
    const { store, request } = fixture({ document })
    const source = store.task('root', 'T-1'); const stop = source.subscribe(vi.fn()); await source.refresh()
    document.visibilityState = 'hidden'; listeners.get('visibilitychange')!()
    await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(1)
    document.visibilityState = 'visible'; listeners.get('visibilitychange')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(request).toHaveBeenCalledTimes(2)
    stop(); await vi.advanceTimersByTimeAsync(60000)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([method]) => method === 'taskView')).toBe(true)
  })

  it('两个根各有T-1不串数据，连接新generation拒绝旧响应', async () => {
    vi.useFakeTimers()
    let generation: { id: number } | undefined = { id: 1 }; let notify!: () => void
    const generationSource = { getSnapshot: () => generation, subscribe: (run: () => void) => { notify = run; return () => undefined } }
    const pending = deferred()
    const request = vi.fn().mockImplementation((_method, { sessionId, taskId }) => sessionId === 'root-A' ? pending.promise : Promise.resolve({ task_id: taskId, rootSessionId: sessionId }))
    const { store } = fixture({ request, generationSource })
    const a = store.task('root-A', 'T-1'), b = store.task('root-B', 'T-1')
    a.subscribe(vi.fn()); b.subscribe(vi.fn()); await b.refresh()
    expect(a.getSnapshot().value).toBeNull()
    expect(b.getSnapshot().value.rootSessionId).toBe('root-B')
    generation = undefined; notify()
    pending.resolve({ task_id: 'T-1', rootSessionId: 'root-A', title: 'obsolete' }); await vi.advanceTimersByTimeAsync(0)
    expect(a.getSnapshot().value).toBeNull()
    request.mockResolvedValue({ task_id: 'T-1', rootSessionId: 'root-A', title: 'new' })
    generation = { id: 2 }; notify(); await vi.advanceTimersByTimeAsync(0)
    expect(a.getSnapshot().value.title).toBe('new')
    expect(b.getSnapshot().value).toBeNull()
  })

  it('取消不合作且快速切换超过容量时有硬上限，不无限保留pending', async () => {
    vi.useFakeTimers()
    const request = vi.fn().mockImplementation(() => new Promise(() => undefined))
    const { store } = fixture({ request, maxEntries: 3 })
    for (let i = 0; i < 30; i += 1) {
      const source = store.task('root', `T-${i}`); const stop = source.subscribe(vi.fn()); await vi.advanceTimersByTimeAsync(0); stop()
    }
    expect(store.diagnostics()).toMatchObject({ cachedEntries: 3, inFlight: 3 })
    expect(request).toHaveBeenCalledTimes(3)
    expect(store.task('root', 'T-99').getSnapshot()).toMatchObject({ status: 'unavailable', value: null })
  })

  it('大量历史卡被动观察不分配缓存、不发RPC、不锁住淘汰；第九当前任务仍可读', async () => {
    vi.useFakeTimers()
    const { store, request } = fixture({ maxEntries: 3 })
    const releases = Array.from({ length: 30 }, (_, index) => {
      const history = store.task('root', `T-${index}`, { passive: true })
      expect(history.getSnapshot().status).toBe('historical')
      expect(history.refresh).toBeUndefined()
      return history.subscribe(vi.fn())
    })
    await vi.advanceTimersByTimeAsync(60000)
    expect(store.diagnostics()).toMatchObject({ cachedEntries: 0, inFlight: 0 })
    expect(request).not.toHaveBeenCalled()
    const current = store.task('root', 'T-99'); const stop = current.subscribe(vi.fn()); await current.refresh()
    expect(current.getSnapshot()).toMatchObject({ status: 'live', value: { task_id: 'T-99' } })
    stop()
    const history = store.task('root', 'T-99', { passive: true }); history.subscribe(vi.fn())
    for (const id of ['T-100', 'T-101', 'T-102']) { const source = store.task('root', id); const release = source.subscribe(vi.fn()); await source.refresh(); release() }
    expect(history.getSnapshot().status).toBe('historical')
    expect(store.diagnostics().cachedEntries).toBeLessThanOrEqual(3)
    for (const release of releases) release()
  })

  it('已知目录v4后丢弃迟到v3 accepted，真实结算后补读一次且当前正文持续轮询', async () => {
    vi.useFakeTimers()
    const old = deferred(), current = deferred()
    let taskReads = 0
    const binding = { cardRevision: 4, workflowRevision: 4, requestRevision: 4 }
    const request = vi.fn((method) => method === 'taskIndex' ? Promise.resolve({ rootSessionId: 'root', tasks: [{ taskId: 'T-1', title: 'current', status: 'pending', ...binding }] }) : (++taskReads === 1 ? old.promise : current.promise))
    const { store } = fixture({ request })
    const source = store.task('root', 'T-1')
    const published: any[] = []
    source.subscribe(() => published.push(source.getSnapshot()))
    const directory = store.index('root'); directory.subscribe(vi.fn()); await directory.refresh()
    expect(taskReads).toBe(1)
    old.resolve({ task_id: 'T-1', rootSessionId: 'root', cardRevision: 3, workflowRevision: 3, requestRevision: 3, acceptance: { status: 'accepted' } })
    await vi.advanceTimersByTimeAsync(0)
    expect(taskReads).toBe(2)
    expect(source.getSnapshot().value).toBeNull()
    expect(published.some(snapshot => snapshot.status === 'live' && snapshot.value?.cardRevision === 3)).toBe(false)
    current.resolve({ task_id: 'T-1', rootSessionId: 'root', ...binding, acceptance: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: { cardRevision: 4 } })
    await vi.advanceTimersByTimeAsync(5000)
    expect(taskReads).toBe(3)
  })

  it('目录版本不倒退；较新的正文v5有效，任何单项旧版本不覆盖已有正确快照', async () => {
    vi.useFakeTimers()
    let directoryRevision = 4, bodyRevision = 5
    const request = vi.fn((method) => Promise.resolve(method === 'taskIndex' ? { rootSessionId: 'root', tasks: [{ taskId: 'T-1', title: 'directory', cardRevision: directoryRevision, workflowRevision: directoryRevision, requestRevision: directoryRevision }] } : { task_id: 'T-1', rootSessionId: 'root', title: 'body', cardRevision: bodyRevision, workflowRevision: bodyRevision, requestRevision: bodyRevision, acceptance: { status: 'accepted' } }))
    const { store } = fixture({ request })
    const directory = store.index('root'); directory.subscribe(vi.fn()); await directory.refresh()
    const source = store.task('root', 'T-1'); source.subscribe(vi.fn()); await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: { cardRevision: 5 } })
    directoryRevision = 3; await directory.refresh()
    expect(directory.getSnapshot()).toMatchObject({ status: 'stale', value: { tasks: [{ cardRevision: 4 }] } })
    bodyRevision = 4; await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'stale', value: { cardRevision: 5 } })
    expect(source.getSnapshot().error).toContain('迟到正文')
  })

  it('治理修订也受目录下界约束，旧Canary快照不能覆盖新撤回状态', async () => {
    vi.useFakeTimers()
    const request = vi.fn((method: string) => Promise.resolve(method === 'taskIndex'
      ? { rootSessionId: 'root', tasks: [{ taskId: 'T-1', title: 'current', status: 'pending', cardRevision: 1, workflowRevision: 1, requestRevision: 1, evolutionRevision: 3 }] }
      : { task_id: 'T-1', rootSessionId: 'root', cardRevision: 1, workflowRevision: 1, requestRevision: 1, evolutionRevision: 2, evolution: { phase: 'canary' } }))
    const { store } = fixture({ request })
    const directory = store.index('root'); directory.subscribe(vi.fn()); await directory.refresh()
    const source = store.task('root', 'T-1'); source.subscribe(vi.fn()); await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'stale', value: null })
    expect(source.getSnapshot().error).toContain('迟到正文')
  })

  it('普通目录持续打开时可发现新任务；终态正文停止轮询但手动刷新仍有效', async () => {
    vi.useFakeTimers()
    const { store, request } = fixture()
    const directory = store.index('root'); directory.subscribe(vi.fn()); await directory.refresh()
    request.mockResolvedValueOnce({ rootSessionId: 'root', tasks: [{ taskId: 'T-2', title: 'new', cardRevision: 1, workflowRevision: 1, requestRevision: 1 }] })
    await vi.advanceTimersByTimeAsync(5000)
    expect(directory.getSnapshot().value.tasks).toHaveLength(1)
    store.dispose()
    const terminal = fixture({ request: vi.fn().mockResolvedValue({ task_id: 'T-1', rootSessionId: 'root', acceptance: { status: 'accepted' } }) })
    const source = terminal.store.task('root', 'T-1'); source.subscribe(vi.fn()); await source.refresh()
    await vi.advanceTimersByTimeAsync(60000)
    expect(terminal.request).toHaveBeenCalledTimes(1)
    await source.refresh(); expect(terminal.request).toHaveBeenCalledTimes(2)
  })

  it('已验收但影子或Canary仍在观察时不能因终态停止轮询', async () => {
    vi.useFakeTimers()
    const terminal = fixture({ request: vi.fn().mockResolvedValue({
      task_id: 'T-1', rootSessionId: 'root', acceptance: { status: 'accepted' },
      evolution: { phase: 'shadow' }
    }) })
    const source = terminal.store.task('root', 'T-1'); const stop = source.subscribe(vi.fn())
    await source.refresh()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(terminal.request.mock.calls.length).toBeGreaterThan(1)
    stop()
  })

  it('错误任务或目录根身份不能替换缓存，偏好有界且不包含正文', async () => {
    vi.useFakeTimers()
    const { store, request } = fixture()
    const source = store.task('root', 'T-1'); source.subscribe(vi.fn()); await source.refresh()
    request.mockResolvedValueOnce({ task_id: 'T-other', rootSessionId: 'root' }); await source.refresh()
    expect(source.getSnapshot()).toMatchObject({ status: 'stale', value: { task_id: 'T-1' } })
    source.setPreference({ kind: 'architecture', scrollTop: 21 }); source.setPreference({ zoom: 2 })
    expect(source.readPreference()).toEqual({ kind: 'architecture', scrollTop: 21, zoom: 2 })
    const directory = store.index('root'); directory.subscribe(vi.fn())
    request.mockResolvedValue({ rootSessionId: 'other-root', tasks: [] }); await directory.refresh()
    expect(directory.getSnapshot().value).toBeNull()
  })
})

describe('原生任务进度入口与六视角', () => {
  it('通过公开list slot注册order20并注入共享Store，不覆盖宿主页面', () => {
    const { progress } = loadClient()
    const connection = { rpc: { call: vi.fn() } }
    let register!: () => any; let spec: any
    const context = { get: () => connection, effect: (effect: () => unknown) => effect(), locale: {}, slots: { inject: (name: string, run: () => any) => { expect(name).toBe('conversation.view'); register = run }, register: (value: unknown) => { spec = value; return () => undefined } } }
    progress.apply(context); register().next()
    expect(spec).toMatchObject({ name: 'conversation.view', id: 'swarm-task-progress', order: 20 })
    expect(spec.label()).toBe('任务进度')
    spec.inject().store.dispose()
  })

  it('普通会话、盲审/规划子会话及能力缺失仅空态，不读任何父根任务', () => {
    const { progress } = loadClient()
    const store = { index: vi.fn(), task: vi.fn() }
    for (const [preset, subagent] of [['standard', undefined], ['yu-shi', { address: { parentSessionId: 'root' } }], ['tian-shu', { address: { parentSessionId: 'root' } }]]) {
      const element = progress.__test__.TaskProgressView({ sessionId: 'child', store, useProjection: () => preset, useSession: (read: (value: unknown) => unknown) => read({ subagent }) })
      expect(element.props['data-swarm-progress-restricted']).toBe('')
    }
    expect(progress.__test__.canReadProgress('tian-shu', undefined, false)).toBe(false)
    expect(progress.__test__.canReadProgress('tian-shu', null)).toBe(true)
    expect(store.index).not.toHaveBeenCalled(); expect(store.task).not.toHaveBeenCalled()
  })

  it('Tab存在时历史卡请求passive source且保留原文；旧宿主inline仍主动读取', () => {
    const { flow } = loadClient()
    const passiveSource = { getSnapshot: () => ({ value: { task_id: 'T-1', card: { title: '新合同', goal: '新目标' } }, status: 'live', error: null, updatedAt: 1 }), subscribe: vi.fn(() => () => undefined) }
    const store = { task: vi.fn(() => passiveSource) }
    const row = flow.__test__.TaskFlowRow({ sessionId: 'root', store, progressAvailable: true, node: { data: { taskId: 'T-1', text: '原始工具结果' } } })
    expect(store.task).toHaveBeenCalledWith('root', 'T-1', { passive: true })
    expect(row.props.snapshot.status).toBe('historical')
    const content = flow.__test__.TaskFlowContent(row.props)
    expect(flatten(content).some(item => item.type === 'pre' && item.children[0] === '原始工具结果')).toBe(true)
    expect(flatten(content).find(item => item.props['data-planning-status'] === 'historical')).toBeDefined()
    flow.__test__.TaskFlowRow({ sessionId: 'root', store, progressAvailable: false, node: { data: { taskId: 'T-2', text: 'old host' } } })
    expect(store.task).toHaveBeenLastCalledWith('root', 'T-2', { passive: false })
  })

  it('任务页先展示进度和图，长合同与三维审核置于默认收起的details', () => {
    const { flow } = loadClient()
    const content = flow.__test__.TaskFlowContent({ taskId: 'T-1', progressPage: true, snapshot: { value: { task_id: 'T-1', card: { title: '长合同', goal: 'x'.repeat(10000) }, blockedRecovery: { active: true, summary: '缺独立验证' } }, status: 'live', error: null, updatedAt: 1 } })
    const nodes = flatten(content)
    const details = nodes.find(item => item.props['data-swarm-contract-details'] === '')
    expect(details).toBeDefined(); expect(details.props.open).not.toBe(true)
    expect(nodes.findIndex(item => item.type === flow.__test__.TaskDiagramPanel)).toBeLessThan(nodes.indexOf(details))
    expect(nodes.findIndex(item => item.type === flow.__test__.TaskProgressSummary)).toBeLessThan(nodes.indexOf(details))
    expect(nodes.find(item => item.props['data-swarm-current-block'] === '')).toBeDefined()
  })

  it('任务页摘要标题、三版本和状态来自同一正文快照，不混用旧目录版本', () => {
    const { progress } = loadClient()
    const snapshot = (value: unknown) => ({ value, status: 'live', error: null, updatedAt: 1 })
    const store = {
      index: () => ({ getSnapshot: () => snapshot({ rootSessionId: 'root', tasks: [{ taskId: 'T-1', title: 'old-directory', cardRevision: 4, workflowRevision: 4, requestRevision: 4, status: 'pending' }] }), readPreference: () => undefined, subscribe: () => () => undefined }),
      task: () => ({ getSnapshot: () => snapshot({ task_id: 'T-1', title: 'new-body', cardRevision: 5, workflowRevision: 6, requestRevision: 7, acceptance: { status: 'accepted' } }), subscribe: () => () => undefined })
    }
    const page = progress.__test__.TaskProgressRoot({ sessionId: 'root', store })
    const binding = flatten(page).find(item => item.props['data-swarm-task-binding'] === 'T-1')
    expect(binding.children.join('')).toContain('new-body')
    expect(binding.children.join('')).toContain('5 / 6 / 7')
    expect(binding.children.join('')).toContain('accepted')
    expect(binding.children.join('')).not.toContain('old-directory')
  })

  it('六视角始终可选，缺编排显示未记录，不虚构第六张图或同时绘制六SVG', () => {
    const { flow } = loadClient()
    const kinds = ['workflow', 'architecture', 'sequence', 'dataflow', 'lifecycle']
    const view = { task_id: 'T-1', cardRevision: 1, workflowRevision: 1, requestRevision: 1, diagrams: { format: 'dsh-agent-swarm/task-diagrams', schemaVersion: 1, binding: { taskId: 'T-1', cardRevision: 1, workflowRevision: 1, requestRevision: 1 }, snapshotDigest: 'a'.repeat(64), progress: { total: 0, completed: 0, percent: null, statuses: { succeeded: 0 } }, diagnostics: [], views: kinds.map(kind => ({ kind, mermaid: 'flowchart TD\n  n_a["safe"]', basis: 'snapshot', truncated: 0 })) } }
    const element = flow.__test__.TaskDiagramPanel({ view, t: (key: string) => key, preference: { kind: 'orchestration' } })
    expect(flatten(element).filter(item => item.type === 'option')).toHaveLength(6)
    expect(flatten(element).find(item => item.props['data-swarm-missing-view'] === 'orchestration')).toBeDefined()
    expect(flatten(element).filter(item => item.props.dangerouslySetInnerHTML)).toHaveLength(0)
  })
})
