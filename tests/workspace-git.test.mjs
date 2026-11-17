import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { createExecutionBoundary, EXECUTION_BOUNDARY_CAPS } from '../lib/adapters/dsh-host/execution-boundary.js'
import { createWorkspaceGitPort, WorkspaceGitError } from '../lib/adapters/dsh-host/workspace-git.js'

const exec = promisify(execFile)
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
const git = async (cwd, ...args) => (await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', ...args], {
  cwd,
  env: GIT_ENV,
  maxBuffer: 1024 * 1024
})).stdout.trimEnd()
const gitBytes = async (cwd, ...args) => (await exec('git', args, { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout

const inside = (root, target) => {
  const value = relative(root, target)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

const childFixture = (stdout = '', stderr = '', exitCode = 0) => ({
  done: Promise.resolve({ exitCode }),
  collected: {
    stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
    stderr: { readFrom: () => ({ text: stderr, lossy: false }) }
  },
  terminate: () => {},
  waitForExit: async () => true
})

const fixture = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-workspace-git-'))
  const repositoryRoot = join(directory, 'repo')
  await mkdir(join(repositoryRoot, 'src'), { recursive: true })
  await git(repositoryRoot, 'init', '-b', 'main')
  await git(repositoryRoot, 'config', 'user.name', 'Fixture')
  await git(repositoryRoot, 'config', 'user.email', 'fixture@localhost')
  await writeFile(join(repositoryRoot, 'src', 'a.txt'), 'base-a\n')
  await writeFile(join(repositoryRoot, 'src', 'b.txt'), 'base-b\n')
  await writeFile(join(repositoryRoot, 'outside.txt'), 'base-outside\n')
  await git(repositoryRoot, 'add', '.')
  await git(repositoryRoot, 'commit', '-m', 'baseline')
  const previousHead = await git(repositoryRoot, 'rev-parse', 'HEAD')

  const hooks = { mode: 'workspace-write', allowedRoot: repositoryRoot, cwd: repositoryRoot, fake: undefined, afterDone: undefined, beforeSpawn: undefined }
  const commands = []
  const sessions = new Map()
  const agent = { id: 'worker-1', session: { header: { cwd: repositoryRoot } } }
  sessions.set(agent.session, repositoryRoot)

  const fsPort = {
    resolve: async target => ({ targetKey: await realpath(target), displayPath: target }),
    processPath: target => target.targetKey,
    processPathFromHostPath: path => path,
    contains: (root, target) => inside(root.targetKey, target.targetKey),
    lstat: async path => {
      try {
        const stat = await lstat(path)
        return { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', version: `${stat.ino}:${stat.mtimeMs}` }
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    }
  }
  const sandboxPolicy = { resolve: () => ({ mode: hooks.mode, workspaceRoot: hooks.allowedRoot }) }
  const workingDirectory = {
    get: session => hooks.cwd ?? sessions.get(session),
    set: async (targetAgent, path) => {
      sessions.set(targetAgent.session, await realpath(path))
      return sessions.get(targetAgent.session)
    }
  }
  const subprocess = {
    resolveExecutable: async name => name === 'node' ? process.execPath : name,
    spawn: spec => {
      commands.push({ argv: [...spec.argv], env: { ...spec.env } })
      hooks.beforeSpawn?.(spec, commands.at(-1))
      const fake = hooks.fake?.(spec)
      if (fake !== undefined) return fake
      const env = { ...process.env, ...spec.env }
      for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
      const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, signal: spec.signal, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = '', stderr = ''
      child.stdout.on('data', bytes => { stdout += bytes })
      child.stderr.on('data', bytes => { stderr += bytes })
      const originalDone = new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', exitCode => resolve({ exitCode }))
      })
      const done = originalDone.then(async outcome => {
        await hooks.afterDone?.(spec, outcome, stdout, stderr)
        return outcome
      })
      return {
        done,
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) }
        },
        terminate: () => { if (child.exitCode === null) child.kill('SIGTERM') },
        waitForExit: async () => { await done; return true }
      }
    }
  }
  const ctx = {
    get: name => ({
      agents: { get: id => id === agent.id ? agent : undefined },
      fs: fsPort,
      sandboxPolicy,
      workingDirectory,
      subprocess
    })[name]
  }
  const attemptId = 'attempt-1'
  let current = true
  const boundary = createExecutionBoundary(ctx, () => {})
  boundary.begin(agent.id, attemptId)
  const previousCaps = globalThis[EXECUTION_BOUNDARY_CAPS]
  globalThis[EXECUTION_BOUNDARY_CAPS] = new Set(['subprocess-local/rc3', 'fs-local/rc3', 'working-directory/rc3'])
  t.after(async () => {
    globalThis[EXECUTION_BOUNDARY_CAPS] = previousCaps
    await rm(directory, { recursive: true, force: true })
  })

  const port = createWorkspaceGitPort(ctx)
  const input = (override = {}) => ({
    repositoryRoot,
    path: repositoryRoot,
    branch: 'main',
    expectedHead: previousHead,
    paths: ['src/a.txt'],
    message: 'wip: controlled save',
    writeScopes: [join(repositoryRoot, 'src')],
    ...override
  })
  const save = async (override = {}, controller = new AbortController(), beforeSave) => {
    const policy = {
      agentId: agent.id,
      attemptId,
      mode: 'host-worktree',
      operation: 'host',
      cwd: repositoryRoot,
      repositoryRoot,
      writeScopes: [],
      assertCurrent: () => {
        if (!current) throw new Error('worker authorization revoked')
      }
    }
    return boundary.run(policy, () => {
      beforeSave?.()
      return port.save(agent, input(override), controller.signal)
    })
  }
  const commitPaths = async (from, to) => (await git(repositoryRoot, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', from, to))
    .split('\0').filter(Boolean).sort()
  const stagedPaths = async () => (await git(repositoryRoot, 'diff', '--cached', '--name-only', '-z')).split('\0').filter(Boolean).sort()
  const stageEntry = async path => git(repositoryRoot, 'ls-files', '--stage', '--', path)
  const snapshot = async () => ({
    head: await git(repositoryRoot, 'rev-parse', 'HEAD'),
    branch: await git(repositoryRoot, 'symbolic-ref', 'HEAD'),
    staged: await stagedPaths(),
    index: await gitBytes(repositoryRoot, 'ls-files', '--stage', '-z'),
    a: await readFile(join(repositoryRoot, 'src', 'a.txt'), 'utf8'),
    outside: await readFile(join(repositoryRoot, 'outside.txt'), 'utf8')
  })

  return {
    directory, repositoryRoot, agent, port, input, save, previousHead, hooks, commands,
    commitPaths, stagedPaths, stageEntry, snapshot,
    revoke: () => { current = false }
  }
}

test('workspace git: commits exact selected files while preserving unrelated staged changes', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repositoryRoot, 'outside.txt'), 'staged outside\n')
  await writeFile(join(f.repositoryRoot, 'outside-new.txt'), 'staged new outside\n')
  await git(f.repositoryRoot, 'add', 'outside.txt')
  await git(f.repositoryRoot, 'add', 'outside-new.txt')
  const outsideBefore = await f.stageEntry('outside.txt')
  const outsideNewBefore = await f.stageEntry('outside-new.txt')
  await writeFile(join(f.repositoryRoot, 'src', 'a.txt'), 'changed-a\n')
  await writeFile(join(f.repositoryRoot, 'src', 'new.txt'), 'new-file\n')

  const result = await f.save({ paths: ['src/new.txt', 'src/a.txt'] })

  assert.equal(result.previousHead, f.previousHead)
  assert.notEqual(result.head, f.previousHead)
  assert.deepEqual(result.paths, ['src/a.txt', 'src/new.txt'])
  assert.deepEqual(await f.commitPaths(result.previousHead, result.head), ['src/a.txt', 'src/new.txt'])
  assert.equal(await git(f.repositoryRoot, 'show', `${result.head}:outside.txt`), 'base-outside')
  assert.equal(await f.stageEntry('outside.txt'), outsideBefore)
  assert.equal(await f.stageEntry('outside-new.txt'), outsideNewBefore)
  assert.deepEqual(await f.stagedPaths(), ['outside-new.txt', 'outside.txt'])
  assert.equal((await git(f.repositoryRoot, 'ls-tree', '-r', '--name-only', result.head)).split('\n').includes('outside-new.txt'), false)
  assert.equal(await readFile(join(f.repositoryRoot, 'outside.txt'), 'utf8'), 'staged outside\n')

  assert.ok(f.commands.some(({ argv, env }) => argv.includes('add') && env.GIT_LITERAL_PATHSPECS === '1'))
  assert.ok(f.commands.some(({ argv }) => argv.includes('commit') && argv.includes('--only') && argv.includes('--no-verify')))
  assert.ok(f.commands.every(({ argv }) => !argv.some(value => ['reset', 'clean', 'checkout'].includes(value))))
})

