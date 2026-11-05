import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rename, symlink, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createHostWorktreePort } from '../lib/adapters/dsh-host/worktree.js'
import { restoreRetainedWorktree } from '../lib/application/worktree-recovery.js'
import { intWorktreeRegistry, getWorktreeOwnerKey, RESTORE_WORKTREE_TOOL } from '../lib/worktree-binding.js'
import { createSwarmEventJournal } from '../lib/event-journal.js'
import { createWorkspaceLeaseManager } from '../lib/util/workspace-lease.js'
import { intMutex } from '../lib/util/mutex.js'
import { getSwarmConfig } from '../lib/config.js'
import { getWantedTools } from '../lib/role-registry.js'
import { getBoundTaskToolDefinitions } from '../lib/task-tools.js'
import { getToolApprovalScope } from '../lib/approval-policy.js'
import { intSwarmService } from '../lib/service.js'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 1024 * 1024 })).stdout.trimEnd()
const owner = (name, attempt = name) => ({ agentId: name, taskId: 'T-1', delegationId: `D-${attempt}`, execution: { attemptId: attempt, nodeId: 'implementation', cardRevision: 1, workflowRevision: 1, requestRevision: 1, generation: 1, leaseEpoch: 1 } })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

const fixture = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-retained-worktree-'))
  const repositoryRoot = join(directory, 'repo')
  await mkdir(repositoryRoot)
  await git(repositoryRoot, 'init', '-b', 'main')
  await writeFile(join(repositoryRoot, '.gitignore'), '.agents/\n')
  await writeFile(join(repositoryRoot, 'tracked.txt'), 'base\n')
  await git(repositoryRoot, 'add', '.')
  await git(repositoryRoot, 'commit', '-m', 'baseline')
  const baseCommit = await git(repositoryRoot, 'rev-parse', 'HEAD')
  const path = join(repositoryRoot, '.agents', 'worktrees', 'retained')
  await git(repositoryRoot, 'worktree', 'add', '-b', 'retained', path)
  const created = { repositoryRoot, path, branch: 'retained', baseCommit }
  const cwd = new Map()
  const commands = []
  const hooks = {}
  const ctx = {
    get: name => ({
      workingDirectory: { get: session => cwd.get(session) ?? repositoryRoot, set: async (agent, target, signal) => { await hooks.set?.(agent, target); signal.throwIfAborted(); cwd.set(agent.session, await realpath(target)); return cwd.get(agent.session) } },
      fs: {
        resolve: async target => ({ targetKey: await realpath(target), displayPath: target }), processPath: target => target.targetKey,
        processPathFromHostPath: path => path,
        contains: (root, target) => { const rel = relative(root.targetKey, target.targetKey); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) },
        lstat: async path => { try { const stat = await lstat(path); return { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', version: `${stat.ino}:${stat.mtimeMs}` } } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
      },
      sandboxPolicy: { resolve: () => ({ mode: hooks.mode ?? 'workspace-write', workspaceRoot: hooks.allowedRoot ?? repositoryRoot }) },
      sandbox: { confine: async (argv, policy) => { assert.equal(policy.mode, 'read-only'); commands.push(argv); return { argv, enforcement: 'full' } } },
      subprocess: {
        resolveExecutable: async name => name === 'node' ? process.execPath : name,
        spawn: spec => {
          const env = { ...process.env, ...spec.env }
          for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
          const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, stdio: ['ignore', 'pipe', 'pipe'] })
          let stdout = '', stderr = ''
          child.stdout.on('data', bytes => { stdout += bytes })
          child.stderr.on('data', bytes => { stderr += bytes })
          const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => resolve({ exitCode })) })
          return { done, collected: { stdout: { readFrom: () => ({ text: stdout, lossy: false }) }, stderr: { readFrom: () => ({ text: stderr, lossy: false }) } }, terminate: () => { if (child.exitCode === null) child.kill() }, waitForExit: () => done }
        }
      }
    })[name]
  }
  const host = createHostWorktreePort(ctx)
  const agentA = { id: 'A', session: { header: { cwd: repositoryRoot } } }
  const agentB = { id: 'B', session: { header: { cwd: repositoryRoot } } }
  const registry = intWorktreeRegistry()
  const journalDirectory = join(directory, 'events')
  const journal = createSwarmEventJournal({ directory: journalDirectory, rootSessionId: 'root' })
  const record = registry.bind({ ...created, ...owner('A'), observation: await host.inspect(agentA, created, new AbortController().signal) })
  journal.append({ eventId: 'bound-A', idempotencyKey: 'bound-A', type: 'worktree/bound', ticketId: 'T-1', assignmentId: 'D-A', actor: { kind: 'worker', id: 'A' }, payload: { binding: record } })
  await writeFile(join(path, 'committed.txt'), 'later commit\n')
  await git(path, 'add', 'committed.txt')
  await git(path, 'commit', '-m', 'legitimate later commit')
  await writeFile(join(path, 'tracked.txt'), 'staged content\n')
  await git(path, 'add', 'tracked.txt')
  await writeFile(join(path, 'tracked.txt'), 'staged content\nunstaged content\n')
  await writeFile(join(path, 'untracked-report.txt'), 'retained report\n')
  const leases = createWorkspaceLeaseManager({ ownerDirectory: join(directory, 'leases') })
  const grants = new Map()
  const controls = { valid: true, stopped: true }
  const lock = intMutex()
  const input = (override = {}) => ({
    id: record.worktreeId, agent: agentB, owner: owner('B'), signal: new AbortController().signal,
    registry, journal, host, leases, lock,
    assertCurrent: () => { if (!controls.valid) throw new Error('stale or revoked execution') },
    confirmStopped: async () => { if (!controls.stopped) throw new Error('old writer still active or unknown') },
    assertStopped: () => { if (!controls.stopped) throw new Error('old writer became active') },
    getLease: row => grants.get(getWorktreeOwnerKey(row)),
    retainLease: (lease, row) => { grants.set(getWorktreeOwnerKey(row), lease) }, warn: () => {}, ...override
  })
  const snapshot = async () => {
    const gitDirectory = await git(path, 'rev-parse', '--absolute-git-dir')
    return { head: await git(path, 'rev-parse', 'HEAD'), branch: await git(path, 'symbolic-ref', 'HEAD'),
      status: await git(path, 'status', '--porcelain=v1', '-z'), staged: await git(path, 'diff', '--cached', '--binary'), unstaged: await git(path, 'diff', '--binary'),
      index: sha(await readFile(join(gitDirectory, 'index'))), tracked: sha(await readFile(join(path, 'tracked.txt'))), report: sha(await readFile(join(path, 'untracked-report.txt'))) }
  }
  t.after(async () => { for (const lease of grants.values()) if (leases.isCurrent(lease)) await lease.release({ confirmedStopped: true }); await rm(directory, { recursive: true, force: true }) })
  return { directory, created, agentA, agentB, registry, journal, journalDirectory, host, hooks, record, input, leases, grants, controls, snapshot, commands }
}

