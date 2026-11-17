#!/usr/bin/env node
/** 在 OS 只读根文件系统和断网命名空间内，使用真实历史副本验证新回合。 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

const option = name => {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return resolve(process.argv[index + 1])
}
const sdk = option('--sdk'), plugin = option('--plugin'), source = option('--session-file'), events = option('--events'), output = option('--out')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const decode = file => zstdDecompressSync(readFileSync(file)).toString('utf8').trim().split('\n').map(JSON.parse)
const original = decode(source), header = original[0]
assert.equal(header.type, 'session')
const childIndex = original.filter(event => event.type === 'subagent/catalog' && typeof event.data.childId === 'string').map(event => event.data.childId)
const rootId = header.id, childId = process.argv[process.argv.indexOf('--child') + 1]
assert.ok(childIndex.includes(childId), 'required child must be in the actual native catalog')
mkdirSync(output, { recursive: true, mode: 0o700 })
const base = mkdtempSync(join(output, 'native-continue-')), home = join(base, 'home'), profile = join(home, 'profiles/proof')
mkdirSync(join(profile, 'node_modules'), { recursive: true })
symlinkSync(join(sdk, 'node_modules'), join(home, 'profiles/node_modules'))
symlinkSync(plugin, join(profile, 'node_modules/dsh-agent-swarm'))
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'session-continue-proof', private: true,
  dependencies: { 'dsh-agent-swarm': `link:${plugin}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-agent-swarm'] } } }))
writeFileSync(join(profile, 'cordis.yml'), '[]')
writeFileSync(join(profile, 'cordis.patch.yml'), '[]')
const sessionsRoot = dirname(dirname(dirname(source)))
const buckets = readdirSync(sessionsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
const copied = []
const copySession = file => {
  const rel = relative(sessionsRoot, file)
  assert.ok(!rel.startsWith('..'))
  const target = join(home, 'sessions', rel)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(file, target)
  const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex')
  assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), sha256, 'source changed during snapshot copy')
  copied.push({ relative: rel, sha256 })
}
copySession(source)
for (const id of new Set(childIndex)) {
  const file = buckets.map(bucket => join(sessionsRoot, bucket, id, 'session.v4.jsonl.zstd')).find(existsSync)
  if (file) copySession(file)
}
assert.ok(copied.some(entry => entry.relative.includes(`/${childId}/`)))
cpSync(events, join(home, 'share/dsh-agent-swarm/events-v2'), { recursive: true })
const copiedRootFile = join(home, 'sessions', copied[0].relative)
const rootBefore = decode(copiedRootFile)
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const originalEventPrefixDigest = digest(rootBefore)
const patch = join(base, 'patch.json')
writeFileSync(patch, JSON.stringify([
  { insert: [{ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: header.agentPreset } },
    { id: 'continue-driver', name: join(repo, 'tests/integration/driver/session-continue.mjs') }] },
  { id: 'llm-retry', disabled: true },
  { id: 'spill-local', config: { root: join(home, 'private-spill') } },
  ...['tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search', 'skill-filesystem', 'tool-skill', 'command-goal', 'tool-goal', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'tool-todo', 'tool-web'].map(id => ({ id, disabled: true }))
]))
const preload = join(base, 'preload.mjs'), resultFile = join(base, 'result.json')
writeFileSync(preload, `import os from 'node:os';import{syncBuiltinESMExports}from'node:module';os.homedir=()=>${JSON.stringify(home)};syncBuiltinESMExports();globalThis.fetch=async()=>{throw new Error('session proof forbids external network')};`, { mode: 0o600 })
const run = spawnSync('bwrap', ['--die-with-parent', '--unshare-net', '--ro-bind', '/', '/', '--bind', output, output, '--proc', '/proc', '--dev', '/dev', '--chdir', base,
  process.execPath, join(sdk, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'proof', '--patch', patch], {
  encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  env: { PATH: process.env.PATH, LANG: 'C.UTF-8', DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: `--import=${preload}`,
    CONTINUE_ROOT_ID: rootId, CONTINUE_CHILD_ID: childId, CONTINUE_PRESET: header.agentPreset, CONTINUE_OUT: resultFile }
})
writeFileSync(join(base, 'host.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`, { mode: 0o600 })
let behavior
try { behavior = JSON.parse(readFileSync(resultFile, 'utf8')) } catch (error) { behavior = { status: 'missing-result', error: error.message } }
const sourceUnchanged = copied.every(entry => createHash('sha256').update(readFileSync(join(sessionsRoot, entry.relative))).digest('hex') === entry.sha256)
const rootAfter = decode(copiedRootFile)
const originalEventPrefixUnchanged = digest(rootAfter.slice(0, rootBefore.length)) === originalEventPrefixDigest
const receipt = { sdk, plugin, base, rootId, copiedSessions: copied, sourceUnchanged, originalEventPrefixUnchanged, originalEventPrefixDigest,
  originalRows: rootBefore.length, newRows: rootAfter.length - rootBefore.length, exitCode: run.status, signal: run.signal, spawnError: run.error?.message, behavior }
writeFileSync(join(output, 'native-session-continue-receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ base, exitCode: run.status, sourceUnchanged, originalEventPrefixUnchanged, newRows: receipt.newRows, behavior }))
process.exitCode = run.status === 0 && behavior.status === 'passed' && sourceUnchanged && originalEventPrefixUnchanged ? 0 : 1
