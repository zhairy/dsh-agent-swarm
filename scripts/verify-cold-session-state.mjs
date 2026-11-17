#!/usr/bin/env node
/** 对显式提供的 EventJournal 副本冷读两次，验证恢复门禁而不激活真实 Agent。 */
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const option = name => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return process.argv[index + 1]
}
const plugin = resolve(option('--plugin')), events = resolve(option('--events')), output = resolve(option('--out'))
const rootId = option('--session'), childId = option('--child'), cwd = resolve(option('--cwd'))
mkdirSync(output, { recursive: true, mode: 0o700 })
const home = mkdtempSync(join(output, 'cold-state-'))
const eventDirectory = join(home, 'share/dsh-agent-swarm/events-v2')
cpSync(events, eventDirectory, { recursive: true })
const load = name => import(pathToFileURL(join(plugin, 'lib', `${name}.js`)))
const [{ intSwarmService }, { getSwarmConfig }, { createSwarmEventJournal }, { recoverStateFromJournal }, { SWARM_SEGMENT_SPECS }, { createWorkspaceLeaseManager }] =
  await Promise.all(['service', 'config', 'event-journal', 'state-journal', 'state-chunks', 'util/workspace-lease'].map(load))
const config = getSwarmConfig({ persistence: { enabled: false }, jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false } })
const attempts = { model: 0, activate: 0, start: 0, send: 0 }
const recovery = () => recoverStateFromJournal(createSwarmEventJournal({ directory: eventDirectory, rootSessionId: rootId }), { specs: SWARM_SEGMENT_SPECS, validate: () => true })
const before = recovery()
assert.equal(before.issues.length, 0)
const controlBefore = before.state.agentControls.find(control => control.childId === childId)
assert.ok(controlBefore)
const makeService = () => intSwarmService({
  getConfig: () => config, getLlm: () => undefined, getTools: () => undefined,
  getCredentials: () => undefined, getAttachments: () => undefined,
  getSubagents: () => ({ list: () => [], getProvider: () => undefined,
    start: async () => { attempts.start++; throw new Error('fixture forbids child start') },
    sendMessage: async () => { attempts.send++; throw new Error('fixture forbids old input replay') } }),
  dshHome: home, getAgent: () => undefined,
  inspectParent: async id => id === rootId ? { agentPreset: 'tian-shu', cwd } : undefined,
  activateParent: async () => { attempts.activate++; throw new Error('fixture forbids root activation') },
  fetch: async () => { attempts.model++; throw new Error('fixture forbids external I/O') },
  probe: async () => { throw new Error('cold metadata must not probe a provider') },
  leases: createWorkspaceLeaseManager({ ownerDirectory: join(home, 'isolated-leases') })
})
let status = 'failed', error, first, second
const describe = caught => ({ name: caught.name, code: caught.code, message: caught.message,
  ...(caught.errors ? { errors: caught.errors.map(describe) } : {}), ...(caught.cause ? { cause: describe(caught.cause) } : {}) })
try {
  for (const index of [0, 1]) {
    const service = makeService()
    let primary
    try {
      const view = await service.getAgentViewForRpc(rootId, childId)
      assert.equal(view.phase, 'recovery-required')
      assert.equal(view.paused, true)
      assert.equal(view.needsSideEffectReview, controlBefore.needsSideEffectReview)
      if (index === 0) first = view
      else second = view
    } catch (caught) { primary = caught }
    try { await service.dispose() } catch (caught) {
      if (primary) throw new AggregateError([primary, caught], 'Cold read and cleanup failed')
      throw caught
    }
    if (primary) throw primary
  }
  const after = recovery()
  assert.equal(after.issues.length, 0)
  const record = after.state.delegations.find(record => record.delegationId === controlBefore.delegationId)
  assert.equal(record.session?.kind, 'continuable')
  assert.equal(record.session?.threadId, childId)
  const begins = createSwarmEventJournal({ directory: eventDirectory, rootSessionId: rootId }).queryTypes(['state/journal-begin'])
  assert.equal(begins.filter(event => event.payload.type === 'agent-control/recovery-binding-repaired').length, 1)
  assert.deepEqual(attempts, { model: 0, activate: 0, start: 0, send: 0 })
  status = 'passed'
} catch (caught) { error = describe(caught) }
const receipt = { status, error, home, plugin, rootId, childId, attempts, first, second, before: { sequence: before.sequence, commits: before.commits }, after: { sequence: recovery().sequence, commits: recovery().commits } }
writeFileSync(join(output, 'cold-session-state-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ status, error, home, attempts, before: receipt.before, after: receipt.after }))
process.exitCode = status === 'passed' ? 0 : 1
