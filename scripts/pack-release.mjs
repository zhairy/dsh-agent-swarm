#!/usr/bin/env node
// 发布打包：先构建，再按插件入口的依赖闭包校验 tarball 内容，只有校验通过才产出发布物。
//
// 背景：npm pack 打包的是工作区 lib/（构建产物，被 .gitignore 忽略）。如果先复制源码再打包，
// tarball 会缺少新增模块，而这一点只有安装之后才会暴露。这里把「构建 → 闭包校验 → 打包」绑在一起。
//
// 用法: node scripts/pack-release.mjs [--out <dir>] [--skip-build] [--check-only]
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const args = process.argv.slice(2)
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const checkOnly = args.includes('--check-only')
const outputDirectory = resolve(option('--out') ?? 'release-artifacts')

if (!args.includes('--skip-build')) {
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' })
}

const root = resolve('.')
const entry = join(root, 'lib', 'index.js')
if (!existsSync(entry)) throw new Error('缺少构建产物 lib/index.js：先运行 npm run build')

/** 递归收集入口的相对依赖闭包；缺文件立即失败，而不是等安装后才暴露。 */
const collectClosure = (entryPath) => {
  const seen = new Set()
  const queue = [entryPath]
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

const closure = collectClosure(entry)
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
const missing = [...closure].map((path) => relative(root, path)).filter((path) => !packed.has(path)).sort()
if (missing.length > 0) {
  throw new Error(`tarball 将缺少 ${missing.length} 个入口依赖文件，例如：\n  ${missing.slice(0, 10).join('\n  ')}`)
}
process.stdout.write(JSON.stringify({
  entry: relative(root, entry), closureFiles: closure.size, packagedFiles: packed.size, missing: 0
}, null, 2) + '\n')

if (checkOnly) process.exit(0)

mkdirSync(outputDirectory, { recursive: true })
const packedInfo = firstPackResult(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDirectory], { encoding: 'utf8' }))
const tarball = join(outputDirectory, packedInfo.filename)
const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')

// 发布物一起给校验和：说明文件、清单与 tarball 同批生成，避免手工比对。
const companion = ['RELEASE-NOTES.zh-CN.md', 'release-manifest.json'].map((name) => join(outputDirectory, name)).filter((path) => existsSync(path))
const sums = [
  `${sha256}  ${packedInfo.filename}`,
  ...companion.map((path) => `${createHash('sha256').update(readFileSync(path)).digest('hex')}  ${path.split('/').at(-1)}`)
].join('\n') + '\n'
writeFileSync(join(outputDirectory, 'SHA256SUMS'), sums)
process.stdout.write(JSON.stringify({ tarball: packedInfo.filename, bytes: packedInfo.size, sha256, sums: sums.trim().split('\n').length }, null, 2) + '\n')
