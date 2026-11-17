import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { AgentLike, PluginContextLike } from '../../host-contract.js'
import { getExecutionBoundaryCarrier } from './execution-boundary.js'

export type WorkspaceGitMutationOperation = 'add' | 'commit'
export type WorkspaceGitErrorCode =
  | 'WORKSPACE_GIT_INVALID'
  | 'WORKSPACE_GIT_BOUNDARY_REQUIRED'
  | 'WORKSPACE_GIT_POLICY_DENIED'
  | 'WORKSPACE_GIT_STATE_REJECTED'
  | 'WORKSPACE_GIT_PATH_REJECTED'
  | 'WORKSPACE_GIT_FILTER_DENIED'
  | 'WORKSPACE_GIT_CANCELLED'
  | 'WORKSPACE_GIT_FAILED'
  | 'WORKSPACE_GIT_UNCERTAIN'

export interface WorkspaceGitSaveInput {
  repositoryRoot: string
  path: string
  branch: string
  expectedHead: string
  paths: readonly string[]
  message: string
  writeScopes: readonly string[]
}

export interface WorkspaceGitSaveResult {
  head: string
  previousHead: string
  paths: readonly string[]
}

export interface WorkspaceGitPort {
  save: (agent: AgentLike, input: WorkspaceGitSaveInput, signal: AbortSignal) => Promise<WorkspaceGitSaveResult>
}

interface WorkspaceGitErrorOptions {
  cause?: unknown
  uncertain?: boolean
  operation?: WorkspaceGitMutationOperation
  previousHead?: string
  head?: string
  paths?: readonly string[]
}

export class WorkspaceGitError extends Error {
  readonly code: WorkspaceGitErrorCode
  readonly uncertain: boolean
  readonly operation?: WorkspaceGitMutationOperation
  readonly previousHead?: string
  readonly head?: string
  readonly paths: readonly string[]

  constructor (code: WorkspaceGitErrorCode, message: string, options: WorkspaceGitErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'WorkspaceGitError'
    this.code = code
    this.uncertain = options.uncertain === true
    this.operation = options.operation
    this.previousHead = options.previousHead
    this.head = options.head
    this.paths = Object.freeze([...(options.paths ?? [])])
  }
}

interface ResolvedPath {
  targetKey: string
  displayPath: string
}

interface FileSystemPort {
  resolve: (path: string, options?: { cwd?: string; signal?: AbortSignal }) => Promise<ResolvedPath>
  processPath: (target: ResolvedPath) => string
  processPathFromHostPath?: (path: string) => string | undefined
  lstat: (path: string, options?: { cwd?: string }, signal?: AbortSignal) => Promise<{ type: string; version: string } | undefined>
}

interface HostPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
  sessionId?: string
}

interface ProcessPort {
  resolveExecutable: (name: string, path?: string, signal?: AbortSignal) => Promise<string>
  spawn: (input: {
    argv: string[]
    cwd: string
    env: Record<string, string | undefined>
    signal: AbortSignal
    graceMs: number
    stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
  }) => {
    done: Promise<{ exitCode: number | null }>
    collected: {
      stdout: { readFrom: (offset: number) => { text: string; lossy: boolean } }
      stderr: { readFrom: (offset: number) => { text: string; lossy: boolean } }
    }
    terminate: () => void
    waitForExit: () => Promise<unknown>
  }
}

interface BoundaryScope {
  agentId: string
  mode: string
  operation: string
  cwd: string
  repositoryRoot: string
  assertCurrent: () => void
}

interface BoundaryCarrier {
  storage: { getStore: () => BoundaryScope | undefined }
}

interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

interface Identity {
  path: string
  identity: string
}

