import { randomUUID } from 'node:crypto'
import type { DurableStateStore } from './state-store.js'
import { getValueDigest } from './workflow.js'
import { SwarmError } from './util/errors.js'

export const AUTHORIZATION_POLICY_VERSION = 1
export type AuthorizationPhase = 'prepared' | 'waiting' | 'reconcile-required' | 'answered' | 'approved' | 'declined' | 'cancelled' | 'invalidated' | 'unavailable'
export interface AuthorizationBinding {
  rootSessionId: string
  workspaceId: string
  taskId: string
  lineageId: string
  requestRevision: number
  cardRevision: number
  workflowRevision: number
  nodeId?: string
}
export interface AuthorizationQuestion {
  id: string
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}
export interface AuthorizationApprovalRule { questionId: string; approveLabels: string[]; declineLabels: string[] }
export interface AuthorizationAnswer { id: string; selected: string[]; custom?: string }
export interface AuthorizationQuestionIdentity { id: string; optionDigests: string[]; multiSelect: boolean }
export interface AuthorizationRecordedAnswer { id: string; selectedIndices: number[]; customDigest?: string }
export interface AuthorizationStoredRule { questionId: string; approveIndices: number[]; declineIndices: number[] }
export interface AuthorizationAnswerOrigin { kind: 'tool-result' | 'user-question-reply'; callId: string; messageId?: string }
export interface AuthorizationDecision {
  id: string
  policyVersion: 1
  dedupKey: string
  questionBinding: AuthorizationBinding
  operationDigest: string
  scopeDigest: string
  questions: AuthorizationQuestionIdentity[]
  questionDigest: string
  approvalRules: AuthorizationStoredRule[]
  phase: AuthorizationPhase
  decisionRevision: number
  createdAt: number
  updatedAt: number
  hostCallId?: string
  answerDigest?: string
  answers?: AuthorizationRecordedAnswer[]
  answerOrigin?: AuthorizationAnswerOrigin
  appliesToBinding?: AuthorizationBinding
  reason?: string
}
export interface AuthorizationState { authorizationDecisions?: Record<string, AuthorizationDecision> }
export interface PrepareAuthorizationInput {
  binding: AuthorizationBinding
  operationDigest: string
  scopeDigest: string
  questions: AuthorizationQuestion[]
  /** Rules come from the server-owned operation policy, never from model claims of approval. */
  approvalRules?: AuthorizationApprovalRule[]
  requiresUserDecision: true
}
export interface ConsumeAuthorizationAnswer {
  callId: string
  answers: AuthorizationAnswer[]
  origin: AuthorizationAnswerOrigin
  binding: AuthorizationBinding
  operationDigest: string
  scopeDigest: string
}
export type AuthorizationEvent =
  | { type: 'dispatch-known'; callId: string; questionDigest: string }
  | { type: 'dispatch-unknown' | 'unavailable' | 'invalidate' | 'cancel'; reason: string }
  | { type: 'answer'; input: ConsumeAuthorizationAnswer }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const id = (value: unknown): value is string => text(value) && !/[\u0000-\u001f\u007f]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const exactKeys = (value: Record<string, unknown>, allowed: string[]): boolean => Object.keys(value).every(key => allowed.includes(key))
const fail = (message: string): never => { throw new SwarmError('INVALID_ARGS', message) }
const clone = <T>(value: T): T => structuredClone(value)
const sameOwner = (a: AuthorizationBinding, b: AuthorizationBinding): boolean => ['rootSessionId', 'workspaceId', 'taskId', 'lineageId'].every(key => a[key as keyof AuthorizationBinding] === b[key as keyof AuthorizationBinding])

export const ValidateAuthorizationBinding = (raw: unknown): raw is AuthorizationBinding => object(raw)
  && exactKeys(raw, ['rootSessionId', 'workspaceId', 'taskId', 'lineageId', 'requestRevision', 'cardRevision', 'workflowRevision', 'nodeId'])
  && [raw.rootSessionId, raw.workspaceId, raw.taskId, raw.lineageId].every(id)
  && [raw.requestRevision, raw.cardRevision, raw.workflowRevision].every(revision) && (raw.nodeId === undefined || id(raw.nodeId))

