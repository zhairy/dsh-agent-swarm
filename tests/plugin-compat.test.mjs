import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('../scripts/apply-plugin-compat.mjs', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'swarm-plugin-compat-test-'))
  const plugin = join(base, 'plugin'), plan = join(base, 'plan.json')
  mkdirSync(join(plugin, 'lib'), { recursive: true })
  writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: 'compat-fixture', version: '1.0.0' }))
  writeFileSync(join(plugin, 'lib/a.js'), 'old\n')
  const patch = '--- a/lib/a.js\n+++ b/lib/a.js\n@@ -1 +1 @@\n-old\n+new\n--- /dev/null\n+++ b/lib/extra.js\n@@ -0,0 +1 @@\n+added\n'
  writeFileSync(join(base, 'fixture.patch'), patch)
  writeFileSync(plan, JSON.stringify({ schemaVersion: 1, packageName: 'compat-fixture', baseVersion: '1.0.0', patch: 'fixture.patch', patchSha256: sha(patch), files: [
    { path: 'lib/a.js', beforeSha256: sha('old\n'), afterSha256: sha('new\n') },
    { path: 'lib/extra.js', beforeSha256: null, afterSha256: sha('added\n') }
  ] }))
  const run = (...args) => execFileSync(process.execPath, [script.pathname, '--plugin', plugin, '--plan', plan, ...args], { encoding: 'utf8', stdio: 'pipe' })
  return { base, plugin, plan, run }
}

test('精确插件补丁支持核验、幂等应用和完整恢复，包括新增 helper', () => {
  const item = fixture()
  try {
    assert.throws(() => item.run('--check'))
    assert.equal(JSON.parse(item.run()).status, 'patched')
    assert.equal(JSON.parse(item.run()).status, 'already-patched')
    assert.equal(JSON.parse(item.run('--check')).status, 'verified')
    assert.equal(readFileSync(join(item.plugin, 'lib/extra.js'), 'utf8'), 'added\n')
    assert.equal(JSON.parse(item.run('--restore')).status, 'restored')
    assert.equal(readFileSync(join(item.plugin, 'lib/a.js'), 'utf8'), 'old\n')
    assert.equal(existsSync(join(item.plugin, 'lib/extra.js')), false)
  } finally { rmSync(item.base, { recursive: true, force: true }) }
})

test('未知摘要、混合状态和包身份错误不修改任何文件', () => {
  const item = fixture()
  try {
    writeFileSync(join(item.plugin, 'lib/a.js'), 'unknown\n')
    assert.throws(() => item.run(), /Unknown plugin checksum/)
    assert.equal(readFileSync(join(item.plugin, 'lib/a.js'), 'utf8'), 'unknown\n')
    assert.equal(existsSync(join(item.plugin, 'lib/extra.js')), false)
    writeFileSync(join(item.plugin, 'lib/a.js'), 'new\n')
    assert.throws(() => item.run(), /Unknown plugin checksum/)
    writeFileSync(join(item.plugin, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }))
    assert.throws(() => item.run(), /身份/)
  } finally { rmSync(item.base, { recursive: true, force: true }) }
})

test('补丁结果摘要不匹配时只影响临时副本', () => {
  const item = fixture()
  try {
    const plan = JSON.parse(readFileSync(item.plan, 'utf8'))
    plan.files[1].afterSha256 = sha('wrong\n')
    writeFileSync(item.plan, JSON.stringify(plan))
    assert.throws(() => item.run(), /摘要不匹配/)
    assert.equal(readFileSync(join(item.plugin, 'lib/a.js'), 'utf8'), 'old\n')
    assert.equal(existsSync(join(item.plugin, 'lib/extra.js')), false)
  } finally { rmSync(item.base, { recursive: true, force: true }) }
})