test('worktree recovery: preserves later HEAD, branch, index, staged/unstaged/untracked files and transfers the owner', async t => {
  const f = await fixture(t), before = await f.snapshot()
  assert.notEqual(before.head, f.created.baseCommit)
  const result = await restoreRetainedWorktree(f.input())
  assert.equal(result.state, 'active')
  assert.equal(result.agentId, 'B')
  assert.equal(f.registry.findByAgent('A'), undefined)
  assert.equal(f.host.cwd(f.agentB), f.created.path)
  assert.equal(f.agentB.session.header.cwd, f.created.repositoryRoot)
  assert.deepEqual(await f.snapshot(), before)
  assert.ok(f.commands.every(argv => !argv.some(word => ['reset', 'clean', 'checkout'].includes(word))))
  assert.match(f.registry.canCreate({ agentId: 'C', taskId: 'T-1' }), /当前任务已经绑定/)
})

test('worktree recovery: same current attempt is idempotent; a later attempt receives a new grant', async t => {
  const f = await fixture(t)
  const first = await restoreRetainedWorktree(f.input())
  const sequence = f.journal.summary().sequence
  const repeated = await restoreRetainedWorktree(f.input())
  assert.deepEqual(repeated, first)
  assert.equal(f.journal.summary().sequence, sequence)
  await f.grants.get(getWorktreeOwnerKey(first)).release({ confirmedStopped: true })
  const next = await restoreRetainedWorktree(f.input({ owner: owner('B', 'B-next') }))
  assert.equal(next.execution.attemptId, 'B-next')
  assert.equal(next.ownershipRevision, first.ownershipRevision + 1)
})

