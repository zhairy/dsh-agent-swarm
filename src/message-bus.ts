import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { bindingKey, type AgentBinding, type AgentBindingRegistry, type BindingState } from './agent-binding.js'
import { atomicStateFile, canonicalStateJson, type DurableStateStore } from './state-store.js'

export const MESSAGE_KINDS = ['question', 'answer', 'finding', 'review-response'] as const
export interface ExpertMessage {
  schemaVersion: 1
  id: string
  taskId: string
  rootSessionId: string
  workspaceId: string
  cardRevision: number
  workflowRevision: number
  requestRevision?: number
  fromAgentId: string
  toAgentId: string
  fromThreadId: string
  toThreadId: string
  senderAttemptId: string
  senderGeneration: number
  senderLeaseEpoch: number
  recipientGeneration: number
  recipientLeaseEpoch: number
  nodeId: string
  kind: typeof MESSAGE_KINDS[number]
  correlationId?: string
  createdAt: number
  expiresAt: number
  summary: string
  artifactRefs: string[]
  payloadDigest: string
}
export interface MessageAck { messageId: string; recipientBinding: string; acknowledgedAt: number }
export interface MessageState extends BindingState {
  messages: Record<string, ExpertMessage>
  messageAcks: Record<string, Record<string, MessageAck>>
}
export interface SendMessageInput {
  toAgentId: string
  taskId: string
  kind: ExpertMessage['kind']
  summary: string
  artifactRefs?: string[]
  correlationId?: string
  ttlMs?: number
  messageId?: string
}
export interface MessageBusOptions<T extends MessageState> {
  store: DurableStateStore<T>
  bindings: AgentBindingRegistry
  now?: () => number
  maxPendingPerTask?: number
  maxRetainedMessages?: number
  maxSummaryBytes?: number
  maxEnvelopeBytes?: number
  maxTtlMs?: number
  validateArtifactRef?: (ref: string, binding: AgentBinding) => boolean
}
export class MessageBusError extends Error {
  constructor (readonly code: 'MESSAGE_INVALID' | 'RECEIVER_UNAVAILABLE' | 'IDENTITY_DENIED' | 'MESSAGE_LIMIT' | 'MESSAGE_CORRUPT' | 'PERSISTENCE_REQUIRED' | 'MESSAGE_CONFLICT', message: string) { super(message); this.name = 'MessageBusError' }
}
export interface MessageBus {
  send: (agentId: string, input: SendMessageInput) => Promise<ExpertMessage>
  pull: (agentId: string, input?: { limit?: number }) => Promise<{ messages: ExpertMessage[]; stale: string[] }>
  ack: (agentId: string, input: { messageIds: string[] }) => Promise<{ acknowledged: string[] }>
}
const hash = (value: unknown): string => createHash('sha256').update(canonicalStateJson(value)).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const matchingScope = (a: AgentBinding, b: AgentBinding) => a.rootSessionId === b.rootSessionId && a.workspaceId === b.workspaceId && a.taskId === b.taskId && a.cardRevision === b.cardRevision && a.workflowRevision === b.workflowRevision && (a.requestRevision ?? 1) === (b.requestRevision ?? 1)
const current = (state: BindingState, agentId: string, permission: string): AgentBinding => {
  const binding = state.bindings[agentId]
  if (binding === undefined || binding.state !== 'active' || !binding.permissions.includes(permission)) throw new MessageBusError('IDENTITY_DENIED', 'No active attempt with required messaging capability')
  if (binding.blindReview) throw new MessageBusError('IDENTITY_DENIED', 'Independent blind review cannot receive or send peer reasoning before its report')
  return binding
}

