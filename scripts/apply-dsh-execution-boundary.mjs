import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2), at = args.indexOf('--dsh')
if (at < 0 || !args[at + 1]) throw new Error('Usage: node scripts/apply-dsh-execution-boundary.mjs --dsh <node_modules> [--check|--restore]')
const modules = realpathSync(resolve(args[at + 1]))
const plan = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../patches/dsh-execution-boundary-0.2.2-rc.1.json'), 'utf8'))
if (JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version !== plan.hostVersion) throw new Error('Unsupported Host version')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const prepared = plan.files.map(entry => {
  const file = join(modules, entry.path), actual = realpathSync(file), rel = relative(modules, actual), stat = lstatSync(file)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Unexpected Host file location')
  const source = readFileSync(file), current = sha(source), backup = `${file}.swarm-execution-boundary.orig`
  if (![entry.beforeSha256, entry.afterSha256].includes(current)) throw new Error(`Unknown Host checksum: ${entry.path}`)
  if (existsSync(backup) && sha(readFileSync(backup)) !== entry.beforeSha256) throw new Error(`Invalid original backup: ${entry.path}`)
  let original = current === entry.beforeSha256 ? source : readFileSync(backup)
  let patched = original.toString('utf8')
  for (const edit of entry.edits) {
    if (patched.split(edit.find).length - 1 !== edit.count) throw new Error(`Patch anchor mismatch: ${entry.path}`)
    patched = patched.replaceAll(edit.find, edit.replace)
  }
  if (sha(patched) !== entry.afterSha256) throw new Error('Patched checksum mismatch')
  return { file, backup, source, original, next: args.includes('--restore') ? original : Buffer.from(patched), current, mode: stat.mode & 0o777 }
})
const atomic = (file, bytes, mode) => { const temp = `${file}.boundary-${randomUUID()}`; writeFileSync(temp, bytes, { flag: 'wx', mode }); renameSync(temp, file) }
if (!args.includes('--check')) {
  const written = []
  try {
    for (const item of prepared) {
      if (sha(readFileSync(item.file)) !== item.current) throw new Error('Host file changed during patch preparation')
      if (!existsSync(item.backup)) { writeFileSync(item.backup, item.original, { flag: 'wx', mode: 0o600 }); chmodSync(item.backup, 0o600) }
      if (sha(item.next) !== item.current) { atomic(item.file, item.next, item.mode); written.push(item) }
    }
  } catch (error) {
    for (const item of written.reverse()) if (sha(readFileSync(item.file)) === sha(item.next)) atomic(item.file, item.source, item.mode)
    throw error
  }
}
console.log(JSON.stringify({ checked: args.includes('--check'), restored: args.includes('--restore'), hostVersion: plan.hostVersion, files: prepared.length, state: prepared.map(item => ({ file: relative(modules, item.file), sha256: sha(readFileSync(item.file)) })) }))