const MAX_PATHS = 256
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_ARGUMENT_BYTES = 512 * 1024
const COMMAND_TIMEOUT_MS = 30_000
const IDENTITY_PROGRAM = `const fs=require('node:fs');const paths=process.argv.slice(1);console.log(JSON.stringify(paths.map(p=>{const s=fs.lstatSync(p,{bigint:true});const canonical=fs.realpathSync.native(p);if(s.isSymbolicLink()||canonical!==p||!s.isDirectory())throw Error('unsafe identity');return {path:canonical,identity:[s.dev,s.ino,s.birthtimeNs].join(':')}})))`
const UNSAFE_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.codex', '.dsh', '.direnv'])
const SAFE_ENV_EXAMPLES = /^\.env\.(?:example|sample|template)$/i
const SECRET_NAME = /^(?:(?:credentials|secrets|id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\..+)?|\.netrc|\.npmrc|\.pypirc|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i

const within = (root: string, target: string): boolean => {
  const value = relative(root, target)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

const clean = (value: string): string => value.replace(/\r?\n$/, '')
const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8')

const isSensitivePath = (path: string): boolean => {
  const segments = path.split('/').filter(Boolean)
  const name = segments.at(-1) ?? ''
  if (segments.some(segment => UNSAFE_SEGMENTS.has(segment.toLowerCase()))) return true
  if (/^\.envrc$/i.test(name)) return true
  if (/^\.env(?:\.|$)/i.test(name) && !SAFE_ENV_EXAMPLES.test(name)) return true
  return SECRET_NAME.test(name)
}

const validateInput = (input: WorkspaceGitSaveInput): void => {
  if (input === null || typeof input !== 'object') throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'Git 保存参数无效')
  if (!isAbsolute(input.repositoryRoot) || !isAbsolute(input.path)) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', '主仓库与工作树必须是绝对路径')
  if (/[\u0000-\u001f\u007f]/.test(input.repositoryRoot) || /[\u0000-\u001f\u007f]/.test(input.path)) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', '主仓库或工作树路径无效')
  if (typeof input.branch !== 'string' || input.branch === '' || input.branch.startsWith('-') || input.branch.startsWith('refs/heads/') || /[\u0000-\u001f\u007f]/.test(input.branch)) {
    throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'branch 必须是有效短分支名')
  }
  if (typeof input.expectedHead !== 'string' || !/^[a-f0-9]{40,64}$/i.test(input.expectedHead)) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'expectedHead 必须是完整提交哈希')
  if (typeof input.message !== 'string' || input.message.trim() === '' || input.message.includes('\0')) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', '提交说明不能为空且不能包含 NUL')
  if (byteLength(input.message) > MAX_MESSAGE_BYTES) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', '提交说明超出容量')
  if (!Array.isArray(input.paths) || input.paths.length === 0 || input.paths.length > MAX_PATHS) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'paths 必须是非空精确文件列表')
  if (new Set(input.paths).size !== input.paths.length) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'paths 不能重复')
  if (byteLength(input.paths.join('\0')) > MAX_ARGUMENT_BYTES) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', '精确文件列表超出容量')
  if (!Array.isArray(input.writeScopes) || input.writeScopes.length === 0) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'writeScopes 必须是非空绝对路径列表')
  if (input.writeScopes.some(scope => !isAbsolute(scope) || scope.includes('\0'))) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'writeScopes 必须全部是绝对路径')
}

const normalizeGitPath = (path: string): string => {
  if (typeof path !== 'string' || path === '' || path.length > 4096 || path.includes('\0') || path.includes('\\') || /[\u0001-\u001f\u007f]/.test(path)) {
    throw new WorkspaceGitError('WORKSPACE_GIT_PATH_REJECTED', '文件路径必须是仓库内相对 POSIX 路径')
  }
  if (isAbsolute(path) || path === '.' || path === '..' || path.startsWith('../') || path.includes('/../') || path.endsWith('/..') || path.includes('//')) {
    throw new WorkspaceGitError('WORKSPACE_GIT_PATH_REJECTED', '文件路径不能越出主工作树')
  }
  if (isSensitivePath(path)) throw new WorkspaceGitError('WORKSPACE_GIT_PATH_REJECTED', '拒绝保存 Git、凭据或秘密路径')
  return path
}

