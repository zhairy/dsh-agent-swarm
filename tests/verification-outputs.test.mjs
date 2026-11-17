import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createVerificationOutputPort,
  VerificationOutputError
} from '../src/adapters/dsh-host/verification-outputs.ts'

const exec = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }

const git = async (cwd, ...args) => (await exec(
  'git',
  ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args],
  { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer: 1024 * 1024 }
)).stdout

const gitText = async (cwd, ...args) => (await git(cwd, ...args)).toString('utf8').trimEnd()

const attemptKey = (agentId, attemptId) => createHash('sha256')
  .update('dsh-agent-swarm/verification-output/v1\0')
  .update(agentId)
  .update('\0')
  .update(attemptId)
  .digest('hex')
  .slice(0, 32)

const fixture = async t => {
  const base = await mkdtemp(join(tmpdir(), 'swarm-verification-output-'))
  const repositoryRoot = join(base, 'repo')
  await mkdir(join(repositoryRoot, 'src'), { recursive: true })
  await writeFile(join(repositoryRoot, '.gitignore'), 'var/\n')
  await writeFile(join(repositoryRoot, 'src', 'tracked.txt'), 'tracked-before\n')
  await git(repositoryRoot, 'init', '-b', 'main')
  await git(repositoryRoot, 'add', '.')
  await git(repositoryRoot, 'commit', '-m', 'baseline')

  const agent = { id: 'fu_he-agent', session: { header: { cwd: repositoryRoot } } }
  const hooks = {
    mode: 'workspace-write',
    policyRoot: repositoryRoot,
    additionalWritableRoots: undefined,
    enforcement: 'full',
    beforeConfine: undefined,
    afterDone: undefined
  }
  const sandboxCalls = []
  const commands = []

  const fsPort = {
    resolve: async (path, options = {}) => {
      options.signal?.throwIfAborted?.()
      const targetKey = await realpath(path)
      return { targetKey, displayPath: path }
    },
    processPath: target => target.targetKey,
    processPathFromHostPath: path => path,
    lstat: async (path, _options, signal) => {
      signal?.throwIfAborted?.()
      try {
        const stat = await lstat(path)
        return {
          type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
          version: `${stat.dev}:${stat.ino}`
        }
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    }
  }

  const sandboxPolicy = {
    resolve: () => ({
      mode: hooks.mode,
      workspaceRoot: hooks.policyRoot,
      ...(hooks.additionalWritableRoots === undefined
        ? {}
        : { additionalWritableRoots: hooks.additionalWritableRoots })
    })
  }

  const sandbox = {
    confine: async (argv, policy, signal) => {
      sandboxCalls.push({ argv: [...argv], policy: structuredClone(policy) })
      hooks.beforeConfine?.(argv, policy)
      signal.throwIfAborted()
      return { argv: [...argv], enforcement: hooks.enforcement }
    }
  }

  const subprocess = {
    resolveExecutable: async name => {
      assert.equal(name, 'node')
      return process.execPath
    },
    spawn: spec => {
      commands.push({ argv: [...spec.argv], cwd: spec.cwd, env: { ...spec.env } })
      const env = { ...process.env, ...spec.env }
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env,
        signal: spec.signal,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      const outcome = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', exitCode => resolve({ exitCode }))
      })
      const done = outcome.then(async value => {
        await hooks.afterDone?.(spec, value, stdout, stderr)
        return value
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) }
        },
        terminate: () => {
          if (child.exitCode === null) child.kill('SIGTERM')
        },
        waitForExit: async () => {
          await done
          return true
        }
      }
    }
  }

  const ctx = {
    get: name => ({
      fs: fsPort,
      sandbox,
      sandboxPolicy,
      subprocess
    })[name]
  }
  const port = createVerificationOutputPort(ctx)
  const request = (override = {}) => ({
    repositoryRoot,
    attemptId: 'attempt-verify-1',
    ...override
  })
  const snapshot = async () => ({
    head: await gitText(repositoryRoot, 'rev-parse', 'HEAD'),
    branch: await gitText(repositoryRoot, 'symbolic-ref', 'HEAD'),
    index: await git(repositoryRoot, 'ls-files', '--stage', '-z'),
    status: (await git(repositoryRoot, 'status', '--porcelain', '--untracked-files=all')).toString('utf8'),
    tracked: await readFile(join(repositoryRoot, 'src', 'tracked.txt'), 'utf8'),
    gitHead: await readFile(join(repositoryRoot, '.git', 'HEAD'), 'utf8')
  })

  t.after(async () => {
    await rm(base, { recursive: true, force: true })
  })
  return {
    base,
    repositoryRoot,
    agent,
    hooks,
    sandboxCalls,
    commands,
    port,
    request,
    snapshot
  }
}