/** Normalize only the public ask-user schema fields; untrusted extra fields never become policy. */
export const getAuthorizationQuestions = (raw: unknown): AuthorizationQuestion[] | undefined => {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) return undefined
  const questions: AuthorizationQuestion[] = []
  for (const row of raw) {
    if (!object(row) || !id(row.id) || !text(row.question, 4000) || (row.header !== undefined && (typeof row.header !== 'string' || row.header.length > 128))) return undefined
    const multiSelect = row.multiSelect ?? row.multi_select
    if (multiSelect !== undefined && typeof multiSelect !== 'boolean') return undefined
    if (row.multiSelect !== undefined && row.multi_select !== undefined && row.multiSelect !== row.multi_select) return undefined
    let options: AuthorizationQuestion['options']
    if (row.options !== undefined) {
      if (!Array.isArray(row.options) || row.options.length < 1 || row.options.length > 16) return undefined
      options = []
      for (const option of row.options) {
        if (!object(option) || !text(option.label, 256) || (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 1000))) return undefined
        options.push({ label: option.label, ...(option.description === undefined ? {} : { description: option.description }) })
      }
      if (new Set(options.map(option => option.label)).size !== options.length) return undefined
    }
    questions.push({ id: row.id, question: row.question, ...(row.header === undefined ? {} : { header: row.header }),
      ...(options === undefined ? {} : { options }), ...(multiSelect === undefined ? {} : { multiSelect }) })
  }
  if (new Set(questions.map(question => question.id)).size !== questions.length || JSON.stringify(questions).length > 24_000) return undefined
  return questions
}

const validRules = (raw: unknown, questions: readonly AuthorizationQuestion[]): raw is AuthorizationApprovalRule[] => Array.isArray(raw)
  && raw.length <= questions.length && new Set(raw.map(row => object(row) ? row.questionId : undefined)).size === raw.length
  && raw.every(row => {
    if (!object(row) || !exactKeys(row, ['questionId', 'approveLabels', 'declineLabels']) || !id(row.questionId)) return false
    const question = questions.find(item => item.id === row.questionId)
    if (question === undefined) return false
    const labels = [...(question.options ?? [])].map(option => option.label)
    return [row.approveLabels, row.declineLabels].every(values => Array.isArray(values) && values.length <= 16
      && new Set(values).size === values.length && values.every(value => typeof value === 'string' && labels.includes(value)))
      && !(row.approveLabels as string[]).some(value => (row.declineLabels as string[]).includes(value))
  })

export const getAuthorizationQuestionIdentities = (questions: readonly AuthorizationQuestion[]): AuthorizationQuestionIdentity[] => questions.map(question => ({
  id: question.id, optionDigests: (question.options ?? []).map(option => getValueDigest(option.label)), multiSelect: question.multiSelect === true
}))
const validIdentities = (raw: unknown): raw is AuthorizationQuestionIdentity[] => Array.isArray(raw) && raw.length > 0 && raw.length <= 8
  && new Set(raw.map(row => object(row) ? row.id : undefined)).size === raw.length
  && raw.every(row => object(row) && exactKeys(row, ['id', 'optionDigests', 'multiSelect']) && id(row.id) && typeof row.multiSelect === 'boolean'
    && Array.isArray(row.optionDigests) && row.optionDigests.length <= 16 && row.optionDigests.every(digest) && new Set(row.optionDigests).size === row.optionDigests.length)
const validStoredRules = (raw: unknown, questions: readonly AuthorizationQuestionIdentity[]): raw is AuthorizationStoredRule[] => Array.isArray(raw)
  && raw.length <= questions.length && new Set(raw.map(row => object(row) ? row.questionId : undefined)).size === raw.length
  && raw.every(row => {
    if (!object(row) || !exactKeys(row, ['questionId', 'approveIndices', 'declineIndices']) || !id(row.questionId)) return false
    const question = questions.find(item => item.id === row.questionId)
    if (question === undefined) return false
    return [row.approveIndices, row.declineIndices].every(values => Array.isArray(values) && values.length <= 16
      && new Set(values).size === values.length && values.every(value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) < question.optionDigests.length))
      && !(row.approveIndices as number[]).some(value => (row.declineIndices as number[]).includes(value))
  })
