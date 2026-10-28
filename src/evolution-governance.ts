import { getValueDigest } from './workflow.js'

export const EVOLUTION_POLICY_VERSION = 'swarm-evolution/3.1.4-v1'
export const EVOLUTION_SCHEMA_VERSION = 1
export const EVOLUTION_MAX_GROUPS = 256
export const EVOLUTION_MAX_STEPS = 2048
export const EVOLUTION_MAX_REQUEST_HISTORY = 32

export type EvolutionDecision = 'continue' | 'wait' | 'stop'
export type EvolutionExpected = 'continue' | 'wait' | 'stop' | 'unknown'
export type EvolutionSeverity = 'normal' | 'severe'
export type EvolutionPhase =
  | 'candidate'
  | 'evaluating'
  | 'validated'
  | 'released'
  | 'shadow'
  | 'canary'
  | 'active'
  | 'failed'
  | 'stopped'
  | 'revoked'
  | 'reconcile-required'

export interface EvolutionTokenUsage {
  actual: number
  estimated: number
  unknown: number
}

export interface EvolutionWaitHandleObservation {
  id: string
  kind: 'tool' | 'user' | 'authorization' | 'goal'
  state: 'open' | 'settled' | 'unknown'
}

export interface EvolutionReplayStep {
  id: string
  projectionDigest: string
  artifactDigest: string
  baselineDecision: EvolutionDecision
  expected: EvolutionExpected
  severity: EvolutionSeverity
  waitHandle?: EvolutionWaitHandleObservation
  novelEvidence: boolean
  userResume?: boolean
  operationalTokens: EvolutionTokenUsage
  evaluationTokens: EvolutionTokenUsage
}

export interface EvolutionReplayGroup {
  id: string
  lineageId: string
  evidenceSequenceDigest: string
  steps: EvolutionReplayStep[]
}

export interface EvolutionReplayTrace {
  schemaVersion: 1
  split: 'development' | 'calibration' | 'acceptance'
  baselineDigest: string
  candidateDigest: string
  engineVersion: string
  policyVersion: string
  seed: number
  groups: EvolutionReplayGroup[]
}

export interface EvolutionDecisionPolicy {
  schemaVersion: 1
  id: string
  repeatThreshold: number
  respectOpenWait: boolean
  resetOnNewEvidence: boolean
}

export interface EvolutionMetricCounts {
  expectedDecisions: number
  falseStops: number
  legitimateWaitFalseStops: number
  falsePasses: number
  severeFalsePasses: number
  trueStops: number
  validWaits: number
  unknown: number
}

export interface EvolutionMetricSummary extends EvolutionMetricCounts {
  groupCount: number
  stepCount: number
  falseStopGroups: number
  falsePassGroups: number
  falseStopUpper95: number
  falsePassUpper95: number
}

export interface EvolutionEvaluationResult {
  schemaVersion: 1
  policyVersion: string
  engineVersion: string
  traceDigest: string
  policyDigest: string
  split: EvolutionReplayTrace['split']
  seed: number
  baselineDigest: string
  candidateDigest: string
  groupCount: number
  stepCount: number
  replayDigests: [string, string, string]
  deterministic: boolean
  sideEffects: 0
  networkCalls: 0
  operationalTokens: EvolutionTokenUsage
  evaluationTokens: EvolutionTokenUsage
  metrics: { candidate: EvolutionMetricSummary; baseline: EvolutionMetricSummary }
  statisticalClaim: 'not-zero-risk' | 'insufficient-independent-groups'
  outcome: 'passed' | 'failed' | 'unavailable'
  recommendation: 'manual-canary-review' | 'blocked'
  reasons: string[]
  digest: string
}

export interface EvolutionEvaluationState {
  state: 'missing' | 'pending' | 'passed' | 'failed' | 'unavailable'
  resultDigest?: string
  traceDigest?: string
  baselineDigest?: string
  candidateDigest?: string
  split?: EvolutionReplayTrace['split']
  groupCount?: number
  stepCount?: number
  falseStops?: number
  legitimateWaitFalseStops?: number
  falsePasses?: number
  severeFalsePasses?: number
  unknown?: number
  falseStopUpper95?: number
  falsePassUpper95?: number
  operationalTokens?: EvolutionTokenUsage
  evaluationTokens?: EvolutionTokenUsage
  observedAt?: number
}

export interface EvolutionReleaseRef {
  releaseId: string
  version: string
  gitCommit: string
  artifactSha256: string
  manifestDigest: string
  policyVersion: string
  previousVersion?: string
  registeredAt: number
}

export interface EvolutionShadowState {
  state: 'not_started' | 'observing' | 'stopped'
  samples: number
  recommendation: 'unknown' | 'continue' | 'stop'
  changedExecution: false
  startedAt?: number
  updatedAt?: number
}

