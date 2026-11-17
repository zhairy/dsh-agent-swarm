import { AsyncLocalStorage } from 'node:async_hooks'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentLike, PluginContextLike } from '../../host-contract.js'

export const EXECUTION_BOUNDARY_KEY = Symbol.for('dsh-agent-swarm.execution-boundary.v1')
export const EXECUTION_BOUNDARY_CAPS = Symbol.for('dsh-agent-swarm.execution-boundary-capabilities.v1')
export const WRITER_EPOCH = (agentId: string, attemptId: string): string => JSON.stringify([agentId, attemptId])

export interface ExecutionBoundaryPolicy {
  taskId?: string
  agentId: string
  attemptId: string
  mode: 'write' | 'read-only' | 'host-worktree'
  operation: 'shell' | 'file' | 'host'
  cwd: string
  repositoryRoot: string
  writeScopes: readonly string[]
  /** 主仓库元数据始终只读；Git 保存使用独立的固定命令入口。 */
  protectedRoots?: readonly string[]
  expectedGitIdentity?: string
  expectedWritableIdentities?: readonly { path: string; identity: string }[]
  readOnlyIdentities?: readonly { path: string; identity: string }[]
  expectedDirectoryIdentity?: string
  assertCurrent: () => void
}
interface Identity { path: string; identity: string }
interface Epoch { active: number; unknown: boolean; sealed: boolean }
interface SpawnSpec { argv: readonly string[]; cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal; [key: string]: unknown }
interface ProcessHandle { done: Promise<unknown>; waitForExit: () => Promise<boolean> }
interface Scope extends ExecutionBoundaryPolicy {
  epoch: Epoch
  roots: readonly Identity[]
  protectedAnchors: readonly Identity[]
  readOnlyAnchors: readonly Identity[]
  anchor: Identity
  bwrap?: string
  launcher: string
  onSettled: (agentId: string) => void
}
interface Carrier {
  primaryProtectionVersion: 2
  version: 1
  storage: AsyncLocalStorage<Scope>
  epochs: Map<string, Epoch>
  prepareSpawn: (spec: SpawnSpec) => { spec: SpawnSpec; assertContainment: (mode: string) => void; started: (handle: ProcessHandle) => void } | undefined
  assertFilePath: (path: string) => void
  assertWorkingDirectory: (agent: AgentLike, current: string, exists?: boolean) => void
  assertTerminal: () => void
}

const within = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
const identity = (path: string): Identity => {
  const canonical = realpathSync.native(path), stat = lstatSync(path, { bigint: true })
  if (canonical !== resolve(path) || stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile())) throw new Error('工作树执行路径不是原物理路径')
  return { path: canonical, identity: [stat.dev, stat.ino, stat.birthtimeNs].join(':') }
}
const ALIAS_SCAN_ENTRY_LIMIT = 250_000
const inodeKey = (stat: NonNullable<ReturnType<typeof lstatSync>>): string => `${stat.dev}:${stat.ino}`

/**
 * 只读 bind 保护的是路径，无法阻断事先存在于 writable bind 中的同 inode alias。
 * verifier 输出域采用 reject-all：任何 hardlink/symlink 都不可信；主树仍只对
 * protected Git inode 求交，避免把普通源码硬链接误判成 Git 写入。
 */