const normalizeAnswers = (raw: unknown, questions: readonly AuthorizationQuestionIdentity[]): AuthorizationRecordedAnswer[] | undefined => {
  if (!Array.isArray(raw) || raw.length !== questions.length || new Set(raw.map(row => object(row) ? row.id : undefined)).size !== raw.length) return undefined
  const answers: AuthorizationRecordedAnswer[] = []
  for (const question of questions) {
    const row = raw.find(item => object(item) && item.id === question.id)
    if (!object(row) || !exactKeys(row, ['id', 'selected', 'custom']) || !Array.isArray(row.selected)
      || row.selected.length > (question.multiSelect ? 16 : 1) || new Set(row.selected).size !== row.selected.length
      || row.selected.some(value => typeof value !== 'string' || !question.optionDigests.includes(getValueDigest(value)))
      || (row.custom !== undefined && (typeof row.custom !== 'string' || row.custom.length > 4000))) return undefined
    answers.push({ id: question.id, selectedIndices: (row.selected as string[]).map(value => question.optionDigests.indexOf(getValueDigest(value))),
      ...(typeof row.custom !== 'string' || row.custom.trim() === '' ? {} : { customDigest: getValueDigest(row.custom) }) })
  }
  return answers
}

const validOrigin = (raw: unknown): raw is AuthorizationAnswerOrigin => object(raw) && exactKeys(raw, ['kind', 'callId', 'messageId'])
  && ['tool-result', 'user-question-reply'].includes(String(raw.kind)) && id(raw.callId) && (raw.messageId === undefined || id(raw.messageId))
const answerPhase = (answers: readonly AuthorizationRecordedAnswer[], rules: readonly AuthorizationStoredRule[]): 'approved' | 'declined' | 'answered' => {
  if (answers.some(answer => answer.selectedIndices.some(index => rules.find(rule => rule.questionId === answer.id)?.declineIndices.includes(index)))) return 'declined'
  return answers.every(answer => answer.selectedIndices.length > 0 && answer.customDigest === undefined
    && answer.selectedIndices.every(index => rules.find(rule => rule.questionId === answer.id)?.approveIndices.includes(index))) ? 'approved' : 'answered'
}

export const getAuthorizationDedupKey = (input: Pick<PrepareAuthorizationInput, 'binding' | 'operationDigest' | 'scopeDigest'>): string => getValueDigest({
  rootSessionId: input.binding.rootSessionId, workspaceId: input.binding.workspaceId, taskId: input.binding.taskId,
  lineageId: input.binding.lineageId, operationDigest: input.operationDigest, scopeDigest: input.scopeDigest, policyVersion: AUTHORIZATION_POLICY_VERSION
})

const phases: readonly AuthorizationPhase[] = ['prepared', 'waiting', 'reconcile-required', 'answered', 'approved', 'declined', 'cancelled', 'invalidated', 'unavailable']
export const isAuthorizationWaiting = (decision: AuthorizationDecision): boolean => ['prepared', 'waiting', 'reconcile-required', 'unavailable'].includes(decision.phase)
export const isAuthorizationApplicable = (decision: AuthorizationDecision, binding: AuthorizationBinding, operationDigest: string, scopeDigest: string): boolean =>
  decision.phase === 'approved' && decision.policyVersion === AUTHORIZATION_POLICY_VERSION && decision.operationDigest === operationDigest
  && decision.scopeDigest === scopeDigest && decision.appliesToBinding !== undefined && getValueDigest(decision.appliesToBinding) === getValueDigest(binding)