test('worktree recovery: two concurrent takeover requests cannot both acquire ownership', async t => {
  const f = await fixture(t), started = deferred(), proceed = deferred()
  f.hooks.set = async () => { started.resolve(); await proceed.promise }
  const first = restoreRetainedWorktree(f.input())
  await started.promise
  await assert.rejects(restoreRetainedWorktree(f.input({ agent: { id: 'C', session: {} }, owner: owner('C') })), /并发接管/)
  proceed.resolve()
  assert.equal((await first).agentId, 'B')
  assert.equal(f.registry.findByAgent('C'), undefined)
})

for (const scenario of ['wrong-task', 'revoked', 'old-writer', 'competing-lease', 'unknown-writer', 'wrong-branch', 'wrong-repository', 'unrelated-history', 'symlink-escape', 'replaced-directory', 'replacement-during-cwd', 'read-only-policy', 'scope-escape']) {
  test(`worktree recovery refuses ${scenario}`, async t => {
    const f = await fixture(t)
    let request = f.input(), competing
    if (scenario === 'wrong-task') request.owner = { ...owner('B'), taskId: 'T-other' }
    if (scenario === 'revoked') f.controls.valid = false
    if (scenario === 'old-writer') f.controls.stopped = false
    if (scenario === 'competing-lease') competing = await f.leases.acquire(f.created.path, 'another-writer', 'write')
    if (scenario === 'unknown-writer') { competing = await f.leases.acquire(f.created.path, 'unknown-writer', 'write'); await competing.release({ confirmedStopped: false }) }
    if (scenario === 'wrong-branch') await git(f.created.path, 'switch', '-c', 'wrong-branch')
    if (scenario === 'unrelated-history') {
      const tree = await git(f.created.path, 'rev-parse', 'HEAD^{tree}')
      const unrelated = await git(f.created.path, 'commit-tree', tree, '-m', 'unrelated root')
      await git(f.created.path, 'update-ref', 'refs/heads/retained', unrelated)
      await git(f.created.path, 'cat-file', '-e', `${f.created.baseCommit}^{commit}`)
    }
    if (scenario === 'wrong-repository') {
      const other = join(f.directory, 'other-repo'), otherTree = join(other, 'checkout')
      await mkdir(other); await git(other, 'init', '-b', 'main'); await git(other, 'commit', '--allow-empty', '-m', 'other repository')
      await git(other, 'worktree', 'add', '-b', 'retained', otherTree)
      await copyFile(join(otherTree, '.git'), join(f.created.path, '.git'))
    }
    if (scenario === 'replacement-during-cwd') f.hooks.set = async () => { const oldPath = `${f.created.path}-original`; await rename(f.created.path, oldPath); await mkdir(f.created.path); await copyFile(join(oldPath, '.git'), join(f.created.path, '.git')) }
    if (scenario === 'symlink-escape' || scenario === 'replaced-directory') {
      const oldPath = `${f.created.path}-retained`
      await rename(f.created.path, oldPath)
      if (scenario === 'symlink-escape') await symlink(oldPath, f.created.path)
      else { await mkdir(f.created.path); await copyFile(join(oldPath, '.git'), join(f.created.path, '.git')) }
    }
    if (scenario === 'read-only-policy') f.hooks.mode = 'read-only'
    if (scenario === 'scope-escape') f.hooks.allowedRoot = join(f.directory, 'elsewhere')
    await assert.rejects(restoreRetainedWorktree(request))
    assert.notEqual(f.registry.findById(f.record.worktreeId)?.agentId, 'B')
    assert.equal(f.journal.queryTypes(['worktree/restored']).length, 0)
    if (competing) await competing.release({ confirmedStopped: true })
  })
}

