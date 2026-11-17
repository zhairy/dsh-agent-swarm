import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, access, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createExecutionBoundary, getExecutionBoundaryCarrier, EXECUTION_BOUNDARY_CAPS, EXECUTION_BOUNDARY_KEY } from '../lib/adapters/dsh-host/execution-boundary.js'

const fixture = async t => {
  await access('/usr/bin/bwrap')
  const home = await mkdtemp(join(tmpdir(), 'swarm-kernel-fence-')), repo = join(home, 'repo'), cwd = join(repo, 'worktree'), allowed = join(cwd, 'allowed')
  await mkdir(allowed, { recursive: true })
  await writeFile(join(repo, 'source.txt'), 'source-protected')
  await writeFile(join(cwd, 'outside.txt'), 'scope-protected')
  const previous = globalThis[EXECUTION_BOUNDARY_CAPS]
  // Component tests model the bridge advertisement; the integration driver
  // separately loads the exact patched Host and executes its real tools.
  globalThis[EXECUTION_BOUNDARY_CAPS] = new Set(['subprocess-local/rc1', 'fs-local/rc1', 'working-directory/rc1'])
  t.after(async () => { globalThis[EXECUTION_BOUNDARY_CAPS] = previous; await rm(home, { recursive: true, force: true }) })
  const agentId = randomUUID(), attemptId = randomUUID(), stat = lstatSync(cwd, { bigint: true })
  const hostPolicy = { mode: 'workspace-write', workspaceRoot: repo }
  const boundary = createExecutionBoundary({ get: name => name === 'fs' ? { processPathFromHostPath: p => p } : name === 'subprocess' ? { resolveExecutable: async program => { assert.equal(program, 'bwrap'); return '/usr/bin/bwrap' } } : name === 'agents' ? { get: id => id === agentId ? { id, session: {} } : undefined } : name === 'sandboxPolicy' ? { resolve: () => hostPolicy } : undefined }, () => {})
  boundary.begin(agentId, attemptId)
  let valid = true
  const hooks = { beforeSpawn: undefined }
  const policy = { agentId, attemptId, mode: 'write', operation: 'shell', cwd, repositoryRoot: repo, writeScopes: [allowed], expectedDirectoryIdentity: [stat.dev, stat.ino, stat.birthtimeNs].join(':'), assertCurrent: () => { if (!valid) throw new Error('revoked') } }
  const carrier = getExecutionBoundaryCarrier()
  const launch = async (argv, override = {}) => {
    const ticket = carrier.prepareSpawn({ argv, cwd, ...override })
    ticket.assertContainment('linux-scope')
    await hooks.beforeSpawn?.(ticket)
    const env = { ...process.env, ...ticket.spec.env }
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
    const child = spawn(ticket.spec.argv[0], ticket.spec.argv.slice(1), { cwd: ticket.spec.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code })) })
    ticket.started({ done, waitForExit: async () => { await done; return true } })
    const result = await done
    return { ...result, stdout, stderr }
  }
  const run = (argv, override) => boundary.run(policy, () => launch(argv, override))
  return { home, repo, cwd, allowed, boundary, carrier, policy, hostPolicy, hooks, launch, run, revoke: () => { valid = false } }
}
const write = path => [process.execPath, '-e', 'require("fs").writeFileSync(process.argv[1],"changed")', path]