test('workspace git: disables hooks, signing, fsmonitor and external diff from project config', async t => {
  const f = await fixture(t)
  const marker = join(f.directory, 'executed')
  const script = async name => {
    const path = join(f.directory, name)
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\ncat >/dev/null 2>&1 || true\n`)
    await chmod(path, 0o755)
    return path
  }
  const hookDirectory = join(f.repositoryRoot, '.git-hooks')
  await mkdir(hookDirectory)
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
    const path = join(hookDirectory, name)
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\n`)
    await chmod(path, 0o755)
  }
  await git(f.repositoryRoot, 'config', 'core.hooksPath', '.git-hooks')
  await git(f.repositoryRoot, 'config', 'core.fsmonitor', await script('fsmonitor.sh'))
  await git(f.repositoryRoot, 'config', 'diff.external', await script('external-diff.sh'))
  await git(f.repositoryRoot, 'config', 'commit.verbose', 'true')
  await git(f.repositoryRoot, 'config', 'commit.gpgSign', 'true')
  await writeFile(join(f.repositoryRoot, 'src', 'a.txt'), 'safe controlled save\n')

  await f.save({ message: 'wip: no unsafe project commands' })

  await assert.rejects(access(marker), error => error.code === 'ENOENT')
  assert.ok(f.commands.every(({ argv }) => argv.every(value => !value.includes(marker))))
})