/** Strict persisted-record validation; the outer FeatureState validator also checks task ownership. */
export const ValidateAuthorizationDecision = (raw: unknown): raw is AuthorizationDecision => {
  if (!object(raw) || !exactKeys(raw, ['id', 'policyVersion', 'dedupKey', 'questionBinding', 'operationDigest', 'scopeDigest', 'questions', 'questionDigest', 'approvalRules',
    'phase', 'decisionRevision', 'createdAt', 'updatedAt', 'hostCallId', 'answerDigest', 'answers', 'answerOrigin', 'appliesToBinding', 'reason'])
    || !id(raw.id) || raw.policyVersion !== AUTHORIZATION_POLICY_VERSION || !ValidateAuthorizationBinding(raw.questionBinding)
    || ![raw.dedupKey, raw.operationDigest, raw.scopeDigest, raw.questionDigest].every(digest) || !revision(raw.decisionRevision)
    || !phases.includes(raw.phase as AuthorizationPhase) || !Number.isFinite(raw.createdAt) || Number(raw.createdAt) < 0
    || !Number.isFinite(raw.updatedAt) || Number(raw.updatedAt) < Number(raw.createdAt)
    || (raw.hostCallId !== undefined && !id(raw.hostCallId)) || (raw.reason !== undefined && !text(raw.reason, 1000))) return false
  if (!validIdentities(raw.questions) || !validStoredRules(raw.approvalRules, raw.questions)
    || getAuthorizationDedupKey({ binding: raw.questionBinding, operationDigest: raw.operationDigest as string, scopeDigest: raw.scopeDigest as string }) !== raw.dedupKey) return false
  const identities = raw.questions
  const hasAnswer = raw.answers !== undefined || raw.answerDigest !== undefined || raw.answerOrigin !== undefined || raw.appliesToBinding !== undefined
  if (hasAnswer) {
    if (!['answered', 'approved', 'declined', 'cancelled', 'invalidated'].includes(String(raw.phase))) return false
    const answers = raw.answers
    if (!Array.isArray(answers) || answers.length !== raw.questions.length || new Set(answers.map(row => object(row) ? row.id : undefined)).size !== answers.length
      || answers.some(row => {
        const question = object(row) ? identities.find(item => item.id === row.id) : undefined
        return !object(row) || !exactKeys(row, ['id', 'selectedIndices', 'customDigest']) || question === undefined
          || !Array.isArray(row.selectedIndices) || row.selectedIndices.length > (question.multiSelect ? 16 : 1)
          || new Set(row.selectedIndices).size !== row.selectedIndices.length || row.selectedIndices.some(value => !Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= question.optionDigests.length)
          || (row.customDigest !== undefined && !digest(row.customDigest))
      }) || !digest(raw.answerDigest) || raw.answerDigest !== getValueDigest(answers) || !validOrigin(raw.answerOrigin)
      || raw.answerOrigin.callId !== raw.hostCallId || !ValidateAuthorizationBinding(raw.appliesToBinding)
      || !sameOwner(raw.questionBinding, raw.appliesToBinding)
      || raw.appliesToBinding.requestRevision < raw.questionBinding.requestRevision
      || raw.appliesToBinding.cardRevision !== raw.questionBinding.cardRevision || raw.appliesToBinding.workflowRevision !== raw.questionBinding.workflowRevision
      || (['approved', 'declined', 'answered'].includes(String(raw.phase)) && answerPhase(answers as AuthorizationRecordedAnswer[], raw.approvalRules) !== raw.phase)) return false
  }
  return (!['answered', 'approved', 'declined'].includes(String(raw.phase)) || hasAnswer)
    && (!['waiting', 'answered', 'approved', 'declined'].includes(String(raw.phase)) || id(raw.hostCallId))
}

