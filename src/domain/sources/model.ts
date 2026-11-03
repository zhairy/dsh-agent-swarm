import { createHash } from 'node:crypto'
import { ValidateTaskCard } from '../../policy.js'

export type ProactiveMode = 'off' | 'observe' | 'auto'
export type TriggerActorKind = 'human' | 'bot' | 'system'
export type TriggerStrength = 'explicit' | 'inferred'
export type TriggerDisposition = 'accepted' | 'would-accept' | 'ignored' | 'filtered'

export interface SourceInstance {
  schemaVersion: 1
  id: string
  kind: string
  enabled: boolean
  selfActor?: string
  botActors: string[]
  allowedActors: string[]
  ignoredThreads: string[]
  replyChannels: string[]
}

export interface TriggerMandate {
  title: string
  goal: string
  acceptance: string[]
  scope: string[]
  flags: Record<string, boolean>
}

export interface TriggerInput {
  sourceId: string
  externalId: string
  threadId: string
  actorId: string
  actorKind: TriggerActorKind
  addressed: boolean
  preview: string
  topics: string[]
  ruleIds: string[]
  replyChannel?: string
  mandate?: TriggerMandate
}

export interface TriggerFact extends TriggerInput {
  schemaVersion: 1
  id: string
  at: string
  contentDigest: string
  strength?: TriggerStrength
}

export interface SourceThread {
  schemaVersion: 1
  id: string
  sourceId: string
  threadId: string
  openedAt: string
  lastAt: string
}

export interface SourceSubscription {
  schemaVersion: 1
  id: string
  sourceId: string
  threadId: string
  ticketId: string
  contextOnly: boolean
  createdAt: string
  endedAt?: string
}

export interface TriggerDecision {
  schemaVersion: 1
  disposition: TriggerDisposition
  reason: string
  policyVersion: string
  matchedRules: string[]
}

const id = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/
const sourceKind = /^[a-z][a-z0-9._-]{0,63}$/
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const uniqueStrings = (values: readonly string[], max: number, maxLength = 128): string[] =>
  [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0 && value.length <= maxLength))].slice(0, max)
const validStringList = (value: unknown, max: number, maxLength = 128): value is string[] => Array.isArray(value)
  && value.length <= max && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= maxLength && id.test(item))
  && new Set(value).size === value.length
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

export const ValidateSourceInstance = (raw: unknown): raw is SourceInstance => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const row = raw as Record<string, unknown>
  return Object.keys(row).every((key) => ['schemaVersion', 'id', 'kind', 'enabled', 'selfActor', 'botActors', 'allowedActors', 'ignoredThreads', 'replyChannels'].includes(key))
    && row.schemaVersion === 1 && typeof row.id === 'string' && row.id.length <= 128 && id.test(row.id)
    && typeof row.kind === 'string' && sourceKind.test(row.kind)
    && typeof row.enabled === 'boolean' && (row.selfActor === undefined || typeof row.selfActor === 'string' && row.selfActor.length <= 128 && id.test(row.selfActor))
    && validStringList(row.botActors, 128) && validStringList(row.allowedActors, 512)
    && validStringList(row.ignoredThreads, 512) && validStringList(row.replyChannels, 64)
}

export const ValidateSourceThread = (raw: unknown): raw is SourceThread => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const row = raw as Record<string, unknown>
  return Object.keys(row).every((key) => ['schemaVersion', 'id', 'sourceId', 'threadId', 'openedAt', 'lastAt'].includes(key))
    && row.schemaVersion === 1 && typeof row.id === 'string' && row.id.length <= 300
    && typeof row.sourceId === 'string' && row.sourceId.length <= 128 && id.test(row.sourceId)
    && typeof row.threadId === 'string' && id.test(row.threadId) && typeof row.openedAt === 'string' && Number.isFinite(Date.parse(row.openedAt))
    && typeof row.lastAt === 'string' && Number.isFinite(Date.parse(row.lastAt))
}