export const assertWritableHardlinkBoundary = (
  writableRoots: readonly { path: string; identity: string }[],
  protectedRoots: readonly { path: string; identity: string }[],
  policy: 'protected-only' | 'reject-all' = 'protected-only'
): void => {
  if (writableRoots.length === 0 || policy === 'protected-only' && protectedRoots.length === 0) return
  const candidates = new Map<string, string>()
  let entries = 0
  const walkWritable = (target: string): void => {
    if (++entries > ALIAS_SCAN_ENTRY_LIMIT) throw new Error('任务写域文件数超出硬链接安全检查容量')
    const stat = lstatSync(target, { bigint: true })
    if (stat.isSymbolicLink()) {
      if (policy === 'reject-all') throw new Error(`verifier 输出目录包含 symlink: ${target}`)
      let resolved: string
      try { resolved = realpathSync.native(target) } catch { return }
      if (protectedRoots.some(root => within(root.path, resolved))) {
        throw new Error('任务写域存在指向受保护 Git 元数据的符号链接 alias')
      }
      return
    }
    if (stat.isFile()) {
      if (stat.nlink > 1n) {
        if (policy === 'reject-all') throw new Error(`verifier 输出目录包含硬链接: ${target}`)
        candidates.set(inodeKey(stat), target)
      }
      return
    }
    if (!stat.isDirectory()) {
      if (policy === 'reject-all') throw new Error(`verifier 输出目录包含不支持的节点类型: ${target}`)
      return
    }
    for (const name of readdirSync(target)) walkWritable(join(target, name))
  }
  for (const root of writableRoots) walkWritable(root.path)
  if (policy === 'reject-all') return
  if (candidates.size === 0) return

  const protectedInodes = new Set<string>()
  let protectedEntries = 0
  const walkProtected = (target: string): void => {
    if (++protectedEntries > ALIAS_SCAN_ENTRY_LIMIT) {
      throw new Error('Git 元数据文件数超出硬链接安全检查容量')
    }
    const stat = lstatSync(target, { bigint: true })
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      protectedInodes.add(inodeKey(stat))
      return
    }
    if (!stat.isDirectory()) return
    for (const name of readdirSync(target)) walkProtected(join(target, name))
  }
  for (const root of protectedRoots) walkProtected(root.path)
  for (const [key, path] of candidates) {
    if (protectedInodes.has(key)) throw new Error(`任务写域存在受保护 Git 元数据的硬链接 alias: ${path}`)
  }
}
const canonicalTarget = (path: string): string => {
  const tail: string[] = []
  let current = resolve(path)
  for (;;) {
    try { return join(realpathSync.native(current), ...tail) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(relative(parent, current)); current = parent
    }
  }
}
const assertScope = (scope: Scope): void => {
  scope.assertCurrent()
  if (scope.epoch.sealed || scope.epoch.unknown) throw new Error('旧执行范围已结束或停净状态未知')
  if (identity(scope.cwd).identity !== scope.anchor.identity) throw new Error('工作树 CWD 在实际执行前已改变')
  if (scope.protectedAnchors.some(root => identity(root.path).identity !== root.identity)) throw new Error('主仓库元数据目录在实际执行前已改变')
  if (scope.readOnlyAnchors.some(root => identity(root.path).identity !== root.identity)) throw new Error('复核的只读 Git 管理目录在实际执行前已改变')
}
const mountArguments = (scope: Scope): string[] => {
  if (process.platform !== 'linux' || scope.bwrap === undefined) throw new Error('当前宿主没有已验证的精确工作树执行隔离能力')
  // Private /run and network namespace prevent a child from asking host daemons
  // to perform filesystem writes outside this mount namespace.
  const args = [scope.bwrap, '--unshare-all', '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run']
  // The test workspace may itself live below /tmp. Re-mount the repository as
  // read-only before layering the exact task grants, never all of host /tmp.
  args.push('--ro-bind', scope.repositoryRoot, scope.repositoryRoot)
  // /tmp 会被替换为私有 tmpfs；linked Git 管理目录须显式只读重现，不能变成写域。
  for (const root of scope.readOnlyAnchors) args.push('--ro-bind', root.path, root.path)
  for (const root of scope.roots) args.push('--bind', root.path, root.path)
  for (const root of scope.protectedRoots ?? []) args.push('--ro-bind', root, root)
  return args
}