const parseStageEntries = (output: string): Map<string, string> => {
  const entries = new Map<string, string>()
  for (const record of output.split('\0')) {
    if (record === '') continue
    const separator = record.indexOf('\t')
    if (separator < 1) throw new WorkspaceGitError('WORKSPACE_GIT_FAILED', 'Git 索引返回了无法解析的记录')
    entries.set(record.slice(separator + 1), record.slice(0, separator))
  }
  return entries
}

const parseWorktrees = (output: string): Array<Record<string, string | true>> => {
  const records: Array<Record<string, string | true>> = []
  let current: Record<string, string | true> | undefined
  for (const field of output.split('\0')) {
    if (field === '') continue
    if (field.startsWith('worktree ')) {
      if (current !== undefined) records.push(current)
      current = { worktree: field.slice('worktree '.length) }
      continue
    }
    if (current === undefined) throw new WorkspaceGitError('WORKSPACE_GIT_STATE_REJECTED', 'Git 工作树列表格式无效')
    if (field.startsWith('HEAD ')) current.HEAD = field.slice(5)
    else if (field.startsWith('branch ')) current.branch = field.slice(7)
    else current[field.split(' ', 1)[0]!] = true
  }
  if (current !== undefined) records.push(current)
  return records
}

const scrubEnvironment = (): Record<string, string | undefined> => {
  const env = Object.fromEntries(Object.keys(process.env).filter(key => /^(?:GIT_|NODE_OPTIONS$|LD_PRELOAD$|LD_LIBRARY_PATH$)/i.test(key)).map(key => [key, undefined]))
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_EDITOR: 'true',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_TERMINAL_PROMPT: '0',
    NODE_OPTIONS: undefined,
    LD_PRELOAD: undefined,
    LD_LIBRARY_PATH: undefined
  })
  return env
}

const GIT_SAFETY_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  // 受控保存不能在命令返回后再派生后台 Git 维护写者。
  '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0',
  '-c', 'gc.autoDetach=false',
  '-c', 'commit.gpgSign=false',
  '-c', 'commit.verbose=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'gpg.program=/bin/false',
  '-c', 'diff.external=',
  '-c', 'diff.trustExitCode=false',
  '-c', 'color.ui=false',
  '-c', 'core.pager=cat',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'protocol.allow=never',
  '-c', 'submodule.recurse=false'
]

const gitArgv = (args: readonly string[]): string[] => ['git', '--no-pager', ...GIT_SAFETY_CONFIG, ...args]

const cancelled = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || /abort|cancel/i.test(error.message))