export interface EvolutionCanaryScope {
  rootSessionId: string
  workspaceId: string
  taskId: string
  lineageId: string
}

export interface EvolutionCanaryState {
  state: 'not_requested' | 'awaiting_user' | 'authorized' | 'active' | 'stopped' | 'complete'
  safetyViolations: number
  stopPolicyDigest?: string
  scope?: EvolutionCanaryScope
  authorizationRef?: string
  startedAt?: number
  updatedAt?: number
  reason?: string
}

export interface EvolutionRevokeState {
  state: 'none' | 'requested' | 'pending_inflight' | 'complete' | 'blocked'
  unresolvedHandles: number
  reason?: string
  requestedAt?: number
  updatedAt?: number
}

export interface EvolutionGovernance {
  schemaVersion: 1
  revision: number
  phase: EvolutionPhase
  evaluation: EvolutionEvaluationState
  shadow: EvolutionShadowState
  canary: EvolutionCanaryState
  revoke: EvolutionRevokeState
  release?: EvolutionReleaseRef
  requestIndex: Record<string, string>
  updatedAt: number
}

export type EvolutionGovernanceEvent =
  | { type: 'begin-evaluation'; traceDigest: string; baselineDigest: string; candidateDigest: string }
  | { type: 'record-evaluation'; result: EvolutionEvaluationResult }
  | { type: 'register-release'; release: EvolutionReleaseRef }
  | { type: 'start-shadow'; at: number }
  | { type: 'record-shadow'; at: number; recommendation: 'continue' | 'stop' }
  | { type: 'request-canary'; scope: EvolutionCanaryScope; stopPolicyDigest: string; at: number }
  | { type: 'authorize-canary'; scope: EvolutionCanaryScope; authorizationRef: string; stopPolicyDigest: string; at: number }
  | { type: 'activate-canary'; at: number }
  | { type: 'stop-canary'; at: number; reason: string; safetyViolation: boolean }
  | { type: 'promote'; at: number; reason?: string }
  | { type: 'revoke'; at: number; reason: string; unresolvedHandles: number }
  | { type: 'reconcile'; at: number; reason: string }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= max
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const integer = (value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const clone = <T>(value: T): T => structuredClone(value)
const decision = (value: unknown): value is EvolutionDecision => ['continue', 'wait', 'stop'].includes(String(value))
const expected = (value: unknown): value is EvolutionExpected => ['continue', 'wait', 'stop', 'unknown'].includes(String(value))
const severity = (value: unknown): value is EvolutionSeverity => ['normal', 'severe'].includes(String(value))
const versionText = (value: unknown): value is string => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
const safeScope = (value: unknown): value is EvolutionCanaryScope => object(value)
  && exactKeys(value, ['rootSessionId', 'workspaceId', 'taskId', 'lineageId'])
  && text(value.rootSessionId, 512) && digest(value.workspaceId) && text(value.taskId, 128) && digest(value.lineageId)

export const ValidateEvolutionTokenUsage = (value: unknown): value is EvolutionTokenUsage => object(value)
  && exactKeys(value, ['actual', 'estimated', 'unknown'])
  && [value.actual, value.estimated, value.unknown].every(item => integer(item))

export const ValidateEvolutionDecisionPolicy = (value: unknown): value is EvolutionDecisionPolicy => object(value)
  && exactKeys(value, ['schemaVersion', 'id', 'repeatThreshold', 'respectOpenWait', 'resetOnNewEvidence'])
  && value.schemaVersion === 1 && text(value.id, 128) && integer(value.repeatThreshold, 1, 32)
  && typeof value.respectOpenWait === 'boolean' && typeof value.resetOnNewEvidence === 'boolean'

const validateWaitHandle = (value: unknown): value is EvolutionWaitHandleObservation => object(value)
  && exactKeys(value, ['id', 'kind', 'state']) && text(value.id, 512)
  && ['tool', 'user', 'authorization', 'goal'].includes(String(value.kind))
  && ['open', 'settled', 'unknown'].includes(String(value.state))

const validateStep = (value: unknown): value is EvolutionReplayStep => object(value)
  && exactKeys(value, ['id', 'projectionDigest', 'artifactDigest', 'baselineDecision', 'expected', 'severity',
    'waitHandle', 'novelEvidence', 'userResume', 'operationalTokens', 'evaluationTokens'])
  && text(value.id, 128) && digest(value.projectionDigest) && digest(value.artifactDigest)
  && decision(value.baselineDecision) && expected(value.expected) && severity(value.severity)
  && (value.waitHandle === undefined || validateWaitHandle(value.waitHandle))
  && typeof value.novelEvidence === 'boolean' && (value.userResume === undefined || typeof value.userResume === 'boolean')
  && ValidateEvolutionTokenUsage(value.operationalTokens) && ValidateEvolutionTokenUsage(value.evaluationTokens)

export const ValidateEvolutionReplayTrace = (value: unknown): value is EvolutionReplayTrace => {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'split', 'baselineDigest', 'candidateDigest', 'engineVersion', 'policyVersion', 'seed', 'groups'])
    || value.schemaVersion !== 1 || !['development', 'calibration', 'acceptance'].includes(String(value.split))
    || !digest(value.baselineDigest) || !digest(value.candidateDigest) || !text(value.engineVersion, 128)
    || value.policyVersion !== EVOLUTION_POLICY_VERSION || !integer(value.seed) || !Array.isArray(value.groups)
    || value.groups.length < 1 || value.groups.length > EVOLUTION_MAX_GROUPS) return false
  let stepCount = 0
  const groups = new Set<string>(), lineages = new Set<string>(), stepIds = new Set<string>()
  for (const group of value.groups) {
    if (!object(group) || !exactKeys(group, ['id', 'lineageId', 'evidenceSequenceDigest', 'steps'])
      || !text(group.id, 128) || !digest(group.lineageId) || !digest(group.evidenceSequenceDigest)
      || groups.has(group.id) || lineages.has(group.lineageId) || !Array.isArray(group.steps) || group.steps.length === 0) return false
    groups.add(group.id); lineages.add(group.lineageId)
    for (const step of group.steps) {
      if (!validateStep(step) || stepIds.has(step.id)) return false
      stepIds.add(step.id)
      stepCount++
      if (stepCount > EVOLUTION_MAX_STEPS) return false
    }
  }
  return true
}