test('kernel execution: in-scope physical write succeeds; source tree and task-scope escapes fail', async t => {
  const f = await fixture(t)
  assert.equal((await f.run(write(join(f.allowed, 'result.txt')))).code, 0)
  assert.equal(await readFile(join(f.allowed, 'result.txt'), 'utf8'), 'changed')
  for (const path of [join(f.repo, 'source.txt'), join(f.cwd, 'outside.txt')]) assert.notEqual((await f.run(write(path))).code, 0)
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'source-protected')
  assert.equal(await readFile(join(f.cwd, 'outside.txt'), 'utf8'), 'scope-protected')
})
test('kernel execution: cd and nested sandbox commands cannot widen the filesystem grant', async t => {
  const f = await fixture(t)
  assert.notEqual((await f.run(['/bin/bash', '-c', 'cd .. && printf escaped > source.txt'])).code, 0)
  assert.notEqual((await f.run(['/usr/bin/bwrap', '--bind', '/', '/', '--', ...write(join(f.repo, 'source.txt'))])).code, 0)
  assert.equal(await readFile(join(f.repo, 'source.txt'), 'utf8'), 'source-protected')
})
test('kernel execution: the Host workspace sandbox can nest without widening the narrower grants', async t => {
  const f = await fixture(t)
  const argv = ['/usr/bin/bwrap', '--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp', '--bind', f.repo, f.repo, '--']
  assert.equal((await f.run([...argv, ...write(join(f.allowed, 'nested.txt'))])).code, 0)
  assert.notEqual((await f.run([...argv, ...write(join(f.cwd, 'outside.txt'))])).code, 0)
  assert.equal(await readFile(join(f.cwd, 'outside.txt'), 'utf8'), 'scope-protected')
})
test('kernel execution: an explicit outside workdir is refused at actual spawn', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run(['/usr/bin/true'], { cwd: f.repo }), /CWD 超出/)
})
test('kernel execution: an exact file scope never grants its parent or siblings', async t => {
  const f = await fixture(t), file = join(f.allowed, 'exact.txt')
  await writeFile(file, 'initial')
  f.policy.writeScopes = [file]
  assert.equal((await f.run(write(file))).code, 0)
  assert.notEqual((await f.run(write(join(f.allowed, 'sibling.txt')))).code, 0)
  assert.equal(await readFile(file, 'utf8'), 'changed')
})
test('execution edge: CWD fallback, late cancellation, and directory replacement are denied', async t => {
  const f = await fixture(t)
  await f.boundary.run(f.policy, async () => {
    assert.throws(() => f.carrier.assertWorkingDirectory({ id: f.policy.agentId }, f.repo), /禁止自动回退/)
    assert.throws(() => f.carrier.assertWorkingDirectory({ id: f.policy.agentId }, f.cwd, false), /禁止自动回退/)
    f.revoke()
    assert.throws(() => f.carrier.prepareSpawn({ argv: ['/usr/bin/true'], cwd: f.cwd }), /revoked/)
  })
  const another = await fixture(t)
  await another.boundary.run(another.policy, async () => {
    await rename(another.cwd, `${another.cwd}-old`); await mkdir(another.cwd)
    assert.throws(() => another.carrier.prepareSpawn({ argv: ['/usr/bin/true'], cwd: another.cwd }), /CWD.*改变/)
  })
})
test('execution edge: real file mutation path is checked after preparation', async t => {
  const f = await fixture(t)
  await f.boundary.run({ ...f.policy, operation: 'file' }, async () => {
    assert.doesNotThrow(() => f.carrier.assertFilePath(join(f.allowed, 'new.txt')))
    assert.throws(() => f.carrier.assertFilePath(join(f.cwd, 'outside.txt')), /task scope/)
    assert.throws(() => f.carrier.assertFilePath(join(f.repo, 'source.txt')), /task scope/)
    f.revoke()
    assert.throws(() => f.carrier.assertFilePath(join(f.allowed, 'new.txt')), /revoked/)
  })
})
test('execution edge: a Host policy change during waiting revokes the prepared execution', async t => {
  const f = await fixture(t)
  await f.boundary.run(f.policy, async () => {
    f.hostPolicy.mode = 'read-only'
    assert.throws(() => f.carrier.prepareSpawn({ argv: ['/usr/bin/true'], cwd: f.cwd }), /文件策略已改变/)
  })
})
test('execution edge: readonly roles get private scratch, not repository write access', async t => {
  const f = await fixture(t), scratch = `/tmp/swarm-private-${randomUUID()}`
  const result = await f.boundary.run({ ...f.policy, mode: 'read-only', writeScopes: [] }, () => f.launch(write(scratch)))
  assert.equal(result.code, 0)
  await assert.rejects(access(scratch))
  assert.notEqual((await f.boundary.run({ ...f.policy, mode: 'read-only', writeScopes: [] }, () => f.launch(write(join(f.allowed, 'forbidden.txt'))))).code, 0)
})
test('execution edge: host runtime absence and persistent terminals fail closed', async t => {
  const f = await fixture(t)
  await f.boundary.run(f.policy, async () => assert.throws(() => f.carrier.assertTerminal(), /持久终端/))
  globalThis[EXECUTION_BOUNDARY_CAPS] = new Set()
  await assert.rejects(f.run(['/usr/bin/true']), /桥接/)
})

