import { GATE_ROLE, type GateId } from './policy.js'
import type { DelegableRoleId } from './role-registry.js'

export type BlockedCause =
  | 'provider-protocol'
  | 'route-exhausted'
  | 'planning-service'
  | 'no-progress'
  | 'missing-gate'
  | 'verification-gap'
  | 'unknown'

export interface BlockedRecoveryView {
  active: boolean
  blocked: boolean
  cause: BlockedCause
  summary: string
  evidence: string[]
  recommendedRoles: Array<{ role: DelegableRoleId; reason: string }>
  nextAction: 'delegate-readonly-diagnosis' | 'switch-route' | 'delegate-gate' | 'revise-plan' | 'wait-external' | 'none'
  allowReadOnlyAutoDelegate: boolean
  requiresUser: boolean
}

interface RecoveryFailureInfo {
  kind: string
  provider: string
  model: string
  message: string
  code?: string
  status?: number
}

interface RecoveryStateInfo {
  terminal?: string
  completed?: boolean
  lastFailure?: RecoveryFailureInfo
}

interface TaskStateInfo {
  acceptance?: { status: 'accepted' | 'blocked' | 'recorded'; missing: string[]; unresolved: string[] }
  checkpoint?: { convergence?: { blocked?: boolean }; unresolved?: string[]; nextAction?: string }
  planningReview?: { status?: string }
}

interface GateStateInfo {
  gate: GateId
  satisfied: boolean
  missing?: string
}

export interface BlockedRecoveryInputInfo {
  task: TaskStateInfo
  gates: GateStateInfo[]
  recovery?: RecoveryStateInfo | null
}

const uniqueRoles = (items: Array<{ role: DelegableRoleId; reason: string }>): Array<{ role: DelegableRoleId; reason: string }> => {
  const roles = new Map<DelegableRoleId, string>()
  for (const item of items) if (!roles.has(item.role)) roles.set(item.role, item.reason)
  return [...roles].map(([role, reason]) => ({ role, reason }))
}

const getGateRoles = (gates: GateStateInfo[], missing: string[]): Array<{ role: DelegableRoleId; reason: string }> => {
  const roles: Array<{ role: DelegableRoleId; reason: string }> = []
  for (const gate of gates.filter((item) => !item.satisfied)) roles.push({
    role: GATE_ROLE[gate.gate].role,
    reason: `补齐门禁 ${gate.gate}：${GATE_ROLE[gate.gate].label}${gate.missing === undefined ? '' : `（${gate.missing}）`}`
  })
  for (const item of missing) {
    if (/验算|算术|数学|数值|反例/.test(item)) roles.push({ role: 'suan_heng', reason: `处理验算缺口：${item}` })
    else if (/审查|独立复核|御史/.test(item)) roles.push({ role: 'yu_shi', reason: `处理审查缺口：${item}` })
    else if (/视觉|截图|观象/.test(item)) roles.push({ role: 'guan_xiang', reason: `处理视觉证据缺口：${item}` })
    else if (/验证|测试|基准|退出码|复核/.test(item)) roles.push({ role: 'fu_he', reason: `处理验证缺口：${item}` })
  }
  return uniqueRoles(roles)
}

/**
 * 只根据当前任务、门禁和路由事实给出恢复处方。
 * 这里不自动执行工具，也不绕过任务门禁；天枢读取结果后再选择只读诊断或对应专家。
 */
