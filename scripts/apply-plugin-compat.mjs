#!/usr/bin/env node
/** 在停止使用的插件副本上应用精确兼容补丁；未知或混合字节一律拒绝。 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
const pluginArg = option('--plugin'), planArg = option('--plan')
if (!pluginArg || !planArg || args.some(arg => arg.startsWith('--') && !['--plugin', '--plan', '--check', '--restore'].includes(arg))) {
  throw new Error('用法: node scripts/apply-plugin-compat.mjs --plugin <离线插件副本> --plan <补丁清单.json> [--check|--restore]')
}
if (args.includes('--check') && args.includes('--restore')) throw new Error('--check 和 --restore 不能同时使用')
const root = realpathSync.native(resolve(pluginArg)), planPath = resolve(planArg)
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (plan.schemaVersion !== 1 || pkg.name !== plan.packageName || pkg.version.split('+')[0] !== plan.baseVersion
  || !Array.isArray(plan.files) || plan.files.length === 0 || plan.files.length > 64) throw new Error('插件身份、版本或补丁清单不匹配')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const isInside = (parent, child) => { const rel = relative(parent, child); return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const validateRelative = path => {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || path.includes('\\')
    || path.split('/').some(part => ['', '.', '..'].includes(part))) throw new Error('补丁包含非法相对路径')
  return path
}
const patchPath = resolve(dirname(planPath), validateRelative(plan.patch))
if (!isInside(dirname(planPath), patchPath) || sha(readFileSync(patchPath)) !== plan.patchSha256) throw new Error('补丁文件摘要不匹配')
const seen = new Set()
const rows = plan.files.map(entry => {
  const path = validateRelative(entry.path)
  if (seen.has(path) || !/^[a-f0-9]{64}$/.test(entry.afterSha256)
    || entry.beforeSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.beforeSha256)) throw new Error('补丁文件重复或摘要不合法')
  seen.add(path)
  const target = resolve(root, path)
  let parent = dirname(target)
  while (!existsSync(parent)) parent = dirname(parent)
  if (!isInside(root, realpathSync.native(parent))) throw new Error(`补丁父目录越界: ${path}`)
  const stat = existsSync(target) ? lstatSync(target) : undefined
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error(`补丁目标不是普通文件: ${path}`)
  const before = stat ? readFileSync(target) : undefined
  return { ...entry, path, target, before, mode: stat?.mode ?? 0o644, digest: before === undefined ? null : sha(before) }
})
const original = rows.every(row => row.digest === row.beforeSha256)
const patched = rows.every(row => row.digest === row.afterSha256)
if (args.includes('--check')) {
  if (!patched) throw new Error('插件尚未应用此精确补丁或文件已改变')
  process.stdout.write(JSON.stringify({ status: 'verified', package: pkg.name, files: rows.length }) + '\n')
  process.exit(0)
}
const restore = args.includes('--restore')
if ((!restore && patched) || (restore && original)) {
  process.stdout.write(JSON.stringify({ status: restore ? 'already-original' : 'already-patched', package: pkg.name }) + '\n')
  process.exit(0)
}
if (restore ? !patched : !original) throw new Error('Unknown plugin checksum 或混合补丁状态；未修改插件')
const stage = mkdtempSync(join(tmpdir(), 'dsh-plugin-compat-'))
const changed = []
try {
  for (const row of rows) if (row.before !== undefined) {
    const file = join(stage, row.path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, row.before, { mode: row.mode })
  }
  execFileSync('/usr/bin/patch', ['--batch', '--fuzz=0', '-p1', ...(restore ? ['--reverse'] : ['--forward']), '--input', patchPath], { cwd: stage, stdio: 'pipe' })
  const visit = directory => readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? visit(join(directory, item.name)) : [relative(stage, join(directory, item.name)).split(sep).join('/')])
  if (visit(stage).some(path => !seen.has(path))) throw new Error('补丁生成了清单之外的文件')
  for (const row of rows) {
    const file = join(stage, row.path), expected = restore ? row.beforeSha256 : row.afterSha256
    const bytes = existsSync(file) ? readFileSync(file) : undefined
    if ((bytes === undefined ? null : sha(bytes)) !== expected) throw new Error(`补丁结果摘要不匹配: ${row.path}`)
    row.next = bytes
  }
  for (const row of rows) {
    // 修改仅在完整预检后发生，调用者负责先停止该副本的使用进程。
    if (row.next === undefined) rmSync(row.target)
    else {
      mkdirSync(dirname(row.target), { recursive: true })
      const temp = `${row.target}.compat-${process.pid}`
      writeFileSync(temp, row.next, { flag: 'wx', mode: row.mode })
      try { renameSync(temp, row.target) } finally { rmSync(temp, { force: true }) }
    }
    changed.push(row)
  }
  process.stdout.write(JSON.stringify({ status: restore ? 'restored' : 'patched', package: pkg.name, files: rows.length }) + '\n')
} catch (error) {
  for (const row of changed.reverse()) {
    if (row.before === undefined) rmSync(row.target, { force: true })
    else writeFileSync(row.target, row.before, { mode: row.mode })
  }
  throw error
} finally { rmSync(stage, { recursive: true, force: true }) }