/** Private immutable files plus durable index/ACK transactions; delivery is pull and at-least-once. */
export const createMessageBus = <T extends MessageState>(options: MessageBusOptions<T>): MessageBus => {
  if (!options.store.durable) throw new MessageBusError('PERSISTENCE_REQUIRED', 'File messaging requires durable state')
  const now = options.now ?? Date.now
  const maxPending = options.maxPendingPerTask ?? 128
  const maxRetained = options.maxRetainedMessages ?? 2048
  const maxSummaryBytes = options.maxSummaryBytes ?? 2048
  const maxEnvelopeBytes = options.maxEnvelopeBytes ?? 8192
  const maxTtl = options.maxTtlMs ?? 24 * 60 * 60 * 1000
  if (![maxPending, maxRetained, maxSummaryBytes, maxEnvelopeBytes, maxTtl].every((n) => Number.isSafeInteger(n) && n > 0)) throw new MessageBusError('MESSAGE_INVALID', 'Invalid message resource policy')
  const directoryFor = (threadId: string) => join(options.store.directory, 'bus', 'inbox', hash(threadId))
  const ensureMailbox = async (threadId: string): Promise<string> => {
    let directory = options.store.directory
    for (const segment of ['bus', 'inbox', hash(threadId)]) {
      directory = join(directory, segment)
      await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error })
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new MessageBusError('MESSAGE_CORRUPT', 'Mailbox ancestors must be private directories, not symlinks')
    }
    return directory
  }
  const pathFor = (message: ExpertMessage) => join(directoryFor(message.toThreadId), 'message-' + message.id + '.json')
  const verifyMessageFile = async (message: ExpertMessage): Promise<void> => {
    const path = pathFor(message)
    const metadata = await lstat(path).catch(() => undefined)
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxEnvelopeBytes) throw new MessageBusError('MESSAGE_CORRUPT', 'Committed message file is missing or invalid')
    const raw = await readFile(path, 'utf8')
    let parsed: ExpertMessage
    try { parsed = JSON.parse(raw) as ExpertMessage } catch { throw new MessageBusError('MESSAGE_CORRUPT', 'Committed message JSON is invalid') }
    const { payloadDigest, ...payload } = parsed
    if (payloadDigest !== hash(payload) || canonicalStateJson(parsed) !== canonicalStateJson(message)) throw new MessageBusError('MESSAGE_CORRUPT', 'Committed message digest or index mismatch')
  }
  const isDeliverable = (state: Pick<MessageState, 'bindingHistory'>, message: ExpertMessage, recipient: AgentBinding): boolean => {
    if (message.toAgentId !== recipient.agentId || message.recipientGeneration !== recipient.generation || message.recipientLeaseEpoch !== recipient.leaseEpoch || message.taskId !== recipient.taskId || message.rootSessionId !== recipient.rootSessionId || message.workspaceId !== recipient.workspaceId || message.cardRevision !== recipient.cardRevision || message.workflowRevision !== recipient.workflowRevision || (message.requestRevision ?? 1) !== (recipient.requestRevision ?? 1) || message.expiresAt <= now()) return false
    const historical = state.bindingHistory[message.fromAgentId + ':' + message.senderGeneration + ':' + message.senderLeaseEpoch]
    return historical !== undefined && historical.attemptId === message.senderAttemptId && matchingScope(historical, recipient) && historical.revocationReason !== 'untrusted' && historical.revocationReason !== 'cancelled'
  }
  return {
    send: async (agentId, input) => {
      if (!input || !MESSAGE_KINDS.includes(input.kind) || typeof input.summary !== 'string' || input.summary.trim() === '' || typeof input.toAgentId !== 'string' || typeof input.taskId !== 'string') throw new MessageBusError('MESSAGE_INVALID', 'Invalid typed message')
      if (Object.keys(input).some((key) => !['toAgentId', 'taskId', 'kind', 'summary', 'artifactRefs', 'correlationId', 'ttlMs', 'messageId'].includes(key))) throw new MessageBusError('MESSAGE_INVALID', 'Sender identity, paths and arbitrary payload fields are forbidden')
      if (Buffer.byteLength(input.summary, 'utf8') > maxSummaryBytes) throw new MessageBusError('MESSAGE_LIMIT', 'Message summary is too large; use artifact references')
      const artifactRefs = input.artifactRefs ?? []
      if (!Array.isArray(artifactRefs) || artifactRefs.length > 16 || artifactRefs.some((ref) => typeof ref !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,255}$/.test(ref))) throw new MessageBusError('MESSAGE_INVALID', 'Artifact references must be opaque identifiers, not paths')
      if (input.correlationId !== undefined && (typeof input.correlationId !== 'string' || input.correlationId.length > 128)) throw new MessageBusError('MESSAGE_INVALID', 'Invalid correlation identifier')
      const ttl = input.ttlMs ?? Math.min(maxTtl, 60 * 60 * 1000)
      if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > maxTtl) throw new MessageBusError('MESSAGE_INVALID', 'Invalid message lifetime')
      const id = input.messageId ?? randomUUID()
      if (!uuid.test(id)) throw new MessageBusError('MESSAGE_INVALID', 'Message id must be a UUID')
      let message!: ExpertMessage
      await options.store.commit('message/send', async (draft) => {
        const sender = current(draft, agentId, 'message-send')
        const recipient = draft.bindings[input.toAgentId]
        if (recipient === undefined || recipient.state !== 'active' || !recipient.permissions.includes('message-read')) throw new MessageBusError('RECEIVER_UNAVAILABLE', 'Recipient is not an active authorized host-bound attempt')
        if (recipient.blindReview || !matchingScope(sender, recipient) || sender.taskId !== input.taskId) throw new MessageBusError('IDENTITY_DENIED', 'Messages cannot cross root/workspace/task/revision or blind-review boundaries')
        if (artifactRefs.some((ref) => options.validateArtifactRef === undefined || !options.validateArtifactRef(ref, sender) || !options.validateArtifactRef(ref, recipient))) throw new MessageBusError('IDENTITY_DENIED', 'Artifact reference is not authorized for both peers')
        const existing = draft.messages[id]
        if (existing !== undefined) {
          if (existing.fromAgentId !== agentId || existing.senderGeneration !== sender.generation || existing.senderLeaseEpoch !== sender.leaseEpoch || existing.toAgentId !== input.toAgentId || existing.recipientGeneration !== recipient.generation || existing.recipientLeaseEpoch !== recipient.leaseEpoch || (existing.requestRevision ?? 1) !== (sender.requestRevision ?? 1) || existing.summary !== input.summary || existing.kind !== input.kind || canonicalStateJson(existing.artifactRefs) !== canonicalStateJson(artifactRefs) || existing.correlationId !== input.correlationId) throw new MessageBusError('MESSAGE_CONFLICT', 'Message id was already committed with different content or identity')
          await verifyMessageFile(existing)
          message = existing; return
        }
        if (Object.keys(draft.messages).length >= maxRetained) throw new MessageBusError('MESSAGE_LIMIT', 'Retained message capacity reached; archive before sending')
        const pending = Object.values(draft.messages).filter((m) => m.taskId === sender.taskId && m.expiresAt > now() && !draft.messageAcks[m.toAgentId + ':' + m.recipientGeneration + ':' + m.recipientLeaseEpoch]?.[m.id]).length
        if (pending >= maxPending) throw new MessageBusError('MESSAGE_LIMIT', 'Task pending message budget exhausted')
        const createdAt = now()
        const payload = {
          schemaVersion: 1 as const, id, taskId: sender.taskId, rootSessionId: sender.rootSessionId, workspaceId: sender.workspaceId,
          cardRevision: sender.cardRevision, workflowRevision: sender.workflowRevision,
          requestRevision: sender.requestRevision ?? 1,
          fromAgentId: sender.agentId, toAgentId: recipient.agentId, fromThreadId: sender.threadId, toThreadId: recipient.threadId,
          senderAttemptId: sender.attemptId, senderGeneration: sender.generation, senderLeaseEpoch: sender.leaseEpoch,
          recipientGeneration: recipient.generation, recipientLeaseEpoch: recipient.leaseEpoch,
          nodeId: sender.nodeId, kind: input.kind, ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
          createdAt, expiresAt: createdAt + ttl, summary: input.summary, artifactRefs: [...artifactRefs]
        }
        message = { ...payload, payloadDigest: hash(payload) }
        const encoded = canonicalStateJson(message)
        if (Buffer.byteLength(encoded, 'utf8') > maxEnvelopeBytes) throw new MessageBusError('MESSAGE_LIMIT', 'Message envelope is too large')
        const directory = await ensureMailbox(message.toThreadId)
        await atomicStateFile(directory, 'message-' + id + '.json', encoded)
        draft.messages[id] = message
      })
      return structuredClone(message)
    },
    pull: async (agentId, input = {}) => {
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 32)) throw new MessageBusError('MESSAGE_INVALID', 'Pull limit must be 1..32')
      const state = options.store.readFields?.(['bindings', 'bindingHistory', 'messages', 'messageAcks']) ?? options.store.read()
      const recipient = current(state, agentId, 'message-read')
      const acks = state.messageAcks[bindingKey(recipient)] ?? {}
      const candidates = Object.values(state.messages).filter((message) => message.toAgentId === agentId && acks[message.id] === undefined).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      const messages: ExpertMessage[] = []; const stale: string[] = []
      for (const message of candidates) {
        if (!isDeliverable(state, message, recipient)) { if (stale.length < 32) stale.push(message.id); continue }
        if (messages.length >= (input.limit ?? 16)) break
        await verifyMessageFile(message)
        messages.push(message)
      }
      // Do not expose messages if an attempt was revoked while files were being read.
      const latest = options.bindings.requireActive(agentId, 'message-read')
      if (bindingKey(latest) !== bindingKey(recipient)) throw new MessageBusError('IDENTITY_DENIED', 'Recipient attempt changed during pull')
      const latestState = options.store.readFields?.(['bindings', 'bindingHistory']) ?? options.store.read()
      current(latestState, agentId, 'message-read')
      const stillValid = messages.filter((message) => isDeliverable(latestState, message, latest))
      for (const message of messages) if (!stillValid.includes(message) && stale.length < 32) stale.push(message.id)
      return { messages: stillValid, stale }
    },
    ack: async (agentId, input) => {
      if (!Array.isArray(input.messageIds) || input.messageIds.length > 32 || input.messageIds.some((id) => !uuid.test(id))) throw new MessageBusError('MESSAGE_INVALID', 'ACK expects at most 32 UUID message identifiers')
      let acknowledged: string[] = []
      await options.store.commit('message/ack', (draft) => {
        const recipient = current(draft, agentId, 'message-read')
        const key = bindingKey(recipient)
        const mailbox = draft.messageAcks[key] ?? {}
        for (const id of new Set(input.messageIds)) {
          const message = draft.messages[id]
          if (message === undefined || !isDeliverable(draft, message, recipient)) throw new MessageBusError('IDENTITY_DENIED', 'Cannot ACK unknown, stale or another recipient message')
          mailbox[id] = mailbox[id] ?? { messageId: id, recipientBinding: key, acknowledgedAt: now() }
        }
        draft.messageAcks[key] = mailbox
        acknowledged = [...new Set(input.messageIds)]
      })
      return { acknowledged }
    }
  }
}
