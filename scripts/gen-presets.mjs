#!/usr/bin/env node
/**
 * 生成 presets/*.patch.yml：以指定 DSH 版本 web-app 的 standard 预设为底，叠加 swarm 角色配置
 * 用法：npm run build && node scripts/gen-presets.mjs [--dsh <node_modules 目录>] [--write-fixture]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { REPO_ROOT, ensureDsh, getSandboxDshModules } from './sandbox.mjs'
import { JS_TAG } from './yaml-js-tag.mjs'

const HEADER = '# 由 scripts/gen-presets.mjs 生成，请勿手改；修改角色请编辑 src/role-registry.ts 或 src/preset-builder.ts 后重新生成\n'

const getArgs = (argv) => ({
  dsh: argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : undefined,
  writeFixture: argv.includes('--write-fixture')
})

const main = async () => {
  const args = getArgs(process.argv.slice(2))
  if (args.dsh === undefined) ensureDsh()
  const modulesDir = args.dsh ?? getSandboxDshModules()
  const standardFile = join(modulesDir, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  if (!existsSync(standardFile)) throw new Error(`找不到 ${standardFile}`)
  const load = (file) => import(pathToFileURL(join(REPO_ROOT, 'lib', file)).href)
  const { getStandardPlugins, getPresetPatch, getPresetFileName, getBundlePatchList } = await load('preset-builder.js')
  const { ROLE_INFO_LIST } = await load('role-registry.js')
  const standard = getStandardPlugins(YAML.parse(readFileSync(standardFile, 'utf8'), { customTags: [JS_TAG] }))
  const presetsDir = join(REPO_ROOT, 'presets')
  mkdirSync(presetsDir, { recursive: true })
  for (const file of readdirSync(presetsDir)) {
    if (file.endsWith('.patch.yml')) rmSync(join(presetsDir, file))
  }
  for (const role of ROLE_INFO_LIST) {
    const text = YAML.stringify(getPresetPatch(role.id, standard), { customTags: [JS_TAG], lineWidth: 0 })
    writeFileSync(join(REPO_ROOT, getPresetFileName(role.id)), HEADER + text, 'utf8')
  }
  const pkgFile = join(REPO_ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const next = { ...pkg, dsh: { ...pkg.dsh, bundle: { ...(pkg.dsh?.bundle ?? {}), patch: getBundlePatchList() } } }
  writeFileSync(pkgFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  if (args.writeFixture) {
    writeFileSync(join(REPO_ROOT, 'tests', 'fixtures', 'standard-plugins.json'), `${JSON.stringify(standard, null, 2)}\n`, 'utf8')
  }
  console.log(`已生成 ${ROLE_INFO_LIST.length} 个预设（standard 来源：${standardFile}）`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
