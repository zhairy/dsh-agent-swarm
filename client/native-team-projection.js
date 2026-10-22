// DSH 原生智能体团队的只读投影。百工仍是任务、证据、租约与执行的唯一控制器；
// 本模块只读取宿主已有的 agentTeam 投影并打开成员会话，不创建成员、不更新任务、不发送消息。

const React = require('react')
const h = React.createElement
let HostModal
try { HostModal = require('@deepseek-ai/dsh-client-ui-primitives').Modal } catch { HostModal = undefined }

const NS = 'swarmNativeTeamProjection'
const SWARM_NAMESPACE = 'swarm-core'

const zh = {
  trigger: '团队镜像',
  title: '原生团队只读投影',
  description: '仅显示 DSH 原生团队的成员、共享任务与实时状态；百工不会通过这些控件创建成员、改任务或绕过门禁。',
  members: '成员',
  tasks: '共享任务',
  empty: '当前会话没有可投影的原生团队成员或任务。',
  unavailable: '原生团队投影暂不可用。',
  running: '运行中',
  inactive: '未运行',
  provisioning: '准备中',
  failed: '失败',
  current: '当前会话',
  open: '打开成员会话',
  owner: '执行者',
  unowned: '未分配',
  blockedBy: '依赖',
  writeScopes: '写入范围',
  ready: '可开始',
  blocked: '被依赖阻塞',
  pending: '待开始',
  in_progress: '进行中',
  completed: '已完成',
  close: '关闭'
}

const en = {
  trigger: 'Team mirror',
  title: 'Read-only native team projection',
  description: 'Shows native DSH team members, shared tasks and live status only. Agent Swarm cannot create members, edit tasks or bypass its gates through this panel.',
  members: 'Members',
  tasks: 'Shared tasks',
  empty: 'This session has no native team members or tasks to project.',
  unavailable: 'The native team projection is unavailable.',
  running: 'Running',
  inactive: 'Inactive',
  provisioning: 'Provisioning',
  failed: 'Failed',
  current: 'Current session',
  open: 'Open member session',
  owner: 'Owner',
  unowned: 'Unowned',
  blockedBy: 'Blocked by',
  writeScopes: 'Write scopes',
  ready: 'Ready',
  blocked: 'Blocked',
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
  close: 'Close'
}

