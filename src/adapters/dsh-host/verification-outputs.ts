import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentLike, PluginContextLike } from '../../host-contract.js'

export type VerificationOutputErrorCode =
  | 'VERIFICATION_OUTPUT_INVALID'
  | 'VERIFICATION_OUTPUT_BOUNDARY_REQUIRED'
  | 'VERIFICATION_OUTPUT_POLICY_DENIED'
  | 'VERIFICATION_OUTPUT_POLICY_CHANGED'
  | 'VERIFICATION_OUTPUT_PATH_REJECTED'
  | 'VERIFICATION_OUTPUT_REPORT_EXISTS'
  | 'VERIFICATION_OUTPUT_IDENTITY_REJECTED'
  | 'VERIFICATION_OUTPUT_ALIAS_REJECTED'
  | 'VERIFICATION_OUTPUT_CANCELLED'
  | 'VERIFICATION_OUTPUT_FAILED'

export interface VerificationOutputRequest {
  repositoryRoot: string
  attemptId: string
}

export interface VerificationOutputDirectoryIdentity {
  path: string
  type: 'directory' | 'file'
  identity: string
}

export interface VerificationOutputResult {
  temporaryRoot: string
  reportRoot: string
  attemptKey: string
  directoryIdentity: {
    repositoryRoot: string
    temporaryRoot: string
    reportRoot: string
    reportParent: string
    gitEntryPath: string
    gitPath: string
    gitType: 'directory'
  }
  identities: {
    repositoryRoot: VerificationOutputDirectoryIdentity
    gitEntry: VerificationOutputDirectoryIdentity
    gitPath: VerificationOutputDirectoryIdentity
    temporaryRoot: VerificationOutputDirectoryIdentity
    reportParent: VerificationOutputDirectoryIdentity
    reportRoot: VerificationOutputDirectoryIdentity
  }
  writeScopes: readonly [string, string]
  protectedRoots: readonly [string, string]
  policyFingerprint: string
}

export interface VerificationOutputPort {
  prepare: (
    agent: AgentLike,
    request: VerificationOutputRequest,
    signal: AbortSignal
  ) => Promise<VerificationOutputResult>
}

interface VerificationOutputErrorOptions {
  cause?: unknown
  uncertain?: boolean
}

export class VerificationOutputError extends Error {
  readonly code: VerificationOutputErrorCode
  readonly uncertain: boolean

  constructor (
    code: VerificationOutputErrorCode,
    message: string,
    options: VerificationOutputErrorOptions = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'VerificationOutputError'
    this.code = code
    this.uncertain = options.uncertain === true
  }
}

interface Target {
  targetKey: string
  displayPath: string
}

interface FileSystemPort {
  resolve: (path: string, options?: { cwd?: string; signal?: AbortSignal }) => Promise<Target>
  processPath: (target: Target) => string
  processPathFromHostPath?: (path: string) => string | undefined
  lstat: (
    path: string,
    options?: { cwd?: string },
    signal?: AbortSignal
  ) => Promise<{ type: string; version: string } | undefined>
}

interface HostPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
  additionalWritableRoots?: readonly string[]
  sessionId?: string
}

