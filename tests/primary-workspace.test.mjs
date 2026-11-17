import test from 'node:test'
import assert from 'node:assert/strict'
import { ParseCreatedWorktree, intWorktreeRegistry } from '../lib/worktree-binding.js'

const primary = { kind: 'primary', repositoryRoot: '/repo', path: '/repo', branch: 'main', baseCommit: 'a'.repeat(40) }
test('primary binding accepts the sole main tree while preserving linked-only legacy parsing', () => {
  assert.deepEqual(ParseCreatedWorktree(primary), primary)
  assert.equal(ParseCreatedWorktree({ ...primary, kind: undefined }), undefined)
  assert.equal(ParseCreatedWorktree({ ...primary, kind: 'unknown' }), undefined)
  assert.equal(ParseCreatedWorktree({ ...primary, path: '/repo/sub' }), undefined)
  assert.ok(ParseCreatedWorktree({ ...primary, kind: 'linked', path: '/repo/.trees/a' }))
})
test('separate primary tasks retain distinct durable identities for the same physical project', () => {
  const registry = intWorktreeRegistry()
  const a = registry.bind({ ...primary, agentId: 'a', taskId: 'T-1', delegationId: 'D-1' })
  const b = registry.bind({ ...primary, agentId: 'b', taskId: 'T-2', delegationId: 'D-2' })
  assert.notEqual(a.worktreeId, b.worktreeId)
  assert.equal(registry.findByTask('T-1')[0].kind, 'primary')
  assert.equal(registry.findByTask('T-2')[0].kind, 'primary')
})
test('one task cannot register both linked and primary records', () => {
  const registry = intWorktreeRegistry()
  registry.bind({ ...primary, kind: 'linked', path: '/repo/.trees/one', branch: 'feature', agentId: 'a', taskId: 'T-1', delegationId: 'D-1' })
  assert.throws(() => registry.bind({ ...primary, agentId: 'b', taskId: 'T-1', delegationId: 'D-2' }), /任务.*工作树/)
  assert.equal(registry.findByTask('T-1').length, 1)
})