const style = {
  trigger: { minHeight: 28, color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', background: 'transparent', border: 0, borderRadius: 6, padding: '3px 7px', fontSize: 12 },
  panel: { display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 'min(70vh, 620px)', overflowY: 'auto', minWidth: 0 },
  note: { margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary)' },
  section: { display: 'flex', flexDirection: 'column', gap: 7 },
  heading: { margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
  item: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 4, width: '100%', padding: '9px 11px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', textAlign: 'left' },
  row: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
  name: { fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { fontSize: 11, lineHeight: 1.45, color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
  error: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' }
}

const statusKey = (status) => ['running', 'inactive', 'provisioning', 'failed'].includes(status) ? status : 'inactive'
const taskStatusKey = (status) => ['pending', 'in_progress', 'completed'].includes(status) ? status : 'pending'
const MAX_PROJECTED_MEMBERS = 32
const MAX_PROJECTED_TASKS = 100

const getTeamSummary = (team) => {
  if (team === null || typeof team !== 'object' || !Array.isArray(team.members) || !Array.isArray(team.tasks)) return undefined
  const members = team.members.filter((member) => member !== null && typeof member === 'object' && typeof member.id === 'string' && typeof member.name === 'string' && typeof member.role === 'string' && typeof member.phase === 'string')
  const tasks = team.tasks.filter((task) => task !== null && typeof task === 'object' && typeof task.id === 'string' && typeof task.subject === 'string' && typeof task.status === 'string')
  if (members.length <= 1 && tasks.length === 0) return undefined
  // 宿主可能广播整块团队看板；渲染层仍给 Node DOM 设置常数上限。
  return {
    members: members.slice(0, MAX_PROJECTED_MEMBERS),
    tasks: tasks.slice(0, MAX_PROJECTED_TASKS),
    memberCount: members.length,
    taskCount: tasks.length,
    truncated: members.length > MAX_PROJECTED_MEMBERS || tasks.length > MAX_PROJECTED_TASKS,
    failure: typeof team.failure === 'string' ? team.failure : undefined
  }
}

const getLeadSessionId = (sessions, sessionId) =>
  sessions.binding(sessionId)?.session.getSnapshot().subagent?.address?.parentSessionId ?? sessionId

/** 打开原生 Team 成员的普通 continuable 子会话；只导航，不发送消息。 */
const openTeammateSession = (services, sessionId, childSessionId) => {
  const sessions = services?.sessions
  const uiWorkspace = services?.uiWorkspace
  if (sessions === undefined || uiWorkspace === undefined) throw new Error('Native team navigation unavailable')
  const parentSessionId = getLeadSessionId(sessions, sessionId)
  if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return false
  if (childSessionId === parentSessionId) uiWorkspace.openSession(parentSessionId)
  else uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })
  return true
}

function TeamMemberRow ({ member, sessionId, useSessions, useSessionStatus, openTeammate, onError, t }) {
  const model = useSessions((state) => state.projectionsBySession?.[member.id]?.values?.modelSelection?.next?.model)
  const statusRunning = useSessionStatus((state) => state.get?.(member.id)?.running)
  const summaryRunning = useSessions((state) => state.byId?.[member.id]?.running)
  const status = member.phase === 'active' ? ((statusRunning ?? summaryRunning) === true ? 'running' : 'inactive') : member.phase
  const current = member.id === sessionId
  const canOpen = !current && typeof openTeammate === 'function' && member.phase === 'active'
  const open = () => {
    try { openTeammate(sessionId, member.id) } catch (error) { onError(error instanceof Error ? error.message : String(error)) }
  }
  return h('button', {
    type: 'button',
    style: style.item,
    disabled: !canOpen,
    title: canOpen ? t('open') : current ? t('current') : member.error,
    'data-native-team-member': member.id,
    onClick: canOpen ? open : undefined
  },
  h('span', { style: style.row },
    h('span', { style: style.name }, member.name),
    h('span', { style: style.meta }, current ? t('current') : member.role)),
  h('span', { style: style.meta }, `${t(statusKey(status))}${model === undefined ? '' : ` · ${model}`}${member.error === undefined ? '' : ` · ${member.error}`}`))
}

function NativeTeamProjection (props) {
  const enabled = typeof props.useNativeTeamProjection === 'function' ? props.useNativeTeamProjection() : false
  const subagentParent = props.useSession((snapshot) => snapshot?.subagent?.address?.parentSessionId)
  const leadSessionId = subagentParent ?? props.sessionId
  const team = getTeamSummary(props.useSessions((state) => state.projectionsBySession?.[leadSessionId]?.values?.agentTeam))
  const phase = props.useSessions((state) => state.phase)
  const [open, setOpen] = React.useState(false)
  const [error, setError] = React.useState(undefined)
  if (!enabled || team === undefined) return null
  const t = props.t
  const body = h('div', { style: style.panel, 'data-swarm-native-team-projection': leadSessionId },
    h('p', { style: style.note }, t('description')),
    error === undefined ? null : h('p', { style: style.error, role: 'alert' }, error),
    team.failure === undefined ? null : h('p', { style: style.error, role: 'alert' }, team.failure),
    h('section', { style: style.section },
      h('h3', { style: style.heading }, `${t('members')} (${team.memberCount})`),
      ...team.members.map((member) => h(TeamMemberRow, {
        key: member.id,
        member,
        sessionId: props.sessionId,
        useSessions: props.useSessions,
        useSessionStatus: props.useSessionStatus,
        openTeammate: props.openTeammate,
        onError: setError,
        t
      }))),
    h('section', { style: style.section },
      h('h3', { style: style.heading }, `${t('tasks')} (${team.taskCount})`),
      team.tasks.length === 0 ? h('p', { style: style.note }, t('empty')) : team.tasks.map((task) => h('div', {
        key: task.id,
        style: style.item,
        'data-native-team-task': task.id
      },
      h('span', { style: style.row },
        h('span', { style: style.name }, task.subject),
        h('span', { style: style.meta }, t(taskStatusKey(task.status)))),
      h('span', { style: style.meta }, `${t('owner')}: ${task.ownerName ?? t('unowned')}`),
      task.blockedBy?.length ? h('span', { style: style.meta }, `${t('blockedBy')}: ${task.blockedBy.join(', ')}`) : null,
      task.writeScopes?.length ? h('span', { style: style.meta }, `${t('writeScopes')}: ${task.writeScopes.join(', ')}`) : null)))
  )
  const modal = HostModal === undefined
    ? open ? h('div', { role: 'dialog', 'aria-modal': true, 'aria-label': t('title'), style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'grid', placeItems: 'center', background: '#0004', padding: 16 } }, h('div', { style: { width: 'min(560px, 100%)', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-3, white)', padding: 16, borderRadius: 8 } }, h('button', { type: 'button', onClick: () => setOpen(false) }, t('close')), body)) : null
    : h(HostModal, { open, onClose: () => setOpen(false), title: t('title'), closeLabel: t('close') }, body)
  return h(React.Fragment, null,
    h('button', {
      type: 'button',
      style: style.trigger,
      'aria-expanded': open,
      'aria-haspopup': 'dialog',
      onClick: () => setOpen(!open)
    }, `${t('trigger')} ${team.memberCount}/${team.taskCount}`),
    phase === 'pending' && open ? h('p', { style: style.note }, t('unavailable')) : modal)
}

const NO_SUBSCRIBE = () => () => undefined

/** 默认关闭；只有用户在 swarm-core 显式启用时才挂载只读投影。 */
const getNativeTeamProjectionHook = (ctx) => {
  let form
  try { form = ctx.get('configForms')?.get?.(SWARM_NAMESPACE) } catch { form = undefined }
  const read = () => form?.getSnapshot?.()?.value?.agents?.nativeTeamProjection === true
  const subscribe = typeof form?.subscribe === 'function' ? (listener) => form.subscribe(listener) : NO_SUBSCRIBE
  return () => React.useSyncExternalStore(subscribe, read)
}

function apply (ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'swarm-native-team: dictionaries')
  const useNativeTeamProjection = getNativeTeamProjectionHook(ctx)
  const actions = { openTeammate: (sessionId, childSessionId) => { openTeammateSession(ctx, sessionId, childSessionId) } }
  ctx.slots.inject('conversation.session.header.actions', function * () {
    yield ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'swarm-native-team-mirror',
      order: -2,
      locale: NS,
      inject: () => ({ useNativeTeamProjection, ...actions })
    }, NativeTeamProjection)
  })
}

exports.inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
exports.apply = apply
exports.__test__ = { getTeamSummary, getLeadSessionId, openTeammateSession, getNativeTeamProjectionHook, NativeTeamProjection, TeamMemberRow }