interface NormalizedPolicy {
  mode: 'workspace-write'
  workspaceRoot: string
  additionalWritableRoots: readonly string[]
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
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
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

interface SandboxPort {
  confine: (
    argv: string[],
    policy: HostPolicy,
    signal: AbortSignal
  ) => Promise<{ argv: string[]; enforcement: string }>
}

interface FixedProgramOutput {
  ok: true
  temporaryRoot: string
  reportRoot: string
  reportParent: string
  gitEntryPath: string
  gitPath: string
  attemptKey: string
  identities: VerificationOutputResult['identities']
}

interface FixedProgramError {
  code?: string
  message?: string
  created?: boolean
}

const OUTPUT_KEY_PREFIX = 'dsh-agent-swarm/verification-output/v1\0'
const COMMAND_TIMEOUT_MS = 30_000
const REQUEST_KEYS = new Set(['repositoryRoot', 'attemptId'])
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const inside = (root: string, target: string): boolean => {
  const value = relative(root, target)
  return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

const clean = (value: string): string => value.replace(/\r?\n$/, '')

const cancelled = (error: unknown): boolean => error instanceof Error
  && (error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || /abort|cancel|timed?\s*out/i.test(error.message))

const validateRequest = (request: VerificationOutputRequest): void => {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', '复核输出参数无效')
  }
  const keys = Object.keys(request)
  if (keys.length !== REQUEST_KEYS.size || keys.some(key => !REQUEST_KEYS.has(key))) {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', '复核输出不接受模型提供的路径字段')
  }
  if (typeof request.repositoryRoot !== 'string'
    || !isAbsolute(request.repositoryRoot)
    || request.repositoryRoot.includes('\0')
    || CONTROL_CHARACTERS.test(request.repositoryRoot)) {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', 'repositoryRoot 必须是有效绝对路径')
  }
  if (typeof request.attemptId !== 'string'
    || request.attemptId === ''
    || Buffer.byteLength(request.attemptId, 'utf8') > 1024
    || CONTROL_CHARACTERS.test(request.attemptId)) {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', 'attemptId 无效')
  }
}

const getAttemptKey = (agentId: string, attemptId: string): string => createHash('sha256')
  .update(OUTPUT_KEY_PREFIX)
  .update(agentId)
  .update('\0')
  .update(attemptId)
  .digest('hex')
  .slice(0, 32)

const scrubEnvironment = (): Record<string, string | undefined> => {
  const env = Object.fromEntries(
    Object.keys(process.env)
      .filter(key => /^(?:NODE_|LD_|DYLD_|BASH_ENV$|ENV$|PYTHON|PERL5LIB$|RUBYLIB$)/i.test(key))
      .map(key => [key, undefined])
  )
  Object.assign(env, {
    DSH_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: undefined,
    NODE_PATH: undefined,
    LD_PRELOAD: undefined,
    LD_LIBRARY_PATH: undefined,
    DYLD_INSERT_LIBRARIES: undefined
  })
  return env
}

/**
 * 固定程序只创建 repo/var/tmp 和本次独占 report，并输出目录身份。
 * 路径完全由 repositoryRoot + opaque attemptKey 派生，不接收模型路径。
 */
const FIXED_PROGRAM = String.raw`
const fs = require('node:fs')
const path = require('node:path')

const fail = (code, message) => {
  const error = new Error(message)
  error.code = code
  throw error
}
const inside = (root, target) => {
  const rel = path.relative(root, target)
  return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}
const identify = (target, allowedTypes) => {
  const stat = fs.lstatSync(target, { bigint: true })
  if (stat.isSymbolicLink()) fail('PATH_REJECTED', '目录或 Git 入口是 symlink: ' + target)
  const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other'
  if (!allowedTypes.includes(type)) fail('PATH_REJECTED', '路径类型不符合要求: ' + target)
  const canonical = fs.realpathSync.native(target)
  if (canonical !== path.resolve(target)) fail('PATH_REJECTED', '路径不是真实规范路径: ' + target)
  return {
    path: canonical,
    type,
    identity: [stat.dev, stat.ino, stat.birthtimeNs].join(':')
  }
}
const ensureDirectory = target => {
  try {
    return identify(target, ['directory'])
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  try {
    fs.mkdirSync(target, { mode: 0o700, recursive: false })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  return identify(target, ['directory'])
}
const sameIdentity = (left, right) =>
  left && right && left.path === right.path && left.type === right.type && left.identity === right.identity
const SCAN_ENTRY_LIMIT = 250000
const assertOutputDirectoriesSafe = roots => {
  let entries = 0
  const walk = target => {
    if (++entries > SCAN_ENTRY_LIMIT) fail('ALIAS_REJECTED', '复核输出文件数超出安全检查容量')
    const stat = fs.lstatSync(target, { bigint: true })
    if (stat.isSymbolicLink()) fail('ALIAS_REJECTED', '复核输出目录包含 symlink: ' + target)
    if (stat.isFile()) {
      if (stat.nlink > 1n) fail('ALIAS_REJECTED', '复核输出目录包含硬链接: ' + target)
      return
    }
    if (!stat.isDirectory()) fail('ALIAS_REJECTED', '复核输出目录包含不支持的节点类型: ' + target)
    for (const name of fs.readdirSync(target)) walk(path.join(target, name))
  }
  for (const root of roots) walk(root)
}

const repositoryRoot = process.argv[1]
const attemptKey = process.argv[2]
const mode = process.argv[3]
const pinnedText = process.argv[4] || ''
let created = false

try {
  if (!path.isAbsolute(repositoryRoot)) fail('PATH_REJECTED', 'repositoryRoot 不是绝对路径')
  if (!/^[a-f0-9]{32}$/.test(attemptKey)) fail('PATH_REJECTED', 'attemptKey 非法')
  const repository = identify(repositoryRoot, ['directory'])
  const gitEntryPath = path.join(repositoryRoot, '.git')
  const gitEntry = identify(gitEntryPath, ['directory', 'file'])
  let gitPath = gitEntryPath
  let git = gitEntry
  if (gitEntry.type === 'file') {
    const content = fs.readFileSync(gitEntryPath)
    if (content.length === 0 || content.length > 4096 || content.includes(0)) {
      fail('PATH_REJECTED', '.git 文件内容无效')
    }
    const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(content.toString('utf8'))
    if (!match) fail('PATH_REJECTED', '.git 文件缺少有效 gitdir')
    gitPath = path.resolve(repositoryRoot, match[1])
    git = identify(gitPath, ['directory'])
  }
  const varRoot = path.join(repositoryRoot, 'var')
  const temporaryRoot = path.join(varRoot, 'tmp')
  const reportsRoot = path.join(varRoot, 'reports')
  const swarmRoot = path.join(reportsRoot, 'swarm')
  const reportRoot = path.join(swarmRoot, attemptKey)
  for (const target of [varRoot, temporaryRoot, reportsRoot, swarmRoot, reportRoot]) {
    if (!inside(repositoryRoot, target) || target.includes('\\')) {
      fail('PATH_REJECTED', '复核输出路径越界')
    }
  }
  const pinned = mode === 'check'
    ? JSON.parse(pinnedText)
    : undefined

  ensureDirectory(varRoot)
  ensureDirectory(temporaryRoot)
  ensureDirectory(reportsRoot)
  ensureDirectory(swarmRoot)

  if (mode === 'prepare') {
    assertOutputDirectoriesSafe([temporaryRoot])
    try {
      fs.lstatSync(reportRoot)
      fail('REPORT_EXISTS', '本次 attempt 的 report 已存在，拒绝覆盖')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      fs.mkdirSync(reportRoot, { mode: 0o700, recursive: false })
      created = true
    } catch (error) {
      if (error.code === 'EEXIST') fail('REPORT_EXISTS', '本次 attempt 的 report 已存在，拒绝覆盖')
      throw error
    }
  } else if (mode !== 'check') {
    fail('INVALID', '未知固定程序模式')
  }

  const identities = {
    repositoryRoot: repository,
    gitEntry,
    gitPath: git,
    temporaryRoot: identify(temporaryRoot, ['directory']),
    reportParent: identify(swarmRoot, ['directory']),
    reportRoot: identify(reportRoot, ['directory'])
  }
  if (mode === 'check') {
    for (const key of Object.keys(identities)) {
      if (!sameIdentity(identities[key], pinned && pinned[key])) {
        fail('IDENTITY_REJECTED', '复核输出目录身份在准备与检查之间改变: ' + key)
      }
    }
  }
  assertOutputDirectoriesSafe([temporaryRoot, reportRoot])
  process.stdout.write(JSON.stringify({
    ok: true,
    temporaryRoot,
    reportRoot,
    reportParent: swarmRoot,
    gitEntryPath,
    gitPath,
    attemptKey,
    identities
  }))
} catch (error) {
  process.stderr.write(JSON.stringify({
    code: error && error.code ? error.code : 'FAILED',
    message: error && error.message ? error.message : String(error),
    created
  }))
  process.exitCode = 1
}
`

const normalizePolicy = async (
  fs: FileSystemPort,
  policy: HostPolicy,
  signal: AbortSignal,
  allowDenied: boolean
): Promise<NormalizedPolicy | undefined> => {
  if (policy === null || typeof policy !== 'object'
    || !isAbsolute(policy.workspaceRoot)
    || policy.workspaceRoot.includes('\0')) {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_POLICY_DENIED', '宿主文件策略无效')
  }
  if (policy.mode !== 'workspace-write') {
    if (allowDenied) return undefined
    throw new VerificationOutputError('VERIFICATION_OUTPUT_POLICY_DENIED', '宿主未授予 workspace-write')
  }
  const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]
  const canonicalRoots = []
  for (const root of roots) {
    if (!isAbsolute(root) || root.includes('\0')) {
      throw new VerificationOutputError('VERIFICATION_OUTPUT_POLICY_DENIED', '宿主允许目录不是绝对路径')
    }
    const target = await fs.resolve(root, { signal })
    const actual = fs.processPath(target)
    if (actual !== resolve(root)) {
      throw new VerificationOutputError('VERIFICATION_OUTPUT_POLICY_DENIED', '宿主允许目录不是规范路径')
    }
    canonicalRoots.push(actual)
  }
  return {
    mode: 'workspace-write',
    workspaceRoot: canonicalRoots[0]!,
    additionalWritableRoots: [...new Set(canonicalRoots.slice(1))].sort(),
    ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId })
  }
}