test('workspace git: refuses project filters before staging and never runs their command', async t => {
  const f = await fixture(t)
  const marker = join(f.directory, 'filter-ran')
  const filter = join(f.directory, 'filter.sh')
  await writeFile(filter, `#!/bin/sh\nprintf ran > '${marker}'\ncat\n`)
  await chmod(filter, 0o755)
  await git(f.repositoryRoot, 'config', 'filter.evil.clean', filter)
  await writeFile(join(f.repositoryRoot, '.gitattributes'), 'src/filtered.txt filter=evil\n')
  await writeFile(join(f.repositoryRoot, 'src', 'filtered.txt'), 'untrusted\n')
  const before = await f.snapshot()

  await assert.rejects(f.save({ paths: ['src/filtered.txt'] }), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_FILTER_DENIED')
    assert.equal(error.uncertain, false)
    return true
  })

  await assert.rejects(access(marker), error => error.code === 'ENOENT')
  assert.deepEqual(await f.snapshot(), before)
  assert.equal(f.commands.some(({ argv }) => argv.includes('add')), false)
})

test('workspace git: rejects scope escapes, absolute or sensitive paths, directories and symlinks', async t => {
  const f = await fixture(t)
  const outside = join(f.directory, 'outside-secret')
  await writeFile(outside, 'outside\n')
  await symlink(outside, join(f.repositoryRoot, 'src', 'link.txt'))
  await writeFile(join(f.repositoryRoot, '.env'), 'TOKEN=not-a-real-token\n')
  const before = await f.snapshot()

  const cases = [
    [{ paths: ['../escape.txt'] }, 'WORKSPACE_GIT_PATH_REJECTED'],
    [{ paths: [join(f.repositoryRoot, 'src', 'a.txt')] }, 'WORKSPACE_GIT_PATH_REJECTED'],
    [{ paths: ['.git/config'] }, 'WORKSPACE_GIT_PATH_REJECTED'],
    [{ paths: ['.env'] }, 'WORKSPACE_GIT_PATH_REJECTED'],
    [{ paths: ['src'] }, 'WORKSPACE_GIT_PATH_REJECTED'],
    [{ paths: ['src/link.txt'] }, 'WORKSPACE_GIT_PATH_REJECTED'],
    [{ paths: ['outside.txt'], writeScopes: [join(f.repositoryRoot, 'src')] }, 'WORKSPACE_GIT_PATH_REJECTED']
  ]
  for (const [override, code] of cases) {
    await assert.rejects(f.save(override), error => {
      assert.ok(error instanceof WorkspaceGitError)
      assert.equal(error.code, code)
      assert.equal(error.uncertain, false)
      return true
    })
  }
  assert.deepEqual(await f.snapshot(), before)
})

test('workspace git: requires active host-worktree scope, writable Host policy and matching CWD', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repositoryRoot, 'src', 'a.txt'), 'not committed without boundary\n')
  const direct = await lstat(f.repositoryRoot)
  assert.equal(direct.isDirectory(), true)

  await assert.rejects(f.port.save(f.agent, f.input(), new AbortController().signal), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_BOUNDARY_REQUIRED')
    assert.equal(error.uncertain, false)
    return true
  })

  f.hooks.mode = 'read-only'
  await assert.rejects(f.save(), error => error.code === 'WORKSPACE_GIT_POLICY_DENIED')
  f.hooks.mode = 'workspace-write'

  f.hooks.cwd = join(f.directory, 'other')
  await assert.rejects(f.save(), error => error.code === 'WORKSPACE_GIT_STATE_REJECTED')
  f.hooks.cwd = f.repositoryRoot

  await assert.rejects(f.save({}, new AbortController(), () => f.revoke()), error => error.code === 'WORKSPACE_GIT_POLICY_DENIED')
  assert.equal(await git(f.repositoryRoot, 'rev-parse', 'HEAD'), f.previousHead)
})