export const ValidateSourceSubscription = (raw: unknown): raw is SourceSubscription => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false
  const row = raw as Record<string, unknown>
  return Object.keys(row).every((key) => ['schemaVersion', 'id', 'sourceId', 'threadId', 'ticketId', 'contextOnly', 'createdAt', 'endedAt'].includes(key))
    && row.schemaVersion === 1 && typeof row.id === 'string' && typeof row.sourceId === 'string' && row.sourceId.length <= 128 && id.test(row.sourceId)
    && typeof row.threadId === 'string' && id.test(row.threadId) && typeof row.ticketId === 'string' && id.test(row.ticketId) && typeof row.contextOnly === 'boolean'
    && typeof row.createdAt === 'string' && Number.isFinite(Date.parse(row.createdAt))
    && (row.endedAt === undefined || typeof row.endedAt === 'string' && Number.isFinite(Date.parse(row.endedAt)))
}

export const createSourceInstance = (input: Omit<SourceInstance, 'schemaVersion' | 'selfActor' | 'botActors' | 'allowedActors' | 'ignoredThreads' | 'replyChannels'> & Partial<Pick<SourceInstance, 'selfActor' | 'botActors' | 'allowedActors' | 'ignoredThreads' | 'replyChannels'>>): SourceInstance => ({
  schemaVersion: 1, id: input.id, kind: input.kind, enabled: input.enabled, ...(input.selfActor === undefined ? {} : { selfActor: input.selfActor }),
  botActors: uniqueStrings(input.botActors ?? [], 128), allowedActors: uniqueStrings(input.allowedActors ?? [], 512),
  ignoredThreads: uniqueStrings(input.ignoredThreads ?? [], 512), replyChannels: uniqueStrings(input.replyChannels ?? [], 64)
})

export const normalizeTrigger = (source: SourceInstance, input: TriggerInput, now: Date): TriggerFact | { filtered: string } => {
  if (!source.enabled) return { filtered: 'source-off' }
  if (!plainObject(input) || typeof input.externalId !== 'string' || typeof input.threadId !== 'string' || typeof input.actorId !== 'string'
    || !id.test(input.externalId) || !id.test(input.threadId) || !id.test(input.actorId)
    || !['human', 'bot', 'system'].includes(input.actorKind) || typeof input.addressed !== 'boolean' || typeof input.preview !== 'string'
    || !Array.isArray(input.topics) || input.topics.length > 32 || input.topics.some((topic) => typeof topic !== 'string' || topic.length > 128)
    || !Array.isArray(input.ruleIds) || input.ruleIds.length > 64 || input.ruleIds.some((rule) => typeof rule !== 'string' || rule.length > 128)
    || (input.replyChannel !== undefined && (typeof input.replyChannel !== 'string' || !id.test(input.replyChannel)))) return { filtered: 'invalid-trigger' }
  if (source.ignoredThreads.includes(input.threadId)) return { filtered: 'thread-ignored' }
  const bot = input.actorKind === 'bot'
  if (source.selfActor !== undefined && input.actorId === source.selfActor) return { filtered: 'self-message' }
  const listed = source.allowedActors.length === 0 || source.allowedActors.includes(input.actorId)
  const knownBot = bot && source.botActors.includes(input.actorId)
  if (bot && !knownBot) return { filtered: 'bot-not-allowed' }
  const strength: TriggerStrength | undefined = input.actorKind === 'human' && input.addressed && listed
    ? 'explicit' : (input.actorKind === 'bot' && knownBot) || (input.actorKind === 'human' && (listed || input.addressed)) ? 'inferred' : undefined
  if (strength === undefined) return { filtered: 'actor-not-admitted' }
  const at = now.toISOString()
  let mandate: TriggerMandate | undefined
  if (input.mandate !== undefined) {
    if (!plainObject(input.mandate) || typeof input.mandate.title !== 'string' || typeof input.mandate.goal !== 'string'
      || input.mandate.title.length > 4096 || input.mandate.goal.length > 16_384
      || !Array.isArray(input.mandate.acceptance) || input.mandate.acceptance.length > 32
      || input.mandate.acceptance.some((item) => typeof item !== 'string' || item.length > 512)
      || !Array.isArray(input.mandate.scope) || input.mandate.scope.length > 64
      || input.mandate.scope.some((item) => typeof item !== 'string' || item.length > 512)
      || !plainObject(input.mandate.flags) || Object.keys(input.mandate.flags).length > 32
      || Object.entries(input.mandate.flags).some(([key, value]) => key.length > 128 || typeof value !== 'boolean')) return { filtered: 'invalid-mandate' }
    // The same card contract used by the Task service must pass before Source
    // admission; otherwise auto mode would enqueue an effect that can never run.
    const validated = ValidateTaskCard(input.mandate)
    if (validated.card === undefined) return { filtered: 'invalid-mandate' }
    mandate = { title: validated.card.title.slice(0, 160), goal: validated.card.goal.slice(0, 4000),
      acceptance: uniqueStrings(validated.card.acceptance, 32, 512), scope: uniqueStrings(validated.card.scope, 64, 512),
      flags: { ...validated.card.flags } }
  }
  if (mandate !== undefined && (mandate.title === '' || mandate.goal === '' || mandate.acceptance.length === 0)) return { filtered: 'invalid-mandate' }
  const preview = input.preview.slice(0, 2000)
  return { schemaVersion: 1, id: `trigger-${digest([source.id, input.externalId].join('\0')).slice(0, 40)}`, at,
    sourceId: source.id, externalId: input.externalId, threadId: input.threadId, actorId: input.actorId,
    actorKind: input.actorKind, addressed: input.addressed, preview, topics: uniqueStrings(input.topics, 32),
    ruleIds: uniqueStrings(input.ruleIds, 64), ...(input.replyChannel === undefined ? {} : { replyChannel: input.replyChannel }),
    ...(mandate === undefined ? {} : { mandate }),
    contentDigest: digest(JSON.stringify([input.threadId, input.actorId, preview, input.topics, input.ruleIds])), strength }
}