const parseProgramError = (stderr: string): FixedProgramError => {
  try {
    return JSON.parse(clean(stderr)) as FixedProgramError
  } catch {
    return {}
  }
}

const mapProgramError = (
  error: FixedProgramError,
  uncertainByDefault: boolean
): VerificationOutputError => {
  const message = error.message ?? '固定复核输出程序失败'
  const uncertain = typeof error.created === 'boolean' ? error.created : uncertainByDefault
  switch (error.code) {
  case 'PATH_REJECTED':
    return new VerificationOutputError('VERIFICATION_OUTPUT_PATH_REJECTED', message, { uncertain })
  case 'REPORT_EXISTS':
    return new VerificationOutputError('VERIFICATION_OUTPUT_REPORT_EXISTS', message, { uncertain })
  case 'IDENTITY_REJECTED':
    return new VerificationOutputError('VERIFICATION_OUTPUT_IDENTITY_REJECTED', message, { uncertain })
  case 'ALIAS_REJECTED':
    return new VerificationOutputError('VERIFICATION_OUTPUT_ALIAS_REJECTED', message, { uncertain: true })
  default:
    return new VerificationOutputError('VERIFICATION_OUTPUT_FAILED', message, { uncertain })
  }
}

const validateProgramOutput = (
  value: unknown,
  expected: {
    repositoryRoot: string
    temporaryRoot: string
    reportRoot: string
    reportParent: string
    gitEntryPath: string
    attemptKey: string
  }
): FixedProgramOutput => {
  if (value === null || typeof value !== 'object') {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_FAILED', '固定程序未返回身份摘要')
  }
  const output = value as Partial<FixedProgramOutput>
  if (output.ok !== true
    || output.temporaryRoot !== expected.temporaryRoot
    || output.reportRoot !== expected.reportRoot
    || output.reportParent !== expected.reportParent
    || output.gitEntryPath !== expected.gitEntryPath
    || typeof output.gitPath !== 'string'
    || !isAbsolute(output.gitPath)
    || output.identities === undefined
    || output.identities.gitPath.path !== output.gitPath
    || output.attemptKey !== expected.attemptKey) {
    throw new VerificationOutputError('VERIFICATION_OUTPUT_FAILED', '固定程序返回了非预期路径')
  }
  return output as FixedProgramOutput
}