const createCarrier = (): Carrier => {
  const storage = new AsyncLocalStorage<Scope>(), epochs = new Map<string, Epoch>()
  return {
    primaryProtectionVersion: 2,
    version: 1, storage, epochs,
    prepareSpawn: spec => {
      const scope = storage.getStore()
      if (scope === undefined) return undefined
      assertScope(scope)
      spec.signal?.throwIfAborted()
      let next = spec
      if (scope.mode !== 'host-worktree') {
        if (scope.operation !== 'shell') throw new Error('文件操作未授权启动子进程')
        if (typeof spec.cwd !== 'string' || !isAbsolute(spec.cwd) || !within(scope.cwd, realpathSync.native(spec.cwd))) throw new Error('实际 Shell CWD 超出授权工作树，拒绝执行')
        for (const root of scope.roots) if (identity(root.path).identity !== root.identity) throw new Error('任务 scope 目录在执行前已改变')
        const protectedRoots = [...scope.protectedAnchors, ...scope.readOnlyAnchors]
        const hardlinkPolicy = scope.expectedWritableIdentities === undefined ? 'protected-only' : 'reject-all'
        assertWritableHardlinkBoundary(scope.roots, protectedRoots, hardlinkPolicy)
        const proof = { anchor: scope.anchor, roots: scope.roots, protectedRoots, hardlinkPolicy, cwd: realpathSync.native(spec.cwd), argv: spec.argv }
        const env = { ...(spec.env ?? {}), NODE_OPTIONS: undefined, LD_PRELOAD: undefined, LD_LIBRARY_PATH: undefined }
        next = { ...spec, cwd: scope.cwd, env, argv: [...mountArguments(scope), '--', process.execPath, scope.launcher, '--swarm-exec', JSON.stringify(proof)] }
      }
      // A missing/rejected handle remains unknown: spawn can fail after allocating
      // a process range. No absence of an in-memory job may erase this evidence.
      scope.epoch.active++
      let registered = false, nativeRange = false
      return { spec: next, assertContainment: mode => {
        // Host PGID fallback can report waitForExit=true after descendants have
        // escaped. Only the native managed range is a stop certificate here.
        if (mode !== 'linux-scope') { scope.epoch.unknown = true; throw new Error('Host 未提供原生进程管理范围，拒绝受保护执行') }
        nativeRange = true
      }, started: handle => {
        if (registered) throw new Error('执行范围重复登记')
        if (!nativeRange) { scope.epoch.unknown = true; throw new Error('实际进程未确认原生管理范围') }
        registered = true
        void handle.done.then(async () => {
          if (await handle.waitForExit() !== true) throw new Error('Host 未确认后代进程停净')
          scope.epoch.active--
        }).catch(() => { scope.epoch.unknown = true }).finally(() => scope.onSettled(scope.agentId))
      } }
    },
    assertFilePath: path => {
      const scope = storage.getStore()
      if (scope === undefined) return
      assertScope(scope)
      if (scope.mode === 'host-worktree') return
      const target = canonicalTarget(path)
      if (scope.protectedRoots?.some(root => within(root, target))) throw new Error('主仓库 Git 元数据只能通过受控 Git 保存工具修改')
      if (scope.protectedRoots?.length) {
        try { if (lstatSync(target).isFile() && lstatSync(target).nlink > 1) throw new Error('主工作区不允许通过硬链接修改文件') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      if (scope.mode !== 'write' || !within(scope.cwd, target) || !scope.writeScopes.some(root => within(root, target))) throw new Error('实际文件写入超出工作树或 task scope')
    },
    assertWorkingDirectory: (agent, current, exists) => {
      const scope = storage.getStore()
      if (scope === undefined || scope.agentId !== agent.id || scope.mode === 'host-worktree') return
      assertScope(scope)
      if (current !== scope.cwd || exists === false) throw new Error('原工作树不可用；禁止自动回退到源目录执行')
    },
    assertTerminal: () => { if (storage.getStore() !== undefined) throw new Error('受保护工作树不支持持久终端执行；请使用标准 Shell 执行器') }
  }
}

/** Process-persistent carrier: old async callbacks remain fenced across plugin reload. */
export const getExecutionBoundaryCarrier = (): Carrier => {
  const globals = globalThis as Record<symbol, unknown>
  let carrier = globals[EXECUTION_BOUNDARY_KEY] as Carrier | undefined
  if (carrier === undefined) { carrier = createCarrier(); globals[EXECUTION_BOUNDARY_KEY] = carrier }
  if (carrier.version !== 1) throw new Error('执行边界桥接版本不匹配')
  if (carrier.primaryProtectionVersion !== 2) throw new Error('旧进程尚未加载 verifier 输出防硬链接保护，请在安全收尾后重启服务')
  return carrier
}

export const createExecutionBoundary = (ctx: PluginContextLike, onSettled: (agentId: string) => void) => {
  const carrier = getExecutionBoundaryCarrier()
  const launcher = fileURLToPath(new URL('./fence-launcher.js', import.meta.url))
  const available = (): boolean => {
    const caps = (globalThis as Record<symbol, unknown>)[EXECUTION_BOUNDARY_CAPS]
    // 同一已核验版本的物理钩子必须齐全，不能用混装组件拼出写入能力。
    return caps instanceof Set && ['rc1', 'rc3'].some(generation =>
      ['subprocess-local', 'fs-local', 'working-directory'].every(name => caps.has(`${name}/${generation}`)))
  }
  return {
    available,
    begin: (agentId: string, attemptId: string): void => {
      const key = WRITER_EPOCH(agentId, attemptId)
      const previous = carrier.epochs.get(key)
      if (previous !== undefined) {
        if (previous.sealed || previous.unknown) throw new Error('写者执行 epoch 已结束或未知')
        return
      }
      carrier.epochs.set(key, { active: 0, unknown: false, sealed: false })
    },
    seal: (agentId: string, attemptId: string): boolean => {
      const epoch = carrier.epochs.get(WRITER_EPOCH(agentId, attemptId))
      if (!available() || epoch === undefined || epoch.active > 0 || epoch.unknown) return false
      epoch.sealed = true
      return true
    },
    quiescent: (agentId: string, attemptId: string): boolean => {
      const epoch = carrier.epochs.get(WRITER_EPOCH(agentId, attemptId))
      return available() && epoch?.sealed === true && epoch.active === 0 && !epoch.unknown
    },
    run: async <T>(policy: ExecutionBoundaryPolicy | undefined, next: () => Promise<T>): Promise<T> => {
      if (policy === undefined) return next()
      if (!available()) throw new Error('受保护工具需要与当前 DSH 版本匹配的执行边界桥接；当前未执行工具')
      const fs = ctx.get('fs') as { processPathFromHostPath?: (path: string) => string | undefined } | undefined
      if (fs?.processPathFromHostPath?.(policy.cwd) !== policy.cwd) throw new Error('当前执行世界不支持本机工作树隔离')
      const agent = (ctx.get('agents') as { get: (id: string) => AgentLike | undefined } | undefined)?.get(policy.agentId)
      const policies = ctx.get('sandboxPolicy') as { resolve: (input: { session: unknown }) => { mode: string; workspaceRoot: string; additionalWritableRoots?: readonly string[] } } | undefined
      if (agent === undefined || policies === undefined) throw new Error('宿主执行身份或文件策略不可核验')
      const standing = policies.resolve({ session: agent.session })
      const initialPolicy = JSON.stringify(standing)
      if (policy.mode === 'write' && !['workspace-write', 'danger-full-access'].includes(standing.mode)) throw new Error('宿主未授予工作区写入权限')
      const assertCurrent = () => {
        policy.assertCurrent()
        if (JSON.stringify(policies.resolve({ session: agent.session })) !== initialPolicy) throw new Error('实际执行前宿主文件策略已改变')
      }
      const epoch = carrier.epochs.get(WRITER_EPOCH(policy.agentId, policy.attemptId))
      if (epoch === undefined) throw new Error('当前执行未进入可信 Host epoch')
      const anchor = identity(policy.cwd)
      if (policy.mode === 'write' && anchor.identity !== policy.expectedDirectoryIdentity) throw new Error('工作树目录身份在执行准入期间改变')
      const scopes = policy.writeScopes.map(path => {
        const canonical = canonicalTarget(path)
        if (canonical !== resolve(path)) throw new Error('任务 scope 不能通过符号链接改写物理授权目录')
        return canonical
      })
      if (scopes.length > 128 || scopes.some(root => root.length > 4096)) throw new Error('任务 scope 超出执行边界容量')
      if (scopes.some(root => !within(policy.cwd, root))) throw new Error('任务 scope 超出当前工作树')
      if (policy.mode === 'write' && standing.mode === 'workspace-write') {
        const permitted = [standing.workspaceRoot, ...(standing.additionalWritableRoots ?? [])].map(canonicalTarget)
        if (scopes.some(root => !permitted.some(parent => within(parent, root)))) throw new Error('任务 scope 超出宿主文件策略')
      }
      // 任务合同可以预留尚未创建的报告目录。Shell 不挂载不存在的路径，也不能据此写其父目录；
      // 受控准备入口创建并验证后，后续执行才取得对应挂载。其它已授权目录不因此失效。
      const roots = policy.mode === 'write' && policy.operation === 'shell' ? scopes.flatMap(root => {
        try { return [identity(root)] } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
      }) : []
      if (policy.expectedWritableIdentities !== undefined && (roots.length !== policy.expectedWritableIdentities.length || roots.some((root, i) => root.path !== policy.expectedWritableIdentities![i]?.path || root.identity !== policy.expectedWritableIdentities![i]?.identity))) throw new Error('复核输出目录在执行前已改变')
      const protectedAnchors = (policy.protectedRoots ?? []).map(identity)
      const readOnlyAnchors = (policy.readOnlyIdentities ?? []).map(root => {
        const actual = identity(root.path)
        if (actual.identity !== root.identity) throw new Error('复核 Git 管理目录身份不匹配')
        return actual
      })
      if (protectedAnchors.some(root => !within(policy.cwd, root.path)) || policy.expectedGitIdentity !== undefined && protectedAnchors[0]?.identity !== policy.expectedGitIdentity) throw new Error('主仓库元数据保护身份不一致')
      const subprocess = ctx.get('subprocess') as { resolveExecutable: (name: string) => Promise<string> } | undefined
      const bwrap = policy.operation !== 'shell' ? undefined : await subprocess?.resolveExecutable('bwrap')
      const scope: Scope = Object.freeze({ ...policy, assertCurrent, writeScopes: Object.freeze(scopes), anchor: Object.freeze(anchor), roots: Object.freeze(roots.map(root => Object.freeze(root))), protectedAnchors: Object.freeze(protectedAnchors), readOnlyAnchors: Object.freeze(readOnlyAnchors), epoch, launcher, bwrap, onSettled })
      assertScope(scope)
      return carrier.storage.run(scope, next)
    }
  }
}