const emptyTokens = (): EvolutionTokenUsage => ({ actual: 0, estimated: 0, unknown: 0 })
const addTokens = (target: EvolutionTokenUsage, source: EvolutionTokenUsage): void => {
  target.actual += source.actual
  target.estimated += source.estimated
  target.unknown += source.unknown
}

const getBinomLog = (n: number, k: number): number => {
  let value = 0
  for (let index = 1; index <= k; index++) value += Math.log(n - k + index) - Math.log(index)
  return value
}

const getBinomialCdf = (events: number, trials: number, probability: number): number => {
  if (events < 0) return 0
  if (events >= trials) return 1
  if (probability <= 0) return 1
  if (probability >= 1) return events >= trials ? 1 : 0
  const logs: number[] = []
  for (let count = 0; count <= events; count++) {
    logs.push(getBinomLog(trials, count) + count * Math.log(probability) + (trials - count) * Math.log1p(-probability))
  }
  const maximum = Math.max(...logs)
  return Math.exp(maximum) * logs.reduce((sum, item) => sum + Math.exp(item - maximum), 0)
}

/** One-sided Clopper-Pearson upper bound; 0/n remains an interval, never a claim of zero risk. */
export const getEvolutionUpper95 = (events: number, trials: number): number => {
  if (!integer(events) || !integer(trials) || trials === 0 || events > trials) throw new Error('Invalid binomial counts')
  if (events === trials) return 1
  let low = events / trials, high = 1
  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = (low + high) / 2
    if (getBinomialCdf(events, trials, middle) > 0.05) low = middle
    else high = middle
  }
  return high
}

const getMetrics = (groups: readonly EvolutionReplayGroup[], decisions: readonly string[]): EvolutionMetricSummary => {
  const counts: EvolutionMetricCounts = {
    expectedDecisions: 0, falseStops: 0, legitimateWaitFalseStops: 0, falsePasses: 0,
    severeFalsePasses: 0, trueStops: 0, validWaits: 0, unknown: 0
  }
  let cursor = 0, falseStopGroups = 0, falsePassGroups = 0
  for (const group of groups) {
    let groupFalseStop = false, groupFalsePass = false
    for (const step of group.steps) {
      const observed = decisions[cursor++]!
      counts.expectedDecisions++
      if (step.expected === 'unknown') { counts.unknown++; continue }
      if (step.expected === 'stop' && observed !== 'stop') {
        counts.falsePasses++; groupFalsePass = true
        if (step.severity === 'severe') counts.severeFalsePasses++
      }
      if ((step.expected === 'continue' || step.expected === 'wait') && observed === 'stop') {
        counts.falseStops++; groupFalseStop = true
        if (step.expected === 'wait') counts.legitimateWaitFalseStops++
      }
      if (step.expected === 'stop' && observed === 'stop') counts.trueStops++
      if (step.expected === 'wait' && observed === 'wait') counts.validWaits++
    }
    if (groupFalseStop) falseStopGroups++
    if (groupFalsePass) falsePassGroups++
  }
  return {
    ...counts, groupCount: groups.length, stepCount: cursor,
    falseStopGroups, falsePassGroups,
    falseStopUpper95: getEvolutionUpper95(falseStopGroups, groups.length),
    falsePassUpper95: getEvolutionUpper95(falsePassGroups, groups.length)
  }
}

