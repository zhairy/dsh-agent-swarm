import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskStore } from './evidence.js'
import type { SwarmEventJournal, SwarmEventType } from './event-journal.js'
import { canonicalStateJson } from './state-core.js'
import { projectTicketLifecycle } from './domain/tickets/lifecycle.js'

export interface StateImportInput {
  journal: SwarmEventJournal
  store: Pick<TaskStore, 'getTasks' | 'getTaskDelegations'>
  rootSessionId: string
  workspaceId: string
  sourcePath: string
  schemaVersion: number
  now?: () => Date
  /** The one-time migration writes a manifest; subsequent post-commit projection syncs do not. */
  writeManifest?: boolean
}

export interface StateImportReport {
  sourceDigest: string
  imported: number
  skipped: number
  mapping: Array<{ taskId: string; stage: string; eventId: string; title: string }>
  unrecoverable: Array<{ kind: 'task' | 'delegation'; id: string; reason: string }>
  projectionMismatches: Array<{ taskId: string; expected: string; observed?: string }>
  manifestPath?: string
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const stageKey = (stage: ReturnType<typeof projectTicketLifecycle>['stage']): string => stage.stage === 'working' || stage.stage === 'person'
  ? `${stage.stage}:${stage.action}`
  : stage.stage === 'ended' ? `ended:${stage.outcome}` : stage.stage

const safeId = (prefix: string, identity: string): string => `${prefix}-${sha256(identity).slice(0, 40)}`

/**
 * Import the committed 3.1.x/3.2.x TaskStore projection once into the V2 event
 * history. Event identities derive from immutable source facts, so restarting the
 * importer appends no duplicate facts. The manifest contains only structural
 * identifiers and digests; card goals, prompts and evidence bodies stay in the
 * authoritative state store.
 */
export const importFeatureStateToJournal = (input: StateImportInput): StateImportReport => {
  const tasks = [...input.store.getTasks()].sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId))
  const delegationCount = tasks.reduce((sum, task) => sum + input.store.getTaskDelegations(task.taskId).length, 0)
  const sourceDigest = sha256(canonicalStateJson({
    schemaVersion: input.schemaVersion,
    rootSessionId: input.rootSessionId,
    workspaceId: input.workspaceId,
    tasks: tasks.map((task) => ({ taskId: task.taskId, updatedAt: task.updatedAt, cardRevision: task.cardRevision ?? 1,
      workflowRevision: task.workflowRevision ?? 1, requestRevision: task.requestRevision ?? 1, acceptance: task.acceptance?.status ?? null,
      delegations: input.store.getTaskDelegations(task.taskId).map((record) => ({ id: record.delegationId, status: record.status,
        finalization: record.finalization ?? null, attemptId: record.attemptId ?? null, startedAt: record.startedAt, finishedAt: record.finishedAt ?? null,
        evidenceCount: record.evidence.length })) }))
  }))
  const mapping: StateImportReport['mapping'] = []
  const unrecoverable: StateImportReport['unrecoverable'] = []
  let imported = 0
  let skipped = 0
  const taskIds = new Set(tasks.map((task) => task.taskId))
  const mappingRevision = new Map<string, { request: number; card: number; workflow: number }>()

  for (const task of tasks) {
    if (!task.taskId || task.taskId.length > 128) {
      unrecoverable.push({ kind: 'task', id: String(task.taskId ?? '<missing>'), reason: 'invalid-task-id' })
      continue
    }
    const delegations = input.store.getTaskDelegations(task.taskId)
    const projection = projectTicketLifecycle(task, delegations)
    const expected = stageKey(projection.stage)
    const fact = {
      schemaVersion: input.schemaVersion,
      workspaceId: input.workspaceId,
      task: { taskId: task.taskId, updatedAt: task.updatedAt, requestRevision: task.requestRevision ?? 1,
        cardRevision: task.cardRevision ?? 1, workflowRevision: task.workflowRevision ?? 1, acceptance: task.acceptance?.status ?? null },
      delegations: delegations.map((record) => ({ id: record.delegationId, status: record.status, finalization: record.finalization ?? null,
        attemptId: record.attemptId ?? null, startedAt: record.startedAt, finishedAt: record.finishedAt ?? null, evidenceCount: record.evidence.length }))
    }
    const eventId = safeId('evt-state-task', canonicalStateJson(fact))
    const event = input.journal.append({
      eventId,
      idempotencyKey: `state-import:${sha256(canonicalStateJson(fact))}`,
      ticketId: task.taskId,
      type: 'ticket/state-changed' satisfies SwarmEventType,
      actor: { kind: 'host', id: `state-import:${input.rootSessionId}` },
      policyVersion: `state-schema/${input.schemaVersion}`,
      revision: { request: task.requestRevision ?? 1, card: task.cardRevision ?? 1, workflow: task.workflowRevision ?? 1 },
      payload: { source: 'legacy-state-importer', stage: expected, title: task.card.title.slice(0, 200),
        assignmentIds: projection.assignmentIds.slice(0, 2048), ...(projection.activeAssignmentId === undefined ? {} : { activeAssignmentId: projection.activeAssignmentId }) }
    })
    if (event === undefined) skipped++
    else imported++
    mappingRevision.set(task.taskId, { request: task.requestRevision ?? 1, card: task.cardRevision ?? 1, workflow: task.workflowRevision ?? 1 })
    mapping.push({ taskId: task.taskId, stage: expected, eventId, title: task.card.title.slice(0, 200) })

    for (const record of delegations) {
      if (!record.delegationId || record.delegationId.length > 128) {
        unrecoverable.push({ kind: 'delegation', id: String(record.delegationId ?? '<missing>'), reason: 'invalid-assignment-id' })
        continue
      }
      if (!taskIds.has(record.taskId)) {
        unrecoverable.push({ kind: 'delegation', id: record.delegationId, reason: 'unknown-ticket' })
        continue
      }
      const evidenceFact = canonicalStateJson({ workspaceId: input.workspaceId, taskId: task.taskId, delegationId: record.delegationId,
        status: record.status, finalization: record.finalization ?? null, attemptId: record.attemptId ?? null,
        startedAt: record.startedAt, finishedAt: record.finishedAt ?? null, evidenceCount: record.evidence.length })
      const evidenceEvent = input.journal.append({
        eventId: safeId('evt-state-assignment', evidenceFact),
        idempotencyKey: `state-import-assignment:${sha256(evidenceFact)}`,
        ticketId: task.taskId,
        assignmentId: record.delegationId,
        type: 'evidence/recorded',
        actor: { kind: 'worker', id: record.delegationId },
        revision: { request: record.requestRevision ?? 1, card: record.cardRevision ?? 1, workflow: record.workflowRevision ?? 1,
          leaseEpoch: record.assignment?.leaseEpoch ?? 0 },
        payload: { source: 'legacy-state-importer', outcome: record.status, finalization: record.finalization ?? null,
          evidenceCount: record.evidence.length, attemptId: record.attemptId ?? null }
      })
      if (evidenceEvent === undefined) skipped++
      else imported++
    }
  }

  const reconcileProjection = (): StateImportReport['projectionMismatches'] => {
    const projection = input.journal.project()
    const mismatches = mapping.flatMap((item) => {
      const observed = projection.tickets[item.taskId]?.stage
      return observed === item.stage ? [] : [{ taskId: item.taskId, expected: item.stage, ...(observed === undefined ? {} : { observed }) }]
    })
    for (const mismatch of mismatches) {
      const identity = canonicalStateJson({ workspaceId: input.workspaceId, taskId: mismatch.taskId, expected: mismatch.expected,
        observed: mismatch.observed ?? null, sourceDigest })
      const event = input.journal.append({ eventId: safeId('evt-state-reconcile', identity), idempotencyKey: `state-import-reconcile:${sha256(identity)}`,
        ticketId: mismatch.taskId, type: 'ticket/state-changed', actor: { kind: 'host', id: `state-import:${input.rootSessionId}` },
        revision: { request: mappingRevision.get(mismatch.taskId)?.request ?? 1, card: mappingRevision.get(mismatch.taskId)?.card ?? 1,
          workflow: mappingRevision.get(mismatch.taskId)?.workflow ?? 1 }, payload: { source: 'legacy-state-importer', stage: mismatch.expected } })
      if (event !== undefined) imported++
      else skipped++
    }
    const reconciled = input.journal.project()
    return mapping.flatMap((item) => {
      const observed = reconciled.tickets[item.taskId]?.stage
      return observed === item.stage ? [] : [{ taskId: item.taskId, expected: item.stage, ...(observed === undefined ? {} : { observed }) }]
    })
  }
  const projectionMismatches = reconcileProjection()
  let manifestPath: string | undefined
  if (input.writeManifest !== false) {
    const manifestDirectory = join(input.journal.path, '..', 'imports')
    mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 })
    manifestPath = join(manifestDirectory, `state-${sha256(input.rootSessionId).slice(0, 16)}.json`)
    const temporary = `${manifestPath}.tmp-${process.pid}`
  const manifest = {
    schemaVersion: 1,
    kind: 'legacy-state-import',
    rootSessionId: input.rootSessionId,
    workspaceId: input.workspaceId,
    sourcePath: input.sourcePath,
    sourceDigest,
    sourceSchemaVersion: input.schemaVersion,
    taskCount: tasks.length,
    delegationCount,
    imported,
    skipped,
    mapping,
    unrecoverable,
    projectionMismatches,
    journalSegments: input.journal.segments().length,
    at: (input.now?.() ?? new Date()).toISOString()
  }
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, manifestPath)
  }
  return { sourceDigest, imported, skipped, mapping, unrecoverable, projectionMismatches, ...(manifestPath === undefined ? {} : { manifestPath }) }
}