export const createWorkspaceGitPort = (ctx: PluginContextLike): WorkspaceGitPort => {
  const get = <T>(name: string): T | undefined => ctx.get(name) as T | undefined
  const warn = (message: string, details: Record<string, unknown>): void => {
    try {
      ctx.logger?.('workspace-git')?.warn(message, details)
    } catch {
      // 日志故障不能替换安全结果，也不能让已完成操作变成可重试。
    }
  }

  return {
    save: async (agent, input, signal) => {
      validateInput(input)
      if (agent === null || typeof agent !== 'object' || typeof agent.id !== 'string' || agent.id === '') throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'Agent 身份无效')
      if (agent.session === undefined) throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', 'Agent session 缺失')
      if (signal === null || typeof signal !== 'object' || typeof signal.throwIfAborted !== 'function') throw new WorkspaceGitError('WORKSPACE_GIT_INVALID', '取消信号无效')

      const fs = get<FileSystemPort>('fs')
      const subprocess = get<ProcessPort>('subprocess')
      const policyPort = get<{ resolve: (input: { session: unknown }) => HostPolicy }>('sandboxPolicy')
      const workingDirectory = get<{ get: (session: unknown) => string | undefined }>('workingDirectory')
      if (fs === undefined || subprocess === undefined || policyPort === undefined || workingDirectory === undefined) {
        throw new WorkspaceGitError('WORKSPACE_GIT_POLICY_DENIED', '宿主缺少受控 Git 保存所需的文件、进程、策略或 CWD 能力')
      }

      const previousHead = input.expectedHead.toLowerCase()
      const paths = Object.freeze(input.paths.map(normalizeGitPath).sort())
      const fail = (code: WorkspaceGitErrorCode, message: string, options: WorkspaceGitErrorOptions = {}): never => {
        warn('受控 Git 保存拒绝或失败', { code, message, pathCount: paths.length })
        throw new WorkspaceGitError(code, message, { previousHead, paths, ...options })
      }

      const scope = (getExecutionBoundaryCarrier() as unknown as BoundaryCarrier).storage.getStore()
      if (scope === undefined || scope.mode !== 'host-worktree' || scope.operation !== 'host' || scope.agentId !== agent.id
        || resolve(scope.cwd) !== resolve(input.path) || resolve(scope.repositoryRoot) !== resolve(input.repositoryRoot)) {
        throw new WorkspaceGitError('WORKSPACE_GIT_BOUNDARY_REQUIRED', '受控 Git 保存必须处于当前 Agent 的 host-worktree 执行边界', { previousHead, paths })
      }
      const boundary = scope

      const assertBoundary = (): void => {
        try {
          boundary.assertCurrent()
        } catch (error) {
          fail('WORKSPACE_GIT_POLICY_DENIED', 'Worker 或 attempt 授权已撤销，受控 Git 保存未继续', { cause: error })
        }
      }

      const resolveCanonical = async (path: string, label: string, currentSignal: AbortSignal = signal): Promise<string> => {
        try {
          const target = await fs.resolve(path, { signal: currentSignal })
          const actual = fs.processPath(target)
          if (actual !== resolve(path)) fail('WORKSPACE_GIT_STATE_REJECTED', `${label}不是真实规范路径`)
          return actual
        } catch (error) {
          if (error instanceof WorkspaceGitError) throw error
          if (signal.aborted) fail('WORKSPACE_GIT_CANCELLED', '受控 Git 保存已取消', { cause: error })
          return fail('WORKSPACE_GIT_STATE_REJECTED', `${label}无法规范核验`, { cause: error })
        }
      }

      const repositoryRoot = await resolveCanonical(input.repositoryRoot, '主仓库')
      const path = await resolveCanonical(input.path, '主工作树')
      if (repositoryRoot !== path) fail('WORKSPACE_GIT_STATE_REJECTED', 'v1 仅允许 repositoryRoot 与 path 相同的主工作树')
      if (fs.processPathFromHostPath?.(path) !== path) fail('WORKSPACE_GIT_POLICY_DENIED', '当前执行世界不是本机主工作树')

      const resolvePolicy = (): HostPolicy => {
        try {
          return policyPort.resolve({ session: agent.session })
        } catch (error) {
          return fail('WORKSPACE_GIT_POLICY_DENIED', '宿主文件策略无法核验', { cause: error })
        }
      }
      const policy = resolvePolicy()
      const policyFingerprint = JSON.stringify(policy)
      if (policy.mode === 'read-only') fail('WORKSPACE_GIT_POLICY_DENIED', '宿主文件策略为只读，不能保存 Git')

      const allowedRoots = await Promise.all([policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])].map(async root => {
        if (!isAbsolute(root)) fail('WORKSPACE_GIT_POLICY_DENIED', '宿主允许目录必须是绝对路径')
        return resolveCanonical(root, '宿主允许目录')
      }))
      if (!allowedRoots.some(root => within(root, repositoryRoot))) fail('WORKSPACE_GIT_POLICY_DENIED', '主工作树不在宿主允许写入目录内')

      const currentCwd = workingDirectory.get(agent.session)
      if (currentCwd === undefined || resolve(currentCwd) !== repositoryRoot) fail('WORKSPACE_GIT_STATE_REJECTED', '实际 CWD 不属于待保存的主工作树')

      const runProcess = async (executable: string, args: readonly string[], cwd: string, timeoutMs: number, ignoreSignal = false): Promise<CommandResult> => {
        const bounded = ignoreSignal ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        const program = await subprocess.resolveExecutable(executable, undefined, bounded)
        bounded.throwIfAborted()
        const child = subprocess.spawn({
          argv: [program, ...args],
          cwd,
          env: scrubEnvironment(),
          signal: bounded,
          graceMs: 1000,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 8 * 1024 * 1024 }, stderr: { maxBytes: 64 * 1024 } }
        })
        try {
          const outcome = await child.done
          if (await child.waitForExit() !== true) throw new Error('宿主未确认受控 Git 子进程停净')
          const stdout = child.collected.stdout.readFrom(0)
          const stderr = child.collected.stderr.readFrom(0)
          if (stdout.lossy || stderr.lossy) throw new Error('受控 Git 输出超出容量')
          bounded.throwIfAborted()
          return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text }
        } finally {
          child.terminate()
          await child.waitForExit()
        }
      }

      const runGit = (args: readonly string[], options: { timeoutMs?: number; ignoreSignal?: boolean } = {}): Promise<CommandResult> => {
        const argv = gitArgv(args)
        return runProcess(argv[0]!, argv.slice(1), repositoryRoot, options.timeoutMs ?? COMMAND_TIMEOUT_MS, options.ignoreSignal)
      }

      const requireGit = async (args: readonly string[], code: WorkspaceGitErrorCode, message: string): Promise<string> => {
        const result = await runGit(args)
        if (result.exitCode !== 0) fail(code, message)
        return clean(result.stdout)
      }

      const assertPolicyCurrent = (): void => {
        assertBoundary()
        if (JSON.stringify(resolvePolicy()) !== policyFingerprint) fail('WORKSPACE_GIT_POLICY_DENIED', '宿主文件策略在保存期间改变，受控 Git 保存未继续')
        if (resolve(workingDirectory.get(agent.session) ?? '') !== repositoryRoot) fail('WORKSPACE_GIT_STATE_REJECTED', '主工作树 CWD 在保存期间改变')
      }

      try {
        const branchCheck = await runGit(['check-ref-format', '--branch', input.branch])
        if (branchCheck.exitCode !== 0) fail('WORKSPACE_GIT_STATE_REJECTED', 'branch 不是有效分支名')

        const [topLevel, gitDirectoryText, commonDirectoryText, bare, insideWorktree, branchRef, head] = await Promise.all([
          requireGit(['rev-parse', '--show-toplevel'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验主仓库根目录'),
          requireGit(['rev-parse', '--path-format=absolute', '--absolute-git-dir'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验 .git 目录'),
          requireGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验 Git common 目录'),
          requireGit(['rev-parse', '--is-bare-repository'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验仓库类型'),
          requireGit(['rev-parse', '--is-inside-work-tree'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验工作树类型'),
          requireGit(['symbolic-ref', '--quiet', 'HEAD'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验当前分支'),
          requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验当前 HEAD')
        ])
        if (topLevel !== repositoryRoot || bare !== 'false' || insideWorktree !== 'true') fail('WORKSPACE_GIT_STATE_REJECTED', '目标不是唯一主工作树仓库')
        if (branchRef !== `refs/heads/${input.branch}`) fail('WORKSPACE_GIT_STATE_REJECTED', '当前分支与 expected branch 不一致')
        if (head.toLowerCase() !== previousHead) fail('WORKSPACE_GIT_STATE_REJECTED', '当前 HEAD 与 expectedHead 不一致')

        const gitDirectory = await resolveCanonical(gitDirectoryText, '.git 目录')
        const commonDirectory = await resolveCanonical(commonDirectoryText, 'Git common 目录')
        if (gitDirectory !== commonDirectory || gitDirectory !== resolve(repositoryRoot, '.git')) fail('WORKSPACE_GIT_STATE_REJECTED', '主仓库 .git 目录身份不一致')
        if ((await fs.lstat(gitDirectory, undefined, signal))?.type !== 'directory') fail('WORKSPACE_GIT_STATE_REJECTED', '.git 不是普通目录')

        const worktrees = parseWorktrees(await requireGit(['worktree', 'list', '--porcelain', '-z'], 'WORKSPACE_GIT_STATE_REJECTED', '无法核验 Git 工作树注册'))
        if (worktrees.length !== 1 || typeof worktrees[0]?.worktree !== 'string' || resolve(worktrees[0].worktree) !== repositoryRoot
          || worktrees[0].branch !== `refs/heads/${input.branch}` || worktrees[0].bare === true || worktrees[0].detached === true
          || worktrees[0].locked === true || worktrees[0].prunable === true) {
          fail('WORKSPACE_GIT_STATE_REJECTED', '仓库存在多个工作树、detached/bare/locked/prunable 状态，受控保存拒绝继续')
        }

        const scopePaths = await Promise.all(input.writeScopes.map(scopePath => resolveCanonical(scopePath, '任务 scope')))
        if (scopePaths.some(scopePath => !within(repositoryRoot, scopePath))) fail('WORKSPACE_GIT_PATH_REJECTED', '任务 scope 超出主工作树')

        for (const pathValue of paths) {
          const expectedAbsolute = resolve(repositoryRoot, pathValue)
          const actualAbsolute = await resolveCanonical(expectedAbsolute, '保存文件').catch(error => {
            if (error instanceof WorkspaceGitError && error.code === 'WORKSPACE_GIT_CANCELLED') throw error
            return fail('WORKSPACE_GIT_PATH_REJECTED', '保存文件不是真实规范文件', { cause: error })
          })
          if (actualAbsolute !== expectedAbsolute || !scopePaths.some(scopePath => within(scopePath, actualAbsolute))) {
            fail('WORKSPACE_GIT_PATH_REJECTED', '保存文件越出任务 scope 或不是真实规范文件')
          }
          const info = await fs.lstat(actualAbsolute, undefined, signal)
          if (info?.type !== 'file') fail('WORKSPACE_GIT_PATH_REJECTED', '仅允许保存既有普通文件，不支持目录、symlink 或删除')
        }

        const attributes = await runGit(['check-attr', '-z', '--all', '--', ...paths])
        if (attributes.exitCode !== 0) fail('WORKSPACE_GIT_FILTER_DENIED', '无法核验项目 Git attributes')
        const fields = attributes.stdout.split('\0')
        if (fields.at(-1) === '') fields.pop()
        if (fields.length % 3 !== 0) fail('WORKSPACE_GIT_FILTER_DENIED', '项目 Git attributes 输出无效')
        for (let index = 0; index < fields.length; index += 3) {
          const attribute = fields[index + 1], value = fields[index + 2]
          if (attribute === 'filter' && value !== 'unspecified' && value !== 'unset') {
            fail('WORKSPACE_GIT_FILTER_DENIED', '项目 filter 不在受控 Git 的已知安全集合内，拒绝执行')
          }
        }

        assertPolicyCurrent()
        signal.throwIfAborted()
        const indexBefore = parseStageEntries(await requireGit(['ls-files', '--stage', '-z'], 'WORKSPACE_GIT_STATE_REJECTED', '无法读取 Git 索引'))
        const selectedSet = new Set(paths)
        const identitiesBefore = await runProcess('node', ['-e', IDENTITY_PROGRAM, repositoryRoot, gitDirectory], repositoryRoot, COMMAND_TIMEOUT_MS)
        if (identitiesBefore.exitCode !== 0) fail('WORKSPACE_GIT_STATE_REJECTED', '主工作树或 .git 目录身份核验失败')
        const pinnedIdentities = JSON.parse(clean(identitiesBefore.stdout)) as Identity[]
        if (!Array.isArray(pinnedIdentities) || pinnedIdentities.length !== 2
          || pinnedIdentities[0]?.path !== repositoryRoot || pinnedIdentities[1]?.path !== gitDirectory) {
          fail('WORKSPACE_GIT_STATE_REJECTED', '主工作树或 .git 目录身份输出无效')
        }

        let operation: WorkspaceGitMutationOperation | undefined
        try {
          operation = 'add'
          const added = await runGit(['add', '--', ...paths])
          if (added.exitCode !== 0) fail('WORKSPACE_GIT_UNCERTAIN', 'Git add 失败，索引现场保留且结果不确定', { uncertain: true, operation })

          try {
            assertPolicyCurrent()
            signal.throwIfAborted()
            if (await requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'WORKSPACE_GIT_UNCERTAIN', 'Git add 后无法复核 HEAD') !== previousHead) {
              fail('WORKSPACE_GIT_UNCERTAIN', 'Git add 后 HEAD 已改变，拒绝继续提交', { uncertain: true, operation })
            }
            const identitiesAfterAdd = await runProcess('node', ['-e', IDENTITY_PROGRAM, repositoryRoot, gitDirectory], repositoryRoot, COMMAND_TIMEOUT_MS)
            if (identitiesAfterAdd.exitCode !== 0) fail('WORKSPACE_GIT_UNCERTAIN', 'Git add 后主工作树目录身份无法复核', { uncertain: true, operation })
            const afterIdentities = JSON.parse(clean(identitiesAfterAdd.stdout)) as Identity[]
            if (JSON.stringify(afterIdentities) !== JSON.stringify(pinnedIdentities)) fail('WORKSPACE_GIT_UNCERTAIN', 'Git add 后主工作树或 .git 目录身份改变', { uncertain: true, operation })

            const changedForCommit = (await requireGit(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', 'HEAD', '--', ...paths], 'WORKSPACE_GIT_UNCERTAIN', 'Git add 后无法核验待提交路径')).split('\0').filter(Boolean).sort()
            if (JSON.stringify(changedForCommit) !== JSON.stringify(paths)) {
              fail('WORKSPACE_GIT_UNCERTAIN', '已暂存路径与精确输入列表不一致，拒绝继续提交', { uncertain: true, operation })
            }
          } catch (error) {
            if (error instanceof WorkspaceGitError) {
              if (error.uncertain) throw error
              throw new WorkspaceGitError('WORKSPACE_GIT_UNCERTAIN', error.message, {
                cause: error, uncertain: true, operation, previousHead, paths
              })
            }
            throw new WorkspaceGitError('WORKSPACE_GIT_UNCERTAIN', 'Git add 后状态复核失败，索引现场保留', { cause: error, uncertain: true, operation, previousHead, paths })
          }

          operation = 'commit'
          assertPolicyCurrent()
          signal.throwIfAborted()
          const committed = await runGit(['commit', '--only', '--no-verify', '--no-gpg-sign', '--cleanup=verbatim', '-m', input.message, '--', ...paths], { timeoutMs: 60_000 })
          if (committed.exitCode !== 0) fail('WORKSPACE_GIT_UNCERTAIN', 'Git commit 失败，未自动重发且现场保留', { uncertain: true, operation })

          try {
            assertPolicyCurrent()
            signal.throwIfAborted()
            const nextHead = await requireGit(['rev-parse', '--verify', 'HEAD^{commit}'], 'WORKSPACE_GIT_UNCERTAIN', '提交后无法读取 HEAD')
            if (nextHead === previousHead) fail('WORKSPACE_GIT_UNCERTAIN', 'Git commit 成功但 HEAD 未推进', { uncertain: true, operation, head: nextHead })
            const committedPaths = (await requireGit(['diff-tree', '--no-ext-diff', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', previousHead, nextHead], 'WORKSPACE_GIT_UNCERTAIN', '提交后无法核验提交路径'))
              .split('\0').filter(Boolean).sort()
            if (JSON.stringify(committedPaths) !== JSON.stringify(paths)) {
              fail('WORKSPACE_GIT_UNCERTAIN', '提交内容包含范围外路径或缺少请求路径', { uncertain: true, operation, head: nextHead })
            }

            const indexAfter = parseStageEntries(await requireGit(['ls-files', '--stage', '-z'], 'WORKSPACE_GIT_UNCERTAIN', '提交后无法读取 Git 索引'))
            for (const [indexPath, entry] of indexBefore) {
              if (!selectedSet.has(indexPath) && indexAfter.get(indexPath) !== entry) {
                fail('WORKSPACE_GIT_UNCERTAIN', '范围外索引项在保存期间改变，拒绝宣称成功', { uncertain: true, operation, head: nextHead })
              }
            }
            const identitiesAfterCommit = await runProcess('node', ['-e', IDENTITY_PROGRAM, repositoryRoot, gitDirectory], repositoryRoot, COMMAND_TIMEOUT_MS)
            if (identitiesAfterCommit.exitCode !== 0) fail('WORKSPACE_GIT_UNCERTAIN', '提交后主工作树目录身份无法复核', { uncertain: true, operation, head: nextHead })
            const finalIdentities = JSON.parse(clean(identitiesAfterCommit.stdout)) as Identity[]
            if (JSON.stringify(finalIdentities) !== JSON.stringify(pinnedIdentities)) fail('WORKSPACE_GIT_UNCERTAIN', '提交后主工作树或 .git 目录身份改变', { uncertain: true, operation, head: nextHead })
            assertPolicyCurrent()
            signal.throwIfAborted()
            return { head: nextHead, previousHead, paths }
          } catch (error) {
            if (error instanceof WorkspaceGitError) {
              if (error.uncertain) throw error
              throw new WorkspaceGitError('WORKSPACE_GIT_UNCERTAIN', error.message, {
                cause: error, uncertain: true, operation, previousHead, paths
              })
            }
            throw new WorkspaceGitError('WORKSPACE_GIT_UNCERTAIN', 'Git commit 后状态复核失败，未自动重发', { cause: error, uncertain: true, operation, previousHead, paths })
          }
        } catch (error) {
          if (error instanceof WorkspaceGitError) {
            if (error.uncertain) {
              const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], { ignoreSignal: true })
                .then(result => result.exitCode === 0 ? clean(result.stdout) : undefined, () => undefined)
              warn('受控 Git 保存结果不确定', { operation: error.operation ?? operation, previousHead, observedHead: head ?? null, pathCount: paths.length })
              throw new WorkspaceGitError(error.code, error.message, {
                cause: error, uncertain: true, operation: error.operation ?? operation, previousHead, head: error.head ?? head, paths
              })
            }
            throw error
          }
          if (signal.aborted || cancelled(error)) {
            return fail('WORKSPACE_GIT_UNCERTAIN', '受控 Git 保存被取消，命令现场保留且不会自动重发', { cause: error, uncertain: true, operation, previousHead })
          }
          return fail('WORKSPACE_GIT_UNCERTAIN', '受控 Git 保存部分失败，命令现场保留且不会自动重发', { cause: error, uncertain: true, operation, previousHead })
        }
      } catch (error) {
        if (error instanceof WorkspaceGitError) throw error
        if (signal.aborted || cancelled(error)) return fail('WORKSPACE_GIT_CANCELLED', '受控 Git 保存已取消', { cause: error })
        return fail('WORKSPACE_GIT_FAILED', '受控 Git 保存预检失败', { cause: error })
      }
    }
  }
}
