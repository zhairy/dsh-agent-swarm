import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ValidateCompatBundle } from '../scripts/verify-release-compat.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), 'swarm-release-compat-')), root = join(base, 'bundle'), sdk = join(base, 'sdk')
  mkdirSync(join(root, 'components/toy'), { recursive: true }); mkdirSync(join(sdk, '@deepseek-ai/dsh'), { recursive: true })
  writeFileSync(join(sdk, '@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.2.2-rc.3' }))
  const files = { 'package.json': JSON.stringify({ name: 'toy', version: '1.0.0' }), 'index.mjs': "export const value = 42\n" }
  for (const [path, value] of Object.entries(files)) writeFileSync(join(root, 'components/toy', path), value)
  const plan = { schemaVersion: 1, hostVersion: '0.2.2-rc.3', components: [{ directory: 'components/toy', name: 'toy', version: '1.0.0', files: Object.fromEntries(Object.entries(files).map(([path, value]) => [path, sha(value)])) }] }
  const save = () => writeFileSync(join(root, 'compat-manifest.json'), JSON.stringify(plan))
  save(); return { base, root, sdk, plan, save }
}

test('兼容包完整核验后才为离线副本链接同一 SDK', () => {
  const f = fixture()
  try {
    assert.equal(ValidateCompatBundle(f.root, f.sdk).verified, true)
    assert.equal(existsSync(join(f.root, 'components/toy/node_modules')), false)
    assert.equal(ValidateCompatBundle(f.root, f.sdk, { linkSdk: true }).sdkLinked, true)
    assert.equal(ValidateCompatBundle(f.root, f.sdk).verified, true)
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})

test('未知字节、额外文件和错误 SDK 均拒绝且不创建链接', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.root, 'components/toy/index.mjs'), 'changed')
    assert.throws(() => ValidateCompatBundle(f.root, f.sdk, { linkSdk: true }), /摘要/)
    assert.equal(existsSync(join(f.root, 'components/toy/node_modules')), false)
    writeFileSync(join(f.root, 'components/toy/index.mjs'), 'export const value = 42\n')
    writeFileSync(join(f.root, 'extra.log'), 'unexpected')
    assert.throws(() => ValidateCompatBundle(f.root, f.sdk), /清单外/)
    rmSync(join(f.root, 'extra.log'))
    writeFileSync(join(f.sdk, '@deepseek-ai/dsh/package.json'), JSON.stringify({ version: '0.2.2-rc.4' }))
    assert.throws(() => ValidateCompatBundle(f.root, f.sdk), /精确目标/)
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})

test('缺失相对依赖与路径逃逸在链接 SDK 前拒绝', () => {
  const f = fixture()
  try {
    const code = "import './missing.mjs'\n"
    writeFileSync(join(f.root, 'components/toy/index.mjs'), code)
    f.plan.components[0].files['index.mjs'] = sha(code); f.save()
    assert.throws(() => ValidateCompatBundle(f.root, f.sdk, { linkSdk: true }), /相对导入/)
    f.plan.components[0].directory = '../escape'; f.save()
    assert.throws(() => ValidateCompatBundle(f.root, f.sdk), /非法路径/)
    assert.equal(existsSync(join(f.root, 'components/toy/node_modules')), false)
  } finally { rmSync(f.base, { recursive: true, force: true }) }
})
