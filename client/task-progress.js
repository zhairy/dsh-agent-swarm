// 原生Conversation View只提供观察入口；任务准入、执行和验收仍由百工服务决定。
const React = require('react')
const h = React.createElement
const { retainTaskViewStore } = require('@swarm/task-view-store')
const { NS, validateTaskView, TaskFlowContent, useTaskSnapshot, dictionaries } = require('@swarm/task-flow')
const VIEW_ID = 'swarm-task-progress'
const EMPTY = Object.freeze({ value: null, status: 'idle', error: null, updatedAt: null })
const NO_SUBSCRIBE = () => () => undefined
const getEmpty = () => EMPTY
Object.assign(dictionaries.zh, { taskChoice: '当前任务', noTasks: '本会话还没有可读取的任务卡。请在天枢会话中创建任务；此页面不会自动创建任务。', restrictedProgress: '任务进度仅展示当前百工根会话。普通会话与受限子会话不会读取父任务。', directoryUnavailable: '任务目录暂不可用', loadingDirectory: '读取当前会话任务目录…', refreshDirectory: '刷新任务目录', binding: '合同 / 流程 / 需求版本', evolutionRevision: '治理修订', taskState: '任务状态' })
Object.assign(dictionaries.en, { taskChoice: 'Current task', noTasks: 'No task cards are available in this session. Create a task in a Tian Shu session; this page does not create one.', restrictedProgress: 'Task progress is limited to the current Swarm root. Ordinary sessions and restricted children do not read parent tasks.', directoryUnavailable: 'Task directory unavailable', loadingDirectory: 'Loading tasks for this session…', refreshDirectory: 'Refresh task directory', binding: 'Card / workflow / request revisions', evolutionRevision: 'Governance revision', taskState: 'Task status' })
const fallbackTranslate = (key) => dictionaries.zh[key] ?? key
const canReadProgress = (preset, subagent, hasSessionHook = true) => hasSessionHook && preset === 'tian-shu' && (subagent === undefined || subagent === null)
// 独立工作区在自身正文交互层承接点击，避免会话输入宽度把手截获图表/节点；不改宿主控件。
const pageStyle = { position: 'relative', zIndex: 1, height: '100%', minHeight: 0, minWidth: 0, overflow: 'auto', padding: 'clamp(12px, 3vw, 28px)', boxSizing: 'border-box', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)' }
const inputStyle = { minHeight: 36, maxWidth: '100%', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit' }

function TaskProgressRoot (props) {
  const { sessionId, store } = props
  const t = typeof props.t === 'function' ? props.t : fallbackTranslate
  const directory = React.useMemo(() => store?.index(sessionId), [store, sessionId])
  const index = React.useSyncExternalStore(directory?.subscribe ?? NO_SUBSCRIBE, directory?.getSnapshot ?? getEmpty)
  const [selected, setSelected] = React.useState(directory?.readPreference()?.taskId ?? '')
  const tasks = index.value?.rootSessionId === sessionId ? index.value.tasks : []
  const task = tasks.find((item) => item.taskId === selected) ?? tasks[0]
  const taskId = task?.taskId
  const { snapshot, source } = useTaskSnapshot(store, sessionId, taskId)
  React.useEffect(() => {
    if (props.viewRequest?.view !== VIEW_ID || index.value === null) return
    const focus = props.viewRequest.focus
    if (tasks.some((item) => item.taskId === focus)) { setSelected(focus); directory?.setPreference({ taskId: focus }) }
    props.completeViewRequest?.()
  }, [props.viewRequest, props.completeViewRequest, index.value, directory])
  const select = (id) => { setSelected(id); directory?.setPreference({ taskId: id }) }
  return h('section', { style: pageStyle, 'data-swarm-progress-page': sessionId, 'aria-label': t('progressTab') },
    h('div', { style: { width: '100%', maxWidth: 1440, margin: '0 auto' } },
      h('header', { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } },
        h('h2', { style: { fontSize: 20, margin: '0 0 8px' } }, t('progressTab')),
        tasks.length === 0 ? null : h('label', { style: { minWidth: 0 } }, `${t('taskChoice')} `, h('select', { value: taskId, style: inputStyle, 'aria-label': t('taskChoice'), 'data-swarm-task-choice': '', onChange: (event) => select(event.target.value) }, ...tasks.map((item) => h('option', { key: item.taskId, value: item.taskId }, `${item.taskId} · ${item.title}`)))),
        h('button', { type: 'button', style: { ...inputStyle, cursor: 'pointer', marginLeft: 'auto' }, disabled: index.status === 'loading' || index.status === 'refreshing', onClick: () => directory?.refresh() }, t('refreshDirectory'))),
      index.error === null ? null : h('p', { role: 'status', 'data-swarm-directory-error': '', style: { overflowWrap: 'anywhere' } }, `${t('directoryUnavailable')}：${index.error}`),
      task === undefined ? h('p', { role: 'status' }, index.value !== null ? t('noTasks') : t(['loading', 'idle'].includes(index.status) ? 'loadingDirectory' : 'directoryUnavailable')) : h(React.Fragment, null,
        h('p', { 'data-swarm-task-binding': taskId, style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)' } }, `${snapshot.value?.title ?? task.title} · ${t('binding')}：${snapshot.value?.cardRevision ?? task.cardRevision} / ${snapshot.value?.workflowRevision ?? task.workflowRevision} / ${snapshot.value?.requestRevision ?? task.requestRevision} · ${t('evolutionRevision')}：${snapshot.value?.evolutionRevision ?? task.evolutionRevision ?? 0} · ${t('taskState')}：${snapshot.value === null ? task.status : snapshot.value.acceptance?.status ?? 'pending'}`),
        h(TaskFlowContent, { key: taskId, taskId, snapshot, source, onRefresh: source?.refresh, t, progressPage: true })),
      h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('readonly'))))
}

function TaskProgressView (props) {
  const preset = typeof props.useProjection === 'function' ? props.useProjection('agentPreset') : undefined
  const subagent = typeof props.useSession === 'function' ? props.useSession((session) => session?.subagent) : undefined
  const t = typeof props.t === 'function' ? props.t : fallbackTranslate
  // 不用parentSessionId猜根或查询父任务，盲审和普通会话只渲染本地空态。
  if (!canReadProgress(preset, subagent, typeof props.useSession === 'function')) return h('section', { style: pageStyle, 'data-swarm-progress-restricted': '', role: 'status' }, t('restrictedProgress'))
  return h(TaskProgressRoot, { ...props, key: props.sessionId })
}

function apply (ctx) {
  const retained = retainTaskViewStore(ctx.get('connection'), validateTaskView)
  const t = typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallbackTranslate
  ctx.effect(() => retained.release, 'swarm-task-progress: shared reads')
  // 缺少公开slot的旧宿主不会运行该注册器；聊天完整图表保持兼容，不改宿主DOM。
  ctx.slots.inject('conversation.view', function * () {
    yield ctx.slots.register({ name: 'conversation.view', id: VIEW_ID, order: 20, label: () => t('progressTab'), locale: NS, inject: () => ({ store: retained.store }) }, TaskProgressView)
  })
}

exports.inject = ['slots', 'locale', 'uiConversation', 'connection']
exports.apply = apply
exports.__test__ = { VIEW_ID, canReadProgress, TaskProgressView, TaskProgressRoot }