test('workspace git: rejects wrong branch, expected HEAD and multiple worktree registrations', async t => {
  const f = await fixture(t)
  const before = await f.snapshot()
  await assert.rejects(f.save({ branch: 'other' }), error => error.code === 'WORKSPACE_GIT_STATE_REJECTED')
  await assert.rejects(f.save({ expectedHead: '0'.repeat(40) }), error => error.code === 'WORKSPACE_GIT_STATE_REJECTED')
  f.hooks.fake = spec => spec.argv.includes('worktree') && spec.argv.includes('list')
    ? childFixture(`worktree ${f.repositoryRoot}\0HEAD ${f.previousHead}\0branch refs/heads/main\0\0worktree ${f.directory}/second\0HEAD ${f.previousHead}\0branch refs/heads/main\0\0`)
    : undefined
  await assert.rejects(f.save(), error => error.code === 'WORKSPACE_GIT_STATE_REJECTED')
  assert.deepEqual(await f.snapshot(), before)
})

test('workspace git: abort and partial failures remain uncertain without resending commit', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repositoryRoot, 'src', 'a.txt'), 'commit may be visible\n')
  const controller = new AbortController()
  f.hooks.afterDone = (spec, outcome) => {
    if (outcome.exitCode === 0 && spec.argv.includes('commit')) controller.abort()
  }

  await assert.rejects(f.save({}, controller), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_UNCERTAIN')
    assert.equal(error.uncertain, true)
    assert.equal(error.operation, 'commit')
    assert.equal(error.previousHead, f.previousHead)
    return true
  })
  assert.equal(f.commands.filter(({ argv }) => argv.includes('commit')).length, 1)

  const staged = await fixture(t)
  await writeFile(join(staged.repositoryRoot, 'src', 'a.txt'), 'staged before cancellation\n')
  const addController = new AbortController()
  staged.hooks.afterDone = (spec, outcome) => {
    if (outcome.exitCode === 0 && spec.argv.includes('add')) addController.abort()
  }
  await assert.rejects(staged.save({}, addController), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_UNCERTAIN')
    assert.equal(error.uncertain, true)
    assert.equal(error.operation, 'add')
    return true
  })
  assert.equal(staged.commands.some(({ argv }) => argv.includes('commit')), false)
  assert.deepEqual(await staged.stagedPaths(), ['src/a.txt'])

  const failed = await fixture(t)
  await writeFile(join(failed.repositoryRoot, 'src', 'a.txt'), 'commit failed\n')
  failed.hooks.fake = spec => spec.argv.includes('commit')
    ? childFixture('', 'injected commit failure', 1)
    : undefined
  await assert.rejects(failed.save(), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_UNCERTAIN')
    assert.equal(error.uncertain, true)
    assert.equal(error.operation, 'commit')
    return true
  })
  assert.equal(failed.commands.filter(({ argv }) => argv.includes('commit')).length, 1)
  assert.deepEqual(await failed.stagedPaths(), ['src/a.txt'])
})

test('workspace git: policy drift after staging preserves the index and stays uncertain', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repositoryRoot, 'src', 'a.txt'), 'staged before drift\n')
  f.hooks.afterDone = (spec, outcome) => {
    if (outcome.exitCode === 0 && spec.argv.includes('add')) f.hooks.mode = 'read-only'
  }

  await assert.rejects(f.save(), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_UNCERTAIN')
    assert.equal(error.uncertain, true)
    assert.equal(error.operation, 'add')
    return true
  })
  assert.equal(await git(f.repositoryRoot, 'rev-parse', 'HEAD'), f.previousHead)
  assert.deepEqual(await f.stagedPaths(), ['src/a.txt'])
  assert.equal(f.commands.some(({ argv }) => argv.includes('commit')), false)
})

test('workspace git: .git directory replacement after staging is uncertain and prevents commit', async t => {
  const f = await fixture(t)
  await writeFile(join(f.repositoryRoot, 'src', 'a.txt'), 'identity race\n')
  f.hooks.afterDone = async (spec, outcome) => {
    if (outcome.exitCode === 0 && spec.argv.includes('add')) await rename(join(f.repositoryRoot, '.git'), join(f.repositoryRoot, '.git-original'))
  }

  await assert.rejects(f.save(), error => {
    assert.ok(error instanceof WorkspaceGitError)
    assert.equal(error.code, 'WORKSPACE_GIT_UNCERTAIN')
    assert.equal(error.uncertain, true)
    assert.equal(error.operation, 'add')
    return true
  })
  assert.equal(f.commands.some(({ argv }) => argv.includes('commit')), false)
  assert.equal((await lstat(join(f.repositoryRoot, '.git-original'))).isDirectory(), true)
})
