#!/usr/bin/env node
/**
 * 生成 presets/*.patch.yml：以指定 DSH 版本 web-app 的 standard 预设为底，叠加 swarm 角色配置
 * 用法：npm run build && node scripts/gen-presets.mjs --dsh <DSH 的 node_modules 目录>
 * 例如全局安装的 DSH：--dsh "$(npm root -g)/@deepseek-ai/dsh/node_modules"
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import YAML from 'yaml'
import { JS_TAG, getJsRevived } from './yaml-js-tag.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const HEADER = '# 由 scripts/gen-presets.mjs 生成，请勿手改；修改角色请编辑 src/role-registry.ts 或 src/preset-builder.ts 后重新生成\n'

const getArgs = (argv) => {
  if (argv.length !== 2 || argv[0] !== '--dsh' || !argv[1]?.trim() || argv[1].startsWith('--')) {
    throw new Error('用法：node scripts/gen-presets.mjs --dsh <DSH 的 node_modules 目录>')
  }
  return { dsh: argv[1] }
}

const main = async () => {
  const args = getArgs(process.argv.slice(2))
  const modulesDir = args.dsh
  const standardFile = join(modulesDir, '@deepseek-ai', 'dsh-web-app', 'presets', 'standard.patch.yml')
  if (!existsSync(standardFile)) throw new Error(`找不到 ${standardFile}`)
  const load = (file) => import(pathToFileURL(join(REPO_ROOT, 'lib', file)).href)
  const { getStandardPlugins, getPresetPatch, getPresetDeclaration, getPresetFileName, getBundlePatchList } = await load('preset-builder.js')
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
  // 运行时注册用的声明快照：0.2.1-alpha 起子智能体 composition 需要角色预设已注册，
  // 而角色预设默认不在模式列表里，插件在宿主提供激活协议时按需注册这份声明。
  const declarations = ROLE_INFO_LIST.map((role) => getPresetDeclaration(role.id, standard))
  writeFileSync(join(REPO_ROOT, 'presets', 'declarations.json'), `${JSON.stringify({ schemaVersion: 1, declarations }, null, 2)}\n`, 'utf8')
  const pkgFile = join(REPO_ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
  const next = { ...pkg, dsh: { ...pkg.dsh, bundle: { ...(pkg.dsh?.bundle ?? {}), patch: getBundlePatchList() } } }
  writeFileSync(pkgFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`已生成 ${ROLE_INFO_LIST.length} 个预设（standard 来源：${standardFile}）`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