test('execution edge: an old process carrier without the verifier hardlink rule fails closed', async () => {
  const previous = globalThis[EXECUTION_BOUNDARY_KEY]
  globalThis[EXECUTION_BOUNDARY_KEY] = { primaryProtectionVersion: 1, version: 1 }
  try {
    assert.throws(() => getExecutionBoundaryCarrier(), /旧进程/)
  } finally {
    globalThis[EXECUTION_BOUNDARY_KEY] = previous
  }
})
test('quiescence: producer completion alone is insufficient; waitForExit must confirm the managed range', async t => {
  const f = await fixture(t)
  await f.boundary.run(f.policy, async () => {
    const ticket = f.carrier.prepareSpawn({ argv: ['/usr/bin/true'], cwd: f.cwd })
    ticket.assertContainment('linux-scope')
    ticket.started({ done: Promise.resolve(), waitForExit: async () => false })
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.boundary.seal(f.policy.agentId, f.policy.attemptId), false)
  assert.equal(f.boundary.quiescent(f.policy.agentId, f.policy.attemptId), false)
})
test('quiescence: weak process-tree fallback is refused before spawning', async t => {
  const f = await fixture(t)
  await f.boundary.run(f.policy, async () => {
    const ticket = f.carrier.prepareSpawn({ argv: ['/usr/bin/true'], cwd: f.cwd })
    assert.throws(() => ticket.assertContainment('fallback'), /原生进程管理范围/)
  })
  assert.equal(f.boundary.seal(f.policy.agentId, f.policy.attemptId), false)
  assert.equal(f.boundary.quiescent(f.policy.agentId, f.policy.attemptId), false)
})
test('quiescence: only an observed completed epoch can certify a writer, and sealed epochs reject late starts', async t => {
  const f = await fixture(t)
  assert.equal(f.boundary.quiescent('cold-owner', 'old-attempt'), false)
  assert.equal((await f.run(['/usr/bin/true'])).code, 0)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.boundary.seal(f.policy.agentId, f.policy.attemptId), true)
  assert.equal(f.boundary.quiescent(f.policy.agentId, f.policy.attemptId), true)
  await assert.rejects(f.run(['/usr/bin/true']), /已结束/)
})

test('future verification directories do not block other admitted writes or become writable before preparation', async t => {
  const f = await fixture(t)
  const future = join(f.cwd, 'var/tmp')
  f.policy.writeScopes.push(future)
  assert.equal((await f.run(write(join(f.allowed, 'allowed.txt')))).code, 0)
  assert.notEqual((await f.run(['/usr/bin/python3', '-c', 'import os,sys;os.makedirs(sys.argv[1])', future])).code, 0)
})

test('kernel execution: a pre-existing hardlink alias cannot write protected Git metadata', async t => {
  const f = await fixture(t)
  const metadata = join(f.cwd, 'metadata')
  const protectedFile = join(metadata, 'config')
  const alias = join(f.allowed, 'config-alias')
  await mkdir(metadata)
  await writeFile(protectedFile, 'protected')
  await link(protectedFile, alias)
  const stat = lstatSync(metadata, { bigint: true })
  Object.assign(f.policy, {
    protectedRoots: [metadata],
    expectedGitIdentity: [stat.dev, stat.ino, stat.birthtimeNs].join(':')
  })

  await assert.rejects(f.run(write(alias)), /硬链接 alias/)
  assert.equal(await readFile(protectedFile, 'utf8'), 'protected')
  assert.equal(lstatSync(alias).nlink, 2)
})

test('kernel execution: the namespace check rejects an alias created after host preflight', async t => {
  const f = await fixture(t)
  const metadata = join(f.cwd, 'metadata')
  const protectedFile = join(metadata, 'config')
  const alias = join(f.allowed, 'late-config-alias')
  await mkdir(metadata)
  await writeFile(protectedFile, 'protected')
  const stat = lstatSync(metadata, { bigint: true })
  Object.assign(f.policy, {
    protectedRoots: [metadata],
    expectedGitIdentity: [stat.dev, stat.ino, stat.birthtimeNs].join(':')
  })
  f.hooks.beforeSpawn = async () => { await link(protectedFile, alias) }

  const result = await f.run(write(alias))

  assert.equal(result.code, 125)
  assert.match(result.stderr, /SWARM_EXECUTION_BOUNDARY_REJECTED/)
  assert.equal(await readFile(protectedFile, 'utf8'), 'protected')
  assert.equal(lstatSync(alias).nlink, 2)
})