const rejectsCode = async (promise, code) => {
  let rejected
  await assert.rejects(promise, error => {
    assert.ok(error instanceof VerificationOutputError)
    assert.equal(error.code, code, `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ''}`)
    rejected = error
    return true
  })
  return rejected
}

test('verification outputs: prepares fixed temp and fresh report roots through a full confined Host boundary', async t => {
  const f = await fixture(t)
  const before = await f.snapshot()
  const controller = new AbortController()

  const output = await f.port.prepare(f.agent, f.request(), controller.signal)
  const key = attemptKey(f.agent.id, 'attempt-verify-1')

  assert.equal(output.attemptKey, key)
  assert.equal(output.temporaryRoot, join(f.repositoryRoot, 'var', 'tmp'))
  assert.equal(output.reportRoot, join(f.repositoryRoot, 'var', 'reports', 'swarm', key))
  assert.deepEqual(output.writeScopes, [output.temporaryRoot, output.reportRoot])
  assert.deepEqual(output.protectedRoots, [f.repositoryRoot, join(f.repositoryRoot, '.git')])
  assert.match(output.directoryIdentity.repositoryRoot, /^\d+:\d+:\d+$/)
  assert.match(output.directoryIdentity.temporaryRoot, /^\d+:\d+:\d+$/)
  assert.match(output.directoryIdentity.reportRoot, /^\d+:\d+:\d+$/)
  assert.equal(output.directoryIdentity.gitPath, join(f.repositoryRoot, '.git'))
  assert.equal(output.identities.reportRoot.path, output.reportRoot)
  assert.equal((await lstat(output.temporaryRoot)).isDirectory(), true)
  assert.equal((await lstat(output.reportRoot)).isDirectory(), true)

  assert.equal(f.sandboxCalls.length, 2)
  assert.equal(f.commands.length, 2)
  assert.deepEqual(f.sandboxCalls[0].policy, {
    mode: 'workspace-write',
    workspaceRoot: f.repositoryRoot
  })
  assert.deepEqual(f.sandboxCalls[1].policy, {
    mode: 'read-only',
    workspaceRoot: f.repositoryRoot
  })
  for (const command of f.commands) {
    assert.equal(command.argv[0], process.execPath)
    assert.equal(command.argv[1], '-e')
    assert.equal(command.cwd, f.repositoryRoot)
    assert.equal(command.env.NODE_OPTIONS, undefined)
    assert.equal(command.env.LD_PRELOAD, undefined)
  }

  assert.deepEqual(await f.snapshot(), before)
  assert.equal((await git(f.repositoryRoot, 'status', '--porcelain')).toString('utf8'), '')
})

test('verification outputs: rejects model-supplied paths instead of accepting arbitrary roots', async t => {
  const f = await fixture(t)
  await rejectsCode(
    f.port.prepare(f.agent, f.request({ reportRoot: '/tmp/forged-report' }), new AbortController().signal),
    'VERIFICATION_OUTPUT_INVALID'
  )
  await rejectsCode(
    f.port.prepare(f.agent, f.request({ temporaryRoot: '/tmp/forged-temp' }), new AbortController().signal),
    'VERIFICATION_OUTPUT_INVALID'
  )
  assert.equal(f.sandboxCalls.length, 0)
  await assert.rejects(access(join(f.repositoryRoot, 'var')), error => error.code === 'ENOENT')
})

