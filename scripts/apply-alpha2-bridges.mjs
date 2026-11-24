#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const at = args.indexOf('--dsh')
if (at < 0 || !args[at + 1]) throw new Error('Usage: node scripts/apply-alpha2-bridges.mjs --dsh <node_modules> [--check|--restore]')
if (args.filter(arg => arg === '--dsh').length !== 1
  || args.some((arg, index) => index !== at + 1 && !['--dsh', '--check', '--restore'].includes(arg))
  || args.includes('--check') && args.includes('--restore')) {
  throw new Error('Invalid alpha2 bridge arguments')
}

const modules = realpathSync(resolve(args[at + 1]))
const dshManifest = join(modules, '@deepseek-ai/dsh/package.json')
const hostVersion = JSON.parse(readFileSync(dshManifest, 'utf8')).version
const nodeParts = process.versions.node.split('.').map(Number)
const minimumParts = [24, 22, 3]
for (let index = 0; index < minimumParts.length; index += 1) {
  const actual = nodeParts[index] ?? 0
  const minimum = minimumParts[index]
  if (actual > minimum) break
  if (actual < minimum) throw new Error(`Node ${minimumParts.join('.')} or newer is required; found ${process.versions.node}`)
}

const plan = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../patches/dsh-host-0.2.3-alpha.2-bridges.json'), 'utf8'))
if (plan.hostVersion !== hostVersion || hostVersion !== '0.2.3-alpha.2') throw new Error('Alpha2 bridge manifest version mismatch')
for (const name of ['dsh', 'dsh-agent-loop', 'dsh-subprocess-local', 'dsh-working-directory', 'dsh-fs-local']) {
  const manifest = join(modules, '@deepseek-ai', name, 'package.json')
  if (JSON.parse(readFileSync(manifest, 'utf8')).version !== hostVersion) throw new Error(`Package version mismatch: ${name}`)
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = file => {
  const value = relative(modules, file)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}
const applyEdits = (file, source, edits) => {
  let text = source.toString('utf8')
  for (const edit of edits) {
    const matches = text.split(edit.find).length - 1
    if (matches !== edit.count) throw new Error(`Patch anchor mismatch: ${file} (${matches} != ${edit.count})`)
    text = text.replaceAll(edit.find, edit.replace)
  }
  return Buffer.from(text)
}

const prepared = plan.files.map(entry => {
  const file = join(modules, entry.path)
  const actual = realpathSync(file)
  const stat = lstatSync(file)
  if (!inside(actual) || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unexpected Host file location: ${entry.path}`)
  const current = readFileSync(file)
  const currentSha = sha(current)
  const backup = `${file}.swarm-alpha2-bridge.orig`
  if (![entry.beforeSha256, entry.afterSha256].includes(currentSha)) throw new Error(`Unknown Host checksum: ${entry.path}`)
  if (existsSync(backup) && sha(readFileSync(backup)) !== entry.beforeSha256) throw new Error(`Invalid original backup: ${entry.path}`)
  if (currentSha === entry.afterSha256 && !existsSync(backup)) throw new Error(`Patched Host lacks its original backup: ${entry.path}`)
  const original = currentSha === entry.beforeSha256 ? current : readFileSync(backup)
  const patched = applyEdits(entry.path, original, entry.edits)
  if (sha(original) !== entry.beforeSha256 || sha(patched) !== entry.afterSha256) throw new Error(`Bridge checksum mismatch: ${entry.path}`)
  return {
    entry,
    file,
    backup,
    current,
    currentSha,
    original,
    patched,
    desired: args.includes('--restore') ? original : patched,
    mode: stat.mode & 0o777
  }
})

const atomic = (file, bytes, mode) => {
  const temporary = `${file}.alpha2-bridge-${randomUUID()}`
  writeFileSync(temporary, bytes, { flag: 'wx', mode })
  renameSync(temporary, file)
}

if (!args.includes('--check')) {
  const written = []
  try {
    for (const item of prepared) {
      if (sha(readFileSync(item.file)) !== item.currentSha) throw new Error(`Host file changed during preparation: ${item.entry.path}`)
      if (!existsSync(item.backup)) {
        writeFileSync(item.backup, item.original, { flag: 'wx', mode: 0o600 })
        chmodSync(item.backup, 0o600)
      }
      const desiredSha = sha(item.desired)
      if (desiredSha !== item.currentSha) {
        atomic(item.file, item.desired, item.mode)
        written.push(item)
      }
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (sha(readFileSync(item.file)) === sha(item.desired)) atomic(item.file, item.current, item.mode)
    }
    throw error
  }
  if (args.includes('--restore')) {
    for (const item of prepared) {
      if (existsSync(item.backup)) rmSync(item.backup, { force: true })
    }
  }
}

console.log(JSON.stringify({
  checked: args.includes('--check'),
  restored: args.includes('--restore'),
  hostVersion,
  nodeVersion: process.versions.node,
  files: prepared.length,
  state: prepared.map(item => ({
    file: relative(modules, item.file),
    sha256: sha(readFileSync(item.file))
  }))
}, null, 2))
