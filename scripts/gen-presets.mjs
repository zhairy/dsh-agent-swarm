#!/usr/bin/env node
/**
 * 生成 presets/*.patch.yml：以指定 DSH 版本 web-app 的 standard 预设为底，叠加 swarm 角色配置
 * 用法：npm run build && node scripts/gen-presets.mjs [--dsh <DSH 的 node_modules 目录>] [--write-fixture]
 * 例如全局安装的 DSH：--dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { JS_TAG, getJsRevived } from './yaml-js-tag.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 未指定 --dsh 时才使用开发沙箱（scripts/sandbox.mjs）安装的 DSH */
const getModulesDir = async (dsh) => {
  if (dsh !== undefined) return dsh
  let sandbox
  try {
    sandbox = await import('./sandbox.mjs')
  } catch {
    throw new Error('没有开发沙箱（scripts/sandbox.mjs）：请用 --dsh 指定 DSH 的 node_modules 目录，例如 --dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"')
  }
  sandbox.ensureDsh()
  return sandbox.getSandboxDshModules()
}

const HEADER = '# 由 scripts/gen-presets.mjs 生成，请勿手改；修改角色请编辑 src/role-registry.ts 或 src/preset-builder.ts 后重新生成\n'

const getArgs = (argv) => ({
  dsh: argv.includes('--dsh') ? argv[argv.indexOf('--dsh') + 1] : undefined,
  writeFixture: argv.includes('--write-fixture')
})

const main = async () => {
  const args = getArgs(process.argv.slice(2))
  const modulesDir = await getModulesDir(args.dsh)
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
    const text = YAML.stringify(getJsRevived(getPresetPatch(role.id, standard)), { customTags: [JS_TAG], lineWidth: 0 })
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
