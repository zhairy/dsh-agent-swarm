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
import { bindPrimaryWorkspace } from '../lib/application/primary-workspace.js'
import { getWorkspacePlan, ValidateWorkspacePlan } from '../lib/workspace-policy.js'

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
  const path = repositoryRoot
  const created = { kind: 'primary', repositoryRoot, path, branch: 'main', baseCommit }
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


const primaryInput = async t => {
  const f = await fixture(t)
  await writeFile(join(f.created.path, 'agent.md'), '唯一基线工作树是当前仓库。禁止 git worktree add、linked worktree、第二 checkout。\n')
  const metadata = await f.host.inspectWorkspace(f.agentA, new AbortController().signal)
  const registry = intWorktreeRegistry()
  const journal = createSwarmEventJournal({ directory: join(f.directory, 'primary-events'), rootSessionId: 'root' })
  const lease = await f.leases.acquire(f.created.path, 'A:current-attempt', 'write')
  f.grants.set('primary', lease)
  const input = { record: metadata.record, workspacePlan: metadata.plan, expectedHead: metadata.plan.head, agent: f.agentA, owner: owner('A'), signal: new AbortController().signal,
    registry, journal, host: f.host, leases: f.leases, lease, lock: intMutex(),
    assertCurrent: () => { if (!f.controls.valid) throw new Error('stale attempt') }, retainLease: (grant, record) => { f.grants.set(getWorktreeOwnerKey(record), grant) } }
  return { ...f, metadata, registry, journal, lease, input }
}
test('primary Host binding preserves HEAD, staged/unstaged/untracked bytes and stays a single worktree', async t => {
  const f = await primaryInput(t), before = await f.snapshot()
  const bound = await bindPrimaryWorkspace(f.input)
  assert.equal(bound.kind, 'primary'); assert.equal(bound.state, 'active')
  assert.equal(f.metadata.plan.mode, 'primary'); assert.equal(ValidateWorkspacePlan(f.metadata.plan), true)
  assert.deepEqual(await f.snapshot(), before)
  assert.equal((await git(f.created.path, 'worktree', 'list', '--porcelain')).split('worktree ').length - 1, 1)
  const cold = intWorktreeRegistry(); cold.hydrateJournal(f.journal.read().events)
  assert.equal(cold.findById(bound.worktreeId).kind, 'primary')
  assert.equal(cold.findById(bound.worktreeId).state, 'recovery-required')
})
for (const scenario of ['wrong-head', 'cancelled', 'revoked', 'cwd-failed', 'journal-failed', 'cancel-after-commit', 'multiple-worktrees']) {
  test(`primary binding fails closed: ${scenario}`, async t => {
    const f = await primaryInput(t)
    if (scenario === 'wrong-head') f.input.expectedHead = 'f'.repeat(40)
    if (scenario === 'cancelled') { const c = new AbortController(); c.abort(); f.input.signal = c.signal }
    if (scenario === 'revoked') f.controls.valid = false
    if (scenario === 'cwd-failed') f.hooks.set = () => { throw Error('CWD failed') }
    if (scenario === 'journal-failed') f.input.journal = { ...f.journal, append: () => { throw Error('durability failed') } }
    if (scenario === 'cancel-after-commit') { const c = new AbortController(); f.input.signal = c.signal; f.input.journal = { ...f.journal, append: event => { const result = f.journal.append(event); c.abort(); return result } } }
    if (scenario === 'multiple-worktrees') await git(f.created.path, 'worktree', 'add', '-b', 'other', join(f.created.path, '.agents', 'other'))
    await assert.rejects(bindPrimaryWorkspace(f.input))
    assert.equal(f.registry.project().some(r => r.state === 'active'), false)
  })
}
test('primary restore reuses the new attempt root lease and fences the previous owner', async t => {
  const f = await primaryInput(t)
  const old = await bindPrimaryWorkspace(f.input)
  await f.lease.release({ confirmedStopped: true })
  const lease = await f.leases.acquire(f.created.path, 'B:next-attempt', 'write'); f.grants.set('B', lease)
  const restored = await restoreRetainedWorktree({ id: old.worktreeId, agent: f.agentB, owner: owner('B'), signal: new AbortController().signal,
    registry: f.registry, journal: f.journal, host: f.host, leases: f.leases, primaryLease: lease, workspacePlan: f.metadata.plan, lock: intMutex(),
    assertCurrent: () => {}, confirmStopped: async () => {}, assertStopped: () => {}, getLease: () => undefined,
    retainLease: () => {}, warn: () => {} })
  assert.equal(restored.state, 'active'); assert.equal(restored.agentId, 'B'); assert.equal(f.registry.findByAgent('A'), undefined)
})
test('a primary binding cannot publish the old project under a new project contract', async t => {
  const f = await primaryInput(t)
  const other = getWorkspacePlan({ ...f.metadata.plan, repositoryRoot: '/other-project', sources: [{ path: 'agent.md', text: 'dsh.workspace: primary', digest: sha(Buffer.from('dsh.workspace: primary')) }] })
  await assert.rejects(bindPrimaryWorkspace({ ...f.input, workspacePlan: other }), /工作区.*(?:合同|规划|项目)/)
  assert.equal(f.registry.project().length, 0)
})
test('workspace rules constrain planning and contradictory requirements remain blocked', () => {
  const record = { repositoryRoot: '/repo', branch: 'main', head: 'a'.repeat(40) }
  const source = text => [{ path: 'agent.md', digest: sha(Buffer.from(text)), text }]
  assert.equal(getWorkspacePlan({ ...record, sources: source('唯一基线工作树。禁止 git worktree add。') }).mode, 'primary')
  assert.equal(getWorkspacePlan({ ...record, sources: source('dsh.workspace: linked') }).mode, 'linked')
  assert.equal(getWorkspacePlan({ ...record, sources: source('dsh.workspace: primary\ndsh.workspace: linked') }).mode, 'blocked')
  const plan = getWorkspacePlan({ ...record, sources: [] }); assert.equal(ValidateWorkspacePlan(plan), true)
  assert.equal(ValidateWorkspacePlan({ ...plan, mode: 'primary' }), false)
  const reordered = JSON.parse(JSON.stringify(plan, Object.keys(plan).sort()))
  assert.equal(ValidateWorkspacePlan(reordered), true, 'StateStore canonical key ordering must preserve the plan digest')
})
