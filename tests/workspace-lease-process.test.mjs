import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

const setup = async t => {
  const directory = await mkdtemp(join(tmpdir(), 'swarm-lease-process-')), owners = join(directory, 'owners')
  await mkdir(owners)
  const children = ['A', 'B'].map(name => fork(new URL('./fixtures/lease-race-worker.mjs', import.meta.url), [directory, owners, name], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }))
  const call = (child, action) => new Promise((resolve, reject) => {
    const id = randomUUID(), timer = setTimeout(() => { child.off('message', listener); reject(new Error('lease worker timeout')) }, 5000)
    const listener = result => { if (result.id !== id) return; clearTimeout(timer); child.off('message', listener); resolve(result) }
    child.on('message', listener); child.send({ action, id })
  })
  t.after(async () => { await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill() }))); await rm(directory, { recursive: true, force: true }) })
  return { directory, owners, children, call }
}

test('cross-process stale lease: both contenders refuse, original owner file is unchanged', async t => {
  const f = await setup(t), lock = join(f.owners, `workspace-${createHash('sha256').update(f.directory).digest('hex')}.json`)
  const original = JSON.stringify({ schemaVersion: 1, pid: 2 ** 22 + 12345, host: hostname(), leaseId: 'stale', owner: 'old', cwd: f.directory })
  await writeFile(lock, original, { mode: 0o600 })
  const results = await Promise.all(f.children.map(child => f.call(child, 'claim')))
  assert.deepEqual(results.map(row => row.code), ['WORKSPACE_BUSY', 'WORKSPACE_BUSY'])
  assert.equal(await readFile(lock, 'utf8'), original)
})
test('cross-process lease: one winner; concurrent release cannot unlink the following owner', async t => {
  const f = await setup(t), results = await Promise.all(f.children.map(child => f.call(child, 'claim')))
  assert.equal(results.filter(row => row.granted).length, 1)
  const winner = results[0].granted ? 0 : 1, loser = 1 - winner
  await f.call(f.children[winner], 'release')
  const next = await f.call(f.children[loser], 'claim')
  assert.equal(next.granted, true)
  await f.call(f.children[winner], 'release')
  const [file] = await readdir(f.owners)
  assert.equal(JSON.parse(await readFile(join(f.owners, file), 'utf8')).leaseId, next.leaseId)
  await f.call(f.children[loser], 'release')
})