/** Pure reducer: only verified host observations may be supplied by the server adapter. */
export const reduceAuthorizationDecision = (record: AuthorizationDecision, event: AuthorizationEvent, at: number): AuthorizationDecision => {
  if (!ValidateAuthorizationDecision(record) || !Number.isFinite(at) || at < 0) return fail('授权记录或时间无效')
  const change = (patch: Partial<AuthorizationDecision>): AuthorizationDecision => ({ ...clone(record), ...patch, decisionRevision: record.decisionRevision + 1, updatedAt: Math.max(at, record.updatedAt) })
  if (event.type === 'cancel' || event.type === 'invalidate') {
    if (!text(event.reason, 1000)) return fail('授权撤销原因必须明确且有界')
    const phase = event.type === 'cancel' ? 'cancelled' : 'invalidated'
    return record.phase === phase ? clone(record) : change({ phase, reason: event.reason })
  }
  if (event.type === 'dispatch-unknown' || event.type === 'unavailable') {
    if (!text(event.reason, 1000)) return fail('授权恢复原因必须明确且有界')
    if (!isAuthorizationWaiting(record)) return clone(record)
    const phase = event.type === 'unavailable' ? 'unavailable' : 'reconcile-required'
    return record.phase === phase && record.reason === event.reason ? clone(record) : change({ phase, reason: event.reason })
  }
  if (event.type === 'dispatch-known') {
    if (!id(event.callId) || event.questionDigest !== record.questionDigest) return fail('真实问答身份或问题合同不匹配')
    if (record.hostCallId !== undefined && record.hostCallId !== event.callId) throw new SwarmError('RECOVERY_REQUIRED', '同一用户决定已绑定另一问答，禁止重复提问')
    if (!isAuthorizationWaiting(record)) return clone(record)
    return record.phase === 'waiting' && record.hostCallId === event.callId ? clone(record) : change({ phase: 'waiting', hostCallId: event.callId })
  }
  if (event.type !== 'answer') return fail('未知授权状态事件')
  const input = event.input
  if (!ValidateAuthorizationBinding(input.binding) || !sameOwner(record.questionBinding, input.binding)
    || input.operationDigest !== record.operationDigest || input.scopeDigest !== record.scopeDigest
    || input.binding.requestRevision < record.questionBinding.requestRevision
    || input.binding.cardRevision !== record.questionBinding.cardRevision || input.binding.workflowRevision !== record.questionBinding.workflowRevision
    || !validOrigin(input.origin) || input.callId !== record.hostCallId || input.origin.callId !== input.callId) throw new SwarmError('STALE_EVIDENCE', '用户答复与当前操作、范围或原问题绑定不一致')
  const answers = normalizeAnswers(input.answers, record.questions)
  if (answers === undefined) return fail('用户答复的问题、选项或答案格式不合法')
  const answerDigest = getValueDigest(answers)
  if (record.phase === 'cancelled' || record.phase === 'invalidated') throw new SwarmError('STALE_EVIDENCE', '授权已取消或失效，迟到答复不能恢复动作')
  if (record.answerDigest !== undefined) {
    if (record.answerDigest !== answerDigest) throw new SwarmError('STALE_EVIDENCE', '同一问答已有不同的真实答复，请核对当前决定')
    return clone(record)
  }
  if (!isAuthorizationWaiting(record) || record.hostCallId === undefined) throw new SwarmError('RECOVERY_REQUIRED', '真实提问尚未绑定，不能消费用户答复')
  return change({ phase: answerPhase(answers, record.approvalRules), answers,
    answerDigest, answerOrigin: clone(input.origin), appliesToBinding: clone(input.binding) })
}