const replay = (trace: EvolutionReplayTrace, policy: EvolutionDecisionPolicy): EvolutionDecision[] => {
  const decisions: EvolutionDecision[] = []
  for (const group of trace.groups) {
    // 每组是独立谱系，与运行时按谱系计数一致；跨组共享计数会把独立样本误判为重复。
    const hits = new Map<string, number>()
    for (const step of group.steps) {
      if (step.waitHandle?.state === 'open' && policy.respectOpenWait) { decisions.push('wait'); continue }
      if (step.userResume === true || (step.novelEvidence && policy.resetOnNewEvidence)) hits.delete(step.projectionDigest)
      const count = (hits.get(step.projectionDigest) ?? 0) + 1
      hits.set(step.projectionDigest, count)
      decisions.push(count > policy.repeatThreshold ? 'stop' : 'continue')
    }
  }
  return decisions
}

const withoutResultDigest = (result: Omit<EvolutionEvaluationResult, 'digest'>): Omit<EvolutionEvaluationResult, 'digest'> => result

/** Pure decision replay. It accepts no tool, filesystem, network, clock or random source. */
export const runEvolutionEvaluation = (trace: EvolutionReplayTrace, policy: EvolutionDecisionPolicy): EvolutionEvaluationResult => {
  if (!ValidateEvolutionReplayTrace(trace) || !ValidateEvolutionDecisionPolicy(policy)) throw new Error('Invalid evolution trace or policy')
  const traceDigest = getValueDigest(trace), policyDigest = getValueDigest(policy)
  const runs = [replay(trace, policy), replay(trace, policy), replay(trace, policy)]
  const replayDigests = runs.map((run) => getValueDigest({ traceDigest, policyDigest, seed: trace.seed, decisions: run })) as [string, string, string]
  const deterministic = new Set(replayDigests).size === 1
  const baselineFlat = trace.groups.flatMap(group => group.steps.map(step => step.baselineDecision))
  const metrics = {
    candidate: getMetrics(trace.groups, runs[0]!),
    baseline: getMetrics(trace.groups, baselineFlat)
  }
  const operationalTokens = emptyTokens(), evaluationTokens = emptyTokens()
  for (const group of trace.groups) for (const step of group.steps) {
    addTokens(operationalTokens, step.operationalTokens)
    addTokens(evaluationTokens, step.evaluationTokens)
  }
  const reasons: string[] = []
  if (trace.split !== 'acceptance') reasons.push('development/calibration traces cannot authorize release')
  if (trace.groups.length < 3) reasons.push('fewer than three independent groups')
  if (!deterministic) reasons.push('three replay digests differ')
  if (metrics.candidate.unknown > 0) reasons.push('unknown decisions remain')
  if (metrics.candidate.legitimateWaitFalseStops > 0) reasons.push('legitimate waiting was stopped')
  if (metrics.candidate.severeFalsePasses > 0) reasons.push('severe false pass remains')
  if (metrics.candidate.falseStops > metrics.baseline.falseStops) reasons.push('false stops regress against baseline')
  if (metrics.candidate.falsePasses > metrics.baseline.falsePasses) reasons.push('false passes regress against baseline')
  if (!(metrics.candidate.trueStops > metrics.baseline.trueStops
    || metrics.candidate.falseStops < metrics.baseline.falseStops
    || metrics.candidate.falsePasses < metrics.baseline.falsePasses)) reasons.push('no measured decision improvement')
  const outcome: EvolutionEvaluationResult['outcome'] = trace.split === 'acceptance' && trace.groups.length > 0 ? (reasons.length === 0 ? 'passed' : 'failed') : 'unavailable'
  const result = withoutResultDigest({
    schemaVersion: 1, policyVersion: EVOLUTION_POLICY_VERSION, engineVersion: trace.engineVersion,
    traceDigest, policyDigest, split: trace.split, seed: trace.seed,
    baselineDigest: trace.baselineDigest, candidateDigest: trace.candidateDigest,
    groupCount: trace.groups.length, stepCount: trace.groups.reduce((sum, group) => sum + group.steps.length, 0),
    replayDigests, deterministic, sideEffects: 0, networkCalls: 0, operationalTokens, evaluationTokens, metrics,
    statisticalClaim: trace.groups.length >= 30 ? 'not-zero-risk' : 'insufficient-independent-groups',
    outcome, recommendation: outcome === 'passed' ? 'manual-canary-review' : 'blocked', reasons
  })
  return { ...result, digest: getValueDigest(result) }
}

