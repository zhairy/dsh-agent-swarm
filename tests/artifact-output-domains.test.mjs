import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getArtifactSnapshot } from '../lib/artifacts.js'

test('approved test outputs and Git metadata do not turn a read-only source verification into a source edit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'swarm-artifact-output-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const d of ['src', '.git', 'var/tmp', 'var/reports/swarm']) await mkdir(join(root, d), { recursive: true })
  await writeFile(join(root, 'src/code.py'), 'answer = 42\n')
  await writeFile(join(root, '.git/config'), 'baseline')
  const options = { exclude: ['.git', 'var/tmp', 'var/reports/swarm'] }
  const before = await getArtifactSnapshot(root, ['.'], options)
  await writeFile(join(root, 'var/tmp/cache'), 'pytest cache')
  await writeFile(join(root, 'var/reports/swarm/report.json'), '{"passed":true}')
  await writeFile(join(root, '.git/config'), 'controlled git state')
  const after = await getArtifactSnapshot(root, ['.'], options)
  assert.equal(after.complete, true); assert.equal(after.digest, before.digest)
  assert.deepEqual(after.entries.map(e => e.path), ['src/code.py'])
  await writeFile(join(root, 'src/code.py'), 'answer = 43\n')
  assert.notEqual((await getArtifactSnapshot(root, ['.'], options)).digest, before.digest)
})
test('controlled exclusions never make an escaping source alias complete', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'swarm-artifact-alias-')), root = join(parent, 'repo')
  t.after(() => rm(parent, { recursive: true, force: true })); await mkdir(root)
  await writeFile(join(parent, 'outside'), 'outside')
  await symlink(join(parent, 'outside'), join(root, 'source-link'))
  assert.equal((await getArtifactSnapshot(root, ['source-link'], { exclude: ['var/tmp'] })).complete, false)
  await assert.rejects(getArtifactSnapshot(root, ['.'], { exclude: ['../source'] }))
})
