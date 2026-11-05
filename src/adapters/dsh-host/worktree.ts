import { isAbsolute, relative, sep } from 'node:path'
import type { AgentLike, PluginContextLike } from '../../host-contract.js'
import type { CreatedWorktreeInfo, WorktreeObservation } from '../../worktree-binding.js'

export interface WorktreeHostPort {
  cwd: (agent: AgentLike) => string
  setCwd: (agent: AgentLike, path: string, signal: AbortSignal) => Promise<string>
  inspect: (agent: AgentLike, record: CreatedWorktreeInfo, signal: AbortSignal) => Promise<WorktreeObservation>
}
interface Target { targetKey: string; displayPath: string }
interface FileSystemPort {
  resolve: (path: string, options?: { cwd?: string; signal?: AbortSignal }) => Promise<Target>
  processPath: (target: Target) => string
  processPathFromHostPath: (path: string) => string | undefined
  contains: (root: Target, target: Target) => boolean
  lstat: (path: string, options?: { cwd?: string }, signal?: AbortSignal) => Promise<{ type: string; version: string } | undefined>
}
interface Policy { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string; additionalWritableRoots?: readonly string[]; sessionId?: string }
interface ProcessPort {
  resolveExecutable: (name: string, path?: string, signal?: AbortSignal) => Promise<string>
  spawn: (input: { argv: string[]; cwd: string; env: Record<string, string | undefined>; signal: AbortSignal; graceMs: number; stdio: { stdin: 'ignore'; stdout: { maxBytes: number }; stderr: { maxBytes: number } } }) => {
    done: Promise<{ exitCode: number | null }>
    collected: { stdout: { readFrom: (offset: number) => { text: string; lossy: boolean } }; stderr: { readFrom: (offset: number) => { text: string; lossy: boolean } } }
    terminate: () => void
    waitForExit: () => Promise<unknown>
  }
}
const inside = (root: string, path: string): boolean => { const value = relative(root, path); return value === '' || value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value) }
const IDENTITY_PROGRAM = `const fs=require('node:fs');const paths=process.argv.slice(1);console.log(JSON.stringify(paths.map(p=>{const s=fs.lstatSync(p,{bigint:true});if(s.isSymbolicLink())throw Error('symbolic identity');return {path:fs.realpathSync.native(p),identity:[s.dev,s.ino,s.birthtimeNs].join(':')}})))`