export const ValidateEvolutionEvaluationResult = (value: unknown): value is EvolutionEvaluationResult => {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'policyVersion', 'engineVersion', 'traceDigest', 'policyDigest', 'split', 'seed',
    'baselineDigest', 'candidateDigest', 'groupCount', 'stepCount', 'replayDigests', 'deterministic', 'sideEffects', 'networkCalls',
    'operationalTokens', 'evaluationTokens', 'metrics', 'statisticalClaim', 'outcome', 'recommendation', 'reasons', 'digest'])
    || value.schemaVersion !== 1 || value.policyVersion !== EVOLUTION_POLICY_VERSION || !text(value.engineVersion, 128)
    || ![value.traceDigest, value.policyDigest, value.baselineDigest, value.candidateDigest, value.digest, ...(Array.isArray(value.replayDigests) ? value.replayDigests : [])].every(digest)
    || !['development', 'calibration', 'acceptance'].includes(String(value.split)) || !integer(value.seed)
    || !integer(value.groupCount, 1, EVOLUTION_MAX_GROUPS) || !integer(value.stepCount, 1, EVOLUTION_MAX_STEPS)
    || !Array.isArray(value.replayDigests) || value.replayDigests.length !== 3 || typeof value.deterministic !== 'boolean'
    || value.sideEffects !== 0 || value.networkCalls !== 0 || !ValidateEvolutionTokenUsage(value.operationalTokens)
    || !ValidateEvolutionTokenUsage(value.evaluationTokens) || !object(value.metrics)
    || !['not-zero-risk', 'insufficient-independent-groups'].includes(String(value.statisticalClaim))
    || !['passed', 'failed', 'unavailable'].includes(String(value.outcome))
    || !['manual-canary-review', 'blocked'].includes(String(value.recommendation))
    || !Array.isArray(value.reasons) || value.reasons.length > 16 || value.reasons.some(reason => !text(reason, 512))) return false
  const { digest: stored, ...payload } = value
  return stored === getValueDigest(payload)
}

export const getInitialEvolutionGovernance = (at: number): EvolutionGovernance => {
  if (!timestamp(at)) throw new Error('Invalid evolution timestamp')
  return {
    schemaVersion: 1, revision: 1, phase: 'candidate',
    evaluation: { state: 'missing' },
    shadow: { state: 'not_started', samples: 0, recommendation: 'unknown', changedExecution: false },
    canary: { state: 'not_requested', safetyViolations: 0 },
    revoke: { state: 'none', unresolvedHandles: 0 },
    requestIndex: {}, updatedAt: at
  }
}

const validateEvaluationState = (value: unknown): value is EvolutionEvaluationState => {
  if (!object(value) || !exactKeys(value, ['state', 'resultDigest', 'traceDigest', 'baselineDigest', 'candidateDigest', 'split',
    'groupCount', 'stepCount', 'falseStops', 'legitimateWaitFalseStops', 'falsePasses', 'severeFalsePasses', 'unknown',
    'falseStopUpper95', 'falsePassUpper95', 'operationalTokens', 'evaluationTokens', 'observedAt'])
    || !['missing', 'pending', 'passed', 'failed', 'unavailable'].includes(String(value.state))) return false
  if (value.state === 'missing') return Object.keys(value).length === 1
  if (value.state === 'pending') return digest(value.traceDigest) && digest(value.baselineDigest) && digest(value.candidateDigest)
    && Object.keys(value).every(key => ['state', 'traceDigest', 'baselineDigest', 'candidateDigest'].includes(key))
  return digest(value.resultDigest) && digest(value.traceDigest) && digest(value.baselineDigest) && digest(value.candidateDigest)
    && ['development', 'calibration', 'acceptance'].includes(String(value.split))
    && [value.groupCount, value.stepCount, value.falseStops, value.legitimateWaitFalseStops, value.falsePasses, value.severeFalsePasses, value.unknown].every(item => integer(item))
    && typeof value.falseStopUpper95 === 'number' && value.falseStopUpper95 >= 0 && value.falseStopUpper95 <= 1
    && typeof value.falsePassUpper95 === 'number' && value.falsePassUpper95 >= 0 && value.falsePassUpper95 <= 1
    && ValidateEvolutionTokenUsage(value.operationalTokens) && ValidateEvolutionTokenUsage(value.evaluationTokens) && timestamp(value.observedAt)
}

const validateRelease = (value: unknown): value is EvolutionReleaseRef => object(value)
  && exactKeys(value, ['releaseId', 'version', 'gitCommit', 'artifactSha256', 'manifestDigest', 'policyVersion', 'previousVersion', 'registeredAt'])
  && text(value.releaseId, 128) && versionText(value.version) && commit(value.gitCommit) && digest(value.artifactSha256)
  && digest(value.manifestDigest) && text(value.policyVersion, 128) && (value.previousVersion === undefined || versionText(value.previousVersion))
  && timestamp(value.registeredAt)

