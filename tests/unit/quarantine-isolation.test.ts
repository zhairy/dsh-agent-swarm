import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getSwarmConfig } from '../../src/config.js'
import { createSwarmEventJournal } from '../../src/event-journal.js'
import type { AgentLike } from '../../src/host-contract.js'
import { intSwarmService } from '../../src/service.js'

it('keeps identical T-1 task IDs quarantined per root session', async () => {
  const home = mkdtempSync(join(tmpdir(), 'quarantine-root-isolation-'))
  const cwdA = join(home, 'root-a')
  const cwdB = join(home, 'root-b')
  mkdirSync(cwdA)
  mkdirSync(cwdB)
  const rootA: AgentLike = { id: 'root-a', session: { header: { agentPreset: 'tian-shu', cwd: cwdA } } }
  const rootB: AgentLike = { id: 'root-b', session: { header: { agentPreset: 'tian-shu', cwd: cwdB } } }
  const agents = new Map([[rootA.id, rootA], [rootB.id, rootB]])
  const eventDirectory = join(home, 'share', 'dsh-agent-swarm', 'events-v2')
  createSwarmEventJournal({ directory: eventDirectory, rootSessionId: rootA.id }).append({
    eventId: 'quarantine-root-a-T-1',
    idempotencyKey: 'quarantine-root-a-T-1',
    ticketId: 'T-1',
    type: 'ticket/quarantined',
    actor: { kind: 'watchdog', id: 'fixture' },
    payload: { stage: 'quarantined' }
  })
  const config = getSwarmConfig({
    jev: { enabled: false },
    planningReview: { enabled: false },
    workflow: { mode: 'off' }
  })
  const service = intSwarmService({
    getConfig: () => config,
    getLlm: () => undefined,
    getSubagents: () => undefined,
    getTools: () => undefined,
    getAttachments: () => undefined,
    getCredentials: () => undefined,
    getAgent: id => agents.get(id),
    dshHome: home,
    fetch: async () => { throw new Error('fixture network denied') }
  })
  const exec = (agent: AgentLike) => ({ agent, signal: new AbortController().signal })
  const card = (title: string) => ({ title, goal: title, acceptance: ['结果可核对'], scope: [], flags: {} })
  try {
    const taskA = await service.AddTaskCard(card('root A'), exec(rootA))
    const taskB = await service.AddTaskCard(card('root B'), exec(rootB))
    expect(taskA.task_id).toBe('T-1')
    expect(taskB.task_id).toBe('T-1')

    const statusA = service.getStatus({}, exec(rootA)).watchdog.quarantinedTaskIds
    const statusB = service.getStatus({}, exec(rootB)).watchdog.quarantinedTaskIds
    const revision = await service.AddTaskCard({
      ...card('root B revised'),
      task_id: taskB.task_id,
      expected_card_revision: taskB.cardRevision
    }, exec(rootB)).then(value => ({ value }), error => ({ error }))
    const revisionA = await service.AddTaskCard({
      ...card('root A revised'),
      task_id: taskA.task_id,
      expected_card_revision: taskA.cardRevision
    }, exec(rootA)).then(value => ({ value }), error => ({ error }))
    expect(statusA).toEqual(['T-1'])
    expect.soft(statusB).toEqual([])
    expect.soft('error' in revision ? String(revision.error) : undefined).toBeUndefined()
    expect.soft('error' in revisionA ? String(revisionA.error) : undefined).toContain('Ticket 已隔离')
    expect.soft(service.getStatus({}, exec(rootA)).watchdog.quarantinedTaskIds).toEqual(['T-1'])
  } finally {
    await service.dispose()
    rmSync(home, { recursive: true, force: true })
  }
})