export const getBlockedRecovery = (input: BlockedRecoveryInputInfo): BlockedRecoveryView => {
  const failure = input.recovery?.completed === true && input.recovery.terminal === undefined ? undefined : input.recovery?.lastFailure
  const terminal = input.recovery?.terminal
  const taskBlocked = input.task.acceptance?.status === 'blocked'
  const noProgress = input.task.checkpoint?.convergence?.blocked === true || input.task.checkpoint?.nextAction === 'incomplete'
  const accepted = input.task.acceptance?.status === 'accepted'
  const active = !accepted && (taskBlocked || noProgress || terminal !== undefined || failure !== undefined)
  const evidence: string[] = []

  if (accepted) return {
    active: false, blocked: false, cause: 'unknown', summary: '任务已验收；历史路由错误不撤销当前验收，也不要求重复执行。',
    evidence: [], recommendedRoles: [], nextAction: 'none', allowReadOnlyAutoDelegate: false, requiresUser: false
  }

  if (failure !== undefined) evidence.push(`${failure.provider}/${failure.model}: ${failure.kind}${failure.code === undefined ? '' : ` (${failure.code})`} — ${failure.message}`)
  if (terminal !== undefined) evidence.push(`最近逻辑请求终态：${terminal}`)
  if (input.task.planningReview?.status !== undefined) evidence.push(`规划审核：${input.task.planningReview.status}`)
  if (input.task.checkpoint?.unresolved?.length) evidence.push(`检查点未解决：${input.task.checkpoint.unresolved.slice(0, 3).join('；')}`)
  if (input.task.acceptance?.missing.length) evidence.push(`验收缺失：${input.task.acceptance.missing.slice(0, 3).join('；')}`)

  if (failure?.kind === 'protocol_incompatible') {
    return {
      active, blocked: taskBlocked, cause: 'provider-protocol',
      summary: '当前会话与故障模型的消息协议不兼容；继续原路由只会重复失败。应先切到兼容回退模型，再由只读专家核对恢复后的会话与证据。',
      evidence, recommendedRoles: [{ role: 'fu_he', reason: '只读核对切换路由后的会话、证据与未完成步骤，不重放业务写入' }],
      nextAction: 'delegate-readonly-diagnosis', allowReadOnlyAutoDelegate: true, requiresUser: false
    }
  }
  if (terminal !== undefined) {
    return {
      active, blocked: taskBlocked, cause: 'route-exhausted',
      summary: '当前逻辑请求没有可用路由或恢复次数已耗尽；应先切换模型、等待明确恢复时间或处理宿主服务，而不是重复提交同一业务任务。',
      evidence, recommendedRoles: [], nextAction: 'switch-route', allowReadOnlyAutoDelegate: false,
      requiresUser: terminal !== 'route_chain_exhausted'
    }
  }
  if (input.task.planningReview?.status === 'unavailable') {
    return {
      active, blocked: taskBlocked, cause: 'planning-service',
      summary: '规划审核服务未返回结果；先恢复审核通道并显式复审，不能把服务故障解释为用户未授权或任务无效。',
      evidence, recommendedRoles: [{ role: 'yu_shi', reason: '审核通道恢复后执行独立只读复审' }],
      nextAction: 'wait-external', allowReadOnlyAutoDelegate: false, requiresUser: false
    }
  }
  if (noProgress) {
    return {
      active, blocked: taskBlocked, cause: 'no-progress',
      summary: '连续检查点没有新增证据或已解决发现；应回到任务合同修正实质缺口，而不是继续同义改卡或重复评分。',
      evidence, recommendedRoles: uniqueRoles([{ role: 'mou_ding', reason: '重新拆分受阻节点并给出最小修正合同' }, { role: 'yu_shi', reason: '只读审查新方案是否解决旧发现' }]),
      nextAction: 'revise-plan', allowReadOnlyAutoDelegate: true, requiresUser: false
    }
  }

  const missingGates = input.gates.filter((gate) => !gate.satisfied)
  const roles = getGateRoles(input.gates, input.task.acceptance?.missing ?? [])
  if (missingGates.length > 0 || roles.length > 0) {
    const gap = missingGates.length > 0 || /缺失|不满足|不足|需要|未运行|未提供/.test((input.task.acceptance?.missing ?? []).join(' '))
    return {
      active, blocked: taskBlocked, cause: gap ? 'missing-gate' : 'verification-gap',
      summary: gap ? '任务仍有未满足的硬门禁或验收证据；按门禁映射委派对应专家补齐。' : '任务已到阻塞状态，但未发现路由故障；应按缺失证据委派验证角色。',
      evidence, recommendedRoles: roles, nextAction: 'delegate-gate', allowReadOnlyAutoDelegate: true, requiresUser: false
    }
  }

  return {
    active, blocked: taskBlocked, cause: 'unknown', summary: '没有识别出可直接自动恢复的根因；保留现有门禁并请求宿主维护或用户裁决。',
    evidence, recommendedRoles: [], nextAction: active ? 'wait-external' : 'none', allowReadOnlyAutoDelegate: false, requiresUser: active
  }
}
