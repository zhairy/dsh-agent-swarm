#!/usr/bin/env node
// 发布打包：先构建，再按插件入口的依赖闭包校验 tarball 内容，只有校验通过才产出发布物。
//
// 背景：npm pack 打包的是工作区 lib/（构建产物，被 .gitignore 忽略）。如果先复制源码再打包，
// tarball 会缺少新增模块，而这一点只有安装之后才会暴露。这里把「构建 → 闭包校验 → 打包」绑在一起。
//
// 用法: node scripts/pack-release.mjs [--out <dir>] [--skip-build] [--check-only]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const checkOnly = args.includes('--check-only')
const allowDirty = args.includes('--allow-dirty')
const outputDirectory = resolve(option('--out') ?? 'release-artifacts')
const evidencePath = option('--evidence') === undefined ? undefined : resolve(option('--evidence'))
const explicitCommit = option('--git-commit') ?? process.env.GITHUB_SHA
const previousVersion = option('--previous-version')

if (evidencePath !== undefined && !existsSync(evidencePath)) throw new Error(`证据文件不存在：${evidencePath}`)
if (previousVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(previousVersion)) throw new Error('previous-version 格式不合法')

if (!args.includes('--skip-build')) {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
}

const root = resolve('.')
const entry = join(root, 'lib', 'index.js')
if (!existsSync(entry)) throw new Error('缺少构建产物 lib/index.js：先运行 npm run build')
const packageInfo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!checkOnly && !allowDirty) {
  let gitWorktree = false
  try { gitWorktree = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' }).trim() === 'true' } catch {}
  if (gitWorktree) {
    const outputRelative = relative(root, outputDirectory).replaceAll('\\', '/')
    const pathspecs = ['.', ...(outputRelative !== '' && !outputRelative.startsWith('..') ? [`:(exclude)${outputRelative}`] : [])]
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', ...pathspecs], { cwd: root, encoding: 'utf8' }).trim()
    if (dirty !== '') throw new Error(`发布必须绑定干净工作树；先提交源码和说明，或显式使用 --allow-dirty：\n${dirty}`)
  }
}
const entries = [...new Set([entry, ...Object.values(packageInfo.exports ?? {})
  .filter((value) => typeof value === 'string' && value.startsWith('./') && value.endsWith('.js') && !value.includes('*'))
  .map((value) => resolve(root, value))])]

/** 递归收集入口的相对依赖闭包；缺文件立即失败，而不是等安装后才暴露。 */
const collectClosure = (entryPaths) => {
  const seen = new Set()
  const queue = [...entryPaths]
  while (queue.length > 0) {
    const current = queue.pop()
    if (seen.has(current)) continue
    seen.add(current)
    if (!existsSync(current)) throw new Error(`依赖闭包里缺少文件：${current}`)
    const text = readFileSync(current, 'utf8')
    for (const match of text.matchAll(/['"](\.[^'"]+\.js)['"]/g)) queue.push(resolve(dirname(current), match[1]))
  }
  return seen
}

const closure = collectClosure(entries)
/** npm 在不同版本下把 pack 结果输出为数组或「包名 → 结果」的对象，这里两种都接受。 */
const firstPackResult = (text) => {
  const parsed = JSON.parse(text)
  const result = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (result === undefined || result === null || typeof result !== 'object') throw new Error('npm pack 输出无法解析')
  return result
}
// --ignore-scripts 跳过 prepare：否则 npm 会在 pack 期间再次构建，把构建日志混进 JSON 输出。
const packInfo = firstPackResult(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))
const packed = new Set((packInfo.files ?? []).map((file) => file.path))
const forbiddenPackagePath = (path) =>
  /^docs\/(?:plans|evidence|releases)\//.test(path)
  || /^(?:PRD|tests?|src|client)\//.test(path)
  || /^lib\/preset-builder\.(?:js|js\.map|d\.ts)$/.test(path)
  || /^scripts\/(?:build-client|gen-presets|pack-release|sandbox|sync-dsh|yaml-js-tag)\.mjs$/.test(path)
  || /(?:^|\/)\.(?:enola|omc|work|sandbox)\//.test(path)