const validateShadow = (value: unknown): value is EvolutionShadowState => object(value)
  && exactKeys(value, ['state', 'samples', 'recommendation', 'changedExecution', 'startedAt', 'updatedAt'])
  && ['not_started', 'observing', 'stopped'].includes(String(value.state)) && integer(value.samples)
  && ['unknown', 'continue', 'stop'].includes(String(value.recommendation)) && value.changedExecution === false
  && (value.startedAt === undefined || timestamp(value.startedAt)) && (value.updatedAt === undefined || timestamp(value.updatedAt))

const validateCanary = (value: unknown): value is EvolutionCanaryState => object(value)
  && exactKeys(value, ['state', 'safetyViolations', 'stopPolicyDigest', 'scope', 'authorizationRef', 'startedAt', 'updatedAt', 'reason'])
  && ['not_requested', 'awaiting_user', 'authorized', 'active', 'stopped', 'complete'].includes(String(value.state))
  && integer(value.safetyViolations) && (value.stopPolicyDigest === undefined || digest(value.stopPolicyDigest))
  && (value.scope === undefined || safeScope(value.scope)) && (value.authorizationRef === undefined || text(value.authorizationRef, 512))
  && (value.startedAt === undefined || timestamp(value.startedAt)) && (value.updatedAt === undefined || timestamp(value.updatedAt))
  && (value.reason === undefined || text(value.reason, 1000))

const validateRevoke = (value: unknown): value is EvolutionRevokeState => object(value)
  && exactKeys(value, ['state', 'unresolvedHandles', 'reason', 'requestedAt', 'updatedAt'])
  && ['none', 'requested', 'pending_inflight', 'complete', 'blocked'].includes(String(value.state))
  && integer(value.unresolvedHandles) && (value.reason === undefined || text(value.reason, 1000))
  && (value.requestedAt === undefined || timestamp(value.requestedAt)) && (value.updatedAt === undefined || timestamp(value.updatedAt))

export const ValidateEvolutionGovernance = (value: unknown): value is EvolutionGovernance => {
  if (!object(value) || !exactKeys(value, ['schemaVersion', 'revision', 'phase', 'evaluation', 'shadow', 'canary', 'revoke', 'release', 'requestIndex', 'updatedAt'])
    || value.schemaVersion !== 1 || !integer(value.revision, 1) || !timestamp(value.updatedAt)
    || !['candidate', 'evaluating', 'validated', 'released', 'shadow', 'canary', 'active', 'failed', 'stopped', 'revoked', 'reconcile-required'].includes(String(value.phase))
    || !validateEvaluationState(value.evaluation) || !validateShadow(value.shadow) || !validateCanary(value.canary) || !validateRevoke(value.revoke)
    || (value.release !== undefined && !validateRelease(value.release)) || !object(value.requestIndex)
    || Object.keys(value.requestIndex).length > EVOLUTION_MAX_REQUEST_HISTORY
    || Object.entries(value.requestIndex).some(([key, item]) => !digest(key) || !digest(item))) return false
  if (['released', 'shadow', 'canary', 'active'].includes(String(value.phase)) && (value.evaluation.state !== 'passed' || value.release === undefined)) return false
  if (value.phase === 'active' && (value.canary.state !== 'complete' || value.canary.authorizationRef === undefined)) return false
  if (value.phase === 'revoked' && value.revoke.state === 'none') return false
  return true
}

const eventPayload = (event: EvolutionGovernanceEvent): unknown => {
  if (event.type === 'record-evaluation') return { type: event.type, digest: event.result.digest }
  if (event.type === 'reconcile') return { ...event, reason: event.reason }
  return event
}

const assertTransition = (record: EvolutionGovernance, next: EvolutionPhase, allowed: readonly EvolutionPhase[]): void => {
  if (!allowed.includes(record.phase)) throw new Error(`Evolution transition ${record.phase} -> ${next} is not allowed`)
}