/** No direct process/file access: all inspection is confined by the calling Host policy. */
export const createHostWorktreePort = (ctx: PluginContextLike): WorktreeHostPort => {
  const directory = () => {
    const value = ctx.get('workingDirectory') as { get: (session: unknown) => string; set: (agent: AgentLike, path: string, signal: AbortSignal) => Promise<string> } | undefined
    if (value === undefined) throw new Error('宿主未提供 workingDirectory，不能恢复工作树')
    return value
  }
  return {
    cwd: agent => directory().get(agent.session),
    setCwd: (agent, path, signal) => directory().set(agent, path, signal),
    inspect: async (agent, record, signal) => {
      signal.throwIfAborted()
      const fs = ctx.get('fs') as FileSystemPort | undefined
      const subprocess = ctx.get('subprocess') as ProcessPort | undefined
      const sandbox = ctx.get('sandbox') as { confine: (argv: string[], policy: Policy, signal: AbortSignal) => Promise<{ argv: string[]; enforcement: string }> } | undefined
      const policy = (ctx.get('sandboxPolicy') as { resolve: (input: { session: unknown }) => Policy } | undefined)?.resolve({ session: agent.session })
      if (!fs || !subprocess || !sandbox || !policy) throw new Error('宿主缺少受限文件或 Git 核验能力')
      if (policy.mode === 'read-only') throw new Error('宿主当前策略为只读，不能恢复写入授权')
      // Existing leases are local OS leases; never pretend they protect a remote execution world.
      if (typeof fs.processPathFromHostPath !== 'function' || fs.processPathFromHostPath(record.path) !== record.path) throw new Error('当前工作区不支持本机排他租约')
      const [root, target, pathInfo] = await Promise.all([
        fs.resolve(record.repositoryRoot, { signal }), fs.resolve(record.path, { signal }), fs.lstat(record.path, undefined, signal)
      ])
      if (fs.processPath(root) !== record.repositoryRoot || fs.processPath(target) !== record.path || !fs.contains(root, target)
        || root.targetKey === target.targetKey || pathInfo?.type !== 'directory') throw new Error('原工作树路径已改变或越界')
      if ((await fs.lstat(`${record.path}/.git`, undefined, signal))?.type !== 'file') throw new Error('原工作树 Git 入口不是普通文件')
      const roots = [policy.workspaceRoot, ...(policy.additionalWritableRoots ?? [])]
      if (policy.mode !== 'danger-full-access' && !roots.some(path => inside(path, record.path))) throw new Error('工作树不在宿主允许目录内')
      const run = async (cwd: string, argv: string[]): Promise<string> => {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        const command = [await subprocess.resolveExecutable(argv[0]!, undefined, bounded), ...argv.slice(1)]
        const wrapped = await sandbox.confine(command, { ...policy, mode: 'read-only' }, bounded)
        if (wrapped.enforcement !== 'full') throw new Error('宿主只读执行边界不完整，拒绝工作树核验')
        bounded.throwIfAborted()
        const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(process.env).filter(key => /^GIT_/i.test(key)).map(key => [key, undefined]))
        Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' })
        const child = subprocess.spawn({ argv: wrapped.argv, cwd, env, signal: bounded, graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 16 * 1024 } } })
        try {
          const outcome = await child.done
          bounded.throwIfAborted()
          const output = child.collected.stdout.readFrom(0)
          if (outcome.exitCode !== 0 || output.lossy) throw new Error('工作树 Git/目录核验失败或输出超限')
          return output.text
        } finally { child.terminate(); await child.waitForExit() }
      }
      const git = (cwd: string, args: string[]) => run(cwd, ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args])
      const clean = (text: string) => text.replace(/\r?\n$/, '')
      const [rootTop, pathTop, rootCommon, pathCommon, gitDirectory, branch, head, registration] = await Promise.all([
        git(record.repositoryRoot, ['rev-parse', '--show-toplevel']), git(record.path, ['rev-parse', '--show-toplevel']),
        git(record.repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']), git(record.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
        git(record.path, ['rev-parse', '--absolute-git-dir']), git(record.path, ['symbolic-ref', '--quiet', 'HEAD']),
        git(record.path, ['rev-parse', '--verify', 'HEAD^{commit}']), git(record.repositoryRoot, ['worktree', 'list', '--porcelain', '-z'])
      ])
      if (clean(rootTop) !== record.repositoryRoot || clean(pathTop) !== record.path || clean(branch) !== `refs/heads/${record.branch}` || clean(rootCommon) !== clean(pathCommon)) throw new Error('工作树仓库、common-dir 或分支与原记录不一致')
      const registered = registration.split('\0\0').map(block => block.split('\0')).find(lines => lines.includes(`worktree ${record.path}`))
      if (!registered?.includes(`branch refs/heads/${record.branch}`) || registered.some(line => /^(locked|prunable|detached)( |$)/.test(line))) throw new Error('原工作树未正确注册或处于锁定/损坏状态')
      if (!/^[a-f0-9]{40,64}$/i.test(record.baseCommit)) throw new Error('原工作树基线提交无效')
      await git(record.path, ['cat-file', '-e', `${record.baseCommit}^{commit}`])
      const paths = [record.repositoryRoot, record.path, clean(gitDirectory), clean(pathCommon)]
      const identities = JSON.parse(await run(record.repositoryRoot, ['node', '-e', IDENTITY_PROGRAM, ...paths])) as Array<{ path: string; identity: string }>
      if (!Array.isArray(identities) || identities.length !== 4 || identities.some((item, index) => item.path !== paths[index] || typeof item.identity !== 'string')) throw new Error('工作树目录身份核验失败')
      signal.throwIfAborted()
      const currentPolicy = (ctx.get('sandboxPolicy') as { resolve: (input: { session: unknown }) => Policy }).resolve({ session: agent.session })
      if (JSON.stringify(currentPolicy) !== JSON.stringify(policy)) throw new Error('核验期间宿主文件策略已改变')
      return { repositoryIdentity: identities[0]!.identity, directoryIdentity: identities[1]!.identity, gitIdentity: identities[2]!.identity, commonIdentity: identities[3]!.identity, gitDirectory: paths[2]!, commonDirectory: paths[3]!, head: clean(head) }
    }
  }
}