test('kernel execution: Shell cannot create a new hardlink from protected metadata', async t => {
  const f = await fixture(t)
  const metadata = join(f.cwd, 'metadata')
  const protectedFile = join(metadata, 'config')
  const alias = join(f.allowed, 'runtime-config-alias')
  await mkdir(metadata)
  await writeFile(protectedFile, 'protected')
  const stat = lstatSync(metadata, { bigint: true })
  Object.assign(f.policy, {
    protectedRoots: [metadata],
    expectedGitIdentity: [stat.dev, stat.ino, stat.birthtimeNs].join(':')
  })

  const result = await f.run([
    process.execPath,
    '-e',
    'require("fs").linkSync(process.argv[1], process.argv[2])',
    protectedFile,
    alias
  ])

  assert.notEqual(result.code, 0)
  await assert.rejects(access(alias), error => error.code === 'ENOENT')
  assert.equal(await readFile(protectedFile, 'utf8'), 'protected')
})

test('kernel execution: verifier writable scopes reject a hardlink alias to source', async t => {
  const f = await fixture(t)
  const metadata = join(f.cwd, 'metadata')
  const protectedFile = join(metadata, 'config')
  const source = join(f.cwd, 'source.ts')
  const alias = join(f.allowed, 'source-alias.ts')
  await mkdir(metadata)
  await writeFile(protectedFile, 'protected')
  await writeFile(source, 'source-read-only')
  const sourceBefore = await readFile(source)
  await link(source, alias)
  const metadataStat = lstatSync(metadata, { bigint: true })
  const allowedStat = lstatSync(f.allowed, { bigint: true })
  Object.assign(f.policy, {
    protectedRoots: [metadata],
    expectedGitIdentity: [metadataStat.dev, metadataStat.ino, metadataStat.birthtimeNs].join(':'),
    expectedWritableIdentities: [{
      path: f.allowed,
      identity: [allowedStat.dev, allowedStat.ino, allowedStat.birthtimeNs].join(':')
    }]
  })

  const outcome = await f.run(write(alias)).then(
    result => ({ result }),
    error => ({ error })
  )

  assert.deepEqual(await readFile(source), sourceBefore)
  assert.ok('error' in outcome || outcome.result.code !== 0)
  assert.equal(lstatSync(alias).nlink, 2)
})

test('kernel execution: namespace check applies the strict verifier hardlink rule', async t => {
  const f = await fixture(t)
  const metadata = join(f.cwd, 'metadata')
  const protectedFile = join(metadata, 'config')
  const source = join(f.cwd, 'source.ts')
  const alias = join(f.allowed, 'late-source-alias.ts')
  await mkdir(metadata)
  await writeFile(protectedFile, 'protected')
  await writeFile(source, 'source-read-only')
  const sourceBefore = await readFile(source)
  const metadataStat = lstatSync(metadata, { bigint: true })
  const allowedStat = lstatSync(f.allowed, { bigint: true })
  Object.assign(f.policy, {
    protectedRoots: [metadata],
    expectedGitIdentity: [metadataStat.dev, metadataStat.ino, metadataStat.birthtimeNs].join(':'),
    expectedWritableIdentities: [{
      path: f.allowed,
      identity: [allowedStat.dev, allowedStat.ino, allowedStat.birthtimeNs].join(':')
    }]
  })
  f.hooks.beforeSpawn = async () => { await link(source, alias) }

  const result = await f.run(write(alias))

  assert.deepEqual(await readFile(source), sourceBefore)
  assert.equal(result.code, 125)
  assert.match(result.stderr, /SWARM_EXECUTION_BOUNDARY_REJECTED/)
  assert.equal(lstatSync(alias).nlink, 2)
})

test('kernel execution: strict verifier hardlink policy leaves ordinary source reads available', async t => {
  const f = await fixture(t)
  const metadata = join(f.cwd, 'metadata')
  const source = join(f.cwd, 'source.ts')
  await mkdir(metadata)
  await writeFile(join(metadata, 'config'), 'protected')
  await writeFile(source, 'source-readable')
  const metadataStat = lstatSync(metadata, { bigint: true })
  const allowedStat = lstatSync(f.allowed, { bigint: true })
  Object.assign(f.policy, {
    protectedRoots: [metadata],
    expectedGitIdentity: [metadataStat.dev, metadataStat.ino, metadataStat.birthtimeNs].join(':'),
    expectedWritableIdentities: [{
      path: f.allowed,
      identity: [allowedStat.dev, allowedStat.ino, allowedStat.birthtimeNs].join(':')
    }]
  })

  const result = await f.run([
    process.execPath,
    '-e',
    'process.stdout.write(require("fs").readFileSync(process.argv[1]))',
    source
  ])

  assert.equal(result.code, 0)
  assert.equal(result.stdout, 'source-readable')
  assert.equal(await readFile(source, 'utf8'), 'source-readable')
})