for (const scenario of ['cancel-during-cwd', 'revision-during-cwd', 'old-writer-during-cwd', 'cwd-failed', 'cwd-unconfirmed', 'journal-failed', 'journal-threw-after-commit', 'interrupted-after-commit']) {
  test(`worktree recovery stays fenced on ${scenario}`, async t => {
    const f = await fixture(t), before = await f.snapshot(), controller = new AbortController()
    const request = f.input({ signal: controller.signal })
    if (scenario === 'cancel-during-cwd') f.hooks.set = () => controller.abort()
    if (scenario === 'revision-during-cwd') f.hooks.set = () => { f.controls.valid = false }
    if (scenario === 'old-writer-during-cwd') f.hooks.set = () => { f.controls.stopped = false }
    if (scenario === 'cwd-failed') f.hooks.set = () => { throw new Error('CWD persistence failed') }
    if (scenario === 'cwd-unconfirmed') request.host = { ...f.host, cwd: () => f.created.repositoryRoot }
    if (scenario === 'journal-failed') request.journal = { ...f.journal, append: () => { throw new Error('durability failed') } }
    if (scenario === 'journal-threw-after-commit') request.journal = { ...f.journal, append: event => { f.journal.append(event); throw new Error('commit acknowledgement failed') } }
    if (scenario === 'interrupted-after-commit') request.journal = { ...f.journal, append: event => { const result = f.journal.append(event); controller.abort(); return result } }
    await assert.rejects(restoreRetainedWorktree(request))
    assert.equal(f.registry.findById(f.record.worktreeId).state, 'recovery-required')
    assert.deepEqual(await f.snapshot(), before)
    assert.equal((await f.leases.getStatus(f.created.path)).busy, false)
    const recovered = intWorktreeRegistry()
    recovered.hydrateJournal(createSwarmEventJournal({ directory: f.journalDirectory, rootSessionId: 'root' }).read().events)
    assert.equal(recovered.findById(f.record.worktreeId).state, 'recovery-required')
    if (scenario === 'interrupted-after-commit' || scenario === 'journal-threw-after-commit') { assert.equal(recovered.findByAgent('A'), undefined); assert.equal(recovered.findByAgent('B').state, 'recovery-required') }
    if (scenario === 'journal-threw-after-commit') await assert.rejects(restoreRetainedWorktree(f.input()), /重新加载核对/)
  })
}

test('worktree recovery journal replay keeps latest owner fenced, even after a later legacy creation import', async t => {
  const f = await fixture(t)
  await restoreRetainedWorktree(f.input())
  const events = f.journal.read().events
  const registry = intWorktreeRegistry()
  registry.hydrateJournal([...events, { ...events[0], payload: { legacyData: f.record } }])
  assert.equal(registry.findByAgent('A'), undefined)
  assert.equal(registry.findByAgent('B').state, 'recovery-required')
  const invalid = structuredClone(events)
  invalid.at(-1).payload.previousOwner = 'forged-owner'
  assert.throws(() => intWorktreeRegistry().hydrateJournal(invalid), /事件链不一致/)
})

test('worktree execution journal latches write failure instead of reusing an uncertain sequence', async t => {
  const f = await fixture(t), original = `${f.journal.path}.saved`
  await rename(f.journal.path, original)
  await mkdir(f.journal.path)
  const event = { eventId: randomUUID(), idempotencyKey: randomUUID(), type: 'worktree/restored', actor: { kind: 'host', id: 'fixture' }, payload: {} }
  assert.throws(() => f.journal.append(event))
  await rm(f.journal.path, { recursive: true })
  await rename(original, f.journal.path)
  assert.match(f.journal.fatalError, /durability/)
  assert.throws(() => f.journal.append(event), /reopen/)
})

test('worktree restoration tool accepts only the server-resolved id and is limited to writable roles and write approval', async () => {
  let called = false
  const definitions = getBoundTaskToolDefinitions({ getConfig: () => getSwarmConfig({}), RestoreWorktree: async raw => { called = true; return raw } })
  const definition = definitions.find(tool => tool.name === RESTORE_WORKTREE_TOOL)
  assert.ok(definition)
  await assert.rejects(definition.execute({ worktree_id: 'wt-fixture', path: '/injected', owner: 'attacker' }, { signal: new AbortController().signal }))
  assert.equal(called, false)
  for (const role of ['tian_shu', 'tan_wei', 'yu_shi', 'fu_he']) assert.equal(getWantedTools(role).includes(RESTORE_WORKTREE_TOOL), false)
  for (const role of ['zhu_jian', 'ji_feng']) assert.equal(getWantedTools(role).includes(RESTORE_WORKTREE_TOOL), true)
  assert.equal(getToolApprovalScope(RESTORE_WORKTREE_TOOL), 'write')
})