export const getPolicyVersion = (mode: ProactiveMode, rules: readonly string[]): string =>
  `proactive/${mode}/${digest(JSON.stringify([...rules].sort())).slice(0, 16)}`

export const evaluateTrigger = (trigger: TriggerFact, input: { mode: ProactiveMode; rules: readonly string[]; hasActiveTicket?: boolean; hasMandate?: boolean }): TriggerDecision => {
  const policyVersion = getPolicyVersion(input.mode, input.rules)
  if (trigger.strength === 'explicit') return { schemaVersion: 1, disposition: 'accepted', reason: 'explicit-request', policyVersion, matchedRules: [] }
  if (trigger.strength !== 'inferred') return { schemaVersion: 1, disposition: 'filtered', reason: 'no-inferred-strength', policyVersion, matchedRules: [] }
  const matchedRules = trigger.ruleIds.filter((rule) => input.rules.includes(rule))
  if (input.mode === 'off') return { schemaVersion: 1, disposition: 'filtered', reason: 'proactive-off', policyVersion, matchedRules }
  if (matchedRules.length === 0) return { schemaVersion: 1, disposition: 'ignored', reason: 'no-enabled-rule', policyVersion, matchedRules }
  if (input.hasMandate !== true) return { schemaVersion: 1, disposition: 'ignored', reason: 'mandate-required', policyVersion, matchedRules }
  if (input.mode === 'observe') return { schemaVersion: 1, disposition: 'would-accept', reason: 'observe-only', policyVersion, matchedRules }
  if (input.hasActiveTicket === true) return { schemaVersion: 1, disposition: 'ignored', reason: 'thread-already-active', policyVersion, matchedRules }
  return { schemaVersion: 1, disposition: 'accepted', reason: 'proactive-rule', policyVersion, matchedRules }
}
