#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = '0.2.2-rc.1'
const ORIGINAL_SHA256 = 'a6fa8e0c7c90191caf5f4a3bb5c624a86e9845cf3c79d020b71420d0e20ae4c1'
const PATCHED_SHA256 = 'c7390f4da755e9c57ad9176df605d2991822bdeb7f13e87260b4f5d0e51ea5ae'
const args = process.argv.slice(2)
const at = args.indexOf('--dsh-root')
if (at < 0 || !args[at + 1]) throw new Error('必须显式提供 --dsh-root，指向隔离安装根目录')
if (args.filter((arg) => arg === '--dsh-root').length !== 1 || args.some((arg, index) => index !== at + 1 && !['--dsh-root', '--check', '--restore'].includes(arg))
  || (args.includes('--check') && args.includes('--restore'))) throw new Error('参数无效：只能选择 --check 或 --restore')
const installRoot = realpathSync(resolve(args[at + 1]))
const dshManifest = join(installRoot, 'node_modules/@deepseek-ai/dsh/package.json')
if (JSON.parse(readFileSync(dshManifest, 'utf8')).version !== VERSION) throw new Error('DSH 版本与桥接补丁不匹配')
const require = createRequire(dshManifest)
const agentManifest = realpathSync(require.resolve('@deepseek-ai/dsh-agent-loop/package.json'))
if (!agentManifest.startsWith(installRoot + sep)) throw new Error('agent-loop 实际位置超出指定安装根目录')
if (JSON.parse(readFileSync(agentManifest, 'utf8')).version !== VERSION) throw new Error('agent-loop 版本与桥接补丁不匹配')
const packageRoot = dirname(agentManifest)
const target = join(packageRoot, 'lib/index.js')
const backup = join(packageRoot, `lib/index.js.swarm-pristine-${ORIGINAL_SHA256.slice(0, 12)}`)
const patchFile = resolve(dirname(fileURLToPath(import.meta.url)), '../patches/dsh-agent-loop-0.2.2-rc.1-step-model-bridge.patch')
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const current = digest(target)
const restore = args.includes('--restore')
const check = args.includes('--check')

if (check) {
  if (current !== ORIGINAL_SHA256 && current !== PATCHED_SHA256) throw new Error('agent-loop 摘要未知，拒绝继续')
  console.log(JSON.stringify({ version: VERSION, state: current === PATCHED_SHA256 ? 'patched' : 'original', sha256: current }))
} else if (restore) {
  if (current === ORIGINAL_SHA256) console.log(JSON.stringify({ version: VERSION, state: 'original', changed: false }))
  else {
    if (current !== PATCHED_SHA256 || !existsSync(backup) || digest(backup) !== ORIGINAL_SHA256) throw new Error('补丁或备份摘要不匹配，拒绝回滚')
    const temporary = `${target}.swarm-restore-${process.pid}`
    copyFileSync(backup, temporary, constants.COPYFILE_EXCL)
    try {
      if (digest(target) !== PATCHED_SHA256) throw new Error('回滚期间目标文件发生变化')
      renameSync(temporary, target)
    } finally { rmSync(temporary, { force: true }) }
    console.log(JSON.stringify({ version: VERSION, state: 'original', changed: true }))
  }
} else if (current === PATCHED_SHA256) {
  console.log(JSON.stringify({ version: VERSION, state: 'patched', changed: false }))
} else {
  if (current !== ORIGINAL_SHA256) throw new Error('agent-loop 摘要与预期原版不同，拒绝打补丁')
  const temporary = mkdtempSync(join(packageRoot, '.swarm-bridge-'))
  try {
    const tempLib = join(temporary, 'lib')
    mkdirSync(tempLib)
    copyFileSync(target, join(tempLib, 'index.js'))
    const result = spawnSync('patch', ['--batch', '--forward', '-p1', '-i', patchFile], { cwd: temporary, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`应用桥接补丁失败：${result.stderr || result.stdout || result.error?.message || 'unknown'}`)
    if (digest(join(tempLib, 'index.js')) !== PATCHED_SHA256) throw new Error('补丁结果摘要不匹配')
    if (existsSync(backup) && digest(backup) !== ORIGINAL_SHA256) throw new Error('已有桥接备份摘要不匹配')
    if (!existsSync(backup)) copyFileSync(target, backup, constants.COPYFILE_EXCL)
    if (digest(target) !== ORIGINAL_SHA256) throw new Error('补丁期间目标文件发生变化')
    renameSync(join(tempLib, 'index.js'), target)
    console.log(JSON.stringify({ version: VERSION, state: 'patched', changed: true, backup }))
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