test('worktree service: a new delegated Worker restores the retained tree; previous and settled owners remain denied', { timeout: 20000 }, async t => {
  const cleanup = []
  const f = await fixture({ after: action => cleanup.push(action) })
  const root = { id: 'root', status: 'idle', session: { header: { agentPreset: 'tian-shu', cwd: f.created.repositoryRoot } } }
  const live = new Map([[root.id, root]])
  const runs = [], waiting = []
  const sealed = new Set()
  let allowQuiescenceProof = false
  const outputs = JSON.parse(await readFile(new URL('./fixtures/valid-outputs.json', import.meta.url), 'utf8'))
  const config = getSwarmConfig({ jev: { enabled: false }, review: { enabled: false }, planningReview: { enabled: false }, workflow: { mode: 'advisory' },
    watchdog: { enabled: false }, agents: { maxRetries: 0 }, routes: { zhu_jian: { chain: [{ provider: 'fixture', model: 'fixture' }] } } })
  const service = intSwarmService({ getConfig: () => config, dshHome: join(f.directory, 'service'), getLlm: () => undefined,
    getCredentials: () => undefined, getAttachments: () => undefined, getAgent: id => live.get(id), getWorktreeHost: () => f.host,
    getJobs: () => ({ list: () => [] }), fetch: async () => { throw new Error('network prohibited') }, probe: async () => ({ ok: true, vision: false }),
    writerBoundary: { available: () => true, begin: () => {}, seal: (id, attempt) => { sealed.add(`${id}:${attempt}`); return true }, quiescent: (id, attempt) => allowQuiescenceProof && sealed.has(`${id}:${attempt}`) },
    getTools: () => ({ register: () => () => {}, guard: () => () => {}, schemas: () => ['create_worktree', RESTORE_WORKTREE_TOOL, 'read', 'write', 'edit', 'bash', 'swarm_context_read'].map(name => ({ name })) }),
    getSubagents: () => ({ list: () => ['spawn'], getProvider: () => ({ capabilities: { agentOptions: true, outputSchema: true, toolFilter: true, persona: true, depthLimit: true } }),
      start: async () => {
        const id = `worker-${waiting.length + 1}`, result = deferred()
        const child = { id, status: 'running', session: { header: { parentSession: root.id, agentPreset: 'zhu-jian', cwd: f.created.repositoryRoot } } }
        live.set(id, child)
        waiting.push({ child, result })
        return { id, result: result.promise, dispose: async () => {} }
      } })
  })
  cleanup.push(async () => { for (const row of waiting) { row.child.status = 'idle'; row.result.resolve({ output: [], stopReason: 'completed', structured: outputs.zhu_jian }) } await Promise.allSettled(runs); await service.dispose() })
  t.after(async () => { for (const action of cleanup.reverse()) await action() })
  const rootExec = { agent: root, signal: new AbortController().signal }
  const task = await service.AddTaskCard({ title: 'restore retained worktree', goal: 'retain staged and unstaged changes', acceptance: ['original workspace survives'], scope: ['.'], flags: {} }, rootExec)
  const start = async () => {
    const count = waiting.length
    const run = service.delegate({ task_id: task.task_id, role: 'zhu_jian', prompt: 'Continue the current implementation without repeating successful writes.', session: 'oneshot', backend: 'api' }, rootExec)
    runs.push(run)
    void run.catch(() => {})
    for (let i = 0; i < 200 && waiting.length === count; i++) await new Promise(resolve => setTimeout(resolve, 5))
    if (waiting.length === count) { await run; throw new Error('worker did not start') }
    const row = waiting[count]
    await new Promise(resolve => setImmediate(resolve))
    await service.WaitAgentReady(row.child)
    return { ...row, run, exec: { agent: row.child, signal: new AbortController().signal } }
  }
  const a = await start()
  await f.host.setCwd(a.child, f.created.path, a.exec.signal)
  await service.CompleteManagedTool({ name: 'create_worktree', ...a.exec }, f.created)
  assert.equal(service.getGuardReason({ name: 'write', arguments: { path: 'worker.txt' }, ...a.exec }), undefined)
  assert.match(service.getGuardReason({ name: 'write', arguments: { path: join(f.created.repositoryRoot, 'outside.txt') }, ...a.exec }), /超出.*工作树/)
  const id = (await service.ReadContext({}, a.exec)).worktrees[0].worktree_id
  const inFlight = { name: 'write', arguments: { path: 'pending.txt' }, callId: 'in-flight-write', ...a.exec }
  service.PrepareManagedTool(inFlight)
  await service.BeforeManagedTool(inFlight)
  service.ObserveToolDispatch(inFlight)
  const late = { name: 'write', arguments: { path: 'late.txt' }, callId: 'old-pending-call', ...a.exec }
  service.PrepareManagedTool(late)
  a.child.status = 'idle'
  a.result.resolve({ output: [], stopReason: 'completed', structured: outputs.zhu_jian })
  await a.run
  const leaseProbe = createWorkspaceLeaseManager()
  assert.equal((await leaseProbe.getStatus(f.created.repositoryRoot)).mutationUnknown, true)
  service.FinishManagedTool(inFlight)
  for (let i = 0; i < 100 && (await leaseProbe.getStatus(f.created.repositoryRoot)).busy; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((await leaseProbe.getStatus(f.created.repositoryRoot)).mutationUnknown, false)
  const b = await start()
  assert.ok(service.getGuardReason({ name: 'write', arguments: { path: 'worker.txt' }, ...b.exec }))
  config.approvals.mode = 'deny'
  config.approvals.scope = ['write']
  await assert.rejects(service.RestoreWorktree({ worktree_id: id }, b.exec))
  config.approvals.mode = 'inherit'
  await assert.rejects(service.RestoreWorktree({ worktree_id: id }, b.exec), /停净证明/)
  allowQuiescenceProof = true
  const before = await f.snapshot()
  const restored = await service.RestoreWorktree({ worktree_id: id }, b.exec)
  assert.equal(restored.agentId, b.child.id)
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(service.getGuardReason({ name: 'write', arguments: { path: 'worker.txt' }, ...b.exec }), undefined)
  assert.ok(service.getGuardReason({ name: 'write', arguments: { path: 'worker.txt' }, ...a.exec }))
  assert.throws(() => service.ObserveToolDispatch(late))
  await f.host.setCwd(b.child, f.created.repositoryRoot, b.exec.signal)
  assert.match(service.getGuardReason({ name: 'write', arguments: { path: 'worker.txt' }, ...b.exec }), /CWD/)
  await service.RestoreWorktree({ worktree_id: id }, b.exec)
  await service.BeforeManagedTool({ name: 'write', arguments: { path: 'worker.txt' }, ...b.exec })
  await writeFile(join(f.created.path, 'worker.txt'), 'new authorized owner\n')
  assert.equal(await readFile(join(f.created.path, 'worker.txt'), 'utf8'), 'new authorized owner\n')
  await assert.rejects(service.RestoreWorktree({ worktree_id: id, owner: 'forged' }, b.exec))
  assert.ok(service.getGuardReason({ name: RESTORE_WORKTREE_TOOL, arguments: { worktree_id: id }, ...rootExec }))
  await rename(f.created.path, `${f.created.path}-original`)
  await mkdir(f.created.path)
  await copyFile(join(`${f.created.path}-original`, '.git'), join(f.created.path, '.git'))
  await assert.rejects(service.BeforeManagedTool({ name: 'write', arguments: { path: 'injected.txt' }, ...b.exec }), /目录已被替换/)
  assert.ok(service.getGuardReason({ name: 'write', arguments: { path: 'injected.txt' }, ...b.exec }))
  b.child.status = 'idle'
  b.result.resolve({ output: [], stopReason: 'completed', structured: outputs.zhu_jian })
  await b.run
  assert.ok(service.getGuardReason({ name: 'write', arguments: { path: 'worker.txt' }, ...b.exec }))
})