const forbidden = [...packed].filter(forbiddenPackagePath).sort()
if (forbidden.length > 0) {
  throw new Error(`tarball 包含开发或实施文件 ${forbidden.length} 个，例如：\n  ${forbidden.slice(0, 10).join('\n  ')}`)
}
const missing = [...closure].map((path) => relative(root, path)).filter((path) => !packed.has(path)).sort()
if (missing.length > 0) {
  throw new Error(`tarball 将缺少 ${missing.length} 个入口依赖文件，例如：\n  ${missing.slice(0, 10).join('\n  ')}`)
}
const requiredRuntimeFiles = packageInfo.name === 'dsh-agent-swarm'
  ? [...new Set([
      'package.json', 'README.md', 'THIRD-PARTY-NOTICES.md', 'LICENSE', 'cordis.patch.yml',
      'presets/declarations.json', 'locale/zh.json', 'locale/en.json',
      'skills/jev-judgments/SKILL.md', 'skills/typesafe-ai/SKILL.md', 'skills/typesafe-ai/LICENSE',
      ...(packageInfo.dsh?.bundle?.patch ?? []).map((path) => String(path).replace(/^\.\//, ''))
    ])].sort()
  : []
const missingRuntime = requiredRuntimeFiles.filter((path) => !existsSync(join(root, path)) || !packed.has(path))
if (missingRuntime.length > 0) {
  throw new Error(`tarball 将缺少 ${missingRuntime.length} 个运行时静态文件，例如：\n  ${missingRuntime.slice(0, 10).join('\n  ')}`)
}
const closureReport = {
  entry: relative(root, entry), entries: entries.map((path) => relative(root, path)), closureFiles: closure.size,
  packagedFiles: packed.size, missing: 0, missingRuntime: 0, forbidden: 0
}

if (checkOnly) {
  process.stdout.write(JSON.stringify(closureReport, null, 2) + '\n')
  process.exit(0)
}

mkdirSync(outputDirectory, { recursive: true })
const packedInfo = firstPackResult(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDirectory], { encoding: 'utf8' }))
const tarball = join(outputDirectory, packedInfo.filename)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const stableTarball = packageInfo.name === 'dsh-agent-swarm' ? 'dsh-agent-swarm.tgz' : undefined
if (stableTarball !== undefined) copyFileSync(tarball, join(outputDirectory, stableTarball))
const gitCommit = explicitCommit ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('发布必须绑定 40 位 Git commit')
const evidence = evidencePath === undefined ? undefined : {
  bytes: statSync(evidencePath).size,
  sha256: createHash('sha256').update(readFileSync(evidencePath)).digest('hex')
}
const manifest = {
  schemaVersion: 1,
  package: packageInfo.name,
  version: packageInfo.version,
  gitCommit,
  tarball: packedInfo.filename,
  tarballBytes: packedInfo.size,
  tarballSha256: sha256,
  ...(stableTarball === undefined ? {} : { stableTarball }),
  compatibility: {
    minVersion: packageInfo.dsh?.minVersion ?? packageInfo.engines?.dsh ?? null,
    testedVersions: packageInfo.dsh?.testedVersions ?? []
  },
  ...(previousVersion === undefined ? {} : { previousVersion }),
  ...(evidence === undefined ? {} : { evidence }),
  packageFiles: packedInfo.files?.length ?? packed.size,
  policyVersion: `swarm-release/${packageInfo.version}-v1`
}
writeFileSync(join(outputDirectory, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

// 发布物一起给校验和：说明文件、清单与 tarball 同批生成，避免手工比对。
const companion = ['RELEASE-NOTES.zh-CN.md', 'RELEASE-NOTES.en.md', 'release-manifest.json'].map((name) => join(outputDirectory, name)).filter((path) => existsSync(path))
const sums = [
  `${sha256}  ${packedInfo.filename}`,
  ...(stableTarball === undefined ? [] : [`${sha256}  ${stableTarball}`]),
  ...companion.map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${path.split('/').at(-1)}`)
].join('\n') + '\n'
writeFileSync(join(outputDirectory, 'SHA256SUMS'), sums)
process.stdout.write(JSON.stringify({ ...closureReport, tarball: packedInfo.filename, ...(stableTarball === undefined ? {} : { stableTarball }), bytes: packedInfo.size, sha256, gitCommit,
  manifest: 'release-manifest.json', ...(evidence === undefined ? {} : { evidenceSha256: evidence.sha256 }),
  sums: sums.trim().split('\n').length }, null, 2) + '\n')