export const createAuthorizationRepository = <T extends AuthorizationState>(store: DurableStateStore<T>, options: { now?: () => number; maxEntries?: number; maxPerTask?: number; id?: () => string } = {}) => {
  const now = options.now ?? Date.now, maxEntries = options.maxEntries ?? 128, maxPerTask = options.maxPerTask ?? 64
  if (![maxEntries, maxPerTask].every(value => Number.isSafeInteger(value) && value > 0) || maxEntries > 128 || maxPerTask > 64) return fail('授权记录容量配置超出安全范围')
  let cachedSequence = -1, cache: Record<string, AuthorizationDecision> = {}
  const entries = (): Record<string, AuthorizationDecision> => {
    const sequence = store.getSequence()
    if (cachedSequence !== sequence) {
      const current = (store.readFields === undefined ? store.read().authorizationDecisions : store.readFields(['authorizationDecisions']).authorizationDecisions) ?? {}
      if (!object(current) || Object.entries(current).some(([key, value]) => !ValidateAuthorizationDecision(value) || value.id !== key)) throw new SwarmError('RECOVERY_REQUIRED', '授权状态不可验证，请通过受支持入口核对')
      cache = current; cachedSequence = sequence
    }
    return cache
  }
  const update = async (decisionId: string, event: AuthorizationEvent): Promise<AuthorizationDecision> => {
    let result: AuthorizationDecision | undefined
    await store.update(`authorization/${event.type}`, { build: (state) => {
      const current = state.authorizationDecisions?.[decisionId]
      if (current === undefined) throw new SwarmError('RECOVERY_REQUIRED', '授权决定不存在，不能猜测历史许可')
      result = reduceAuthorizationDecision(current, event, now())
      return { set: { authorizationDecisions: { [decisionId]: result } } }
    } })
    cachedSequence = -1
    return clone(result!)
  }
  return {
    get: (decisionId: string): AuthorizationDecision | undefined => { const value = entries()[decisionId]; return value === undefined ? undefined : clone(value) },
    forTask: (taskId: string, rootSessionId?: string): AuthorizationDecision[] => Object.values(entries()).filter(value => value.questionBinding.taskId === taskId
      && (rootSessionId === undefined || value.questionBinding.rootSessionId === rootSessionId)).map(clone),
    prepare: async (input: PrepareAuthorizationInput): Promise<{ decision: AuthorizationDecision; reused: boolean }> => {
      const questions = getAuthorizationQuestions(input.questions), rules = input.approvalRules ?? []
      if (input.requiresUserDecision !== true || !ValidateAuthorizationBinding(input.binding) || !digest(input.operationDigest) || !digest(input.scopeDigest)
        || questions === undefined || !validRules(rules, questions)) return fail('只为实际缺少的用户决定登记有效操作、范围与问题')
      const at = now(), dedupKey = getAuthorizationDedupKey(input)
      let result: AuthorizationDecision | undefined, reused = false
      await store.update('authorization/prepare', { build: (state) => {
        const all = Object.values(state.authorizationDecisions ?? {})
        const previous = all.find(value => value.dedupKey === dedupKey)
        if (previous !== undefined) { result = clone(previous); reused = true; return {} }
        if (all.length >= maxEntries || all.filter(value => value.questionBinding.taskId === input.binding.taskId && value.questionBinding.rootSessionId === input.binding.rootSessionId
          && value.questionBinding.workspaceId === input.binding.workspaceId).length >= maxPerTask) throw new SwarmError('CAPACITY_EXCEEDED', '授权记录容量已满；保留旧决定并经受支持的归档/核对入口处理，不重复询问或制造批准')
        result = { id: options.id?.() ?? `auth-${randomUUID()}`, policyVersion: AUTHORIZATION_POLICY_VERSION, dedupKey, questionBinding: clone(input.binding),
          operationDigest: input.operationDigest, scopeDigest: input.scopeDigest, questions: getAuthorizationQuestionIdentities(questions), questionDigest: getValueDigest(questions),
          approvalRules: rules.map(rule => ({ questionId: rule.questionId,
            approveIndices: rule.approveLabels.map(label => questions.find(question => question.id === rule.questionId)!.options!.findIndex(option => option.label === label)),
            declineIndices: rule.declineLabels.map(label => questions.find(question => question.id === rule.questionId)!.options!.findIndex(option => option.label === label)) })),
          phase: 'prepared', decisionRevision: 1, createdAt: at, updatedAt: at }
        if (!ValidateAuthorizationDecision(result) || state.authorizationDecisions?.[result.id] !== undefined) return fail('授权决定身份无效或重复')
        return { set: { authorizationDecisions: { [result.id]: result } } }
      } })
      cachedSequence = -1
      return { decision: clone(result!), reused }
    },
    dispatchKnown: (decisionId: string, input: { callId: string; questionDigest: string }) => update(decisionId, { type: 'dispatch-known', ...input }),
    dispatchUnknown: (decisionId: string, reason: string) => update(decisionId, { type: 'dispatch-unknown', reason }),
    consumeAnswer: (decisionId: string, input: ConsumeAuthorizationAnswer) => update(decisionId, { type: 'answer', input }),
    unavailable: (decisionId: string, reason: string) => update(decisionId, { type: 'unavailable', reason }),
    invalidate: (decisionId: string, reason: string) => update(decisionId, { type: 'invalidate', reason }),
    cancel: (decisionId: string, reason: string) => update(decisionId, { type: 'cancel', reason })
  }
}
