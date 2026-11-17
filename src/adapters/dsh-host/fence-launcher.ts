import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

interface Identity { path: string; identity: string }
interface LaunchProof { anchor: Identity; roots: Identity[]; cwd: string; argv: string[] }
const same = (record: Identity): boolean => {
  const stat = lstatSync(record.path, { bigint: true })
  return !stat.isSymbolicLink() && realpathSync.native(record.path) === record.path && [stat.dev, stat.ino, stat.birthtimeNs].join(':') === record.identity
}
/** Runs after the kernel has pinned the read-only tree and exact writable mounts. */
export const executeFenced = async (proof: LaunchProof): Promise<number> => {
  if (!proof || !Array.isArray(proof.argv) || proof.argv.length === 0 || !proof.argv.every(value => typeof value === 'string')
    || !Array.isArray(proof.roots) || proof.roots.length > 256 || !same(proof.anchor) || !proof.roots.every(same)) throw new Error('工作树执行视图与授权身份不一致')
  const cwd = realpathSync.native(proof.cwd), rel = relative(proof.anchor.path, cwd)
  if (cwd !== proof.cwd || !isAbsolute(cwd) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('工作树执行目录已改变')
  process.chdir(cwd)
  const child = spawn(proof.argv[0]!, proof.argv.slice(1), { cwd, env: process.env, stdio: 'inherit' })
  return await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) })
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--swarm-exec') {
  try { process.exitCode = await executeFenced(JSON.parse(process.argv[3] ?? 'null') as LaunchProof) }
  catch { process.stderr.write('SWARM_EXECUTION_BOUNDARY_REJECTED\n'); process.exitCode = 125 }
}