test('verification outputs: rejects symlink path escape for var and .git', async t => {
  const varFixture = await fixture(t)
  const before = await varFixture.snapshot()
  const outside = join(varFixture.base, 'outside')
  await mkdir(outside)
  await symlink(outside, join(varFixture.repositoryRoot, 'var'))
  await rejectsCode(
    varFixture.port.prepare(varFixture.agent, varFixture.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_PATH_REJECTED'
  )
  assert.deepEqual(await readdir(outside), [])
  const after = await varFixture.snapshot()
  assert.equal(after.head, before.head)
  assert.equal(after.branch, before.branch)
  assert.deepEqual(after.index, before.index)
  assert.equal(after.gitHead, before.gitHead)
  assert.equal(after.tracked, before.tracked)

  const gitFixture = await fixture(t)
  await rename(join(gitFixture.repositoryRoot, '.git'), join(gitFixture.repositoryRoot, '.git-real'))
  await symlink(join(gitFixture.repositoryRoot, '.git-real'), join(gitFixture.repositoryRoot, '.git'))
  await rejectsCode(
    gitFixture.port.prepare(gitFixture.agent, gitFixture.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_PATH_REJECTED'
  )
  await assert.rejects(access(join(gitFixture.repositoryRoot, 'var')), error => error.code === 'ENOENT')
})

test('verification outputs: never overwrites an existing report for the same opaque attempt', async t => {
  const f = await fixture(t)
  const first = await f.port.prepare(f.agent, f.request(), new AbortController().signal)
  const marker = join(first.reportRoot, 'old-report.txt')
  await writeFile(marker, 'keep-old\n')

  await rejectsCode(
    f.port.prepare(f.agent, f.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_REPORT_EXISTS'
  )
  assert.equal(await readFile(marker, 'utf8'), 'keep-old\n')

  const next = await f.port.prepare(
    f.agent,
    f.request({ attemptId: 'attempt-verify-2' }),
    new AbortController().signal
  )
  assert.notEqual(next.reportRoot, first.reportRoot)
})

test('verification outputs: linked worktree protects the resolved gitdir instead of the .git file', async t => {
  const f = await fixture(t)
  const linkedRoot = join(f.base, 'linked')
  await git(f.repositoryRoot, 'worktree', 'add', '-b', 'verification-linked', linkedRoot)
  f.hooks.policyRoot = f.base
  const linkedAgent = {
    id: 'fu_he-linked',
    session: { header: { cwd: linkedRoot } }
  }
  const gitEntry = await readFile(join(linkedRoot, '.git'), 'utf8')
  assert.match(gitEntry, /^gitdir: .+\n?$/)
  const gitDirectory = await realpath(gitEntry.trim().slice('gitdir: '.length))
  const trackedPath = join(linkedRoot, 'src', 'tracked.txt')
  const before = {
    head: await gitText(linkedRoot, 'rev-parse', 'HEAD'),
    index: await git(linkedRoot, 'ls-files', '--stage', '-z'),
    tracked: await readFile(trackedPath, 'utf8'),
    gitEntry
  }

  const output = await f.port.prepare(
    linkedAgent,
    {
      repositoryRoot: linkedRoot,
      attemptId: 'attempt-linked-1'
    },
    new AbortController().signal
  )

  assert.equal(output.temporaryRoot, join(linkedRoot, 'var', 'tmp'))
  assert.equal(output.reportRoot, join(
    linkedRoot,
    'var',
    'reports',
    'swarm',
    attemptKey(linkedAgent.id, 'attempt-linked-1')
  ))
  assert.deepEqual(output.writeScopes, [output.temporaryRoot, output.reportRoot])
  assert.deepEqual(output.protectedRoots, [linkedRoot, gitDirectory])
  assert.equal(output.identities.gitEntry.path, join(linkedRoot, '.git'))
  assert.equal(output.identities.gitEntry.type, 'file')
  assert.equal(output.identities.gitPath.path, gitDirectory)
  assert.equal(output.directoryIdentity.gitPath, gitDirectory)
  assert.equal(output.directoryIdentity.gitType, 'directory')
  assert.equal(await gitText(linkedRoot, 'rev-parse', 'HEAD'), before.head)
  assert.deepEqual(await git(linkedRoot, 'ls-files', '--stage', '-z'), before.index)
  assert.equal(await readFile(trackedPath, 'utf8'), before.tracked)
  assert.equal(await readFile(join(linkedRoot, '.git'), 'utf8'), before.gitEntry)
})

test('verification outputs: rejects pre-existing hardlink aliases to linked Git metadata', async t => {
  const f = await fixture(t)
  const linkedRoot = join(f.base, 'linked-alias')
  await git(f.repositoryRoot, 'worktree', 'add', '-b', 'verification-linked-alias', linkedRoot)
  f.hooks.policyRoot = f.base
  const linkedAgent = {
    id: 'fu_he-linked-alias',
    session: { header: { cwd: linkedRoot } }
  }
  const commonDirectory = await realpath(resolve(
    linkedRoot,
    await gitText(linkedRoot, 'rev-parse', '--git-common-dir')
  ))
  const protectedFile = join(commonDirectory, 'config')
  const before = await readFile(protectedFile)
  const alias = join(linkedRoot, 'var', 'tmp', 'config-alias')
  await mkdir(join(linkedRoot, 'var', 'tmp'), { recursive: true })
  await link(protectedFile, alias)

  const error = await rejectsCode(
    f.port.prepare(
      linkedAgent,
      {
        repositoryRoot: linkedRoot,
        attemptId: 'attempt-linked-alias'
      },
      new AbortController().signal
    ),
    'VERIFICATION_OUTPUT_ALIAS_REJECTED'
  )

  assert.equal(error.uncertain, true)
  assert.deepEqual(await readFile(protectedFile), before)
  assert.equal((await lstat(alias)).nlink, 2)
})

test('verification outputs: rejects a pre-existing hardlink alias to source', async t => {
  const f = await fixture(t)
  const source = join(f.repositoryRoot, 'src', 'tracked.txt')
  const sourceBefore = await readFile(source)
  const alias = join(f.repositoryRoot, 'var', 'tmp', 'source-alias.txt')
  await mkdir(join(f.repositoryRoot, 'var', 'tmp'), { recursive: true })
  await link(source, alias)

  const error = await rejectsCode(
    f.port.prepare(f.agent, f.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_ALIAS_REJECTED'
  )

  assert.equal(error.uncertain, true)
  assert.deepEqual(await readFile(source), sourceBefore)
  assert.equal((await lstat(alias)).nlink, 2)
})

test('verification outputs: rejects a pre-existing hardlink alias to an old report', async t => {
  const f = await fixture(t)
  const oldReport = join(f.repositoryRoot, 'var', 'reports', 'swarm', 'old-report', 'result.txt')
  const alias = join(f.repositoryRoot, 'var', 'tmp', 'old-report-alias.txt')
  await mkdir(join(f.repositoryRoot, 'var', 'reports', 'swarm', 'old-report'), { recursive: true })
  await mkdir(join(f.repositoryRoot, 'var', 'tmp'), { recursive: true })
  await writeFile(oldReport, 'old-report\n')
  const oldReportBefore = await readFile(oldReport)
  await link(oldReport, alias)

  const error = await rejectsCode(
    f.port.prepare(f.agent, f.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_ALIAS_REJECTED'
  )

  assert.equal(error.uncertain, true)
  assert.deepEqual(await readFile(oldReport), oldReportBefore)
  assert.equal((await lstat(alias)).nlink, 2)
})

test('verification outputs: reject-all policy also rejects a hardlink contained within tmp', async t => {
  const f = await fixture(t)
  const original = join(f.repositoryRoot, 'var', 'tmp', 'same-tmp.txt')
  const alias = join(f.repositoryRoot, 'var', 'tmp', 'same-tmp-alias.txt')
  await mkdir(join(f.repositoryRoot, 'var', 'tmp'), { recursive: true })
  await writeFile(original, 'same-tmp\n')
  await link(original, alias)

  await rejectsCode(
    f.port.prepare(f.agent, f.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_ALIAS_REJECTED'
  )

  assert.equal(await readFile(original, 'utf8'), 'same-tmp\n')
  assert.equal((await lstat(original)).nlink, 2)
  assert.equal((await lstat(alias)).nlink, 2)
})

test('verification outputs: check phase rejects a source alias added after preparation', async t => {
  const f = await fixture(t)
  const source = join(f.repositoryRoot, 'src', 'tracked.txt')
  const sourceBefore = await readFile(source)
  const alias = join(f.repositoryRoot, 'var', 'tmp', 'late-source-alias.txt')
  let added = false
  f.hooks.afterDone = async (_spec, outcome) => {
    if (outcome.exitCode !== 0 || added) return
    added = true
    await link(source, alias)
  }

  const error = await rejectsCode(
    f.port.prepare(f.agent, f.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_ALIAS_REJECTED'
  )

  assert.equal(error.uncertain, true)
  assert.equal(added, true)
  assert.deepEqual(await readFile(source), sourceBefore)
  assert.equal((await lstat(alias)).nlink, 2)
})

test('verification outputs: cancellation and Host policy drift fail closed', async t => {
  const cancelledFixture = await fixture(t)
  const controller = new AbortController()
  cancelledFixture.hooks.beforeConfine = () => controller.abort()
  await rejectsCode(
    cancelledFixture.port.prepare(cancelledFixture.agent, cancelledFixture.request(), controller.signal),
    'VERIFICATION_OUTPUT_CANCELLED'
  )
  assert.equal(cancelledFixture.commands.length, 0)
  await assert.rejects(access(join(cancelledFixture.repositoryRoot, 'var')), error => error.code === 'ENOENT')

  const denied = await fixture(t)
  denied.hooks.mode = 'read-only'
  await rejectsCode(
    denied.port.prepare(denied.agent, denied.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_POLICY_DENIED'
  )
  assert.equal(denied.sandboxCalls.length, 0)

  const partial = await fixture(t)
  partial.hooks.enforcement = 'partial'
  await rejectsCode(
    partial.port.prepare(partial.agent, partial.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_POLICY_DENIED'
  )
  assert.equal(partial.commands.length, 0)

  const drift = await fixture(t)
  drift.hooks.afterDone = (_spec, outcome) => {
    if (outcome.exitCode === 0) drift.hooks.mode = 'read-only'
  }
  const driftError = await rejectsCode(
    drift.port.prepare(drift.agent, drift.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_POLICY_CHANGED'
  )
  assert.equal(driftError.uncertain, true)
})

test('verification outputs: a second identity pass detects report replacement', async t => {
  const f = await fixture(t)
  const reportRoot = join(
    f.repositoryRoot,
    'var',
    'reports',
    'swarm',
    attemptKey(f.agent.id, 'attempt-verify-1')
  )
  f.hooks.afterDone = async (_spec, outcome) => {
    if (outcome.exitCode !== 0) return
    try {
      await access(reportRoot)
    } catch {
      return
    }
    await rename(reportRoot, `${reportRoot}-replaced`)
    await mkdir(reportRoot, { recursive: false })
  }

  const identityError = await rejectsCode(
    f.port.prepare(f.agent, f.request(), new AbortController().signal),
    'VERIFICATION_OUTPUT_IDENTITY_REJECTED'
  )
  assert.equal(identityError.uncertain, true)
})
