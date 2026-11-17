import { isAbsolute, relative, sep } from 'node:path'
import type { AgentLike, PluginContextLike } from '../../host-contract.js'
import type { CreatedWorktreeInfo, WorktreeObservation } from '../../worktree-binding.js'
import { getWorkspacePlan, type WorkspacePlan, type WorkspaceRuleSource } from '../../workspace-policy.js'

export interface WorktreeHostPort {
  cwd: (agent: AgentLike) => string
  setCwd: (agent: AgentLike, path: string, signal: AbortSignal) => Promise<string>
  inspect: (agent: AgentLike, record: CreatedWorktreeInfo, signal: AbortSignal) => Promise<WorktreeObservation>
  inspectWorkspace?: (agent: AgentLike, signal: AbortSignal, ruleRoot?: string) => Promise<{ record: CreatedWorktreeInfo; plan: WorkspacePlan }>
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
const RULES_PROGRAM = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const root=process.argv[1],out=[];for(const name of ['AGENTS.md','agent.md']){const file=path.join(root,name);let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)}catch(e){if(e.code==='ENOENT')continue;throw e}try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>262144)throw Error('invalid project rule file');const buffer=Buffer.alloc(262145),length=fs.readSync(fd,buffer,0,buffer.length,0),after=fs.fstatSync(fd);if(length>262144||length!==st.size||after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)throw Error('project rule file changed');const bytes=buffer.subarray(0,length),text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);out.push({path:name,text,digest:crypto.createHash('sha256').update(bytes).digest('hex')})}finally{fs.closeSync(fd)}}console.log(JSON.stringify(out))`
const GIT_LINK_PROGRAM = `const fs=require('node:fs'),path=require('node:path');let count=0;function walk(p){if(++count>100000)throw Error('metadata limit');const st=fs.lstatSync(p);if(st.isSymbolicLink()||st.isFile()&&st.nlink>1)throw Error('metadata alias');if(st.isDirectory())for(const n of fs.readdirSync(p))walk(path.join(p,n))}walk(process.argv[1]);console.log('verified')`

/** 固定的只读探针共用 Host 沙箱，不从插件直接读取项目规则或启动宿主命令。 */
const readHost = async (ctx: PluginContextLike, agent: AgentLike, cwd: string, argv: string[], signal: AbortSignal): Promise<string> => {
  const process = ctx.get('subprocess') as ProcessPort | undefined
  const sandbox = ctx.get('sandbox') as { confine: (argv: string[], policy: Policy, signal: AbortSignal) => Promise<{ argv: string[]; enforcement: string }> } | undefined
  const policy = (ctx.get('sandboxPolicy') as { resolve: (input: { session: unknown }) => Policy } | undefined)?.resolve({ session: agent.session })
  if (!process || !sandbox || !policy) throw new Error('宿主缺少只读工作区核验能力')
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(15_000)])
  const command = [await process.resolveExecutable(argv[0]!, undefined, bounded), ...argv.slice(1)]
  const wrapped = await sandbox.confine(command, { ...policy, mode: 'read-only' }, bounded)
  if (wrapped.enforcement !== 'full') throw new Error('宿主只读边界不完整')
  const env: Record<string, string | undefined> = Object.fromEntries(Object.keys(globalThis.process.env).filter(k => /^GIT_/i.test(k)).map(k => [k, undefined]))
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' })
  const child = process.spawn({ argv: wrapped.argv, cwd, env, signal: bounded, graceMs: 1000, stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 16384 } } })
  try {
    const result = await child.done, output = child.collected.stdout.readFrom(0)
    bounded.throwIfAborted()
    if (result.exitCode !== 0 || output.lossy) throw new Error('工作区只读核验失败或输出超限')
    return output.text.replace(/\r?\n$/, '')
  } finally { child.terminate(); await child.waitForExit() }
}

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
    inspectWorkspace: async (agent, signal, ruleRoot) => {
      const cwd = ruleRoot ?? directory().get(agent.session)
      const git = (args: string[]) => readHost(ctx, agent, cwd, ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], signal)
      const [repositoryRoot, reference, head, registration] = await Promise.all([git(['rev-parse', '--show-toplevel']), git(['symbolic-ref', '--quiet', 'HEAD']), git(['rev-parse', '--verify', 'HEAD^{commit}']), git(['worktree', 'list', '--porcelain', '-z'])])
      if (!isAbsolute(repositoryRoot) || !reference.startsWith('refs/heads/') || !/^[a-f0-9]{40,64}$/.test(head)) throw new Error('工作区仓库、分支或 HEAD 无法核验')
      const branch = reference.slice('refs/heads/'.length)
      const sources = JSON.parse(await readHost(ctx, agent, repositoryRoot, ['node', '-e', RULES_PROGRAM, repositoryRoot], signal)) as WorkspaceRuleSource[]
      const worktreeCount = registration.split('\0\0').filter(block => block.includes('worktree ')).length
      return { record: { kind: 'primary', path: repositoryRoot, repositoryRoot, branch, baseCommit: head }, plan: getWorkspacePlan({ repositoryRoot, branch, head, sources, worktreeCount }) }
    },
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
        || (record.kind === 'primary' ? root.targetKey !== target.targetKey : root.targetKey === target.targetKey) || pathInfo?.type !== 'directory') throw new Error('原工作树路径已改变或越界')
      const gitType = (await fs.lstat(`${record.path}/.git`, undefined, signal))?.type
      if (gitType !== (record.kind === 'primary' ? 'directory' : 'file')) throw new Error('原工作树 Git 入口类型不符')
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
      if (record.kind === 'primary' && registration.split('\0\0').filter(block => block.includes('worktree ')).length !== 1) throw new Error('主工作区要求唯一工作树，拒绝已有 linked 工作树')
      if (record.kind === 'primary' && (clean(gitDirectory) !== `${record.path}/.git` || clean(pathCommon) !== `${record.path}/.git`)) throw new Error('主工作区 Git 身份与根目录不符')
      if (!registered?.includes(`branch refs/heads/${record.branch}`) || registered.some(line => /^(locked|prunable|detached)( |$)/.test(line))) throw new Error('原工作树未正确注册或处于锁定/损坏状态')
      if (!/^[a-f0-9]{40,64}$/i.test(record.baseCommit)) throw new Error('原工作树基线提交无效')
      await git(record.path, ['cat-file', '-e', `${record.baseCommit}^{commit}`])
      // Existence does not establish lineage. Pin the observed HEAD, allow its
      // legitimate descendants, and reject unrelated or rewritten histories.
      await git(record.path, ['merge-base', '--is-ancestor', record.baseCommit, clean(head)])
      const paths = [record.repositoryRoot, record.path, clean(gitDirectory), clean(pathCommon)]
      // .git 的只读挂载无法保护预先存在的外部硬链接别名；主树先拒绝这些别名。
      if (record.kind === 'primary') await run(record.repositoryRoot, ['node', '-e', GIT_LINK_PROGRAM, clean(gitDirectory)])
      const identities = JSON.parse(await run(record.repositoryRoot, ['node', '-e', IDENTITY_PROGRAM, ...paths])) as Array<{ path: string; identity: string }>
      if (!Array.isArray(identities) || identities.length !== 4 || identities.some((item, index) => item.path !== paths[index] || typeof item.identity !== 'string')) throw new Error('工作树目录身份核验失败')
      signal.throwIfAborted()
      const currentPolicy = (ctx.get('sandboxPolicy') as { resolve: (input: { session: unknown }) => Policy }).resolve({ session: agent.session })
      if (JSON.stringify(currentPolicy) !== JSON.stringify(policy)) throw new Error('核验期间宿主文件策略已改变')
      return { repositoryIdentity: identities[0]!.identity, directoryIdentity: identities[1]!.identity, gitIdentity: identities[2]!.identity, commonIdentity: identities[3]!.identity, gitDirectory: paths[2]!, commonDirectory: paths[3]!, head: clean(head) }
    }
  }
}