export const transitionEvolutionGovernance = (
  record: EvolutionGovernance,
  event: EvolutionGovernanceEvent,
  options: { expectedRevision: number; requestId: string; at: number }
): EvolutionGovernance => {
  if (!ValidateEvolutionGovernance(record) || !integer(options.expectedRevision, 1) || !text(options.requestId, 512) || !timestamp(options.at)) {
    throw new Error('Invalid evolution transition input')
  }
  const requestKey = getValueDigest(options.requestId), requestDigest = getValueDigest(eventPayload(event))
  const prior = record.requestIndex[requestKey]
  if (prior !== undefined) {
    if (prior !== requestDigest) throw new Error('Evolution request id was reused with a different action')
    return clone(record)
  }
  if (record.phase === 'revoked' && event.type !== 'revoke') throw new Error('Revoked evolution state cannot be revived')
  if (options.expectedRevision !== record.revision) throw new Error('Evolution revision conflict')
  const next = clone(record)
  next.updatedAt = Math.max(record.updatedAt, options.at)
  switch (event.type) {
    case 'begin-evaluation':
      assertTransition(record, 'evaluating', ['candidate'])
      if (!digest(event.traceDigest) || !digest(event.baselineDigest) || !digest(event.candidateDigest)) throw new Error('Invalid evaluation digests')
      next.phase = 'evaluating'
      next.evaluation = { state: 'pending', traceDigest: event.traceDigest, baselineDigest: event.baselineDigest, candidateDigest: event.candidateDigest }
      break
    case 'record-evaluation': {
      assertTransition(record, event.result.outcome === 'passed' ? 'validated' : event.result.outcome === 'failed' ? 'failed' : 'reconcile-required', ['evaluating'])
      if (!ValidateEvolutionEvaluationResult(event.result)
        || event.result.traceDigest !== record.evaluation.traceDigest
        || event.result.baselineDigest !== record.evaluation.baselineDigest
        || event.result.candidateDigest !== record.evaluation.candidateDigest) throw new Error('Evaluation result does not match the frozen evaluation')
      next.phase = event.result.outcome === 'passed' ? 'validated' : event.result.outcome === 'failed' ? 'failed' : 'reconcile-required'
      next.evaluation = {
        state: event.result.outcome === 'passed' ? 'passed' : event.result.outcome,
        resultDigest: event.result.digest, traceDigest: event.result.traceDigest, baselineDigest: event.result.baselineDigest,
        candidateDigest: event.result.candidateDigest, split: event.result.split, groupCount: event.result.groupCount,
        stepCount: event.result.stepCount, falseStops: event.result.metrics.candidate.falseStops,
        legitimateWaitFalseStops: event.result.metrics.candidate.legitimateWaitFalseStops,
        falsePasses: event.result.metrics.candidate.falsePasses, severeFalsePasses: event.result.metrics.candidate.severeFalsePasses,
        unknown: event.result.metrics.candidate.unknown, falseStopUpper95: event.result.metrics.candidate.falseStopUpper95,
        falsePassUpper95: event.result.metrics.candidate.falsePassUpper95, operationalTokens: event.result.operationalTokens,
        evaluationTokens: event.result.evaluationTokens, observedAt: options.at
      }
      break
    }
    case 'register-release':
      assertTransition(record, 'released', ['validated'])
      if (!validateRelease(event.release) || record.evaluation.state !== 'passed' || record.evaluation.candidateDigest !== event.release.artifactSha256) {
        throw new Error('Release artifact does not match the passed candidate evaluation')
      }
      next.phase = 'released'; next.release = clone(event.release)
      break
    case 'start-shadow':
      assertTransition(record, 'shadow', ['released'])
      if (!timestamp(event.at)) throw new Error('Invalid shadow start')
      next.phase = 'shadow'; next.shadow = { state: 'observing', samples: 0, recommendation: 'unknown', changedExecution: false, startedAt: event.at, updatedAt: event.at }
      break
    case 'record-shadow':
      assertTransition(record, 'shadow', ['shadow'])
      if (!timestamp(event.at) || !['continue', 'stop'].includes(event.recommendation) || next.shadow.samples >= 1_000_000) throw new Error('Invalid shadow observation')
      next.shadow = { ...next.shadow, samples: next.shadow.samples + 1, recommendation: event.recommendation, updatedAt: event.at,
        ...(event.recommendation === 'stop' ? { state: 'stopped' as const } : {}) }
      break
    case 'request-canary':
      assertTransition(record, 'canary', ['shadow'])
      if (!safeScope(event.scope) || !digest(event.stopPolicyDigest) || !timestamp(event.at) || record.shadow.samples === 0) throw new Error('Canary requires shadow evidence and an explicit root scope')
      next.phase = 'canary'
      next.canary = { state: 'awaiting_user', safetyViolations: 0, scope: clone(event.scope), stopPolicyDigest: event.stopPolicyDigest, updatedAt: event.at }
      break
    case 'authorize-canary':
      assertTransition(record, 'canary', ['canary'])
      if (record.canary.state !== 'awaiting_user' || !safeScope(event.scope) || !text(event.authorizationRef, 512)
        || !digest(event.stopPolicyDigest) || getValueDigest(event.scope) !== getValueDigest(record.canary.scope)
        || event.stopPolicyDigest !== record.canary.stopPolicyDigest) throw new Error('Canary authorization does not match the requested root scope')
      next.canary = { ...next.canary, state: 'authorized', authorizationRef: event.authorizationRef, updatedAt: event.at }
      break
    case 'activate-canary':
      assertTransition(record, 'canary', ['canary'])
      if (record.canary.state !== 'authorized' || record.canary.authorizationRef === undefined || record.canary.scope === undefined) throw new Error('Canary is not authorized')
      next.canary = { ...next.canary, state: 'active', startedAt: event.at, updatedAt: event.at }
      break
    case 'stop-canary':
      assertTransition(record, 'stopped', ['shadow', 'canary'])
      if (!text(event.reason, 1000) || !timestamp(event.at)) throw new Error('Canary stop requires a reason')
      next.phase = 'stopped'
      next.shadow = { ...next.shadow, state: 'stopped', updatedAt: event.at, recommendation: 'stop' }
      next.canary = { ...next.canary, state: 'stopped', updatedAt: event.at, reason: event.reason,
        safetyViolations: next.canary.safetyViolations + (event.safetyViolation ? 1 : 0) }
      break
    case 'promote':
      assertTransition(record, 'active', ['canary'])
      if (record.canary.state !== 'active' || record.canary.authorizationRef === undefined) throw new Error('Promotion needs an active authorized Canary')
      next.phase = 'active'
      next.canary = { ...next.canary, state: 'complete', updatedAt: event.at, ...(event.reason === undefined ? {} : { reason: event.reason }) }
      break
    case 'revoke':
      if (!text(event.reason, 1000) || !integer(event.unresolvedHandles)) throw new Error('Revocation needs a reason and unresolved handle count')
      next.phase = 'revoked'
      next.shadow = { ...next.shadow, state: 'stopped', recommendation: 'stop', updatedAt: event.at }
      next.canary = { ...next.canary, state: 'stopped', updatedAt: event.at, reason: event.reason }
      next.revoke = { state: event.unresolvedHandles > 0 ? 'pending_inflight' : 'complete', unresolvedHandles: event.unresolvedHandles,
        reason: event.reason, requestedAt: record.revoke.requestedAt ?? event.at, updatedAt: event.at }
      break
    case 'reconcile':
      if (!text(event.reason, 1000) || !['evaluating', 'shadow', 'canary'].includes(record.phase)) throw new Error('Only transient evolution states require reconciliation')
      next.phase = 'reconcile-required'
      if (record.phase === 'shadow') next.shadow = { ...next.shadow, state: 'stopped', updatedAt: event.at }
      if (record.phase === 'canary') next.canary = { ...next.canary, state: 'stopped', updatedAt: event.at, reason: event.reason }
      break
  }
  next.revision = record.revision + 1
  next.requestIndex = { ...record.requestIndex, [requestKey]: requestDigest }
  if (!ValidateEvolutionGovernance(next)) throw new Error('Evolution transition produced invalid state')
  return next
}