export const createVerificationOutputPort = (ctx: PluginContextLike): VerificationOutputPort => {
  const get = <T>(name: string): T | undefined => ctx.get(name) as T | undefined
  const warn = (message: string, details: Record<string, unknown>): void => {
    try {
      ctx.logger?.('verification-outputs')?.warn(message, details)
    } catch {
      // 日志故障不能替换安全结果。
    }
  }

  return {
    prepare: async (agent, request, signal) => {
      validateRequest(request)
      if (agent === null || typeof agent !== 'object'
        || typeof agent.id !== 'string'
        || agent.id === ''
        || CONTROL_CHARACTERS.test(agent.id)) {
        throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', 'Agent 身份无效')
      }
      if (agent.session === undefined) {
        throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', 'Agent session 缺失')
      }
      if (signal === null || typeof signal !== 'object'
        || typeof signal.throwIfAborted !== 'function') {
        throw new VerificationOutputError('VERIFICATION_OUTPUT_INVALID', '取消信号无效')
      }

      const fs = get<FileSystemPort>('fs')
      const subprocess = get<ProcessPort>('subprocess')
      const sandbox = get<SandboxPort>('sandbox')
      const policyPort = get<{
        resolve: (input: { session: unknown }) => HostPolicy
      }>('sandboxPolicy')
      if (fs === undefined
        || subprocess === undefined
        || sandbox === undefined
        || policyPort === undefined) {
        throw new VerificationOutputError(
          'VERIFICATION_OUTPUT_BOUNDARY_REQUIRED',
          '宿主缺少 fs、subprocess、sandbox 或 sandboxPolicy'
        )
      }

      const fail = (
        code: VerificationOutputErrorCode,
        message: string,
        options: VerificationOutputErrorOptions = {}
      ): never => {
        warn('复核输出准备拒绝或失败', {
          code,
          message,
          uncertain: options.uncertain === true
        })
        throw new VerificationOutputError(code, message, options)
      }

      let preparedOutput: FixedProgramOutput | undefined
      let mutationObserved = false
      try {
        signal.throwIfAborted()
        const resolvedRepository = await fs.resolve(request.repositoryRoot, { signal })
        const repositoryRoot = fs.processPath(resolvedRepository)
        if (repositoryRoot !== resolve(request.repositoryRoot)
          || fs.processPathFromHostPath?.(repositoryRoot) !== repositoryRoot) {
          return fail('VERIFICATION_OUTPUT_PATH_REJECTED', 'repositoryRoot 不是本机规范路径')
        }
        if ((await fs.lstat(repositoryRoot, undefined, signal))?.type !== 'directory') {
          return fail('VERIFICATION_OUTPUT_PATH_REJECTED', 'repositoryRoot 不是普通目录')
        }
        const gitEntryPath = join(repositoryRoot, '.git')
        const gitInfo = await fs.lstat(gitEntryPath, undefined, signal)
        if (gitInfo?.type !== 'directory' && gitInfo?.type !== 'file') {
          return fail('VERIFICATION_OUTPUT_PATH_REJECTED', '.git 缺失、是 symlink 或类型未知')
        }

        const resolvePolicy = async (
          changed: boolean
        ): Promise<NormalizedPolicy | undefined> => {
          let policy: HostPolicy
          try {
            policy = policyPort.resolve({ session: agent.session })
          } catch (error) {
            if (signal.aborted) {
              return fail('VERIFICATION_OUTPUT_CANCELLED', '复核输出准备已取消', { cause: error })
            }
            return fail('VERIFICATION_OUTPUT_POLICY_DENIED', '宿主文件策略无法核验', { cause: error })
          }
          const normalized = await normalizePolicy(fs, policy, signal, changed)
          if (changed && normalized === undefined) {
            return fail('VERIFICATION_OUTPUT_POLICY_CHANGED', '准备期间 Host 文件策略已改变')
          }
          return normalized
        }

        const policy = await resolvePolicy(false)
        if (policy === undefined) {
          return fail('VERIFICATION_OUTPUT_POLICY_DENIED', '宿主未授予 workspace-write')
        }
        const allowedRoots = [policy.workspaceRoot, ...policy.additionalWritableRoots]
        if (!allowedRoots.some(root => inside(root, repositoryRoot))) {
          return fail('VERIFICATION_OUTPUT_POLICY_DENIED', '项目不在 Host workspace-write 范围内')
        }
        const policyFingerprint = JSON.stringify(policy)
        const assertPolicyCurrent = async (): Promise<void> => {
          signal.throwIfAborted()
          const current = await resolvePolicy(true)
          if (current === undefined || JSON.stringify(current) !== policyFingerprint) {
            return fail('VERIFICATION_OUTPUT_POLICY_CHANGED', '准备期间 Host 文件策略已改变')
          }
        }

        const attemptKey = getAttemptKey(agent.id, request.attemptId)
        const temporaryRoot = join(repositoryRoot, 'var', 'tmp')
        const reportParent = join(repositoryRoot, 'var', 'reports', 'swarm')
        const reportRoot = join(reportParent, attemptKey)
        const expected = {
          repositoryRoot,
          temporaryRoot,
          reportRoot,
          reportParent,
          gitEntryPath,
          attemptKey
        }

        const runFixedProgram = async (
          mode: 'prepare' | 'check',
          pinned: FixedProgramOutput['identities'] | undefined
        ): Promise<FixedProgramOutput> => {
          signal.throwIfAborted()
          const bounded = AbortSignal.any([signal, AbortSignal.timeout(COMMAND_TIMEOUT_MS)])
          let program: string
          try {
            program = await subprocess.resolveExecutable('node', undefined, bounded)
          } catch (error) {
            if (signal.aborted || cancelled(error)) {
              return fail('VERIFICATION_OUTPUT_CANCELLED', '复核输出准备已取消', { cause: error })
            }
            return fail('VERIFICATION_OUTPUT_FAILED', 'Host 无法解析固定 node 程序', { cause: error })
          }
          bounded.throwIfAborted()
          const command = [
            program,
            '-e',
            FIXED_PROGRAM,
            repositoryRoot,
            attemptKey,
            mode,
            pinned === undefined ? '' : JSON.stringify(pinned)
          ]
          let wrapped: { argv: string[]; enforcement: string }
          try {
            wrapped = await sandbox.confine(command, {
              mode: mode === 'prepare' ? 'workspace-write' : 'read-only',
              workspaceRoot: policy.workspaceRoot,
              ...(policy.additionalWritableRoots.length === 0
                ? {}
                : { additionalWritableRoots: policy.additionalWritableRoots }),
              ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId })
            }, bounded)
          } catch (error) {
            if (signal.aborted || cancelled(error)) {
              return fail('VERIFICATION_OUTPUT_CANCELLED', '复核输出准备已取消', { cause: error })
            }
            return fail('VERIFICATION_OUTPUT_POLICY_DENIED', 'Host sandbox 无法建立执行边界', { cause: error })
          }
          if (wrapped.enforcement !== 'full') {
            return fail('VERIFICATION_OUTPUT_POLICY_DENIED', 'Host sandbox confine 不是 full')
          }
          bounded.throwIfAborted()
          await assertPolicyCurrent()

          const child = subprocess.spawn({
            argv: wrapped.argv,
            cwd: repositoryRoot,
            env: scrubEnvironment(),
            signal: bounded,
            graceMs: 1000,
            stdio: {
              stdin: 'ignore',
              stdout: { maxBytes: 128 * 1024 },
              stderr: { maxBytes: 16 * 1024 }
            }
          })
          try {
            let outcome: { exitCode: number | null }
            try {
              outcome = await child.done
            } catch (error) {
              if (signal.aborted || cancelled(error)) {
                return fail('VERIFICATION_OUTPUT_CANCELLED', '复核输出准备已取消', {
                  cause: error,
                  uncertain: mode === 'prepare'
                })
              }
              return fail('VERIFICATION_OUTPUT_FAILED', '固定复核输出程序执行失败', {
                cause: error,
                uncertain: mode === 'prepare'
              })
            }
            if (await child.waitForExit() !== true) {
              return fail('VERIFICATION_OUTPUT_FAILED', 'Host 未确认固定复核输出程序停净', {
                uncertain: mode === 'prepare'
              })
            }
            const stdout = child.collected.stdout.readFrom(0)
            const stderr = child.collected.stderr.readFrom(0)
            if (stdout.lossy || stderr.lossy) {
              return fail('VERIFICATION_OUTPUT_FAILED', '固定程序输出超出容量', {
                uncertain: mode === 'prepare'
              })
            }
            if (outcome.exitCode !== 0) {
              throw mapProgramError(parseProgramError(stderr.text), mode === 'prepare')
            }
            if (mode === 'prepare') mutationObserved = true
            bounded.throwIfAborted()
            await assertPolicyCurrent()
            let parsed: unknown
            try {
              parsed = JSON.parse(clean(stdout.text))
            } catch (error) {
              return fail('VERIFICATION_OUTPUT_FAILED', '固定程序输出不是 JSON', {
                cause: error,
                uncertain: mode === 'prepare'
              })
            }
            return validateProgramOutput(parsed, expected)
          } finally {
            child.terminate()
            await child.waitForExit()
          }
        }

        const prepared = await runFixedProgram('prepare', undefined)
        preparedOutput = prepared
        const checked = await runFixedProgram('check', prepared.identities)
        signal.throwIfAborted()
        await assertPolicyCurrent()
        return {
          temporaryRoot,
          reportRoot,
          attemptKey,
          directoryIdentity: {
            repositoryRoot: checked.identities.repositoryRoot.identity,
            temporaryRoot: checked.identities.temporaryRoot.identity,
            reportRoot: checked.identities.reportRoot.identity,
            reportParent: checked.identities.reportParent.identity,
            gitEntryPath: checked.gitEntryPath,
            gitPath: checked.gitPath,
            gitType: 'directory'
          },
          identities: checked.identities,
          writeScopes: Object.freeze([temporaryRoot, reportRoot]),
          protectedRoots: Object.freeze([repositoryRoot, checked.gitPath]),
          policyFingerprint
        }
      } catch (error) {
        if (error instanceof VerificationOutputError) {
          if ((mutationObserved || preparedOutput !== undefined) && !error.uncertain) {
            throw new VerificationOutputError(error.code, error.message, {
              cause: error,
              uncertain: true
            })
          }
          throw error
        }
        if (signal.aborted || cancelled(error)) {
          return fail('VERIFICATION_OUTPUT_CANCELLED', '复核输出准备已取消', {
            cause: error,
            uncertain: mutationObserved || preparedOutput !== undefined
          })
        }
        return fail('VERIFICATION_OUTPUT_FAILED', '复核输出准备失败', {
          cause: error,
          uncertain: mutationObserved || preparedOutput !== undefined
        })
      }
    }
  }
}