export const isEvolutionActiveForRecall = (governance: EvolutionGovernance | undefined): boolean => governance === undefined || governance.phase === 'active'

export const getEvolutionCanaryOperationDigest = (input: {
  experienceId: string
  evaluationResultDigest: string
  releaseManifestDigest: string
  stopPolicyDigest: string
}): string => getValueDigest({
  kind: 'evolution-canary', experienceId: input.experienceId, evaluationResultDigest: input.evaluationResultDigest,
  releaseManifestDigest: input.releaseManifestDigest, stopPolicyDigest: input.stopPolicyDigest,
  policyVersion: EVOLUTION_POLICY_VERSION
})

export const getEvolutionCanaryScopeDigest = (scope: EvolutionCanaryScope, artifactSha256: string): string => getValueDigest({
  rootSessionId: scope.rootSessionId, workspaceId: scope.workspaceId, taskId: scope.taskId, lineageId: scope.lineageId,
  artifactSha256, policyVersion: EVOLUTION_POLICY_VERSION
})

/** Restart cannot infer that an old process's in-flight evaluation/Canary is safe. */
export const recoverEvolutionGovernance = (governance: EvolutionGovernance, at: number): EvolutionGovernance => {
  if (!ValidateEvolutionGovernance(governance) || !timestamp(at)) throw new Error('Invalid evolution recovery input')
  if (!['evaluating', 'shadow', 'canary'].includes(governance.phase)) return clone(governance)
  const next = clone(governance)
  next.phase = 'reconcile-required'
  next.updatedAt = Math.max(at, next.updatedAt)
  if (governance.phase === 'shadow') next.shadow = { ...next.shadow, state: 'stopped', updatedAt: next.updatedAt }
  if (governance.phase === 'canary') next.canary = { ...next.canary, state: 'stopped', updatedAt: next.updatedAt, reason: 'restart-requires-host-reconciliation' }
  return next
}
